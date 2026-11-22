import "server-only";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { InsufficientBalanceError, isAdmin, requireBalance, UsageLimitError, withCharge } from "./billing";
import { loadStyleCardForDrafting, recentEdits } from "./data";
import { GenerationError, generateFromSource, reviewReadability, SourceSkip } from "./llm";
import { getPromoLink, getPromoSettings } from "./promo-data";
import { createJob, PublishError, updateScheduled } from "./publish";
import { sendMessage, sendPhoto, type Keyboard } from "./tg-api";
import { QUALITY_OK, scoreForCard } from "./quality";
import { firstUrl, looksCut, overusedPhrases, overuseHits, postShape, sourceProblem, splitThread, type PostShape } from "./source-check";
import { extractArticle, fetchPage, isFeed } from "./web-fetch";
import { fitsPost, trigramSimilarity } from "./text";
import { fetchTweetPhotos, getAccount, hasScope, isPremium } from "./x";
import { fetchChannelPostPhotos } from "./tg-channel";
import { makeCard, takeSourceImage } from "./images";

/**
 * 自动发帖：信息源里有新内容 → 用这位客户的风格卡写成推文 → 检查和原文的重合度 →
 * 全自动模式直接排进定时，经官方 X API 发出；确认模式先推到 TG / 网页，点确认才发。
 *
 * 规矩：
 * - 每位客户只用自己的信息源、自己的风格卡、自己的 X 账号、自己的余额
 * - 每条先扣「自动写一条」的钱，没写成（太像原文、模型出错）就退回；发帖照常按条扣
 * - 和原文重合度：X 用户的推文不得超过 50%，其他来源不得超过 67%，超过就不发
 * - 同一件事被几个源同时发：收进灵感池时就按跨来源去重挡掉（见 tg-feed.ts），不会发两遍
 * - 几条候选里挑质量分最高的（代码打分，看像不像本人、有没有 AI 腔、和最近发过的是否重复）；
 *   全自动模式下质量分低于 60 的不直接发，改成推到 TG 等确认
 * - 每天条数上限、两条最短间隔、只在设定的时段内发
 * - 只发原创帖子：不自动私信、关注、点赞、转推
 */

export type AutoSettings = typeof schema.autopilotSettings.$inferSelect;
export type AutoRow = typeof schema.autoPosts.$inferSelect;

export const MODES = ["review", "auto"] as const;
export const MODE_LABEL: Record<(typeof MODES)[number], string> = {
  review: "先确认再发（推到 TG，点一下才发）",
  auto: "全自动（写好直接排进定时发出）",
};
/** X 用户的推文：和原文重合度上限 */
export const X_MAX_OVERLAP = 0.5;
/** 其他来源：和原文重合度上限 */
export const WEB_MAX_OVERLAP = 0.67;
/** 每天最多尝试写几倍于上限的条数（含没通过检查的），控制花费 */
const ATTEMPT_FACTOR = 3;
/** 间隔最长能设到多少分钟 */
export const GAP_MAX = 24 * 60;
/** 客户：每天最多能设几条、两条最短隔几分钟 */
export const CUSTOMER_LIMITS = { capMax: 50, gapMin: 10 } as const;
/** 平台方自己的账号（管理员）：放开，每天最多 1000 条、最短 1 分钟 */
export const OWNER_LIMITS = { capMax: 1000, gapMin: 1 } as const;
/** 接口校验用的最宽范围 */
export const CAP_MAX = OWNER_LIMITS.capMax;

/** 这个账号能设的范围：平台方自己的账号放开，客户按客户上限 */
export async function limitsFor(userId: string): Promise<{ capMax: number; gapMin: number; owner: boolean }> {
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const owner = !!u && (await isAdmin(u));
  return { ...(owner ? OWNER_LIMITS : CUSTOMER_LIMITS), owner };
}

const DEFAULTS: Omit<AutoSettings, "userId" | "updatedAt"> = {
  enabled: false,
  mode: "review",
  dailyCap: 5,
  minGapMin: 90,
  maxGapMin: 0,
  startHour: 0,
  endHour: 24,
  tz: "Asia/Shanghai",
  attachLink: false,
  withPromo: false,
  withImage: false,
  linkReply: false,
  longForm: true,
  instruction: "",
  maxAgeHours: 48,
  perSourceDaily: 2,
};

export async function getSettings(userId: string): Promise<AutoSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.autopilotSettings).where(eq(schema.autopilotSettings.userId, userId)).limit(1);
  return row ?? { userId, updatedAt: new Date(0), ...DEFAULTS };
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function saveSettings(userId: string, patch: Partial<Omit<AutoSettings, "userId" | "updatedAt">>) {
  const cur = await getSettings(userId);
  const next = { ...cur, ...patch };
  // 链接要么放正文，要么放评论区，不两边都放
  if (patch.linkReply) next.attachLink = false;
  else if (patch.attachLink) next.linkReply = false;
  const lim = await limitsFor(userId);
  if (!MODES.includes(next.mode as (typeof MODES)[number])) next.mode = "review";
  next.dailyCap = Math.max(1, Math.min(lim.capMax, Math.round(next.dailyCap)));
  next.minGapMin = Math.max(lim.gapMin, Math.min(GAP_MAX, Math.round(next.minGapMin)));
  next.maxGapMin = Math.max(0, Math.min(GAP_MAX, Math.round(next.maxGapMin)));
  if (next.maxGapMin && next.maxGapMin < next.minGapMin) next.maxGapMin = next.minGapMin;
  next.startHour = Math.max(0, Math.min(23, Math.round(next.startHour)));
  next.endHour = Math.max(0, Math.min(24, Math.round(next.endHour)));
  if (!validTz(next.tz)) next.tz = DEFAULTS.tz;
  next.instruction = next.instruction.slice(0, 500);
  next.maxAgeHours = Math.max(1, Math.min(24 * 14, Math.round(next.maxAgeHours)));
  next.perSourceDaily = Math.max(1, Math.min(lim.capMax, Math.round(next.perSourceDaily)));
  const { userId: _u, updatedAt: _t, ...values } = next;
  void _u;
  void _t;
  const db = await getDb();
  await db
    .insert(schema.autopilotSettings)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: schema.autopilotSettings.userId, set: { ...values, updatedAt: new Date() } });
  return getSettings(userId);
}

// ---------- 时段 ----------

export function localHour(d: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d);
  return Number(h) % 24;
}

/** 时段的说法：「全天」或「9:00–23:00」 */
export function hoursLabel(s: Pick<AutoSettings, "startHour" | "endHour">): string {
  if (s.startHour === s.endHour || (s.startHour === 0 && s.endHour === 24)) return "全天 24 小时";
  return `${s.startHour}:00–${s.endHour}:00${s.endHour < s.startHour ? "（跨夜）" : ""}`;
}

/** 「9-23」「22到6」「全天」→ [开始, 结束]；看不懂返回 null */
export function parseHours(input: string): [number, number] | null {
  const raw = input.replace(/\s+/g, "");
  if (/^(全天|24|24h|24小时|全部|不限|0-24)$/i.test(raw)) return [0, 24];
  const t = raw.replace(/[点时:：]00|[点时]/g, "");
  const m = t.match(/^(\d{1,2})[-~～到至—–](\d{1,2})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 23 || b > 24 || a === b) return null;
  return [a, b];
}

export function inWindow(hour: number, start: number, end: number): boolean {
  if (start === end || (start === 0 && end === 24)) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 从 from 开始，第一个落在发帖时段里的时间（按 15 分钟往后找，最多找两天） */
export function nextInWindow(from: Date, s: Pick<AutoSettings, "startHour" | "endHour" | "tz">): Date {
  let t = new Date(from);
  for (let i = 0; i < 200; i++) {
    if (inWindow(localHour(t, s.tz), s.startHour, s.endHour)) return t;
    t = new Date(t.getTime() + 15 * 60_000);
    t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 15) * 15, 0, 0);
  }
  return from;
}

/** 这次两条之间隔几分钟：设了范围就在范围里随机，看起来不像机器定时 */
export function pickGapMin(s: Pick<AutoSettings, "minGapMin" | "maxGapMin">, rand = Math.random()): number {
  const hi = Math.max(s.minGapMin, s.maxGapMin);
  return s.minGapMin + rand * (hi - s.minGapMin);
}

/** 间隔的说法：「5 分钟」或「1–10 分钟随机」 */
export function gapLabel(s: Pick<AutoSettings, "minGapMin" | "maxGapMin">): string {
  const f = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} 小时` : `${m} 分钟`);
  return s.maxGapMin > s.minGapMin ? `${f(s.minGapMin).replace(/ 分钟$/, "")}–${f(s.maxGapMin)}随机` : f(s.minGapMin);
}

/** 下一条自动帖的发出时间：离上一条（已排或已发）隔开一个间隔，并且在时段内 */
async function nextSlot(userId: string, s: AutoSettings): Promise<Date> {
  const db = await getDb();
  const [last] = await db
    .select({ at: sql<Date>`coalesce(${schema.posts.publishedAt}, ${schema.posts.scheduledAt})` })
    .from(schema.autoPosts)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.autoPosts.postId))
    .where(and(eq(schema.autoPosts.userId, userId), inArray(schema.posts.status, ["scheduled", "publishing", "published"])))
    .orderBy(desc(sql`coalesce(${schema.posts.publishedAt}, ${schema.posts.scheduledAt})`))
    .limit(1);
  const earliest = Date.now() + 30_000;
  const after = last?.at ? new Date(last.at).getTime() + Math.round(pickGapMin(s) * 60_000) : earliest;
  return nextInWindow(new Date(Math.max(earliest, after)), s);
}

// ---------- 写 ----------

class NotUsable extends Error {}

interface Picked {
  item: typeof schema.feedItems.$inferSelect;
  sourceType: string;
  sourceTitle: string | null;
}

export function maxOverlapFor(sourceType: string) {
  return sourceType === "x_user" ? X_MAX_OVERLAP : WEB_MAX_OVERLAP;
}

interface Composed {
  text: string;
  similarity: number;
  quality: number;
  qualityNotes: string[];
  /** 读者视角检查的最低分（通顺 / 完整 / 独立可懂，1–5） */
  readability: number;
  readIssue: string;
}

/** 读者检查每项都到这个分才直接发；低于 MIN_READ 的不用 */
export const READ_OK = 4;
const MIN_READ = 3;

/** 这条要不要先给人看：风格分低，或者读者检查没过 */
export function needsLook(c: Pick<Composed, "quality" | "readability">) {
  return c.quality < QUALITY_OK || c.readability < READ_OK;
}

export function lookNote(c: Composed) {
  const parts: string[] = [];
  if (c.readability < READ_OK) parts.push(`读着可能不顺、看不懂或跑题${c.readIssue ? `：${c.readIssue}` : ""}`);
  if (c.quality < QUALITY_OK) parts.push(`质量分 ${c.quality}${c.qualityNotes.length ? `：${c.qualityNotes.join("；")}` : ""}`);
  return parts.join("。");
}

/**
 * 写之前先看原文够不够写（不扣费）：
 * 推文、TG 消息太短但带着链接的，去读链接里的文章补上（遵守 robots.txt，只读公开页面）；
 * 还是不够的，返回跳过的原因
 */
async function prepareSource(userId: string, p: Picked): Promise<Picked | string> {
  const problem = sourceProblem(p.item.text);
  if (!problem) return p;
  const url = firstUrl(p.item.text);
  if (!url || problem.includes("转推")) return problem;
  try {
    const page = await fetchPage(url);
    if (isFeed(page.body, page.contentType)) return problem;
    const art = extractArticle(page.body);
    const extra = [art.title, art.text].filter(Boolean).join("\n").slice(0, 4000);
    if (sourceProblem(extra)) return problem;
    const text = `${p.item.text}\n\n（链接里的文章）${extra}`;
    const db = await getDb();
    await db
      .update(schema.feedItems)
      .set({ text })
      .where(and(eq(schema.feedItems.id, p.item.id), eq(schema.feedItems.userId, userId)));
    return { ...p, item: { ...p.item, text } };
  } catch {
    return problem;
  }
}

/** 写一条：返回通过检查、质量分最高的正文和重合度；都不合格时抛 NotUsable（外层会退钱） */
async function compose(userId: string, s: AutoSettings, p: Picked): Promise<Composed> {
  const card = await loadStyleCardForDrafting(userId, p.item.text.slice(0, 200));
  if (!card) throw new PublishError("还没有风格卡，自动发帖需要先导入素材并生成风格卡");
  const edits = await recentEdits(userId, 10);
  const promoSettings = s.withPromo ? await getPromoSettings(userId) : null;
  const promo = promoSettings?.defaultId ? await getPromoLink(userId, promoSettings.defaultId) : null;
  const maxOverlap = maxOverlapFor(p.sourceType);
  const link = s.attachLink && p.item.url ? p.item.url : null;
  const origin =
    p.sourceType === "x_user" ? `X 用户 ${p.sourceTitle ?? ""}` : p.sourceTitle || (p.item.url ? new URL(p.item.url).hostname : "外部来源");
  const recent = await recentAutoTexts(userId);
  const avoid = overusedPhrases(recent);
  // 写多长跟原文信息量走：长原文会员写一条长推，不是会员写成串推
  const acc = await getAccount(userId);
  const premium = acc ? await isPremium(acc) : false;
  const shape: PostShape = postShape(p.item.text, { premium, allowLong: s.longForm });
  let out: string[];
  try {
    out = await generateFromSource(
      card,
      { source: p.item.text, origin, instruction: s.instruction, maxOverlap, linkReserve: !!link, count: shape.kind === "single" ? 3 : 2, avoid, shape },
      edits,
      promo,
    );
  } catch (e) {
    if (e instanceof SourceSkip) throw new NotUsable(e.message);
    throw e;
  }
  // 原文链接附在最后一条
  const texts = out.map((c) => (link ? `${c.trimEnd()}\n${link}` : c));
  const plain = (t: string) => splitThread(t).join("\n").replace(link ?? "\u0000", "");
  const quality = scoreForCard(card, texts.map(plain), { long: shape.kind !== "single" });
  const scored = texts
    .map((text, i) => ({ text, similarity: trigramSimilarity(plain(text), p.item.text), q: quality[i] }))
    .filter((c) => fitsAll(c.text, shape.kind === "long"));
  if (!scored.length) throw new NotUsable(shape.kind === "long" ? "写出来的太长了，发不出去" : "写出来的超过了 280 字，发不出去");
  const passing = scored.filter((c) => c.similarity < maxOverlap);
  if (!passing.length) {
    const least = Math.min(...scored.map((c) => c.similarity));
    throw new NotUsable(`写出来的和原文太像（${Math.round(least * 100)}%，上限 ${Math.round(maxOverlap * 100)}%），为免被认为抄袭没有用`);
  }
  // 停在半句的不要
  const whole = passing.filter((c) => !looksCut(splitThread(c.text).at(-1) ?? "", promo ? [promo.url.trim()] : []));
  if (!whole.length) throw new NotUsable("写出来的话都没说完（停在半句），没有用");
  // 读者视角再检查一遍：通顺、说完了、不看原文也能懂
  const reviews = await reviewReadability(p.item.text, whole.map((c) => plain(c.text)), recent);
  if (reviews.some((r) => r.unsafe)) throw new NotUsable("内容涉及色情、赌博或暴力，没有用");
  if (reviews.every((r) => r.repeat)) throw new NotUsable("和最近发过的一条是同一个观点，没有再发");
  const rated = whole
    .map((c, i) => {
      const r = reviews[i];
      return {
        ...c,
        read: r.repeat ? 0 : Math.min(r.fluent, r.complete, r.standalone, r.faithful),
        readSum: r.fluent + r.complete + r.standalone + r.faithful,
        issue: r.issue,
        worn: overuseHits(c.text, avoid),
      };
    })
    .filter((c) => c.read >= MIN_READ);
  if (!rated.length) {
    const issue = reviews.find((r) => r.issue)?.issue;
    throw new NotUsable(`写出来的读着不通顺、看不懂或跑题了${issue ? `（${issue}）` : ""}，没有用`);
  }
  // 先看读不读得懂，再看有没有又用那几个老词，最后看像不像本人
  rated.sort((a, b) => b.read - a.read || a.worn.length - b.worn.length || b.readSum - a.readSum || b.q.score - a.q.score);
  const best = rated[0];
  if (best.worn.length) {
    best.q = { ...best.q, score: Math.max(0, best.q.score - 15 * best.worn.length), notes: [...best.q.notes, `又用了最近用得太多的词：${best.worn.join("、")}`] };
  }
  return {
    text: best.text,
    similarity: Math.round(best.similarity * 100),
    quality: best.q.score,
    qualityNotes: best.q.notes,
    readability: best.read,
    readIssue: best.issue,
  };
}

/** 最近 7 天写出来的自动帖（找反复出现的词用） */
async function recentAutoTexts(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ text: schema.autoPosts.text })
    .from(schema.autoPosts)
    .where(
      and(
        eq(schema.autoPosts.userId, userId),
        inArray(schema.autoPosts.status, ["review", "scheduled", "published"]),
        gte(schema.autoPosts.createdAt, new Date(Date.now() - 7 * 24 * 3600_000)),
      ),
    )
    .orderBy(desc(schema.autoPosts.createdAt))
    .limit(40);
  return rows.map((r) => r.text ?? "").filter(Boolean);
}

/** 最近 48 小时写过的原文里，有没有和这条几乎一样的（几个号转发同一条消息、同一篇文章换个标题） */
async function sameAsRecentSource(userId: string, itemId: string, text: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ text: schema.feedItems.text })
    .from(schema.autoPosts)
    .innerJoin(schema.feedItems, eq(schema.feedItems.id, schema.autoPosts.feedItemId))
    .where(
      and(
        eq(schema.autoPosts.userId, userId),
        ne(schema.autoPosts.feedItemId, itemId),
        inArray(schema.autoPosts.status, ["review", "scheduled", "published"]),
        gte(schema.autoPosts.createdAt, new Date(Date.now() - 48 * 3600_000)),
      ),
    )
    .limit(100);
  return rows.some((r) => trigramSimilarity(text, r.text) >= SAME_SOURCE);
}
const SAME_SOURCE = 0.5;

/**
 * 自动配图：把帖子要点排成一张信息卡（按 image_card 计费；余额不够就这条不带图）。
 * 做不出来、或者 X 还没授权发图，就这条先不带图，不耽误发帖
 */
export async function autoImage(
  userId: string,
  s: Pick<AutoSettings, "withImage">,
  text: string,
  media: string[] = [],
): Promise<{ imageId: string | null; note?: string }> {
  if (!s.withImage) return { imageId: null };
  const acc = await getAccount(userId);
  if (acc && !hasScope(acc, "media.write")) return { imageId: null, note: "X 账号要重新连接一次才能发图，这条先不带图" };
  // 原帖有图：先看原图能不能用（截图、图表、产品图这类；摄影、手绘、人物、色情等不用）
  for (const url of media.slice(0, 2)) {
    try {
      const r = await takeSourceImage(userId, url, text);
      if (r.image) return { imageId: r.image.id };
    } catch (e) {
      console.error("[autopilot] 原图没用上", e instanceof Error ? e.message : e);
    }
  }
  try {
    const img = await makeCard(userId, { text });
    return { imageId: img.id };
  } catch (e) {
    console.error("[autopilot] 配图失败", e instanceof Error ? e.message : e);
    return { imageId: null, note: "配图没做出来，这条先不带图" };
  }
}

/**
 * 给别人引流的链接不放：别人的群（TG、Discord、WhatsApp、QQ、微信、Line）、
 * 别人的社交主页 / 帖子（X、TG、YouTube、Instagram、TikTok、Facebook、小红书、微博…）、
 * 链接聚合页和短链（Linktree、bit.ly…）、带邀请码 / 推广参数的（ref=、invite、aff…）。
 * 只放官网、文档、GitHub、文章这类
 */
const PROMO_HOSTS =
  /(^|\.)(x\.com|twitter\.com|t\.co|t\.me|telegram\.me|telegram\.org|discord\.gg|discord\.com|chat\.whatsapp\.com|wa\.me|line\.me|qm\.qq\.com|jq\.qq\.com|weixin\.qq\.com|u\.wechat\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|douyin\.com|facebook\.com|fb\.me|threads\.net|xiaohongshu\.com|xhslink\.com|weibo\.com|weibo\.cn|bilibili\.com|b23\.tv|linktr\.ee|beacons\.ai|bio\.link|bit\.ly|tinyurl\.com|ow\.ly|buff\.ly|is\.gd|rebrand\.ly|cutt\.ly|shorturl\.at|lnkd\.in|linkedin\.com|reddit\.com)$/i;
const REF_PARAMS = /^(ref|refer|referral|referrer|ref_?code|invite|invite_?code|inviter|aff|affiliate|aff_?id|partner|promo|promo_?code|coupon|via|r|inv|share_?code)$/i;
const REF_PATH = /\/(ref|referral|invite|aff|affiliate)(\/|$|[-_])/i;

/** 去掉 utm_ 这类统计参数 */
function stripTracking(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

export function isPromoLink(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (PROMO_HOSTS.test(u.hostname)) return true;
  if ([...u.searchParams.keys()].some((k) => REF_PARAMS.test(k))) return true;
  if (REF_PATH.test(u.pathname)) return true;
  return false;
}

/** t.co 短链换成真正的地址（只看跳转，不读内容） */
async function expandUrl(u: string): Promise<string | null> {
  try {
    if (new URL(u).hostname !== "t.co") return u;
    const r = await fetch(u, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    const loc = r.headers.get("location");
    return loc && /^https?:\/\//i.test(loc) ? loc : null;
  } catch {
    return null;
  }
}

/**
 * 评论区要放的链接：原文里提到的链接（教程、文章、工具）优先；
 * 网站 / RSS 来源没有的话用文章本身的地址。给别人引流的不用（见 isPromoLink）
 */
export async function replyLinkFor(p: Pick<Picked, "item" | "sourceType">): Promise<string | null> {
  const own = p.item.text.split("（链接里的文章）")[0];
  for (const u of (own.match(/https?:\/\/[^\s)）\]】"'<>]+/gi) ?? []).slice(0, 5)) {
    const real = await expandUrl(u.replace(/[.,，。!！?？]+$/, ""));
    try {
      if (real && !isPromoLink(real)) return stripTracking(real);
    } catch {
      // 不是有效地址，看下一个
    }
  }
  if (p.item.url && !["x_user", "tg_channel", "tg_group"].includes(p.sourceType) && !isPromoLink(p.item.url)) return p.item.url;
  return null;
}

/** 评论区那条的内容 */
export const replyLinkText = (url: string) => `🔗 原文 / 教程：${url}`;

/** 正文 +（有的话）评论区的链接：作为两条的串推发出，第二条就是回复第一条的评论 */
export const autoTweets = (text: string, replyLink: string | null | undefined) => [
  ...splitThread(text),
  ...(replyLink ? [replyLinkText(replyLink)] : []),
];

/** 每一条都能发出去（会员可以发长推）；串推最多 25 条 */
function fitsAll(text: string, long: boolean) {
  const parts = splitThread(text);
  return parts.length > 0 && parts.length <= 25 && parts.every((t) => fitsPost(t, long));
}

/**
 * 给已经排进定时、还没发的自动帖补上原图（之前收进来的内容没记图）：
 * 去原帖找图（X 按 id 读，TG 频道读嵌入页），能用的原图换上（原来的信息卡换掉），不能用的保持原样。
 * 一次最多处理 max 条；AI 次数用完就先停，返回还剩多少
 */
export async function backfillSourceImages(userId: string, max = 15) {
  const db = await getDb();
  const rows = await db
    .select({ a: schema.autoPosts, item: schema.feedItems, imgKind: schema.images.kind })
    .from(schema.autoPosts)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.autoPosts.postId))
    .innerJoin(schema.feedItems, eq(schema.feedItems.id, schema.autoPosts.feedItemId))
    .leftJoin(schema.images, eq(schema.images.id, schema.autoPosts.imageId))
    .where(and(eq(schema.autoPosts.userId, userId), eq(schema.autoPosts.status, "scheduled"), eq(schema.posts.status, "scheduled")))
    .orderBy(schema.posts.scheduledAt);
  const todo = rows.filter((r) => r.imgKind !== "source" && !r.a.note?.includes("原图不适合"));
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号");
  if (!hasScope(acc, "media.write")) throw new PublishError("X 账号要重新连接一次才能发图");
  // 先把没记图的补上图片地址
  const xIds = todo
    .filter((r) => !r.item.media?.length && r.item.kind === "x_user")
    .map((r) => r.item.url?.match(/\/status\/(\d+)/)?.[1])
    .filter((x): x is string => !!x);
  const photos = xIds.length ? await fetchTweetPhotos(acc, xIds) : new Map<string, string[]>();
  let used = 0;
  let unsuitable = 0;
  let noImage = 0;
  let done = 0;
  for (const r of todo.slice(0, max)) {
    let media = r.item.media ?? [];
    if (!media.length) {
      const xid = r.item.url?.match(/\/status\/(\d+)/)?.[1];
      media = xid ? (photos.get(xid) ?? []) : r.item.kind === "tg_channel" && r.item.url ? await fetchChannelPostPhotos(r.item.url) : [];
      if (media.length) await db.update(schema.feedItems).set({ media }).where(eq(schema.feedItems.id, r.item.id));
    }
    done++;
    if (!media.length) {
      noImage++;
      continue;
    }
    let imageId: string | null = null;
    let reason = "";
    for (const url of media.slice(0, 2)) {
      try {
        const t = await takeSourceImage(userId, url, r.a.text);
        if (t.image) {
          imageId = t.image.id;
          break;
        }
        reason = t.reason ?? "";
      } catch (e) {
        if (e instanceof UsageLimitError) return { used, unsuitable, noImage, left: todo.length - done + 1, stopped: e.message };
        throw e;
      }
    }
    if (!imageId) {
      unsuitable++;
      await db.update(schema.autoPosts).set({ note: reason || "原图不适合转用" }).where(eq(schema.autoPosts.id, r.a.id));
      continue;
    }
    await db
      .update(schema.posts)
      .set({ imageId, updatedAt: new Date() })
      .where(and(eq(schema.posts.id, r.a.postId!), eq(schema.posts.userId, userId), eq(schema.posts.status, "scheduled")));
    await db.update(schema.autoPosts).set({ imageId, updatedAt: new Date() }).where(eq(schema.autoPosts.id, r.a.id));
    used++;
  }
  return { used, unsuitable, noImage, left: Math.max(0, todo.length - done), stopped: null as string | null };
}

/** 信息卡是按正文排的，正文改了要重做；原图跟正文无关，留着 */
async function isCardImage(userId: string, imageId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ kind: schema.images.kind })
    .from(schema.images)
    .where(and(eq(schema.images.id, imageId), eq(schema.images.userId, userId)))
    .limit(1);
  return r?.kind === "card";
}

const joinNotes = (...n: (string | null | undefined)[]) => n.filter(Boolean).join("。") || null;

/** 过去 24 小时：已经产出（待确认、已排、已发）几条、一共尝试了几条 */
async function todayCounts(userId: string) {
  const db = await getDb();
  const since = new Date(Date.now() - 24 * 3600_000);
  const [r] = await db
    .select({
      made: sql<number>`count(*) filter (where ${schema.autoPosts.status} in ('review', 'scheduled', 'published'))::int`,
      tried: sql<number>`count(*)::int`,
    })
    .from(schema.autoPosts)
    .where(and(eq(schema.autoPosts.userId, userId), gte(schema.autoPosts.createdAt, since)));
  return { made: r?.made ?? 0, tried: r?.tried ?? 0 };
}

/**
 * 下一条要写的素材：
 * - 来自开了自动发帖的源；订阅时顺带读到的内容，只有带发布时间、并且在 maxAgeHours 内的才用
 * - 原文发布时间在 maxAgeHours 内（不知道发布时间的按收进来的时间）：论坛老帖被顶上来、RSS 补发旧文都不会用
 * - 同一个源过去 24 小时最多用 perSourceDaily 条
 * - 最新的先写：每天条数有限，优先发最新的
 */
async function pickItem(userId: string, s: AutoSettings): Promise<Picked | null> {
  const db = await getDb();
  const since = new Date(Date.now() - s.maxAgeHours * 3600_000);
  const effective = sql`coalesce(${schema.feedItems.publishedAt}, ${schema.feedItems.createdAt})`;
  const [row] = await db
    .select({ item: schema.feedItems, sourceType: schema.sources.type, sourceTitle: schema.sources.title })
    .from(schema.feedItems)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.feedItems.sourceId))
    .leftJoin(
      schema.autoPosts,
      and(eq(schema.autoPosts.feedItemId, schema.feedItems.id), eq(schema.autoPosts.userId, userId)),
    )
    .where(
      and(
        eq(schema.feedItems.userId, userId),
        eq(schema.sources.userId, userId),
        eq(schema.sources.autopilot, true),
        ne(schema.feedItems.status, "dismissed"),
        isNull(schema.autoPosts.id),
        gte(schema.feedItems.createdAt, since),
        sql`${effective} >= ${since.toISOString()}`,
        // 订阅时顺带读到的内容：有原文发布时间、并且够新的也可以用（例如刚关注的大 V 今天发的推文）；
        // 没有发布时间的（网页列表页上的旧文章）只用订阅之后才出现的
        sql`(${schema.feedItems.createdAt} >= coalesce(${schema.sources.autoSince}, ${schema.sources.createdAt}) or ${schema.feedItems.publishedAt} is not null)`,
        sql`(select count(*) from ${schema.autoPosts} ap where ap.user_id = ${userId} and ap.source_id = ${schema.sources.id}
              and ap.status in ('review', 'scheduled', 'published') and ap.created_at > now() - interval '24 hours') < ${s.perSourceDaily}`,
      ),
    )
    .orderBy(desc(effective))
    .limit(1);
  return row ?? null;
}

/** 某位客户：现在能不能写下一条；能就写一条。返回做了什么（测试和日志用） */
export async function processUser(userId: string, now = new Date()): Promise<string> {
  const s = await getSettings(userId);
  if (!s.enabled) return "off";
  if (!inWindow(localHour(now, s.tz), s.startHour, s.endHour)) return "outside-hours";
  const acc = await getAccount(userId);
  if (!acc || acc.authError) return "no-x";
  const counts = await todayCounts(userId);
  if (counts.made >= s.dailyCap) return "cap";
  if (counts.tried >= s.dailyCap * ATTEMPT_FACTOR) return "attempt-cap";
  try {
    // 余额不够写一条再发一条，就先不写（不占素材，充值后自动继续）
    await requireBalance(userId, { auto_draft: 1, post: 1 });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return "balance";
    throw e;
  }
  const picked = await pickItem(userId, s);
  if (!picked) return "idle";
  const db = await getDb();
  // 先占住这条素材（同一条不会被写两次）
  const [claim] = await db
    .insert(schema.autoPosts)
    .values({ userId, feedItemId: picked.item.id, sourceId: picked.item.sourceId, status: "drafting" })
    .onConflictDoNothing()
    .returning();
  if (!claim) return "taken";
  const set = (v: Partial<typeof schema.autoPosts.$inferInsert>) =>
    db.update(schema.autoPosts).set({ ...v, updatedAt: new Date() }).where(eq(schema.autoPosts.id, claim.id)).returning();

  // 原文信息太少、或者和最近用过的原文说的是同一件事的，不写（不扣费）
  const dup = await sameAsRecentSource(userId, picked.item.id, picked.item.text);
  const ready = dup ? "和最近已经写过的一条原文说的是同一件事，没有再写" : await prepareSource(userId, picked);
  if (typeof ready === "string") {
    await set({ status: "skipped", note: ready });
    return "skipped";
  }

  let composed: Composed;
  try {
    composed = await withCharge(userId, "auto_draft", () => compose(userId, s, ready), claim.id);
  } catch (e) {
    if (e instanceof UsageLimitError) {
      // 被防刷线挡住：放回去，下次再写
      await db.delete(schema.autoPosts).where(eq(schema.autoPosts.id, claim.id));
      return "busy";
    }
    const note =
      e instanceof NotUsable || e instanceof PublishError || e instanceof GenerationError || e instanceof InsufficientBalanceError
        ? e.message
        : "写的时候出错了";
    if (!(e instanceof NotUsable || e instanceof PublishError || e instanceof GenerationError || e instanceof InsufficientBalanceError)) {
      console.error("[autopilot]", e);
    }
    await set({ status: "skipped", note });
    return "skipped";
  }

  const img = await autoImage(userId, s, composed.text, ready.item.media ?? []);
  const replyLink = s.linkReply && !s.attachLink ? await replyLinkFor(ready) : null;
  const base = { text: composed.text, similarity: composed.similarity, quality: composed.quality, imageId: img.imageId, replyLink };
  const lowQuality = needsLook(composed);
  if (s.mode === "auto" && lowQuality) {
    await set({
      ...base,
      status: "review",
      note: joinNotes(`${lookNote(composed) || `质量分 ${composed.quality} 偏低`}。没有直接发，请看一下再决定`, img.note),
    });
    await notifyReview(userId, claim.id);
    return "review";
  }
  if (s.mode === "auto") {
    try {
      const job = await createJob(userId, { tweets: autoTweets(composed.text, replyLink), scheduledAt: await nextSlot(userId, s), imageId: img.imageId });
      await set({ ...base, status: "scheduled", postId: job.id, note: img.note ?? null });
      return "scheduled";
    } catch (e) {
      await set({
        ...base,
        status: "review",
        note: `没能自动排期：${e instanceof Error ? e.message : "未知原因"}。确认后可以手动发。`,
      });
      await notifyReview(userId, claim.id);
      return "review";
    }
  }
  await set({ ...base, status: "review", note: joinNotes(lowQuality ? lookNote(composed) : null, img.note) });
  await notifyReview(userId, claim.id);
  return "review";
}

/** 定时任务：所有开了自动发帖的客户，每人这一轮最多写一条 */
export async function runAutopilot(): Promise<number> {
  const db = await getDb();
  // 写到一半被中断（应用重启）的，放回去
  await db
    .delete(schema.autoPosts)
    .where(and(eq(schema.autoPosts.status, "drafting"), sql`${schema.autoPosts.updatedAt} < now() - interval '10 minutes'`));
  const users = await db
    .select({ userId: schema.autopilotSettings.userId })
    .from(schema.autopilotSettings)
    .where(eq(schema.autopilotSettings.enabled, true));
  let made = 0;
  for (const { userId } of users) {
    try {
      const r = await processUser(userId);
      if (r === "scheduled" || r === "review") made++;
    } catch (e) {
      console.error("[autopilot] 处理失败", e instanceof Error ? e.message : e);
    }
  }
  return made;
}

// ---------- 确认 / 跳过 / 改 ----------

export async function ownAuto(userId: string, id: string): Promise<AutoRow> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.autoPosts)
    .where(and(eq(schema.autoPosts.id, id), eq(schema.autoPosts.userId, userId)))
    .limit(1);
  if (!row) throw new PublishError("找不到这条自动帖");
  return row;
}

/** 确认发出：now=true 立即发，否则排到下一个空档 */
export async function approveAuto(userId: string, id: string, opts: { now?: boolean; text?: string } = {}) {
  const row = await ownAuto(userId, id);
  if (row.status !== "review") throw new PublishError(row.status === "scheduled" ? "这条已经排进定时了" : "这条已经处理过了");
  const text = (opts.text ?? row.text).trim();
  const db = await getDb();
  // 先改状态占住，防止连点发两次
  const [claimed] = await db
    .update(schema.autoPosts)
    .set({ status: "approving", text, updatedAt: new Date() })
    .where(and(eq(schema.autoPosts.id, id), eq(schema.autoPosts.status, "review")))
    .returning();
  if (!claimed) throw new PublishError("这条正在处理");
  try {
    const s = await getSettings(userId);
    // 正文改过、图是按旧正文做的：重做一张
    let imageId = row.imageId;
    if (imageId && text !== row.text.trim() && (await isCardImage(userId, imageId))) imageId = (await autoImage(userId, { withImage: true }, text)).imageId;
    const job = await createJob(userId, { tweets: autoTweets(text, row.replyLink), scheduledAt: opts.now ? null : await nextSlot(userId, s), imageId });
    const status = job.status === "published" ? "published" : job.status === "failed" ? "review" : "scheduled";
    const [r] = await db
      .update(schema.autoPosts)
      .set({ status, postId: job.id, note: job.status === "failed" ? job.error : null, updatedAt: new Date() })
      .where(eq(schema.autoPosts.id, id))
      .returning();
    return { row: r, job };
  } catch (e) {
    await db.update(schema.autoPosts).set({ status: "review", updatedAt: new Date() }).where(eq(schema.autoPosts.id, id));
    throw e;
  }
}

export async function skipAuto(userId: string, id: string) {
  const row = await ownAuto(userId, id);
  const db = await getDb();
  if (row.status === "scheduled" && row.postId) {
    await updateScheduled(userId, row.postId, { cancel: true }).catch(() => {});
  } else if (row.status !== "review") {
    throw new PublishError("这条已经发出或处理过了");
  }
  await db.update(schema.autoPosts).set({ status: "skipped", note: "你跳过了这条", updatedAt: new Date() }).where(eq(schema.autoPosts.id, id));
}

/** 改正文（只能改还没发的）；改的时候也要守重合度上限 */
export async function editAuto(userId: string, id: string, text: string) {
  const row = await ownAuto(userId, id);
  if (row.status !== "review") throw new PublishError("只有等确认的可以改");
  const t = text.trim();
  if (!t) throw new PublishError("内容不能为空");
  const acc = await getAccount(userId);
  if (!fitsAll(t, acc?.premium === true)) throw new PublishError(acc?.premium ? "太长了，发不出去" : "有一条超过 280 加权字数（串推用单独一行 --- 分开每一条）");
  const db = await getDb();
  const sim = await overlapWithSource(userId, row, t);
  const [r] = await db
    .update(schema.autoPosts)
    .set({
      text: t,
      similarity: sim.pct,
      // 图是按旧正文做的：重做一张
      ...(row.imageId && t !== row.text.trim() && (await isCardImage(userId, row.imageId)) ? { imageId: (await autoImage(userId, { withImage: true }, t)).imageId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.autoPosts.id, id))
    .returning();
  if (sim.over) throw new PublishError(`改完和原文重合 ${sim.pct}%，超过上限 ${sim.limit}%，请再改改再发`);
  return r;
}

async function overlapWithSource(userId: string, row: AutoRow, text: string) {
  const db = await getDb();
  const [src] = row.feedItemId
    ? await db
        .select({ text: schema.feedItems.text, type: schema.sources.type })
        .from(schema.feedItems)
        .leftJoin(schema.sources, eq(schema.sources.id, schema.feedItems.sourceId))
        .where(and(eq(schema.feedItems.id, row.feedItemId), eq(schema.feedItems.userId, userId)))
        .limit(1)
    : [];
  if (!src) return { pct: 0, limit: 67, over: false };
  const max = maxOverlapFor(src.type ?? "");
  const s = trigramSimilarity(text, src.text);
  return { pct: Math.round(s * 100), limit: Math.round(max * 100), over: s >= max };
}

/** 换一种写法（重新扣一次「自动写一条」） */
export async function rewriteAuto(userId: string, id: string) {
  const row = await ownAuto(userId, id);
  if (row.status !== "review") throw new PublishError("只有等确认的可以重写");
  const db = await getDb();
  const [picked] = row.feedItemId
    ? await db
        .select({ item: schema.feedItems, sourceType: schema.sources.type, sourceTitle: schema.sources.title })
        .from(schema.feedItems)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.feedItems.sourceId))
        .where(and(eq(schema.feedItems.id, row.feedItemId), eq(schema.feedItems.userId, userId)))
        .limit(1)
    : [];
  if (!picked) throw new PublishError("原素材已经删掉了，没法重写");
  const s = await getSettings(userId);
  let c: Composed;
  try {
    c = await withCharge(userId, "auto_draft", () => compose(userId, s, picked), id);
  } catch (e) {
    if (e instanceof NotUsable) throw new PublishError(e.message);
    throw e;
  }
  const [r] = await db
    .update(schema.autoPosts)
    .set({
      text: c.text,
      similarity: c.similarity,
      quality: c.quality,
      note: needsLook(c) ? lookNote(c) : null,
      ...((row.imageId && (await isCardImage(userId, row.imageId))) || (!row.imageId && s.withImage)
        ? { imageId: (await autoImage(userId, { withImage: true }, c.text, picked.item.media ?? [])).imageId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.autoPosts.id, id))
    .returning();
  return r;
}

/** 最近的自动帖（含原文摘要和发布状态），网页和机器人都用 */
export async function listAuto(userId: string, limit = 30) {
  const db = await getDb();
  return db
    .select({
      id: schema.autoPosts.id,
      text: schema.autoPosts.text,
      status: schema.autoPosts.status,
      similarity: schema.autoPosts.similarity,
      quality: schema.autoPosts.quality,
      note: schema.autoPosts.note,
      createdAt: schema.autoPosts.createdAt,
      sourceText: schema.feedItems.text,
      sourceUrl: schema.feedItems.url,
      sourceTitle: schema.sources.title,
      sourceType: schema.sources.type,
      postStatus: schema.posts.status,
      postError: schema.posts.error,
      scheduledAt: schema.posts.scheduledAt,
      postIds: schema.posts.postIds,
      handle: schema.posts.handle,
    })
    .from(schema.autoPosts)
    .leftJoin(schema.feedItems, eq(schema.feedItems.id, schema.autoPosts.feedItemId))
    .leftJoin(schema.sources, eq(schema.sources.id, schema.autoPosts.sourceId))
    .leftJoin(schema.posts, eq(schema.posts.id, schema.autoPosts.postId))
    .where(and(eq(schema.autoPosts.userId, userId), ne(schema.autoPosts.status, "drafting")))
    .orderBy(desc(schema.autoPosts.createdAt))
    .limit(limit);
}

// ---------- TG 推送 ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function reviewButtons(id: string): Keyboard {
  return [
    [
      { text: "✅ 排进定时", callback_data: `aa:${id}` },
      { text: "🚀 现在就发", callback_data: `an:${id}` },
    ],
    [
      { text: "✏️ 自己改", callback_data: `ae:${id}` },
      { text: "🔄 换个写法", callback_data: `ar:${id}` },
      { text: "跳过", callback_data: `ax:${id}` },
    ],
  ];
}

/** 串推给人看：每条前面标上 1/3、2/3… */
export function showThread(text: string) {
  const parts = splitThread(text);
  return parts.length > 1 ? parts.map((t, i) => `【${i + 1}/${parts.length}】\n${t}`).join("\n\n") : text;
}

export function reviewText(r: { text: string; similarity: number | null; quality?: number | null; note: string | null; replyLink?: string | null }, source: { title: string | null; text: string; url: string | null } | null) {
  return (
    `🤖 自动发帖 · 等你确认\n\n${showThread(r.text)}\n\n` +
    (r.replyLink ? `💬 发出后在评论区附：${r.replyLink}\n\n` : "") +
    `— 来源：${source?.title ?? "信息源"}${source?.url ? `\n${source.url}` : ""}\n` +
    `原文摘要：${clip((source?.text ?? "").replace(/\s+/g, " "), 80)}\n` +
    `和原文重合：${r.similarity ?? 0}%${r.quality != null ? ` · 质量 ${r.quality}` : ""}${r.note ? `\n⚠️ ${r.note}` : ""}`
  );
}

/** 等确认的自动帖推到 TG（没绑定就只在网页上显示） */
export async function notifyReview(userId: string, autoId: string) {
  const db = await getDb();
  const [bind] = await db
    .select({ chatId: schema.tgBindings.chatId })
    .from(schema.tgBindings)
    .where(eq(schema.tgBindings.userId, userId))
    .limit(1);
  if (!bind?.chatId) return;
  const [r] = await db
    .select({
      a: schema.autoPosts,
      title: schema.sources.title,
      text: schema.feedItems.text,
      url: schema.feedItems.url,
    })
    .from(schema.autoPosts)
    .leftJoin(schema.feedItems, eq(schema.feedItems.id, schema.autoPosts.feedItemId))
    .leftJoin(schema.sources, eq(schema.sources.id, schema.autoPosts.sourceId))
    .where(and(eq(schema.autoPosts.id, autoId), eq(schema.autoPosts.userId, userId)))
    .limit(1);
  if (!r) return;
  try {
    if (r.a.imageId) {
      const [img] = await db
        .select({ data: schema.images.data })
        .from(schema.images)
        .where(and(eq(schema.images.id, r.a.imageId), eq(schema.images.userId, userId)))
        .limit(1);
      if (img) await sendPhoto(bind.chatId, img.data, "🖼 这条的配图（发帖时一起发出）").catch(() => {});
    }
    await sendMessage(bind.chatId, reviewText(r.a, r.text ? { title: r.title, text: r.text, url: r.url } : null), {
      buttons: reviewButtons(autoId),
    });
    await db.update(schema.autoPosts).set({ tgNotifiedAt: new Date() }).where(eq(schema.autoPosts.id, autoId));
  } catch (e) {
    console.error("[autopilot] 推送到 TG 失败", e instanceof Error ? e.message : e);
  }
}
