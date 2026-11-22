import "server-only";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TweetMetrics } from "@/db/schema";
import { hasLink } from "./billing";
import { getReportPrefs } from "./daily-report";
import { D1_MS, D7_MS, INSIGHT_DAYS, bestHour, engagement, hourIn, insights, type Insights, type PerfRow, type PostKind } from "./post-metrics-core";
import { weightedLength } from "./text";
import { getAccount, getTweetMetrics, XApiError } from "./x";

/**
 * 发帖效果：帖子发出 1 天、7 天后各读一次 X 上的数据，算出哪类内容、什么时间发效果最好。
 * 只读客户本人发出的帖子（官方接口 GET /tweets?ids=，一次 100 条），费用平台承担，不向客户收费。
 */

/** 一轮最多读多少条帖子的数据（一次请求 100 条） */
const PER_TICK = 300;
/** 两轮之间至少隔多久 */
const EVERY_MS = 30 * 60_000;
/** 发出超过这么久还没读到 7 天数据的，不再补读 */
const GIVE_UP_MS = 14 * 24 * 3600_000;

const g = globalThis as unknown as { __vdPerfAt?: number };

function kindOf(p: { tweets: string[]; quoteTweetId: string | null; auto: boolean; draftMode: string | null }): PostKind {
  if (p.auto) return "auto";
  if (p.quoteTweetId) return "quote";
  if (p.tweets.length > 1) return "thread";
  if (hasLink(p.tweets[0] ?? "")) return "link";
  if (p.draftMode === "single" || !weightedLength(p.tweets[0] ?? "").valid) return "long";
  return "short";
}

/** 定时任务：到了 1 天 / 7 天的帖子读一次数据。返回读了几条 */
export async function collectPostMetrics(now = new Date(), force = false): Promise<number> {
  if (!force && g.__vdPerfAt && now.getTime() - g.__vdPerfAt < EVERY_MS) return 0;
  g.__vdPerfAt = now.getTime();
  const db = await getDb();
  const d1Due = new Date(now.getTime() - D1_MS);
  const d7Due = new Date(now.getTime() - D7_MS);
  const giveUp = new Date(now.getTime() - GIVE_UP_MS);
  const due = await db
    .select({
      postId: schema.posts.id,
      userId: schema.posts.userId,
      tweets: schema.posts.tweets,
      postIds: schema.posts.postIds,
      quoteTweetId: schema.posts.quoteTweetId,
      xUserId: schema.posts.xUserId,
      publishedAt: schema.posts.publishedAt,
      draftMode: schema.drafts.mode,
      auto: sql<boolean>`exists (select 1 from ${schema.autoPosts} ap where ap.post_id = ${schema.posts.id})`,
      metricId: schema.postMetrics.id,
    })
    .from(schema.posts)
    .leftJoin(schema.postMetrics, eq(schema.postMetrics.postId, schema.posts.id))
    .leftJoin(schema.drafts, eq(schema.drafts.id, schema.posts.draftId))
    .where(
      and(
        eq(schema.posts.status, "published"),
        sql`jsonb_array_length(${schema.posts.postIds}) > 0`,
        gte(schema.posts.publishedAt, giveUp),
        lte(schema.posts.publishedAt, d1Due),
        or(
          // 还没读过 1 天的（已经过了 7 天的直接读 7 天的）
          and(isNull(schema.postMetrics.d1At), isNull(schema.postMetrics.d7At)),
          and(isNull(schema.postMetrics.d7At), lte(schema.posts.publishedAt, d7Due)),
        ),
      ),
    )
    .orderBy(schema.posts.publishedAt)
    .limit(PER_TICK);

  const byUser = new Map<string, typeof due>();
  for (const r of due) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  let read = 0;
  for (const [userId, rows] of byUser) {
    const acc = await getAccount(userId);
    if (!acc || acc.authError) continue;
    // 只读还是用这个 X 账号发的帖子（换过账号的旧帖读不到）
    const mine = rows.filter((r) => !r.xUserId || r.xUserId === acc.xUserId);
    if (!mine.length) continue;
    let got: Map<string, TweetMetrics>;
    try {
      got = await getTweetMetrics(
        acc,
        mine.map((r) => r.postIds[0]),
      );
    } catch (e) {
      // 额度不够、限流等：这一轮跳过这位客户，下一轮再试
      if (!(e instanceof XApiError)) console.error("[post-metrics]", e);
      continue;
    }
    for (const r of mine) {
      const tweetId = r.postIds[0];
      const m = got.get(tweetId) ?? null;
      const stage7 = r.publishedAt! <= d7Due;
      const patch = stage7 ? { d7: m, d7At: now } : { d1: m, d1At: now };
      if (r.metricId) {
        await db.update(schema.postMetrics).set(patch).where(eq(schema.postMetrics.id, r.metricId));
      } else {
        await db
          .insert(schema.postMetrics)
          .values({
            userId,
            postId: r.postId,
            tweetId,
            kind: kindOf({ tweets: r.tweets, quoteTweetId: r.quoteTweetId, auto: r.auto, draftMode: r.draftMode }),
            publishedAt: r.publishedAt!,
            ...patch,
          })
          .onConflictDoUpdate({ target: schema.postMetrics.postId, set: patch });
      }
      read++;
    }
  }
  return read;
}

/** 这位客户最近 30 天的帖子数据 */
export async function perfRows(userId: string, now = new Date()): Promise<PerfRow[]> {
  const db = await getDb();
  const rows = await db
    .select({ m: schema.postMetrics, tweets: schema.posts.tweets })
    .from(schema.postMetrics)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.postMetrics.postId))
    .where(and(eq(schema.postMetrics.userId, userId), gte(schema.postMetrics.publishedAt, new Date(now.getTime() - INSIGHT_DAYS * 86400_000))))
    .orderBy(desc(schema.postMetrics.publishedAt))
    .limit(500);
  return rows.map(({ m, tweets }) => ({
    postId: m.postId,
    tweetId: m.tweetId,
    kind: m.kind as PostKind,
    text: tweets[0] ?? "",
    publishedAt: m.publishedAt,
    // 7 天的读过了就用 7 天的；7 天时读不到（删了）就不算
    metrics: m.d7At ? m.d7 : m.d1,
  }));
}

export async function myInsights(userId: string, now = new Date()): Promise<{ insights: Insights; tz: string }> {
  const { tz } = await getReportPrefs(userId);
  return { insights: insights(await perfRows(userId, now), tz), tz };
}

/** 下一个「最佳时间」（本地时间的整点）和按钮上显示的文字；数据不够时 null */
export async function nextBestTime(userId: string, now = new Date()): Promise<{ at: Date; label: string } | null> {
  const { insights: i, tz } = await myInsights(userId, now);
  if (!i.bestSlot) return null;
  const h = bestHour(i.bestSlot);
  // 从 10 分钟后的下一个整点起往后找，最多找 48 小时
  const start = new Date(Math.ceil((now.getTime() + 10 * 60_000) / 3600_000) * 3600_000);
  for (let k = 0; k < 48; k++) {
    const t = new Date(start.getTime() + k * 3600_000);
    if (hourIn(t, tz) !== h) continue;
    // 整点按当地时间对齐（半小时时区也对）
    const at = new Date(t.getTime() - (Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "numeric" }).format(t)) % 60) * 60_000);
    const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at) === new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    return { at, label: `${sameDay ? "今天" : "明天"} ${String(h).padStart(2, "0")}:00` };
  }
  return null;
}

/** 日报用：昨天这段时间里读到 1 天数据的帖子里，互动最好的一条 */
export async function bestOfRange(userId: string, from: Date, to: Date) {
  const db = await getDb();
  const rows = await db
    .select({ m: schema.postMetrics, tweets: schema.posts.tweets })
    .from(schema.postMetrics)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.postMetrics.postId))
    .where(and(eq(schema.postMetrics.userId, userId), gte(schema.postMetrics.d1At, from), sql`${schema.postMetrics.d1At} < ${to.toISOString()}`, sql`${schema.postMetrics.d1} is not null`));
  if (!rows.length) return null;
  rows.sort((a, b) => engagement(b.m.d1!) - engagement(a.m.d1!));
  return { text: rows[0].tweets[0] ?? "", metrics: rows[0].m.d1!, count: rows.length };
}

