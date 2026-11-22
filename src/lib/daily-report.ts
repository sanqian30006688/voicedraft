import "server-only";
import { bestOfRange } from "./post-metrics";
import { metricsLine } from "./post-metrics-core";
import { and, eq, gt, gte, inArray, isNotNull, lt, ne, notInArray, sql, type AnyColumn } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { adminUserIds, fmtUsdt, getSetting, postsLeft, setSetting } from "./billing";
import { funnel } from "./rewards";
import { sendMessage, type Keyboard } from "./tg-api";
import { usageBetween, type UsageTotals } from "./usage";
import { backupReportLine } from "./backup";

/**
 * 日报：每天早上发一份「昨天」的小结。只读数据库，不调 AI、不调 X。
 *
 * 1. 顾客日报（TG）：昨天发出几条（其中自动发帖几条）、回复发了几条、待确认几条、新回复候选几条、
 *    今天排了几条定时、预计还能发约 N 条（不显示价格），快用完时提醒充值。昨天什么都没发生、也没有待处理的就不发。
 *    顾客可以在机器人「☰ 更多 → 📰 每日日报」里关掉、改时间和时区。
 * 2. 经营日报（TG，发给管理员）：新注册、绑 TG、首充、充值总额、用户消耗、AI 和 X 成本、毛利、近 7 天漏斗。
 *
 * 要往顾客日报里加一块（例如同行对比），往 REPORT_SECTIONS 里加一个函数就行。
 */

// ---------- 时区 ----------

export const DEFAULT_TZ = "Asia/Shanghai";

/** 机器人里能选的时区 */
export const TZ_CHOICES: { tz: string; label: string }[] = [
  { tz: "Asia/Shanghai", label: "北京时间" },
  { tz: "Asia/Tokyo", label: "东京" },
  { tz: "Asia/Singapore", label: "新加坡" },
  { tz: "Asia/Dubai", label: "迪拜" },
  { tz: "Europe/London", label: "伦敦" },
  { tz: "Europe/Berlin", label: "柏林" },
  { tz: "America/New_York", label: "纽约" },
  { tz: "America/Los_Angeles", label: "洛杉矶" },
];

export const HOUR_CHOICES = [7, 8, 9, 10, 12, 20];

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const tzLabel = (tz: string) => TZ_CHOICES.find((t) => t.tz === tz)?.label ?? tz;

/** 这个时刻在 tz 里是几号几点 */
function localParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: n("year"), m: n("month"), d: n("day"), h: n("hour"), min: n("minute"), s: n("second") };
}

/** tz 里的当前日期 YYYY-MM-DD 和小时 */
export function localDayHour(at: Date, tz: string): { day: string; hour: number } {
  const p = localParts(at, tz);
  return { day: `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, hour: p.h };
}

/** tz 里 day（YYYY-MM-DD）这一天 0 点对应的时刻 */
function startOfLocalDay(day: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // 先按 UTC 0 点猜，再按那个时刻在 tz 里的偏移修正（夏令时切换那天差一小时，日报够用）
  const p = localParts(new Date(guess), tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess;
  return new Date(guess - offset);
}

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

/** 「昨天」在 tz 里的起止时刻 */
export function yesterdayRange(now: Date, tz: string): { day: string; from: Date; to: Date; today: string } {
  const today = localDayHour(now, tz).day;
  const day = shiftDay(today, -1);
  return { day, today, from: startOfLocalDay(day, tz), to: startOfLocalDay(today, tz) };
}

const mmdd = (day: string) => `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;

// ---------- 顾客日报设置 ----------

export interface ReportPrefs {
  enabled: boolean;
  hour: number;
  tz: string;
}

export async function getReportPrefs(userId: string): Promise<ReportPrefs> {
  const db = await getDb();
  const [row] = await db.select().from(schema.dailyReportSettings).where(eq(schema.dailyReportSettings.userId, userId)).limit(1);
  if (row) return { enabled: row.enabled, hour: row.hour, tz: row.tz };
  // 没设置过：时区跟自动发帖的时区走，没有就北京时间
  const [ap] = await db.select({ tz: schema.autopilotSettings.tz }).from(schema.autopilotSettings).where(eq(schema.autopilotSettings.userId, userId)).limit(1);
  return { enabled: true, hour: 9, tz: ap?.tz && validTz(ap.tz) ? ap.tz : DEFAULT_TZ };
}

export async function saveReportPrefs(userId: string, patch: Partial<ReportPrefs>): Promise<ReportPrefs> {
  const cur = await getReportPrefs(userId);
  const next: ReportPrefs = {
    enabled: patch.enabled ?? cur.enabled,
    hour: patch.hour !== undefined && Number.isInteger(patch.hour) && patch.hour >= 0 && patch.hour <= 23 ? patch.hour : cur.hour,
    tz: patch.tz && validTz(patch.tz) ? patch.tz : cur.tz,
  };
  const db = await getDb();
  await db
    .insert(schema.dailyReportSettings)
    .values({ userId, ...next })
    .onConflictDoUpdate({ target: schema.dailyReportSettings.userId, set: { ...next, updatedAt: new Date() } });
  return next;
}

// ---------- 顾客日报内容 ----------

export interface ReportContext {
  userId: string;
  tz: string;
  /** 昨天（顾客时区）的起止 */
  from: Date;
  to: Date;
  now: Date;
}

/** 日报里的一块：lines 是要显示的几行；active 表示「有事可说」（全都不 active 就不发） */
export interface ReportSection {
  lines: string[];
  active: boolean;
  buttons?: Keyboard[number];
}

export type ReportSectionFn = (ctx: ReportContext) => Promise<ReportSection | null>;

const count = sql<number>`count(*)::int`;

/** 昨天发出的帖子、回复，失败的 */
const publishedSection: ReportSectionFn = async ({ userId, from, to }) => {
  const db = await getDb();
  const inRange = (col: typeof schema.posts.publishedAt | typeof schema.posts.updatedAt) => and(gte(col, from), lt(col, to));
  const [[{ n: posted }], [{ n: auto }], [{ n: replied }], [{ n: failed }]] = await Promise.all([
    db.select({ n: count }).from(schema.posts).where(and(eq(schema.posts.userId, userId), eq(schema.posts.status, "published"), inRange(schema.posts.publishedAt))),
    db
      .select({ n: count })
      .from(schema.autoPosts)
      .innerJoin(schema.posts, eq(schema.posts.id, schema.autoPosts.postId))
      .where(and(eq(schema.autoPosts.userId, userId), eq(schema.posts.status, "published"), inRange(schema.posts.publishedAt))),
    db
      .select({ n: count })
      .from(schema.replyItems)
      .where(and(eq(schema.replyItems.userId, userId), eq(schema.replyItems.status, "sent"), gte(schema.replyItems.updatedAt, from), lt(schema.replyItems.updatedAt, to))),
    db.select({ n: count }).from(schema.posts).where(and(eq(schema.posts.userId, userId), eq(schema.posts.status, "failed"), inRange(schema.posts.updatedAt))),
  ]);
  const lines: string[] = [];
  lines.push(posted ? `✅ 发出 ${posted} 条帖子${auto ? `（其中自动发帖 ${auto} 条）` : ""}` : "✅ 没有发帖");
  if (replied) lines.push(`💬 发出 ${replied} 条回复`);
  if (failed) lines.push(`⚠️ ${failed} 条没发出去，可以在「📂 我的内容 → 定时」里重试`);
  return { lines, active: posted + replied + failed > 0 };
};

/** 现在等你处理的：自动发帖待确认、回复候选 */
const pendingSection: ReportSectionFn = async ({ userId, from, to }) => {
  const db = await getDb();
  const hasCandidates = ne(sql`jsonb_array_length(${schema.replyItems.candidates})`, 0);
  const [[{ n: review }], [{ n: newReplies }], [{ n: pendingReplies }]] = await Promise.all([
    db.select({ n: count }).from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, userId), eq(schema.autoPosts.status, "review"))),
    db
      .select({ n: count })
      .from(schema.replyItems)
      .where(and(eq(schema.replyItems.userId, userId), hasCandidates, gte(schema.replyItems.createdAt, from), lt(schema.replyItems.createdAt, to))),
    db
      .select({ n: count })
      .from(schema.replyItems)
      .where(and(eq(schema.replyItems.userId, userId), eq(schema.replyItems.status, "pending"), hasCandidates)),
  ]);
  const lines: string[] = [];
  const buttons: Keyboard[number] = [];
  if (review) {
    lines.push(`🤖 自动发帖有 ${review} 条等你确认`);
    buttons.push({ text: "🤖 去确认", callback_data: "au" });
  }
  if (newReplies || pendingReplies) {
    lines.push(`💬 新的回复候选 ${newReplies} 条${pendingReplies ? `，现在还有 ${pendingReplies} 条没处理` : ""}`);
    if (pendingReplies) buttons.push({ text: "💬 看回复", callback_data: "hm:replies" });
  }
  return { lines, active: review + newReplies + pendingReplies > 0, buttons };
};

/** 今天已经排好的定时 */
const todaySection: ReportSectionFn = async ({ userId, to }) => {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: count })
    .from(schema.posts)
    .where(and(eq(schema.posts.userId, userId), eq(schema.posts.status, "scheduled"), gte(schema.posts.scheduledAt, to), lt(schema.posts.scheduledAt, new Date(to.getTime() + 86400_000))));
  return n ? { lines: [`📅 今天排了 ${n} 条定时`], active: true } : null;
};

/** 昨天读到 1 天数据的帖子里，效果最好的一条 */
const perfSection: ReportSectionFn = async ({ userId, from, to }) => {
  const best = await bestOfRange(userId, from, to);
  if (!best) return null;
  const t = best.text.replace(/\s+/g, " ").trim();
  return {
    lines: [`📈 最近发的${best.count > 1 ? ` ${best.count} 条里` : ""}效果最好的：${t.length > 30 ? `${t.slice(0, 30)}…` : t}`, `   ${metricsLine(best.metrics)}`],
    active: true,
    buttons: [{ text: "📈 发帖效果", callback_data: "pf" }],
  };
};

/** 余额：只说「预计还能发约 N 条」，不说价格；快用完时提醒充值 */
export const LOW_POSTS = 20;
const balanceSection: ReportSectionFn = async ({ userId }) => {
  const left = await postsLeft(userId);
  if (left === null) return null;
  if (left <= 0) return { lines: ["", "🔴 余额用完了，充值后才能继续写和发"], active: false, buttons: [{ text: "➕ 充值", callback_data: "tu" }] };
  if (left <= LOW_POSTS) return { lines: ["", `🟡 预计还能发约 ${left} 条，快用完了，记得充值`], active: false, buttons: [{ text: "➕ 充值", callback_data: "tu" }] };
  return { lines: ["", `📝 预计还能发约 ${left} 条推文`], active: false };
};

/** 顾客日报的各块，按顺序显示。以后加新的一块（例如同行对比）就往这里加 */
export const REPORT_SECTIONS: ReportSectionFn[] = [publishedSection, perfSection, pendingSection, todaySection, balanceSection];

/** 生成这位顾客昨天的日报；昨天没事、也没有待处理的返回 null（不打扰） */
export async function customerReport(userId: string, now = new Date(), tz?: string): Promise<{ text: string; buttons: Keyboard; day: string } | null> {
  const zone = tz ?? (await getReportPrefs(userId)).tz;
  const { day, from, to } = yesterdayRange(now, zone);
  const ctx: ReportContext = { userId, tz: zone, from, to, now };
  const sections = (await Promise.all(REPORT_SECTIONS.map((f) => f(ctx).catch(() => null)))).filter((s): s is ReportSection => !!s);
  if (!sections.some((s) => s.active)) return null;
  const lines = [`📰 昨日小结（${mmdd(day)}）`, ""];
  for (const s of sections) lines.push(...s.lines);
  const row = sections.flatMap((s) => s.buttons ?? []);
  const buttons: Keyboard = [];
  for (let i = 0; i < row.length; i += 2) buttons.push(row.slice(i, i + 2));
  buttons.push([{ text: "⚙️ 日报设置", callback_data: "rp:menu" }]);
  return { text: lines.join("\n"), buttons, day };
}

// ---------- 经营日报（给平台方） ----------

export interface AdminReportConfig {
  enabled: boolean;
  hour: number;
  tz: string;
  lastSentDay?: string | null;
}

export const DEFAULT_ADMIN_REPORT: AdminReportConfig = { enabled: true, hour: 9, tz: DEFAULT_TZ, lastSentDay: null };
const ADMIN_KEY = "admin_report";

export async function getAdminReportConfig(): Promise<AdminReportConfig> {
  return { ...DEFAULT_ADMIN_REPORT, ...((await getSetting<Partial<AdminReportConfig>>(ADMIN_KEY)) ?? {}) };
}

export async function saveAdminReportConfig(patch: Partial<AdminReportConfig>) {
  const cur = await getAdminReportConfig();
  const next = { ...cur, ...patch };
  if (!validTz(next.tz)) next.tz = cur.tz;
  await setSetting(ADMIN_KEY, next);
  return next;
}

export interface BusinessStats {
  day: string;
  tz: string;
  signups: number;
  boundTg: number;
  firstTopups: number;
  topupCount: number;
  topupMicro: number;
  /** 用户用掉的（扣费减退回），含赠送额度 */
  spentMicro: number;
  /** 发出去的签到 / 邀请 / 新人赠送 */
  bonusMicro: number;
  activeUsers: number;
  postsPublished: number;
  usage: UsageTotals;
  grossMicro: number;
}

/** 昨天（tz）的经营数字；管理员自己的账号不算 */
export async function businessStats(now = new Date(), tz = DEFAULT_TZ): Promise<BusinessStats> {
  const db = await getDb();
  const { day, from, to } = yesterdayRange(now, tz);
  const admins = await adminUserIds();
  const notAdmin = (col: AnyColumn) => (admins.length ? notInArray(col, admins) : undefined);
  const L = schema.ledger;
  const inDay = and(gte(L.createdAt, from), lt(L.createdAt, to), notAdmin(L.userId));
  const [[signup], [bound], [money], [first], [posts], usage] = await Promise.all([
    db.select({ n: count }).from(schema.users).where(and(gte(schema.users.createdAt, from), lt(schema.users.createdAt, to), notAdmin(schema.users.id))),
    db
      .select({ n: count })
      .from(schema.tgBindings)
      .where(and(isNotNull(schema.tgBindings.chatId), gte(schema.tgBindings.boundAt, from), lt(schema.tgBindings.boundAt, to), notAdmin(schema.tgBindings.userId))),
    db
      .select({
        topups: sql<number>`count(*) filter (where ${L.kind} = 'topup')::int`,
        topupMicro: sql<string>`coalesce(sum(${L.amountMicro}) filter (where ${L.kind} = 'topup'), 0)`,
        spent: sql<string>`coalesce(-sum(${L.amountMicro}) filter (where ${L.kind} in ('charge', 'refund')), 0)`,
        bonus: sql<string>`coalesce(sum(${L.amountMicro}) filter (where ${L.kind} = 'bonus' and ${L.amountMicro} > 0), 0)`,
        active: sql<number>`count(distinct ${L.userId}) filter (where ${L.kind} = 'charge')::int`,
      })
      .from(L)
      .where(inDay),
    // 首充：昨天充值、而且之前没充过
    db
      .select({ n: sql<number>`count(distinct ${L.userId})::int` })
      .from(L)
      .where(
        and(
          eq(L.kind, "topup"),
          inDay,
          sql`not exists (select 1 from ${L} as earlier where earlier.user_id = ${L.userId} and earlier.kind = 'topup' and earlier.created_at < ${from.toISOString()}::timestamptz)`,
        ),
      ),
    db.select({ n: count }).from(schema.posts).where(and(eq(schema.posts.status, "published"), gte(schema.posts.publishedAt, from), lt(schema.posts.publishedAt, to))),
    usageBetween(from, to),
  ]);
  const spentMicro = Number(money?.spent ?? 0);
  return {
    day,
    tz,
    signups: signup?.n ?? 0,
    boundTg: bound?.n ?? 0,
    firstTopups: first?.n ?? 0,
    topupCount: money?.topups ?? 0,
    topupMicro: Number(money?.topupMicro ?? 0),
    spentMicro,
    bonusMicro: Number(money?.bonus ?? 0),
    activeUsers: money?.active ?? 0,
    postsPublished: posts?.n ?? 0,
    usage,
    grossMicro: spentMicro - usage.costMicro,
  };
}

const u = (m: number) => fmtUsdt(m);
const pctText = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "-");

export async function adminReportText(now = new Date(), tz = DEFAULT_TZ): Promise<string> {
  const s = await businessStats(now, tz);
  const f = await funnel(7, await adminUserIds());
  const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : String(n));
  return [
    `📊 经营日报（${mmdd(s.day)}，${tzLabel(tz)}）`,
    "",
    `👤 新注册 ${s.signups} 人 · 绑 TG ${s.boundTg} 人`,
    `💳 首充 ${s.firstTopups} 人 · 充值 ${s.topupCount} 笔，共 ${u(s.topupMicro)} USDT`,
    `🔥 ${s.activeUsers} 人在用，用掉 ${u(s.spentMicro)} USDT（含赠送额度）· 发出 ${s.postsPublished} 条`,
    `🎁 送出 ${u(s.bonusMicro)} USDT（签到、邀请、新人）`,
    "",
    `🤖 AI 成本 ${u(s.usage.ai.costMicro)}（${s.usage.ai.calls} 次，输入 ${k(s.usage.ai.input + s.usage.ai.cache_read + s.usage.ai.cache_write)} / 输出 ${k(s.usage.ai.output)} token）`,
    `🐦 X 成本 ${u(s.usage.x.costMicro)}（发 ${s.usage.x.post} 条，读 ${s.usage.x.read} 条）`,
    `💰 毛利 ${u(s.grossMicro)} USDT（毛利率 ${pctText(s.grossMicro, s.spentMicro)}）`,
    "",
    `近 7 天：注册 ${f.signups} → 绑 TG ${f.boundTg} → 用过 ${f.used} → 首充 ${f.firstTopup} → 复充 ${f.repeat}`,
    await backupReportLine(now).catch(() => "🗄 数据库备份：状态读取失败"),
    "成本单价在后台「日报」里改；X 的单价请按开发者后台账单核对。",
  ].join("\n");
}

// ---------- 定时发送 ----------

const g = globalThis as unknown as { __vdReportCheck?: number };
const CHECK_MS = 5 * 60_000;
const SEND_WINDOW_HOURS = 4;

/**
 * 调度器每轮调一次，最多每 5 分钟真正检查一次：
 * 到了各人设定的钟点（之后 4 小时内都算，服务重启也不会漏）、今天还没发过的，发一份。
 */
export async function runDailyReports(now = new Date(), force = false): Promise<{ customers: number; admin: boolean }> {
  if (!force && g.__vdReportCheck && now.getTime() - g.__vdReportCheck < CHECK_MS) return { customers: 0, admin: false };
  g.__vdReportCheck = now.getTime();
  const db = await getDb();
  const rows = await db
    .select({
      userId: schema.tgBindings.userId,
      chatId: schema.tgBindings.chatId,
      enabled: schema.dailyReportSettings.enabled,
      hour: schema.dailyReportSettings.hour,
      tz: schema.dailyReportSettings.tz,
      last: schema.dailyReportSettings.lastSentDay,
      apTz: schema.autopilotSettings.tz,
    })
    .from(schema.tgBindings)
    .leftJoin(schema.dailyReportSettings, eq(schema.dailyReportSettings.userId, schema.tgBindings.userId))
    .leftJoin(schema.autopilotSettings, eq(schema.autopilotSettings.userId, schema.tgBindings.userId))
    .where(isNotNull(schema.tgBindings.chatId));
  let customers = 0;
  for (const r of rows) {
    if (r.enabled === false || !r.chatId) continue;
    const tz = r.tz ?? (r.apTz && validTz(r.apTz) ? r.apTz : DEFAULT_TZ);
    const { day, hour } = localDayHour(now, tz);
    const at = r.hour ?? 9;
    // 只在设定钟点后的 4 小时内发：服务停了大半天再起来，不会半夜给人补发早报
    if (hour < at || hour >= at + SEND_WINDOW_HOURS || r.last === day) continue;
    // 先记下「今天发过了」，发失败也不重试，免得刷屏
    await db
      .insert(schema.dailyReportSettings)
      .values({ userId: r.userId, enabled: true, hour: r.hour ?? 9, tz, lastSentDay: day })
      .onConflictDoUpdate({ target: schema.dailyReportSettings.userId, set: { lastSentDay: day } });
    try {
      const rep = await customerReport(r.userId, now, tz);
      if (!rep) continue;
      await sendMessage(r.chatId, rep.text, { buttons: rep.buttons });
      customers++;
    } catch (e) {
      console.error("[daily-report] 顾客日报发送失败", e instanceof Error ? e.message : e);
    }
  }
  const admin = await maybeSendAdminReport(now);
  return { customers, admin };
}

async function maybeSendAdminReport(now: Date): Promise<boolean> {
  const cfg = await getAdminReportConfig();
  if (!cfg.enabled) return false;
  const { day, hour } = localDayHour(now, cfg.tz);
  if (hour < cfg.hour || cfg.lastSentDay === day) return false;
  await saveAdminReportConfig({ lastSentDay: day });
  return (await sendAdminReport(now, cfg.tz)) > 0;
}

/** 把经营日报发到所有管理员绑定的 TG；返回发了几个人 */
export async function sendAdminReport(now = new Date(), tz?: string): Promise<number> {
  const zone = tz ?? (await getAdminReportConfig()).tz;
  const admins = await adminUserIds();
  if (!admins.length) return 0;
  const db = await getDb();
  const chats = await db
    .select({ chatId: schema.tgBindings.chatId })
    .from(schema.tgBindings)
    .where(and(inArray(schema.tgBindings.userId, admins), isNotNull(schema.tgBindings.chatId), gt(sql`length(${schema.tgBindings.chatId})`, 0)));
  if (!chats.length) return 0;
  const text = await adminReportText(now, zone);
  let sent = 0;
  for (const c of chats) {
    try {
      await sendMessage(c.chatId!, text);
      sent++;
    } catch (e) {
      console.error("[daily-report] 经营日报发送失败", e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// ---------- 机器人里的设置 ----------

export function prefsCard(p: ReportPrefs): { text: string; buttons: Keyboard } {
  const text = [
    "📰 每日日报",
    p.enabled ? `已开启：每天 ${p.hour} 点（${tzLabel(p.tz)}）发一份昨天的小结。` : "已关闭。",
    "内容：昨天发了几条、等你确认的、新的回复候选、预计还能发多少条。昨天没动静就不发。",
  ].join("\n");
  const buttons: Keyboard = [
    [{ text: p.enabled ? "🔕 关闭日报" : "🔔 开启日报", callback_data: `rp:on:${p.enabled ? 0 : 1}` }],
    HOUR_CHOICES.slice(0, 3).map((h) => ({ text: `${h === p.hour ? "● " : ""}${h} 点`, callback_data: `rp:h:${h}` })),
    HOUR_CHOICES.slice(3).map((h) => ({ text: `${h === p.hour ? "● " : ""}${h} 点`, callback_data: `rp:h:${h}` })),
    [{ text: `🌏 时区：${tzLabel(p.tz)}`, callback_data: "rp:tz" }],
    [{ text: "↩️ 返回", callback_data: "hm:more" }],
  ];
  return { text, buttons };
}

export function tzCard(p: ReportPrefs): { text: string; buttons: Keyboard } {
  const buttons: Keyboard = [];
  for (let i = 0; i < TZ_CHOICES.length; i += 2) {
    buttons.push(TZ_CHOICES.slice(i, i + 2).map((t, j) => ({ text: `${t.tz === p.tz ? "● " : ""}${t.label}`, callback_data: `rp:z:${i + j}` })));
  }
  buttons.push([{ text: "↩️ 返回", callback_data: "rp:m" }]);
  return { text: "🌏 选日报用的时区", buttons };
}
