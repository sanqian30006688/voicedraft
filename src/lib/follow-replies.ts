import "server-only";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { affordable, charge, InsufficientBalanceError, requireBalance, UsageLimitError } from "./billing";
import { GenerationError } from "./llm";
import { PublishError } from "./publish";
import { fmtWait, hit } from "./rate-limit";
import { generateFor } from "./replies";
import { fetchHomeTimeline, getAccount, XApiError, type XAccount, type XTweet } from "./x";

/**
 * 给关注的人推送回复候选：
 * 读本人首页时间线（「正在关注」，X 的「为你推荐」没有开放接口），按用户设的关键词 / 账号挑出值得回的帖子，
 * 用风格卡写好回复候选，进回复队列并推到 TG。
 *
 * 对方没有 @ 用户，X 的自动化规则不允许程序自动回复这类帖子，所以这里只写候选、绝不自动发出：
 * 每条都要用户在 TG 或网页上点「发送」才会发。不私信、不关注、不点赞、不转推。
 */

/** 手动「现在检查」最短间隔（定时任务不受这个限制，按用户设的间隔） */
const MANUAL_GAP_MS = 2 * 60_000;

export interface PickRules {
  ownXUserId: string;
  keywords: string[];
  handles: string[];
  skipKeywords: string[];
  skipHandles: string[];
}

export interface Picked {
  tweet: XTweet;
  reason: string;
}

const norm = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/** 去掉链接和 @ 之后还剩多少字（太短的帖子没什么可接的） */
function contentLength(text: string): number {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@\w+/g, "")
    .replace(/\s+/g, "").length;
}

/**
 * 从读到的帖子里挑出要写回复候选的（纯函数，方便测试）：
 * - 不回自己的帖子、太短的帖子、命中「不回复」规则的帖子；
 * - 设了账号或关键词时，只挑命中的（账号命中优先）；都没设时，关注的人的帖子都可以；
 * - 同一个人只挑一条（authorsDone 是最近 24 小时已经挑过的人），总数不超过 max；
 * - 新的在前。
 */
export function pickPosts(tweets: XTweet[], rules: PickRules, authorsDone: Set<string>, max: number): Picked[] {
  if (max <= 0) return [];
  const handles = new Set(rules.handles.map(norm).filter(Boolean));
  const keywords = rules.keywords.map((k) => k.trim()).filter(Boolean);
  const skipHandles = new Set(rules.skipHandles.map(norm).filter(Boolean));
  const skipKeywords = rules.skipKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const filtered = handles.size > 0 || keywords.length > 0;

  const byHandle: Picked[] = [];
  const byKeyword: Picked[] = [];
  const rest: Picked[] = [];
  const sorted = [...tweets].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
  for (const t of sorted) {
    const h = norm(t.authorHandle);
    const lower = t.text.toLowerCase();
    if (t.authorId === rules.ownXUserId) continue;
    if (contentLength(t.text) < 8) continue;
    if (skipHandles.has(h) || skipKeywords.some((k) => lower.includes(k))) continue;
    if (handles.has(h)) byHandle.push({ tweet: t, reason: `你指定的账号 @${t.authorHandle}` });
    else {
      const kw = keywords.find((k) => lower.includes(k.toLowerCase()));
      if (kw) byKeyword.push({ tweet: t, reason: `含关键词「${kw}」` });
      else if (!filtered) rest.push({ tweet: t, reason: "你关注的人" });
    }
  }
  const out: Picked[] = [];
  const seen = new Set(authorsDone);
  for (const p of [...byHandle, ...byKeyword, ...rest]) {
    if (out.length >= max) break;
    const key = p.tweet.authorId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** 最近 24 小时已经为关注的人写过多少条候选（AI 判断不该回的不算），以及写过的是哪些人 */
async function usedToday(userId: string): Promise<{ used: number; authors: Set<string> }> {
  const db = await getDb();
  const rows = await db
    .select({ authorId: schema.replyItems.authorId, status: schema.replyItems.status, skipReason: schema.replyItems.skipReason })
    .from(schema.replyItems)
    .where(
      and(
        eq(schema.replyItems.userId, userId),
        eq(schema.replyItems.source, "timeline"),
        gt(schema.replyItems.createdAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    );
  const used = rows.filter((r) => !(r.status === "skipped" && r.skipReason?.startsWith("AI 判断"))).length;
  return { used, authors: new Set(rows.map((r) => r.authorId)) };
}

export interface TimelineResult {
  /** 读了几条 */
  read: number;
  /** 进了回复队列几条 */
  added: number;
  message?: string;
}

const checking = ((globalThis as { __vdTimelineChecking?: Set<string> }).__vdTimelineChecking ??= new Set<string>());

/**
 * 读一次关注的人的新帖子，挑出要回的、写好候选。只读不发。
 * manual：用户手动点「现在检查」，限制最短间隔，防止反复点白花读取费。
 */
export async function checkTimeline(userId: string, opts: { manual?: boolean } = {}): Promise<TimelineResult> {
  if (checking.has(userId)) return { read: 0, added: 0, message: "正在检查中，请稍等" };
  if (opts.manual) {
    const r = hit(`tl:manual:${userId}`, 1, MANUAL_GAP_MS);
    if (!r.ok) throw new UsageLimitError(`刚检查过，请 ${fmtWait(r.retryAfterMs)}后再试。`);
  }
  checking.add(userId);
  try {
    return await checkLocked(userId);
  } finally {
    checking.delete(userId);
  }
}

async function checkLocked(userId: string): Promise<TimelineResult> {
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号");
  if (acc.authError) throw new PublishError("X 授权已失效，请重新连接");
  const db = await getDb();
  const now = new Date();
  if (acc.timelinePausedUntil && acc.timelinePausedUntil > now) {
    return { read: 0, added: 0, message: acc.timelinePausedReason ?? "已暂停" };
  }

  const { used, authors } = await usedToday(userId);
  const room = Math.max(0, acc.timelineDailyCap - used);
  if (room <= 0) {
    await db.update(schema.xAccounts).set({ timelineCheckedAt: now }).where(eq(schema.xAccounts.id, acc.id));
    return { read: 0, added: 0, message: `今天已经写了 ${used} 条，到了每天 ${acc.timelineDailyCap} 条的上限，明天再推` };
  }

  // 每读一条按价目表扣费；最多读余额够付的条数，余额不会扣成负数
  await requireBalance(userId, { timeline_read: 1 });
  const limit = Math.min(acc.timelineReadLimit, await affordable(userId, "timeline_read"));
  let fetched;
  try {
    fetched = await fetchHomeTimeline(acc, acc.timelineSinceId, limit);
  } catch (e) {
    await handleXError(acc, e, now);
    throw e;
  }
  await charge(userId, "timeline_read", fetched.items.length, undefined, "读取关注的人");
  await db
    .update(schema.xAccounts)
    .set({
      timelineSinceId: fetched.newestId ?? acc.timelineSinceId,
      timelineCheckedAt: now,
      timelinePausedUntil: null,
      timelinePausedReason: null,
    })
    .where(eq(schema.xAccounts.id, acc.id));

  const picked = pickPosts(fetched.items, rulesOf(acc), authors, room);
  let added = 0;
  for (const p of picked) {
    const [row] = await db
      .insert(schema.replyItems)
      .values({
        userId,
        source: "timeline",
        matchReason: p.reason,
        tweetId: p.tweet.id,
        authorId: p.tweet.authorId,
        authorHandle: p.tweet.authorHandle,
        authorName: p.tweet.authorName,
        text: p.tweet.text,
        tweetedAt: p.tweet.createdAt,
        status: "pending",
      })
      // 同一条帖子已经在队列里（例如对方 @ 过你）就不再加
      .onConflictDoNothing({ target: [schema.replyItems.userId, schema.replyItems.tweetId] })
      .returning();
    if (!row) continue;
    try {
      const done = await generateFor(userId, row);
      if (done.status === "pending") added++;
    } catch (e) {
      // 没有风格卡、余额不够或模型出错：这条留在队列里等用户手动生成，后面的先不写
      if (!(e instanceof GenerationError || e instanceof PublishError || e instanceof InsufficientBalanceError || e instanceof UsageLimitError)) {
        console.error(e);
      }
      added++;
      break;
    }
  }
  return {
    read: fetched.items.length,
    added,
    message: fetched.items.length ? undefined : "关注的人没有新帖子",
  };
}

function rulesOf(acc: XAccount): PickRules {
  return {
    ownXUserId: acc.xUserId,
    keywords: acc.timelineKeywords,
    handles: acc.timelineHandles,
    skipKeywords: acc.skipKeywords,
    skipHandles: acc.skipHandles,
  };
}

async function handleXError(acc: XAccount, e: unknown, now: Date) {
  if (!(e instanceof XApiError)) return;
  const db = await getDb();
  if (e.kind === "rate_limit") {
    await db
      .update(schema.xAccounts)
      .set({ timelinePausedUntil: e.resetAt, timelinePausedReason: e.message, timelineCheckedAt: now })
      .where(eq(schema.xAccounts.id, acc.id));
  } else if (e.kind === "credits" || e.kind === "forbidden") {
    // 额度不足或没有读取权限：关掉自动检查，避免反复失败；用户处理好后重新打开即可
    await db
      .update(schema.xAccounts)
      .set({ timelineEnabled: false, timelinePausedReason: e.message, timelineCheckedAt: now })
      .where(eq(schema.xAccounts.id, acc.id));
  }
}

/** 定时任务：到了检查间隔、开着「关注的人」的账号 */
export async function dueTimelineUsers(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ userId: schema.xAccounts.userId })
    .from(schema.xAccounts)
    .where(
      and(
        eq(schema.xAccounts.timelineEnabled, true),
        sql`${schema.xAccounts.authError} is null`,
        sql`(${schema.xAccounts.timelinePausedUntil} is null or ${schema.xAccounts.timelinePausedUntil} < now())`,
        sql`(${schema.xAccounts.timelineCheckedAt} is null or ${schema.xAccounts.timelineCheckedAt} < now() - make_interval(mins => ${schema.xAccounts.timelineIntervalMin}))`,
      ),
    )
    .orderBy(asc(schema.xAccounts.timelineCheckedAt));
  return rows.map((r) => r.userId);
}

/** 关注的人相关的设置，网页和 TG 共用 */
export interface FollowSettings {
  timelineEnabled?: boolean;
  timelineIntervalMin?: number;
  timelineKeywords?: string[];
  timelineHandles?: string[];
  timelineDailyCap?: number;
  timelineReadLimit?: number;
}

export const FOLLOW_INTERVALS = [30, 60, 180, 360] as const;
export const FOLLOW_CAPS = [3, 5, 10, 20, 30] as const;

export async function saveFollowSettings(userId: string, patch: FollowSettings): Promise<boolean> {
  const db = await getDb();
  const clean: FollowSettings = { ...patch };
  if (clean.timelineHandles) {
    // 账号名不分大小写，去重时按小写比
    const seen = new Set<string>();
    clean.timelineHandles = clean.timelineHandles
      .map((h) => h.trim().replace(/^@/, ""))
      .filter((h) => h && !seen.has(h.toLowerCase()) && seen.add(h.toLowerCase()));
  }
  if (clean.timelineKeywords) clean.timelineKeywords = [...new Set(clean.timelineKeywords.map((k) => k.trim()).filter(Boolean))];
  const rows = await db
    .update(schema.xAccounts)
    .set({
      ...clean,
      // 重新打开时清掉之前的暂停原因
      ...(clean.timelineEnabled ? { timelinePausedReason: null, timelinePausedUntil: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.xAccounts.userId, userId))
    .returning({ id: schema.xAccounts.id });
  return rows.length > 0;
}
