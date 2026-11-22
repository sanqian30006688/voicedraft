import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  addBalanceTx,
  getConfig,
  getSetting,
  postUnitMicro,
  setSetting,
  toMicro,
  type BillingConfig,
  type Tx,
} from "./billing";

/**
 * 签到和邀请奖励：送的是「赠送额度」，不是钱。
 * - 加到余额里，同时记在 wallets.bonus_micro；扣费先扣它；最后一次拿到奖励后 N 天（默认 90）没用完的过期扣掉。
 * - 签到：每天一次（北京时间），连签满 N 天额外送一笔。没充过值的人奖励先进「存钱罐」，第一次充值到账后一起发，
 *   这样批量注册的小号签到拿不到任何东西。
 * - 邀请：好友注册时只记下是谁邀请的；好友第一次充值到账后，邀请人拿首充的一定比例（有上限），好友再额外送一笔。
 *   自己邀自己（同一个 TG、X 账号）不发；付款钱包和邀请人用过的一样、或超过每月上限的，进后台等人工审核。
 * 所有数字都在后台改，存在 app_settings 的 rewards 里。
 */

export interface RewardsConfig {
  enabled: boolean;
  /** 每天签到送多少（USDT） */
  checkin: number;
  /** 连签满几天额外送 */
  streakDays: number;
  streakBonus: number;
  /** 没充过值的人，存钱罐最多存多少 */
  piggyCap: number;
  /** 赠送额度多少天没用完就过期 */
  expireDays: number;
  /** 邀请人拿好友首充的百分之几 */
  invitePct: number;
  /** 邀请人每个好友最多拿多少 */
  inviteMax: number;
  /** 被邀请的好友首充后额外送多少 */
  inviteeBonus: number;
  /** 每人每月最多自动发几个邀请奖励，超过的进后台审核 */
  inviteMonthly: number;
}

export const DEFAULT_REWARDS: RewardsConfig = {
  enabled: true,
  checkin: 0.03,
  streakDays: 7,
  streakBonus: 0.09,
  piggyCap: 1,
  expireDays: 90,
  invitePct: 10,
  inviteMax: 5,
  inviteeBonus: 1,
  inviteMonthly: 20,
};

const KEY = "rewards";

export async function getRewardsConfig(): Promise<RewardsConfig> {
  const saved = (await getSetting<Partial<RewardsConfig>>(KEY)) ?? {};
  return { ...DEFAULT_REWARDS, ...saved };
}

export async function saveRewardsConfig(next: RewardsConfig) {
  await setSetting(KEY, next);
}

// ---------- 赠送额度 ----------

/** 在调用方的事务里发一笔赠送额度（加余额 + 记流水 + 记成赠送、顺延到期时间） */
export async function grantRewardTx(tx: Tx, userId: string, amountMicro: number, note: string, refId?: string, expireDays?: number) {
  if (amountMicro <= 0) return;
  const days = expireDays ?? (await getRewardsConfig()).expireDays;
  await addBalanceTx(tx, userId, amountMicro, { kind: "bonus", note, refId });
  await tx
    .update(schema.wallets)
    .set({
      bonusMicro: sql`${schema.wallets.bonusMicro} + ${amountMicro}`,
      bonusExpiresAt: new Date(Date.now() + days * 86400_000),
    })
    .where(eq(schema.wallets.userId, userId));
}

/** 到期没用完的赠送额度从余额里扣掉（定时任务调用）。返回处理了几个人 */
export async function expireBonuses(now = new Date()): Promise<number> {
  const db = await getDb();
  const due = await db
    .select({ userId: schema.wallets.userId })
    .from(schema.wallets)
    .where(and(sql`${schema.wallets.bonusMicro} > 0`, lt(schema.wallets.bonusExpiresAt, now)))
    .limit(200);
  let n = 0;
  for (const { userId } of due) {
    await db.transaction(async (tx) => {
      // 重新锁住读一遍：期间可能刚拿到新奖励（到期时间顺延了）或者刚用掉
      const [w] = await tx
        .select({ bonus: schema.wallets.bonusMicro, bal: schema.wallets.balanceMicro, exp: schema.wallets.bonusExpiresAt })
        .from(schema.wallets)
        .where(eq(schema.wallets.userId, userId))
        .for("update");
      if (!w || w.bonus <= 0 || !w.exp || w.exp >= now) return;
      const cut = Math.min(w.bonus, Math.max(0, w.bal));
      await tx.update(schema.wallets).set({ bonusMicro: 0, bonusExpiresAt: null }).where(eq(schema.wallets.userId, userId));
      if (cut > 0) await addBalanceTx(tx, userId, -cut, { kind: "bonus", note: "签到 / 邀请送的额度到期，没用完的部分作废" });
      n++;
    });
  }
  return n;
}

/** 充值过没有（管理员手动调整不算） */
export async function hasPaid(q: Tx | Awaited<ReturnType<typeof getDb>>, userId: string): Promise<boolean> {
  const [t] = await q
    .select({ id: schema.ledger.id })
    .from(schema.ledger)
    .where(and(eq(schema.ledger.userId, userId), eq(schema.ledger.kind, "topup")))
    .limit(1);
  return !!t;
}

/** 「≈ 3 条」「≈ 1/3 条」：把奖励换成大约能多发几条，不给用户看金额 */
export function postsText(cfg: BillingConfig, micro: number): string {
  const unit = postUnitMicro(cfg);
  if (unit <= 0 || micro <= 0) return "一点";
  const ratio = micro / unit;
  if (ratio >= 1) return `${Math.round(ratio)} 条`;
  return `1/${Math.max(2, Math.round(1 / ratio))} 条`;
}

// ---------- 签到 ----------

/** 北京时间的日期 YYYY-MM-DD */
export function beijingDay(now = new Date(), offsetDays = 0): string {
  return new Date(now.getTime() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

export type CheckinResult =
  | { status: "off" }
  | { status: "already"; streak: number }
  | { status: "ok"; streak: number; amountMicro: number; streakBonus: boolean; held: boolean; piggyMicro: number; piggyFull: boolean };

export async function checkin(userId: string, now = new Date()): Promise<CheckinResult> {
  const rc = await getRewardsConfig();
  if (!rc.enabled || rc.checkin <= 0) return { status: "off" };
  const today = beijingDay(now);
  const yesterday = beijingDay(now, -1);
  const db = await getDb();
  return db.transaction(async (tx): Promise<CheckinResult> => {
    // 同一个人同时点很多次：锁住他的钱包行排队（没有就先建一个）
    await tx.insert(schema.wallets).values({ userId }).onConflictDoNothing();
    await tx.select({ u: schema.wallets.userId }).from(schema.wallets).where(eq(schema.wallets.userId, userId)).for("update");
    const [last] = await tx
      .select()
      .from(schema.checkins)
      .where(eq(schema.checkins.userId, userId))
      .orderBy(desc(schema.checkins.day))
      .limit(1);
    if (last?.day === today) return { status: "already", streak: last.streak };
    const streak = last?.day === yesterday ? last.streak + 1 : 1;
    const streakBonus = rc.streakDays > 0 && streak % rc.streakDays === 0;
    let amount = toMicro(rc.checkin) + (streakBonus ? toMicro(rc.streakBonus) : 0);
    const held = !(await hasPaid(tx, userId));
    let piggy = 0;
    let piggyFull = false;
    if (held) {
      const [p] = await tx
        .select({ s: sql<string>`coalesce(sum(${schema.checkins.amountMicro}), 0)` })
        .from(schema.checkins)
        .where(and(eq(schema.checkins.userId, userId), eq(schema.checkins.held, true), isNull(schema.checkins.releasedAt)));
      const room = Math.max(0, toMicro(rc.piggyCap) - Number(p?.s ?? 0));
      if (amount >= room) piggyFull = true;
      amount = Math.min(amount, room);
      piggy = Number(p?.s ?? 0) + amount;
    }
    const ins = await tx
      .insert(schema.checkins)
      .values({ userId, day: today, streak, amountMicro: amount, held })
      .onConflictDoNothing()
      .returning({ id: schema.checkins.id });
    if (!ins.length) return { status: "already", streak };
    if (!held) await grantRewardTx(tx, userId, amount, streakBonus ? `签到（连签 ${streak} 天奖励）` : "每日签到", `checkin:${today}`, rc.expireDays);
    return { status: "ok", streak, amountMicro: amount, streakBonus, held, piggyMicro: piggy, piggyFull };
  });
}

/** 今天签过没有、连签几天、存钱罐里有多少 */
export async function checkinStatus(userId: string, now = new Date()) {
  const db = await getDb();
  const [last] = await db.select().from(schema.checkins).where(eq(schema.checkins.userId, userId)).orderBy(desc(schema.checkins.day)).limit(1);
  const [p] = await db
    .select({ s: sql<string>`coalesce(sum(${schema.checkins.amountMicro}), 0)` })
    .from(schema.checkins)
    .where(and(eq(schema.checkins.userId, userId), eq(schema.checkins.held, true), isNull(schema.checkins.releasedAt)));
  const today = beijingDay(now);
  const alive = last && (last.day === today || last.day === beijingDay(now, -1));
  return { doneToday: last?.day === today, streak: alive ? last.streak : 0, piggyMicro: Number(p?.s ?? 0) };
}

// ---------- 邀请 ----------

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export async function referralCode(userId: string): Promise<string> {
  const db = await getDb();
  for (let i = 0; i < 5; i++) {
    const [have] = await db.select({ code: schema.referralCodes.code }).from(schema.referralCodes).where(eq(schema.referralCodes.userId, userId)).limit(1);
    if (have) return have.code;
    await db.insert(schema.referralCodes).values({ userId, code: newCode() }).onConflictDoNothing();
  }
  throw new Error("生成邀请码失败");
}

async function inviterByCode(code: string): Promise<string | null> {
  if (!/^[a-z0-9]{4,20}$/i.test(code)) return null;
  const db = await getDb();
  const [r] = await db.select({ userId: schema.referralCodes.userId }).from(schema.referralCodes).where(eq(schema.referralCodes.code, code.toLowerCase())).limit(1);
  return r?.userId ?? null;
}

/** 注册多久以内的账号还能被邀请（太久的老用户不能事后补一个邀请人） */
const INVITE_ATTACH_DAYS = 7;

export type AttachResult = "ok" | "invalid" | "self" | "already" | "old";

/** 记下「这位新用户是谁邀请的」；奖励等他首充后再发 */
export async function attachReferral(inviteeId: string, code: string, via: "tg" | "web"): Promise<AttachResult> {
  const inviter = await inviterByCode(code);
  if (!inviter) return "invalid";
  if (inviter === inviteeId) return "self";
  const db = await getDb();
  const [u] = await db.select({ createdAt: schema.users.createdAt }).from(schema.users).where(eq(schema.users.id, inviteeId)).limit(1);
  if (!u) return "invalid";
  const [existing] = await db.select({ s: schema.referrals.status }).from(schema.referrals).where(eq(schema.referrals.inviteeUserId, inviteeId)).limit(1);
  if (existing) return "already";
  if (Date.now() - u.createdAt.getTime() > INVITE_ATTACH_DAYS * 86400_000 || (await hasPaid(db, inviteeId))) return "old";
  // 互相邀请（A 邀了 B，B 再去邀 A）不算
  const [reverse] = await db
    .select({ s: schema.referrals.status })
    .from(schema.referrals)
    .where(and(eq(schema.referrals.inviteeUserId, inviter), eq(schema.referrals.inviterUserId, inviteeId)))
    .limit(1);
  if (reverse) return "self";
  const r = await db.insert(schema.referrals).values({ inviteeUserId: inviteeId, inviterUserId: inviter, via }).onConflictDoNothing().returning();
  return r.length ? "ok" : "already";
}

/** TG 里还没绑定账号的人点了邀请链接：先记下，等他绑定后再挂上 */
export async function rememberTgReferral(tgUserId: string, code: string) {
  if (!(await inviterByCode(code))) return false;
  await setSetting(`ref:tg:${tgUserId}`, { code, at: new Date().toISOString() });
  return true;
}

/** 绑定 TG 成功后：之前点过邀请链接的，挂上邀请关系 */
export async function attachPendingTgReferral(userId: string, tgUserId: string): Promise<AttachResult | null> {
  const saved = await getSetting<{ code: string }>(`ref:tg:${tgUserId}`);
  if (!saved?.code) return null;
  const db = await getDb();
  await db.delete(schema.appSettings).where(eq(schema.appSettings.key, `ref:tg:${tgUserId}`));
  return attachReferral(userId, saved.code, "tg");
}

/** 两个账号是不是同一个人（同一个 TG 号、同一个 X 账号）；是的话返回原因 */
async function sameOwner(a: string, b: string): Promise<string | null> {
  const db = await getDb();
  const tg = await db.select({ userId: schema.tgBindings.userId, chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(inArray(schema.tgBindings.userId, [a, b]));
  const chatOf = (id: string) => tg.find((t) => t.userId === id)?.chatId ?? null;
  const ta = chatOf(a);
  const tb = chatOf(b);
  if (ta && tb && ta === tb) return "同一个 TG 账号";
  // 被邀请人的 TG 以前领过新人赠送、但领的是另一个账号：换邮箱注册的小号
  if (tb) {
    const mark = await getSetting<{ userId: string }>(`bonus:tg:${tb}`);
    if (mark && mark.userId !== b) return "被邀请人的 TG 以前绑过别的账号";
  }
  const x = await db.select({ userId: schema.xAccounts.userId, xUserId: schema.xAccounts.xUserId }).from(schema.xAccounts).where(inArray(schema.xAccounts.userId, [a, b]));
  const xa = x.find((r) => r.userId === a)?.xUserId;
  const xb = x.find((r) => r.userId === b)?.xUserId;
  if (xa && xb && xa === xb) return "同一个 X 账号";
  return null;
}

/** 付款钱包和邀请人用过的一样（交易所提现可能共用地址，所以只进审核、不直接拒绝） */
async function sharedWallet(inviter: string, from: string | null): Promise<boolean> {
  if (!from) return false;
  const db = await getDb();
  const [t] = await db
    .select({ id: schema.topups.id })
    .from(schema.topups)
    .where(and(eq(schema.topups.userId, inviter), sql`lower(${schema.topups.fromAddress}) = ${from.toLowerCase()}`))
    .limit(1);
  return !!t;
}

export function inviteAmounts(rc: RewardsConfig, topupMicro: number) {
  return {
    inviter: Math.min(Math.round((topupMicro * rc.invitePct) / 100), toMicro(rc.inviteMax)),
    invitee: toMicro(rc.inviteeBonus),
  };
}

export interface TopupRewards {
  /** 存钱罐解锁了多少 */
  piggyMicro: number;
  /** 邀请：发了 / 进了审核 / 没发 */
  referral: null | { status: "rewarded" | "review" | "rejected"; inviterId: string; inviterMicro: number; inviteeMicro: number; reason?: string };
}

/**
 * 充值到账后调用（事务提交之后）：解锁签到存钱罐；第一次充值的话处理邀请奖励。
 * 可以重复调用：存钱罐每笔只解锁一次，邀请只在 pending 时处理一次。
 */
export async function onTopup(userId: string, topupMicro: number, fromAddress: string | null): Promise<TopupRewards> {
  const rc = await getRewardsConfig();
  const db = await getDb();
  const out: TopupRewards = { piggyMicro: 0, referral: null };

  out.piggyMicro = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.checkins)
      .set({ releasedAt: new Date() })
      .where(and(eq(schema.checkins.userId, userId), eq(schema.checkins.held, true), isNull(schema.checkins.releasedAt)))
      .returning({ a: schema.checkins.amountMicro });
    const sum = rows.reduce((s, r) => s + r.a, 0);
    await grantRewardTx(tx, userId, sum, `签到存钱罐解锁（${rows.length} 天）`, "piggy", rc.expireDays);
    return sum;
  });

  const [ref] = await db.select().from(schema.referrals).where(and(eq(schema.referrals.inviteeUserId, userId), eq(schema.referrals.status, "pending"))).limit(1);
  if (!ref) return out;
  const amounts = inviteAmounts(rc, topupMicro);
  let status: "rewarded" | "review" | "rejected" = "rewarded";
  let reason: string | undefined;
  const same = await sameOwner(ref.inviterUserId, userId);
  if (same) {
    status = "rejected";
    reason = `疑似自己邀请自己：${same}`;
  } else if (!rc.enabled) {
    status = "rejected";
    reason = "邀请奖励已关闭";
  } else if (await sharedWallet(ref.inviterUserId, fromAddress)) {
    status = "review";
    reason = "付款钱包和邀请人充值用过的一样（也可能是同一个交易所的提现地址）";
  } else {
    const [c] = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.referrals)
      .where(
        and(
          eq(schema.referrals.inviterUserId, ref.inviterUserId),
          eq(schema.referrals.status, "rewarded"),
          gte(schema.referrals.decidedAt, new Date(Date.now() - 30 * 86400_000)),
        ),
      );
    if (Number(c?.n ?? 0) >= rc.inviteMonthly) {
      status = "review";
      reason = `邀请人最近 30 天已经拿了 ${rc.inviteMonthly} 个邀请奖励，超出的人工审核`;
    }
  }
  const done = await db.transaction(async (tx) => {
    const [r] = await tx
      .update(schema.referrals)
      .set({
        status,
        reason: reason ?? null,
        topupMicro,
        fromAddress,
        inviterRewardMicro: amounts.inviter,
        inviteeRewardMicro: amounts.invitee,
        decidedAt: new Date(),
      })
      .where(and(eq(schema.referrals.inviteeUserId, userId), eq(schema.referrals.status, "pending")))
      .returning();
    if (!r) return false;
    if (status === "rewarded") await payReferral(tx, r.inviterUserId, userId, amounts, rc.expireDays);
    return true;
  });
  if (done) out.referral = { status, inviterId: ref.inviterUserId, inviterMicro: amounts.inviter, inviteeMicro: amounts.invitee, reason };
  return out;
}

async function payReferral(tx: Tx, inviter: string, invitee: string, a: { inviter: number; invitee: number }, expireDays: number) {
  await grantRewardTx(tx, inviter, a.inviter, "邀请奖励：好友首充", `ref:${invitee}`, expireDays);
  await grantRewardTx(tx, invitee, a.invitee, "受邀新用户首充奖励", `ref:${invitee}`, expireDays);
}

/** 后台审核：通过（发奖励）或不发 */
export async function decideReferral(inviteeId: string, approve: boolean): Promise<{ inviterId: string; inviterMicro: number; inviteeMicro: number } | null> {
  const rc = await getRewardsConfig();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [r] = await tx
      .update(schema.referrals)
      .set({ status: approve ? "rewarded" : "rejected", decidedAt: new Date(), reason: approve ? "管理员审核通过" : "管理员审核不发" })
      .where(and(eq(schema.referrals.inviteeUserId, inviteeId), eq(schema.referrals.status, "review")))
      .returning();
    if (!r) return null;
    const a = { inviter: r.inviterRewardMicro ?? 0, invitee: r.inviteeRewardMicro ?? 0 };
    if (approve) await payReferral(tx, r.inviterUserId, inviteeId, a, rc.expireDays);
    return { inviterId: r.inviterUserId, inviterMicro: a.inviter, inviteeMicro: a.invitee };
  });
}

/** 我邀请的人：几个在等首充、几个已经发了奖励、一共拿了多少 */
export async function inviteStats(userId: string) {
  const db = await getDb();
  const rows = await db.select({ status: schema.referrals.status, m: schema.referrals.inviterRewardMicro }).from(schema.referrals).where(eq(schema.referrals.inviterUserId, userId));
  return {
    pending: rows.filter((r) => r.status === "pending" || r.status === "review").length,
    rewarded: rows.filter((r) => r.status === "rewarded").length,
    earnedMicro: rows.filter((r) => r.status === "rewarded").reduce((s, r) => s + (r.m ?? 0), 0),
  };
}

// ---------- 后台：邀请记录、转化漏斗 ----------

export async function adminReferrals(limit = 100) {
  const db = await getDb();
  const rows = await db.select().from(schema.referrals).orderBy(desc(schema.referrals.createdAt)).limit(limit);
  const ids = [...new Set(rows.flatMap((r) => [r.inviteeUserId, r.inviterUserId]))];
  const users = ids.length ? await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
  const email = (id: string) => users.find((u) => u.id === id)?.email ?? id.slice(0, 8);
  return rows.map((r) => ({
    invitee: r.inviteeUserId,
    inviteeEmail: email(r.inviteeUserId),
    inviterEmail: email(r.inviterUserId),
    status: r.status,
    reason: r.reason,
    topup: r.topupMicro,
    inviterReward: r.inviterRewardMicro,
    inviteeReward: r.inviteeRewardMicro,
    at: r.createdAt.toISOString(),
  }));
}

export interface Funnel {
  days: number | null;
  signups: number;
  boundTg: number;
  used: number;
  usedUp: number;
  firstTopup: number;
  repeat: number;
  checkinsToday: number;
  invited: number;
  invitedPaid: number;
  rewardsMicro: number;
}

/**
 * 转化漏斗：在这段时间注册的人里，多少绑了 TG、用过收费功能、把送的额度用完、首充、充了两次以上。
 * days 为空 = 全部。管理员账号不算。
 */
export async function funnel(days: number | null, adminIds: string[] = []): Promise<Funnel> {
  const db = await getDb();
  const since = days ? new Date(Date.now() - days * 86400_000) : new Date(0);
  const cfg = await getConfig();
  const unit = postUnitMicro(cfg);
  const users = (await db.select({ id: schema.users.id }).from(schema.users).where(gte(schema.users.createdAt, since)))
    .map((u) => u.id)
    .filter((id) => !adminIds.includes(id));
  const empty: Funnel = { days, signups: 0, boundTg: 0, used: 0, usedUp: 0, firstTopup: 0, repeat: 0, checkinsToday: 0, invited: 0, invitedPaid: 0, rewardsMicro: 0 };
  const [ct] = await db.select({ n: sql<string>`count(*)` }).from(schema.checkins).where(eq(schema.checkins.day, beijingDay()));
  const [rw] = await db
    .select({ s: sql<string>`coalesce(sum(${schema.ledger.amountMicro}), 0)` })
    .from(schema.ledger)
    .where(and(eq(schema.ledger.kind, "bonus"), gte(schema.ledger.createdAt, since), sql`${schema.ledger.amountMicro} > 0`, sql`${schema.ledger.note} <> '新用户赠送'`));
  empty.checkinsToday = Number(ct?.n ?? 0);
  empty.rewardsMicro = Number(rw?.s ?? 0);
  if (!users.length) return empty;
  const per = await db
    .select({
      userId: schema.ledger.userId,
      charges: sql<string>`count(*) filter (where ${schema.ledger.kind} = 'charge')`,
      topups: sql<string>`count(*) filter (where ${schema.ledger.kind} = 'topup')`,
    })
    .from(schema.ledger)
    .where(inArray(schema.ledger.userId, users))
    .groupBy(schema.ledger.userId);
  const bal = await db.select({ userId: schema.wallets.userId, b: schema.wallets.balanceMicro }).from(schema.wallets).where(inArray(schema.wallets.userId, users));
  const tg = await db.select({ userId: schema.tgBindings.userId }).from(schema.tgBindings).where(and(inArray(schema.tgBindings.userId, users), sql`${schema.tgBindings.chatId} is not null`));
  const refs = await db.select({ id: schema.referrals.inviteeUserId }).from(schema.referrals).where(inArray(schema.referrals.inviteeUserId, users));
  const stat = (id: string) => per.find((p) => p.userId === id);
  const paid = (id: string) => Number(stat(id)?.topups ?? 0);
  return {
    ...empty,
    signups: users.length,
    boundTg: tg.length,
    used: users.filter((id) => Number(stat(id)?.charges ?? 0) > 0).length,
    // 用完了：用过收费功能，剩下的已经不够发一条
    usedUp: users.filter((id) => Number(stat(id)?.charges ?? 0) > 0 && (bal.find((b) => b.userId === id)?.b ?? 0) < Math.max(unit, 1)).length,
    firstTopup: users.filter((id) => paid(id) >= 1).length,
    repeat: users.filter((id) => paid(id) >= 2).length,
    invited: refs.length,
    invitedPaid: refs.filter((r) => paid(r.id) >= 1).length,
  };
}
