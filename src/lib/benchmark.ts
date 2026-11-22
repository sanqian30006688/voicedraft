import "server-only";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  STALE_DAYS,
  WINDOW_DAYS,
  compare,
  computeStat,
  dayDiff,
  guessIndustry,
  type AccountStat,
  type BoardEntry,
  type Comparison,
  type Snapshot,
} from "./benchmark-core";
import { getActiveCard } from "./data";
import { getMemoryRow } from "./memory";
import { beijingDay } from "./rewards";
import { getAccount, getPublicMetrics, XApiError } from "./x";

/**
 * 推主数据：每天读一次客户自己 X 账号的公开数据，算涨粉、发帖频率，和同行业比。
 * 只读已连接的客户本人的账号（官方接口 GET /users/me），不读别人的、不抓取。费用平台承担。
 */

export type BenchmarkProfile = typeof schema.benchmarkProfiles.$inferSelect;

/** 按账号记忆和风格卡里的话题猜行业 */
async function autoIndustry(userId: string): Promise<string | null> {
  const [mem, card] = await Promise.all([getMemoryRow(userId), getActiveCard(userId)]);
  const texts: string[] = [];
  if (mem) texts.push(mem.memory.persona, ...mem.memory.topics, ...mem.memory.positions);
  if (card) texts.push(...card.traits.topics);
  return guessIndustry(texts);
}

/** 取个人设置；没有就建一个。行业还没定（或是自动判断的）时顺便重新猜一次 */
export async function getProfile(userId: string): Promise<BenchmarkProfile> {
  const db = await getDb();
  let [row] = await db.select().from(schema.benchmarkProfiles).where(eq(schema.benchmarkProfiles.userId, userId)).limit(1);
  if (!row) {
    [row] = await db
      .insert(schema.benchmarkProfiles)
      .values({ userId, industry: await autoIndustry(userId) })
      .onConflictDoNothing()
      .returning();
    if (!row) [row] = await db.select().from(schema.benchmarkProfiles).where(eq(schema.benchmarkProfiles.userId, userId)).limit(1);
  } else if (row.industrySource === "auto" && !row.industry) {
    const guess = await autoIndustry(userId);
    if (guess) {
      [row] = await db
        .update(schema.benchmarkProfiles)
        .set({ industry: guess, updatedAt: new Date() })
        .where(eq(schema.benchmarkProfiles.userId, userId))
        .returning();
    }
  }
  return row;
}

export async function updateProfile(
  userId: string,
  patch: { industry?: string; publicRank?: boolean; weeklyReport?: boolean },
): Promise<BenchmarkProfile> {
  const db = await getDb();
  await getProfile(userId);
  const set: Partial<typeof schema.benchmarkProfiles.$inferInsert> = { updatedAt: new Date() };
  if (patch.industry !== undefined) {
    set.industry = patch.industry;
    set.industrySource = "user";
  }
  if (patch.publicRank !== undefined) {
    set.publicRank = patch.publicRank;
    set.publicSince = patch.publicRank ? new Date() : null;
  }
  if (patch.weeklyReport !== undefined) set.weeklyReport = patch.weeklyReport;
  const [row] = await db.update(schema.benchmarkProfiles).set(set).where(eq(schema.benchmarkProfiles.userId, userId)).returning();
  return row;
}

// ---------- 每日快照 ----------

/**
 * 读一次今天的数据。今天已经有了、或今天已经试过（失败也算）就不再读，
 * 保证每个账号每天最多花一次读取费用。返回今天是否有数据。
 */
export async function takeSnapshot(userId: string, now = new Date()): Promise<boolean> {
  const db = await getDb();
  const today = beijingDay(now);
  const [have] = await db
    .select({ id: schema.xStatSnapshots.id })
    .from(schema.xStatSnapshots)
    .where(and(eq(schema.xStatSnapshots.userId, userId), eq(schema.xStatSnapshots.day, today)))
    .limit(1);
  if (have) return true;
  const acc = await getAccount(userId);
  if (!acc || acc.authError) return false;
  const profile = await getProfile(userId);
  if (profile.snapshotTriedDay === today) return false;
  // 先记下「今天试过」，再去读：并发或失败都不会重复花钱
  const claimed = await db
    .update(schema.benchmarkProfiles)
    .set({ snapshotTriedDay: today })
    .where(and(eq(schema.benchmarkProfiles.userId, userId), sql`${schema.benchmarkProfiles.snapshotTriedDay} is distinct from ${today}`))
    .returning({ userId: schema.benchmarkProfiles.userId });
  if (!claimed.length) return false;
  try {
    const m = await getPublicMetrics(acc);
    await db
      .insert(schema.xStatSnapshots)
      .values({ userId, xUserId: acc.xUserId, day: today, ...m })
      .onConflictDoNothing();
    return true;
  } catch (e) {
    console.error("[benchmark] 读取账号数据失败", e instanceof XApiError ? e.message : e);
    return false;
  }
}

/** 后台每轮：给今天还没读过数据的已连接账号各读一次（每轮最多 max 个） */
export async function snapshotDue(max = 10, now = new Date()): Promise<number> {
  const db = await getDb();
  const today = beijingDay(now);
  const rows = await db
    .select({ userId: schema.xAccounts.userId, tried: schema.benchmarkProfiles.snapshotTriedDay })
    .from(schema.xAccounts)
    .leftJoin(schema.benchmarkProfiles, eq(schema.benchmarkProfiles.userId, schema.xAccounts.userId))
    .where(isNull(schema.xAccounts.authError));
  const due = rows.filter((r) => r.tried !== today).slice(0, max);
  let n = 0;
  for (const r of due) if (await takeSnapshot(r.userId, now)) n++;
  return n;
}

// ---------- 统计 ----------

interface Loaded {
  userId: string;
  handle: string;
  industry: string | null;
  publicRank: boolean;
  stat: AccountStat;
}

/** 读所有（或指定的）客户最近的快照，算出各自的数据；数据太旧、或已断开 X 的不算 */
async function loadStats(now = new Date(), onlyUsers?: string[]): Promise<Loaded[]> {
  const db = await getDb();
  const since = beijingDay(now, -(WINDOW_DAYS + STALE_DAYS));
  const today = beijingDay(now);
  const snaps = await db
    .select()
    .from(schema.xStatSnapshots)
    .where(
      and(gte(schema.xStatSnapshots.day, since), onlyUsers ? inArray(schema.xStatSnapshots.userId, onlyUsers) : undefined),
    );
  if (!snaps.length) return [];
  const userIds = [...new Set(snaps.map((s) => s.userId))];
  const [accs, profiles] = await Promise.all([
    db
      .select({ userId: schema.xAccounts.userId, handle: schema.xAccounts.handle, xUserId: schema.xAccounts.xUserId })
      .from(schema.xAccounts)
      .where(inArray(schema.xAccounts.userId, userIds)),
    db.select().from(schema.benchmarkProfiles).where(inArray(schema.benchmarkProfiles.userId, userIds)),
  ]);
  const accOf = new Map(accs.map((a) => [a.userId, a]));
  const profOf = new Map(profiles.map((p) => [p.userId, p]));
  const byUser = new Map<string, Snapshot[]>();
  for (const s of snaps) {
    const acc = accOf.get(s.userId);
    // 只用现在绑定的 X 账号的数据
    if (!acc || acc.xUserId !== s.xUserId) continue;
    (byUser.get(s.userId) ?? byUser.set(s.userId, []).get(s.userId)!).push(s);
  }
  const out: Loaded[] = [];
  for (const [userId, list] of byUser) {
    const stat = computeStat(list);
    if (!stat || dayDiff(stat.day, today) > STALE_DAYS) continue;
    const p = profOf.get(userId);
    out.push({ userId, handle: accOf.get(userId)!.handle, industry: p?.industry ?? null, publicRank: p?.publicRank ?? false, stat });
  }
  return out;
}

/** 最近 7 天通过 VoiceDraft 发出的帖子数（自己库里的，不花钱） */
async function postsViaApp(userId: string, now = new Date()): Promise<number> {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.userId, userId),
        eq(schema.posts.status, "published"),
        gte(schema.posts.publishedAt, new Date(now.getTime() - WINDOW_DAYS * 86400_000)),
      ),
    );
  return n;
}

export interface MyBenchmark {
  handle: string;
  profile: BenchmarkProfile;
  stat: AccountStat | null;
  cmp: Comparison | null;
  viaApp: number;
}

/** 「我的数据」：自己的数字 + 同类（或全站）的中间水平和名次。别人是谁一律不给 */
export async function myBenchmark(userId: string, now = new Date(), fetchToday = true): Promise<MyBenchmark | null> {
  const acc = await getAccount(userId);
  if (!acc) return null;
  // 打开「我的数据」时今天还没读过就先读一次；周报不读（同一轮后台已经读过）
  if (fetchToday) await takeSnapshot(userId, now);
  const [profile, all, viaApp] = await Promise.all([getProfile(userId), loadStats(now), postsViaApp(userId, now)]);
  const me = all.find((x) => x.userId === userId) ?? null;
  return {
    handle: acc.handle,
    profile,
    stat: me?.stat ?? null,
    cmp: me ? compare(userId, profile.industry, all) : null,
    viaApp,
  };
}

/** 排行榜：只列本人开启了「公开上榜」的账号 */
export async function leaderboard(viewerId: string, industry?: string | null, now = new Date()): Promise<BoardEntry[]> {
  const all = await loadStats(now);
  return all
    .filter((x) => x.publicRank && (!industry || x.industry === industry))
    .map((x) => ({ handle: x.handle, industry: x.industry, stat: x.stat, mine: x.userId === viewerId }));
}

/** 本周该收周报的人：绑定了 TG、连接了 X、没关周报、这周还没发过 */
export async function dueReportUsers(slot: Date, max = 20): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ userId: schema.xAccounts.userId, on: schema.benchmarkProfiles.weeklyReport, last: schema.benchmarkProfiles.lastReportAt })
    .from(schema.xAccounts)
    .innerJoin(schema.tgBindings, eq(schema.tgBindings.userId, schema.xAccounts.userId))
    .leftJoin(schema.benchmarkProfiles, eq(schema.benchmarkProfiles.userId, schema.xAccounts.userId));
  return rows
    .filter((r) => r.on !== false && (!r.last || r.last < slot))
    .slice(0, max)
    .map((r) => r.userId);
}

export async function markReported(userId: string, at = new Date()) {
  const db = await getDb();
  await getProfile(userId);
  await db.update(schema.benchmarkProfiles).set({ lastReportAt: at }).where(eq(schema.benchmarkProfiles.userId, userId));
}
