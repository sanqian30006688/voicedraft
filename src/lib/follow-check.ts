import "server-only";
import { and, desc, eq, gt, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { charge, getBalance, getConfig, isBillable, refund, requireBalance, reserve, toMicro, UsageLimitError } from "./billing";
import { diffScan, isKeepInfo, readLimit, toCsv } from "./follow-check-core";
import { PublishError } from "./publish";
import { fmtWait, hit } from "./rate-limit";
import { fetchFollowList, getAccount, getPublicMetrics, hasScope, unfollowUser, XApiError, type XAccount } from "./x";

/**
 * 互关检测：用 X 官方接口读本人的「关注」和「粉丝」两个列表，算出
 * - 未回关：我关注了、对方没关注我；
 * - 取关了我：上次扫描还是粉丝、这次不是了。
 *
 * 取关只能用户自己一个一个点（每点一次取关一个人），每天最多 UNFOLLOW_DAILY_CAP 个，两次之间至少隔几秒。
 * 没有「一键全部取关」，也不会自动取关：X 的规则不允许批量 / 自动取关，号容易被限制。
 *
 * 扣费：X 按读到的人数收费，扫描前先告诉用户大约要读多少人、扣多少；确认后先按估算扣下，读完多退少补，失败全退。
 * 取关一次也是先扣、失败退回。
 */

/** 每天最多取关几个（滚动 24 小时） */
export const UNFOLLOW_DAILY_CAP = 50;
/** 两次取关至少隔几秒 */
const UNFOLLOW_GAP_MS = 3_000;
/** X 限制每 15 分钟最多读 15 页（每页 1000 人），一次扫描每个列表最多读这么多 */
export const MAX_LIST = 15_000;
/** 两次扫描至少隔多久（结果在 X 那边 24 小时内是一样的，没必要反复扫） */
const SCAN_GAP_MS = 10 * 60_000;
/** 估算多久内有效：超过就重新读一次关注数 / 粉丝数 */
const EST_TTL_MS = 30 * 60_000;

export const FOLLOW_SCOPE_MESSAGE = "互关检测要多授权一项「读取关注和粉丝」，请重新连接一次 X（点「🔑 重新连接」，在 X 页面上点授权就行）。";

export class FollowCheckError extends Error {}

export type Tab = "nofollow" | "lost" | "ignored";

async function account(userId: string): Promise<XAccount> {
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号");
  if (acc.authError) throw new PublishError("X 授权已失效，请重新连接");
  if (!hasScope(acc, "follows.read")) throw new FollowCheckError(FOLLOW_SCOPE_MESSAGE);
  return acc;
}

export interface Estimate {
  following: number;
  followers: number;
  /** 要读的总人数 */
  people: number;
  /** 预计扣多少（微 USDT）；不扣费的人是 0 */
  costMicro: number;
  balanceMicro: number;
  /** 余额够不够 */
  enough: boolean;
  /** 太大了，暂时扫不了 */
  tooBig: boolean;
}

/** 扫描前：读一下关注数和粉丝数，算出这次要读多少人、预计扣多少 */
export async function estimateScan(userId: string): Promise<Estimate> {
  const acc = await account(userId);
  // 读关注数本身也要 X 收一次费：余额低于停用线的不读，也防止反复点
  await requireBalance(userId, { follow_read: 1 });
  const r = hit(`fc:est:${userId}`, 5, 10 * 60_000);
  if (!r.ok) throw new UsageLimitError(`点得太频繁了，请 ${fmtWait(r.retryAfterMs)}后再试。`);
  const m = await getPublicMetrics(acc);
  const db = await getDb();
  await db
    .insert(schema.followScans)
    .values({ userId, estFollowing: m.following, estFollowers: m.followers, estAt: new Date() })
    .onConflictDoUpdate({ target: schema.followScans.userId, set: { estFollowing: m.following, estFollowers: m.followers, estAt: new Date() } });
  return estimateOf(userId, m.following, m.followers);
}

async function estimateOf(userId: string, following: number, followers: number): Promise<Estimate> {
  const cfg = await getConfig();
  const people = following + followers;
  const billable = await isBillable(userId);
  const costMicro = billable ? toMicro(cfg.prices.follow_read ?? 0) * people : 0;
  const balanceMicro = await getBalance(userId);
  return {
    following,
    followers,
    people,
    costMicro,
    balanceMicro,
    enough: costMicro === 0 || balanceMicro >= costMicro,
    tooBig: following > MAX_LIST || followers > MAX_LIST,
  };
}

export interface ScanResult {
  following: number;
  followers: number;
  noFollowBack: number;
  lost: number;
  /** 这次新发现的取关了我 */
  newlyLost: number;
  first: boolean;
}

const scanning = ((globalThis as { __vdFollowScanning?: Set<string> }).__vdFollowScanning ??= new Set<string>());

/** 用户确认后扫描一次：先按估算扣钱，读两个列表，和上次比，存下结果；读完多退少补，出错全退 */
export async function runScan(userId: string): Promise<ScanResult> {
  if (scanning.has(userId)) throw new UsageLimitError("正在扫描中，请稍等");
  scanning.add(userId);
  try {
    return await scanLocked(userId);
  } finally {
    scanning.delete(userId);
  }
}

async function scanLocked(userId: string): Promise<ScanResult> {
  const acc = await account(userId);
  const db = await getDb();
  const [row] = await db.select().from(schema.followScans).where(eq(schema.followScans.userId, userId)).limit(1);
  if (row?.scannedAt && row.ownXUserId === acc.xUserId && Date.now() - row.scannedAt.getTime() < SCAN_GAP_MS) {
    throw new UsageLimitError(`刚扫描过，请 ${fmtWait(SCAN_GAP_MS - (Date.now() - row.scannedAt.getTime()))}后再扫。`);
  }
  // 估算过期了就重新读一次关注数 / 粉丝数（用户要先看到估算才能点确认，这里只是兜底）
  let estF = row?.estFollowing ?? null;
  let estR = row?.estFollowers ?? null;
  if (estF == null || estR == null || !row?.estAt || Date.now() - row.estAt.getTime() > EST_TTL_MS) {
    const e = await estimateScan(userId);
    estF = e.following;
    estR = e.followers;
  }
  if (estF > MAX_LIST || estR > MAX_LIST) {
    throw new FollowCheckError(`关注或粉丝超过 ${MAX_LIST} 人，暂时扫不了（X 限制每 15 分钟最多读这么多）。`);
  }
  const estimate = estF + estR;
  const limF = Math.min(MAX_LIST, readLimit(estF));
  const limR = Math.min(MAX_LIST, readLimit(estR));

  // 先扣钱再调 X：余额不够直接拦下，一个人都不读
  const hold = estimate > 0 ? await reserve(userId, { follow_read: estimate }, undefined, "互关检测") : null;
  let following, followers;
  try {
    following = await fetchFollowList(acc, "following", limF);
    followers = await fetchFollowList(acc, "followers", limR);
  } catch (e) {
    await refund(hold);
    if (e instanceof XApiError && e.kind === "forbidden") throw new FollowCheckError(FOLLOW_SCOPE_MESSAGE);
    throw e;
  }
  const read = following.length + followers.length;
  if (hold && read < estimate) await refund(hold, { follow_read: estimate - read });
  // 扫描过程中多出来几个人：按实际读到的补扣（读取已经发生了）
  if (read > estimate) await charge(userId, "follow_read", read - estimate, undefined, "互关检测（补扣多读的人）");

  const now = new Date();
  const prev = await db
    .select({
      targetId: schema.followPeople.targetId,
      followsMe: schema.followPeople.followsMe,
      lostAt: schema.followPeople.lostAt,
      ignored: schema.followPeople.ignored,
      unfollowedAt: schema.followPeople.unfollowedAt,
    })
    .from(schema.followPeople)
    .where(and(eq(schema.followPeople.userId, userId), eq(schema.followPeople.ownXUserId, acc.xUserId)));
  const first = !(row?.scannedAt && row.ownXUserId === acc.xUserId);
  const diff = diffScan(following, followers, first ? [] : prev, now);

  await db.transaction(async (tx) => {
    // 换了 X 账号：旧账号的结果不要了
    await tx.delete(schema.followPeople).where(and(eq(schema.followPeople.userId, userId), sql`${schema.followPeople.ownXUserId} <> ${acc.xUserId}`));
    if (first && prev.length) {
      await tx.delete(schema.followPeople).where(eq(schema.followPeople.userId, userId));
    }
    if (diff.remove.length) {
      for (let i = 0; i < diff.remove.length; i += 1000) {
        await tx
          .delete(schema.followPeople)
          .where(
            and(
              eq(schema.followPeople.userId, userId),
              eq(schema.followPeople.ownXUserId, acc.xUserId),
              inArray(schema.followPeople.targetId, diff.remove.slice(i, i + 1000)),
            ),
          );
      }
    }
    const full = diff.upsert.filter((r) => !isKeepInfo(r));
    const keep = diff.upsert.filter(isKeepInfo);
    for (let i = 0; i < full.length; i += 500) {
      await tx
        .insert(schema.followPeople)
        .values(
          full.slice(i, i + 500).map((r) => ({
            userId,
            ownXUserId: acc.xUserId,
            targetId: r.id,
            handle: r.handle,
            name: r.name,
            verifiedType: r.verifiedType,
            followers: r.followers,
            following: r.following,
            iFollow: r.iFollow,
            followsMe: r.followsMe,
            lostAt: r.lostAt,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.followPeople.userId, schema.followPeople.ownXUserId, schema.followPeople.targetId],
          set: {
            handle: sql`excluded.handle`,
            name: sql`excluded.name`,
            verifiedType: sql`excluded.verified_type`,
            followers: sql`excluded.followers`,
            following: sql`excluded.following`,
            iFollow: sql`excluded.i_follow`,
            followsMe: sql`excluded.follows_me`,
            lostAt: sql`excluded.lost_at`,
            updatedAt: now,
          },
        });
    }
    for (const r of keep) {
      await tx
        .update(schema.followPeople)
        .set({ iFollow: false, followsMe: false, lostAt: r.lostAt, updatedAt: now })
        .where(and(eq(schema.followPeople.userId, userId), eq(schema.followPeople.ownXUserId, acc.xUserId), eq(schema.followPeople.targetId, r.id)));
    }
    await tx
      .insert(schema.followScans)
      .values({ userId, ownXUserId: acc.xUserId, scannedAt: now, followingCount: following.length, followersCount: followers.length })
      .onConflictDoUpdate({
        target: schema.followScans.userId,
        set: { ownXUserId: acc.xUserId, scannedAt: now, followingCount: following.length, followersCount: followers.length, estAt: null },
      });
  });
  const s = await summary(userId);
  return { following: following.length, followers: followers.length, noFollowBack: s.noFollowBack, lost: s.lost, newlyLost: diff.newlyLost, first };
}

export interface Summary {
  scannedAt: Date | null;
  following: number;
  followers: number;
  noFollowBack: number;
  lost: number;
  ignored: number;
  unfollowedToday: number;
  unfollowLeft: number;
  /** 需要重新连接 X 才能用 */
  needsScope: boolean;
  connected: boolean;
}

function tabWhere(userId: string, xUserId: string, tab: Tab): SQL {
  const own = and(eq(schema.followPeople.userId, userId), eq(schema.followPeople.ownXUserId, xUserId))!;
  if (tab === "ignored") return and(own, eq(schema.followPeople.ignored, true))!;
  if (tab === "lost") return and(own, eq(schema.followPeople.ignored, false), isNotNull(schema.followPeople.lostAt))!;
  return and(own, eq(schema.followPeople.ignored, false), eq(schema.followPeople.iFollow, true), eq(schema.followPeople.followsMe, false))!;
}

async function unfollowedToday(userId: string): Promise<number> {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.followPeople)
    .where(and(eq(schema.followPeople.userId, userId), gt(schema.followPeople.unfollowedAt, new Date(Date.now() - 24 * 3600_000))));
  return n;
}

export async function summary(userId: string): Promise<Summary> {
  const acc = await getAccount(userId);
  const db = await getDb();
  const [row] = await db.select().from(schema.followScans).where(eq(schema.followScans.userId, userId)).limit(1);
  const today = await unfollowedToday(userId);
  const base = { unfollowedToday: today, unfollowLeft: Math.max(0, UNFOLLOW_DAILY_CAP - today) };
  if (!acc) return { scannedAt: null, following: 0, followers: 0, noFollowBack: 0, lost: 0, ignored: 0, needsScope: false, connected: false, ...base };
  const count = async (tab: Tab) => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.followPeople).where(tabWhere(userId, acc.xUserId, tab));
    return n;
  };
  const same = row?.ownXUserId === acc.xUserId;
  return {
    scannedAt: same ? (row?.scannedAt ?? null) : null,
    following: same ? (row?.followingCount ?? 0) : 0,
    followers: same ? (row?.followersCount ?? 0) : 0,
    noFollowBack: await count("nofollow"),
    lost: await count("lost"),
    ignored: await count("ignored"),
    needsScope: !hasScope(acc, "follows.read"),
    connected: true,
    ...base,
  };
}

export interface PersonRow {
  targetId: string;
  handle: string;
  name: string | null;
  verifiedType: string | null;
  followers: number;
  following: number;
  iFollow: boolean;
  followsMe: boolean;
  lostAt: Date | null;
  ignored: boolean;
}

export interface ListOpts {
  tab: Tab;
  blueOnly?: boolean;
  q?: string;
  page?: number;
  size?: number;
}

/** 名单：未回关按对方粉丝数从多到少，取关了我按发现时间从新到旧 */
export async function listPeople(userId: string, o: ListOpts): Promise<{ rows: PersonRow[]; total: number; page: number; pages: number }> {
  const acc = await getAccount(userId);
  if (!acc) return { rows: [], total: 0, page: 0, pages: 0 };
  const db = await getDb();
  const size = Math.max(1, Math.min(200, o.size ?? 10));
  const conds: SQL[] = [tabWhere(userId, acc.xUserId, o.tab)];
  if (o.blueOnly) conds.push(isNotNull(schema.followPeople.verifiedType));
  const q = o.q?.trim().replace(/^@/, "");
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(schema.followPeople.handle, like), ilike(schema.followPeople.name, like))!);
  }
  const where = and(...conds);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.followPeople).where(where);
  const pages = Math.max(1, Math.ceil(n / size));
  const page = Math.max(0, Math.min(pages - 1, o.page ?? 0));
  const rows = await db
    .select({
      targetId: schema.followPeople.targetId,
      handle: schema.followPeople.handle,
      name: schema.followPeople.name,
      verifiedType: schema.followPeople.verifiedType,
      followers: schema.followPeople.followers,
      following: schema.followPeople.following,
      iFollow: schema.followPeople.iFollow,
      followsMe: schema.followPeople.followsMe,
      lostAt: schema.followPeople.lostAt,
      ignored: schema.followPeople.ignored,
    })
    .from(schema.followPeople)
    .where(where)
    .orderBy(...(o.tab === "lost" ? [desc(schema.followPeople.lostAt)] : [desc(schema.followPeople.followers)]), schema.followPeople.handle)
    .limit(size)
    .offset(page * size);
  return { rows, total: n, page, pages };
}

/** 忽略（不再出现在名单里）或恢复 */
export async function setIgnored(userId: string, targetId: string, ignored: boolean): Promise<boolean> {
  const acc = await getAccount(userId);
  if (!acc) return false;
  const db = await getDb();
  const r = await db
    .update(schema.followPeople)
    .set({ ignored, updatedAt: new Date() })
    .where(and(eq(schema.followPeople.userId, userId), eq(schema.followPeople.ownXUserId, acc.xUserId), eq(schema.followPeople.targetId, targetId)))
    .returning({ id: schema.followPeople.targetId });
  return r.length > 0;
}

/**
 * 取关一个人：只能取关名单里、自己正在关注的人。用户每点一次只取关这一个。
 * 每天最多 UNFOLLOW_DAILY_CAP 个、两次至少隔几秒；先扣钱，X 报错就退回。
 */
export async function unfollowOne(userId: string, targetId: string): Promise<PersonRow> {
  const acc = await account(userId);
  if (!hasScope(acc, "follows.write")) throw new FollowCheckError(FOLLOW_SCOPE_MESSAGE);
  const db = await getDb();
  const [p] = await db
    .select()
    .from(schema.followPeople)
    .where(and(eq(schema.followPeople.userId, userId), eq(schema.followPeople.ownXUserId, acc.xUserId), eq(schema.followPeople.targetId, targetId)))
    .limit(1);
  if (!p) throw new FollowCheckError("名单里没有这个人，请重新扫描一次");
  if (!p.iFollow) throw new FollowCheckError(`你已经没有关注 @${p.handle} 了`);
  if ((await unfollowedToday(userId)) >= UNFOLLOW_DAILY_CAP) {
    throw new UsageLimitError(`今天已经取关 ${UNFOLLOW_DAILY_CAP} 个了，明天再继续。一天取关太多，X 可能会限制你的账号。`);
  }
  const r = hit(`fc:uf:${userId}`, 1, UNFOLLOW_GAP_MS);
  if (!r.ok) throw new UsageLimitError(`慢一点，${fmtWait(r.retryAfterMs)}后再点下一个。`);
  // 先把这一行标成「已取关」占住名额（同时点很多下也不会超过每天上限），失败再改回去
  const now = new Date();
  const claimed = await db
    .update(schema.followPeople)
    .set({ iFollow: false, unfollowedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.followPeople.userId, userId),
        eq(schema.followPeople.ownXUserId, acc.xUserId),
        eq(schema.followPeople.targetId, targetId),
        eq(schema.followPeople.iFollow, true),
      ),
    )
    .returning({ id: schema.followPeople.targetId });
  if (!claimed.length) throw new FollowCheckError(`你已经没有关注 @${p.handle} 了`);
  let hold = null;
  try {
    hold = await reserve(userId, { unfollow: 1 }, targetId, `取关 @${p.handle}`);
    await unfollowUser(acc, targetId);
  } catch (e) {
    await refund(hold);
    if (e instanceof XApiError && e.kind === "not_found") {
      // 对方账号没了：当作已经不关注，不收钱
      return { ...p, iFollow: false };
    }
    await db
      .update(schema.followPeople)
      .set({ iFollow: true, unfollowedAt: p.unfollowedAt, updatedAt: new Date() })
      .where(and(eq(schema.followPeople.userId, userId), eq(schema.followPeople.ownXUserId, acc.xUserId), eq(schema.followPeople.targetId, targetId)));
    if (e instanceof XApiError && e.kind === "forbidden") throw new FollowCheckError(`X 拒绝了这次取关：${e.message}`);
    throw e;
  }
  return { ...p, iFollow: false };
}

const STATUS: Record<Tab, string> = { nofollow: "未回关", lost: "取关了我", ignored: "已忽略" };

/** 导出名单（CSV）：tab 不传时导出未回关 + 取关了我 */
export async function exportCsv(userId: string, tab?: Tab): Promise<string> {
  const tabs: Tab[] = tab ? [tab] : ["nofollow", "lost"];
  const rows: Parameters<typeof toCsv>[0] = [];
  for (const t of tabs) {
    const r = await listPeople(userId, { tab: t, size: 200, page: 0 });
    for (let page = 0; page < r.pages; page++) {
      const part = page === 0 ? r : await listPeople(userId, { tab: t, size: 200, page });
      for (const p of part.rows) rows.push({ ...p, status: STATUS[t] });
    }
  }
  return toCsv(rows);
}
