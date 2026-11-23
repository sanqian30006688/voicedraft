import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fmtUsdt, getBalance, getConfig, parseUsdt, teamFundsOk, teamLeft, teamLink, teamSpent, type TeamLink } from "./billing";
import { createJob, validateTweets, type PostRow } from "./publish";
import { getAccount } from "./x";

/**
 * 团队：
 * - 共用钱包：团队钱包就是所有者的余额，成员在每天 / 每月上限内从里面扣（扣费逻辑在 billing.ts）。
 * - 官号投稿：所有者或管理员把自己连接的 X 设为官号；成员把写好的稿子投给官号，
 *   所有者 / 管理员在 TG 或网页里点「通过」才会用官号发出（立即或定时），也可以改了再发或驳回。
 * 隔离：成员各自的素材、风格卡、草稿、X 授权都还是自己的；所有者只看得到每位成员用了多少钱。
 * 投稿内容团队里能审批的人都看得到（本来就是给官号发的）；普通成员只看得到自己的投稿。
 */

export const MAX_MEMBERS = 20;
const INVITE_TTL_MS = 7 * 86400_000;
const MAX_PENDING_PER_AUTHOR = 30;

export class TeamError extends Error {}

/** 通过后用官号发布失败；balance 表示是余额不足 */
export class TeamPublishError extends TeamError {
  constructor(
    message: string,
    public balance = false,
  ) {
    super(message);
  }
}

export type TeamRow = typeof schema.teams.$inferSelect;
export type SubmissionRow = typeof schema.teamSubmissions.$inferSelect;
export type Role = TeamLink["role"];

export const ROLE_LABEL: Record<Role, string> = { owner: "所有者", admin: "管理员", member: "成员" };

export const canReview = (role: Role) => role === "owner" || role === "admin";

async function getTeam(teamId: string): Promise<TeamRow> {
  const db = await getDb();
  const [t] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
  if (!t) throw new TeamError("团队不存在了");
  return t;
}

/** 当前用户所在的团队和身份；不在任何团队返回 null */
export async function myTeam(userId: string): Promise<{ team: TeamRow; link: TeamLink } | null> {
  const link = await teamLink(userId);
  if (!link) return null;
  return { team: await getTeam(link.teamId), link };
}

async function requireTeam(userId: string) {
  const t = await myTeam(userId);
  if (!t) throw new TeamError("你还不在任何团队里");
  return t;
}

async function requireReviewer(userId: string) {
  const t = await requireTeam(userId);
  if (!canReview(t.link.role)) throw new TeamError("只有团队所有者和管理员可以做这个");
  return t;
}

async function requireOwner(userId: string) {
  const t = await requireTeam(userId);
  if (t.link.role !== "owner") throw new TeamError("只有团队所有者可以做这个");
  return t;
}

function cleanName(name: string) {
  const n = name.trim().slice(0, 40);
  if (!n) throw new TeamError("请给团队起个名字");
  return n;
}

export async function displayName(userId: string): Promise<string> {
  const db = await getDb();
  const [u] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return u ? u.name || u.email.split("@")[0] : "已删除的成员";
}

// ---------- 建团队、邀请、加入、退出 ----------

/**
 * 团队功能要求所有者余额不低于门槛（后台可改，默认 20 USDT）：建团队、发邀请、加入都要检查。
 * 已经建好的团队余额掉到门槛以下：成员暂停共用（改扣自己的余额或停，见 billing.ts），所有者自己照常用，充值后自动恢复。
 */
async function requireTeamFunds(ownerId: string, self: boolean) {
  const cfg = await getConfig();
  if (await teamFundsOk(ownerId, cfg)) return;
  const bal = fmtUsdt(await getBalance(ownerId));
  throw new TeamError(
    self
      ? `团队功能需要你的余额不低于 ${cfg.teamMinBalance} USDT（现在 ${bal} USDT），请先充值（网页「余额」页，或在 TG 机器人里点「💰 余额」）。`
      : `这个团队的余额低于 ${cfg.teamMinBalance} USDT，暂时不能加人，请让团队所有者先充值。`,
  );
}

export async function createTeam(userId: string, name: string): Promise<TeamRow> {
  if (await teamLink(userId)) throw new TeamError("你已经在一个团队里了，先退出才能新建");
  await requireTeamFunds(userId, true);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [t] = await tx.insert(schema.teams).values({ ownerUserId: userId, name: cleanName(name) }).returning();
    await tx.insert(schema.teamMembers).values({ teamId: t.id, userId, role: "owner" });
    return t;
  });
}

export async function renameTeam(userId: string, name: string) {
  const { team } = await requireOwner(userId);
  const db = await getDb();
  await db.update(schema.teams).set({ name: cleanName(name) }).where(eq(schema.teams.id, team.id));
}

/** 生成邀请码（7 天有效）。TG 链接：t.me/机器人?start=team_邀请码；网页：/team?join=邀请码 */
export async function createInvite(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const { team } = await requireReviewer(userId);
  await requireTeamFunds(team.ownerUserId, team.ownerUserId === userId);
  const db = await getDb();
  const code = randomBytes(9).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.insert(schema.teamInvites).values({ code, teamId: team.id, createdBy: userId, expiresAt });
  return { code, expiresAt };
}

/** 作废这个团队所有还有效的邀请链接 */
export async function revokeInvites(userId: string) {
  const { team } = await requireReviewer(userId);
  const db = await getDb();
  await db
    .update(schema.teamInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.teamInvites.teamId, team.id), isNull(schema.teamInvites.revokedAt)));
}

const validInvite = (code: string) =>
  and(eq(schema.teamInvites.code, code), isNull(schema.teamInvites.revokedAt), gt(schema.teamInvites.expiresAt, new Date()));

/** 看一下邀请码是哪个团队的（加入前给用户确认） */
export async function previewInvite(code: string): Promise<{ teamName: string; ownerName: string } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ name: schema.teams.name, owner: schema.teams.ownerUserId })
    .from(schema.teamInvites)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamInvites.teamId))
    .where(validInvite(code))
    .limit(1);
  return row ? { teamName: row.name, ownerName: await displayName(row.owner) } : null;
}

export async function joinTeam(userId: string, code: string): Promise<TeamRow> {
  const db = await getDb();
  const [inv] = await db.select().from(schema.teamInvites).where(validInvite(code.trim())).limit(1);
  if (!inv) throw new TeamError("这个邀请链接已过期或已作废，请找团队所有者重新发一个");
  const current = await teamLink(userId);
  if (current?.teamId === inv.teamId) throw new TeamError("你已经在这个团队里了");
  if (current) throw new TeamError("你已经在另一个团队里了，先退出那个团队才能加入");
  const team = await getTeam(inv.teamId);
  await requireTeamFunds(team.ownerUserId, false);
  await db.transaction(async (tx) => {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, team.id));
    if (n >= MAX_MEMBERS) throw new TeamError(`这个团队已经有 ${MAX_MEMBERS} 人了，满员了`);
    await tx.insert(schema.teamMembers).values({
      teamId: team.id,
      userId,
      role: "member",
      dailyMicro: team.defaultDailyMicro,
      monthlyMicro: team.defaultMonthlyMicro,
    });
    await tx.update(schema.teamInvites).set({ uses: sql`${schema.teamInvites.uses} + 1` }).where(eq(schema.teamInvites.code, inv.code));
  });
  return team;
}

/** 自己退出团队（所有者不能退出，只能解散） */
export async function leaveTeam(userId: string) {
  const { team, link } = await requireTeam(userId);
  if (link.role === "owner") throw new TeamError("所有者不能退出，可以解散团队");
  await dropMember(team, userId);
}

async function dropMember(team: TeamRow, userId: string) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, userId)));
    // 官号是他连接的 X：不再是官号
    if (team.officialUserId === userId) await tx.update(schema.teams).set({ officialUserId: null }).where(eq(schema.teams.id, team.id));
    // 他还没审批的投稿撤回
    await tx
      .update(schema.teamSubmissions)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(
        and(
          eq(schema.teamSubmissions.teamId, team.id),
          eq(schema.teamSubmissions.authorUserId, userId),
          eq(schema.teamSubmissions.status, "pending"),
        ),
      );
  });
}

/** 解散团队：成员都回到只用自己余额；团队钱包（所有者余额）不变 */
export async function dissolveTeam(userId: string) {
  const { team } = await requireOwner(userId);
  const db = await getDb();
  await db.delete(schema.teams).where(eq(schema.teams.id, team.id));
}

// ---------- 成员管理 ----------

async function memberOf(teamId: string, userId: string) {
  const db = await getDb();
  const [m] = await db
    .select()
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)))
    .limit(1);
  if (!m) throw new TeamError("这个人不在你的团队里");
  return m;
}

/** 把成员移出团队：所有者可以移任何人，管理员只能移普通成员 */
export async function removeMember(userId: string, targetId: string) {
  const { team, link } = await requireReviewer(userId);
  const m = await memberOf(team.id, targetId);
  if (m.role === "owner") throw new TeamError("不能移出所有者");
  if (link.role !== "owner" && m.role !== "member") throw new TeamError("只有所有者可以移出管理员");
  await dropMember(team, targetId);
}

/** 所有者设置成员的身份和每天 / 每月上限（USDT 字符串，空 = 不限） */
export async function updateMember(
  userId: string,
  targetId: string,
  change: { role?: "admin" | "member"; daily?: string | null; monthly?: string | null },
) {
  const { team } = await requireOwner(userId);
  const m = await memberOf(team.id, targetId);
  if (m.role === "owner") throw new TeamError("所有者不受上限限制，身份也不能改");
  const set: Partial<typeof schema.teamMembers.$inferInsert> = {};
  if (change.role) set.role = change.role;
  if (change.daily !== undefined) set.dailyMicro = limitMicro(change.daily);
  if (change.monthly !== undefined) set.monthlyMicro = limitMicro(change.monthly);
  const db = await getDb();
  await db.update(schema.teamMembers).set(set).where(and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, targetId)));
  // 降为普通成员后不能再持有官号
  if (change.role === "member" && team.officialUserId === targetId) {
    await db.update(schema.teams).set({ officialUserId: null }).where(eq(schema.teams.id, team.id));
  }
}

function limitMicro(v: string | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const m = parseUsdt(String(v));
  if (!Number.isFinite(m)) throw new TeamError("上限请填数字，例如 5 或 2.5；不限就留空");
  return m;
}

/** 团队设置：新成员默认上限、用完团队额度后是否改扣成员自己的余额 */
export async function updateTeamSettings(userId: string, change: { fallbackPersonal?: boolean; defaultDaily?: string | null; defaultMonthly?: string | null }) {
  const { team } = await requireOwner(userId);
  const set: Partial<typeof schema.teams.$inferInsert> = {};
  if (change.fallbackPersonal !== undefined) set.fallbackPersonal = change.fallbackPersonal;
  if (change.defaultDaily !== undefined) set.defaultDailyMicro = limitMicro(change.defaultDaily);
  if (change.defaultMonthly !== undefined) set.defaultMonthlyMicro = limitMicro(change.defaultMonthly);
  const db = await getDb();
  await db.update(schema.teams).set(set).where(eq(schema.teams.id, team.id));
}

/** 所有者或管理员把「自己」连接的 X 设为官号（不能拿别人的 X 当官号）；on=false 取消 */
export async function setOfficial(userId: string, on: boolean) {
  const { team } = await requireReviewer(userId);
  const db = await getDb();
  if (!on) {
    if (team.officialUserId !== userId) throw new TeamError("官号不是你连接的 X，只有官号连接人或所有者可以取消");
    await db.update(schema.teams).set({ officialUserId: null }).where(eq(schema.teams.id, team.id));
    return;
  }
  const acc = await getAccount(userId);
  if (!acc) throw new TeamError("你还没有连接 X 账号，先到「发布」页连接要当官号的 X");
  if (acc.authError) throw new TeamError("你的 X 授权已失效，先重新连接");
  await db.update(schema.teams).set({ officialUserId: userId }).where(eq(schema.teams.id, team.id));
}

/** 所有者取消官号（不管是谁连接的） */
export async function clearOfficial(userId: string) {
  const { team, link } = await requireReviewer(userId);
  if (link.role !== "owner" && team.officialUserId !== userId) throw new TeamError("只有官号连接人或所有者可以取消");
  const db = await getDb();
  await db.update(schema.teams).set({ officialUserId: null }).where(eq(schema.teams.id, team.id));
}

export async function officialHandle(team: TeamRow): Promise<string | null> {
  if (!team.officialUserId) return null;
  const acc = await getAccount(team.officialUserId);
  return acc && !acc.authError ? acc.handle : null;
}

// ---------- 总览 ----------

export interface TeamOverview {
  id: string;
  name: string;
  role: Role;
  ownerName: string;
  official: { handle: string | null; mine: boolean; holderName: string } | null;
  fallbackPersonal: boolean;
  defaultDaily: string | null;
  defaultMonthly: string | null;
  /** 团队钱包余额：只给所有者和管理员看 */
  balance: string | null;
  me: { daily: string | null; monthly: string | null; usedToday: string; usedMonth: string; left: string | null };
  /** 成员列表和每人用量：所有者和管理员看得到 */
  members: { userId: string; name: string; email: string; role: Role; daily: string | null; monthly: string | null; usedToday: string; usedMonth: string }[] | null;
  pendingCount: number;
  /** 团队余额低于门槛：成员暂停共用 */
  paused: boolean;
  minBalance: number;
}

const fmtLimit = (m: number | null) => (m == null ? null : fmtUsdt(m));

export async function overview(userId: string): Promise<TeamOverview | null> {
  const t = await myTeam(userId);
  if (!t) return null;
  const { team, link } = t;
  const db = await getDb();
  const cfg = await getConfig();
  const reviewer = canReview(link.role);
  const mySpent = link.role === "owner" ? { day: 0, month: 0 } : await teamSpent(db, team.ownerUserId, userId);
  const left = link.role === "owner" ? null : teamLeft(link, mySpent);
  let members: TeamOverview["members"] = null;
  if (reviewer) {
    const rows = await db
      .select({
        userId: schema.teamMembers.userId,
        role: schema.teamMembers.role,
        dailyMicro: schema.teamMembers.dailyMicro,
        monthlyMicro: schema.teamMembers.monthlyMicro,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
      .where(eq(schema.teamMembers.teamId, team.id))
      .orderBy(schema.teamMembers.joinedAt);
    members = [];
    for (const r of rows) {
      const spent = r.role === "owner" ? null : await teamSpent(db, team.ownerUserId, r.userId);
      members.push({
        userId: r.userId,
        name: r.name || r.email.split("@")[0],
        email: r.email,
        role: r.role as Role,
        daily: fmtLimit(r.dailyMicro),
        monthly: fmtLimit(r.monthlyMicro),
        usedToday: spent ? fmtUsdt(spent.day) : "—",
        usedMonth: spent ? fmtUsdt(spent.month) : "—",
      });
    }
  }
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.teamSubmissions)
    .where(and(eq(schema.teamSubmissions.teamId, team.id), eq(schema.teamSubmissions.status, "pending")));
  return {
    id: team.id,
    name: team.name,
    role: link.role,
    ownerName: await displayName(team.ownerUserId),
    official: team.officialUserId
      ? { handle: await officialHandle(team), mine: team.officialUserId === userId, holderName: await displayName(team.officialUserId) }
      : null,
    fallbackPersonal: team.fallbackPersonal,
    defaultDaily: fmtLimit(team.defaultDailyMicro),
    defaultMonthly: fmtLimit(team.defaultMonthlyMicro),
    balance: reviewer ? fmtUsdt(await getBalance(team.ownerUserId)) : null,
    me: {
      daily: fmtLimit(link.dailyMicro),
      monthly: fmtLimit(link.monthlyMicro),
      usedToday: fmtUsdt(mySpent.day),
      usedMonth: fmtUsdt(mySpent.month),
      left: left == null ? null : fmtUsdt(left),
    },
    members,
    pendingCount: reviewer ? n : 0,
    paused: !(await teamFundsOk(team.ownerUserId, cfg)),
    minBalance: cfg.teamMinBalance,
  };
}

/** 团队钱包的流水：所有者看全部成员的，成员只看自己用的 */
export async function teamLedger(userId: string, limit = 50) {
  const { team, link } = await requireTeam(userId);
  const owner = link.role === "owner";
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.ledger.id,
      kind: schema.ledger.kind,
      item: schema.ledger.item,
      quantity: schema.ledger.quantity,
      amountMicro: schema.ledger.amountMicro,
      note: schema.ledger.note,
      createdAt: schema.ledger.createdAt,
      actorUserId: schema.ledger.actorUserId,
    })
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.userId, team.ownerUserId),
        link.role === "owner" ? sql`${schema.ledger.actorUserId} is not null` : eq(schema.ledger.actorUserId, userId),
      ),
    )
    .orderBy(desc(schema.ledger.createdAt))
    .limit(limit);
  const names = new Map<string, string>();
  for (const r of rows) if (r.actorUserId && !names.has(r.actorUserId)) names.set(r.actorUserId, await displayName(r.actorUserId));
  return rows.map((r) => ({ ...r, actorName: owner ? (r.actorUserId ? (names.get(r.actorUserId) ?? "") : "") : null }));
}

// ---------- 官号投稿和审批 ----------

/** 成员投稿给官号 */
export async function submit(userId: string, tweets: string[], note?: string): Promise<SubmissionRow> {
  const { team } = await requireTeam(userId);
  if (!team.officialUserId) throw new TeamError("团队还没有设置官号，请所有者或管理员先把自己连接的 X 设为官号");
  let list: string[];
  try {
    list = validateTweets(tweets);
  } catch (e) {
    throw new TeamError((e as Error).message);
  }
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.teamSubmissions)
    .where(and(eq(schema.teamSubmissions.authorUserId, userId), eq(schema.teamSubmissions.status, "pending")));
  if (n >= MAX_PENDING_PER_AUTHOR) throw new TeamError(`你已经有 ${n} 篇在等审批了，等处理一些再投`);
  const [row] = await db
    .insert(schema.teamSubmissions)
    .values({ teamId: team.id, authorUserId: userId, tweets: list, note: note?.trim().slice(0, 300) || null })
    .returning();
  return row;
}

/** 一篇投稿：审批人看团队里所有的，作者看自己的，其他人看不到 */
export async function getSubmission(userId: string, id: string): Promise<{ sub: SubmissionRow; team: TeamRow; link: TeamLink }> {
  const t = await requireTeam(userId);
  const db = await getDb();
  const [sub] = await db
    .select()
    .from(schema.teamSubmissions)
    .where(and(eq(schema.teamSubmissions.id, id), eq(schema.teamSubmissions.teamId, t.team.id)))
    .limit(1);
  if (!sub || (!canReview(t.link.role) && sub.authorUserId !== userId)) throw new TeamError("找不到这篇投稿");
  return { sub, ...t };
}

export async function listSubmissions(userId: string, which: "pending" | "mine" | "recent", limit = 30) {
  const { team, link } = await requireTeam(userId);
  const db = await getDb();
  const where =
    which === "mine"
      ? and(eq(schema.teamSubmissions.teamId, team.id), eq(schema.teamSubmissions.authorUserId, userId))
      : which === "pending"
        ? and(eq(schema.teamSubmissions.teamId, team.id), eq(schema.teamSubmissions.status, "pending"))
        : eq(schema.teamSubmissions.teamId, team.id);
  if (which !== "mine" && !canReview(link.role)) throw new TeamError("只有团队所有者和管理员可以看全部投稿");
  return db.select().from(schema.teamSubmissions).where(where).orderBy(desc(schema.teamSubmissions.createdAt)).limit(limit);
}

/** 审批人改稿（只能改还在等审批的） */
export async function editSubmission(userId: string, id: string, tweets: string[]): Promise<SubmissionRow> {
  const { sub } = await getSubmission(userId, id);
  const { link } = await requireTeam(userId);
  if (!canReview(link.role) && sub.authorUserId !== userId) throw new TeamError("没有权限改这篇");
  let list: string[];
  try {
    list = validateTweets(tweets);
  } catch (e) {
    throw new TeamError((e as Error).message);
  }
  const db = await getDb();
  const [row] = await db
    .update(schema.teamSubmissions)
    .set({ tweets: list, updatedAt: new Date() })
    .where(and(eq(schema.teamSubmissions.id, sub.id), eq(schema.teamSubmissions.status, "pending")))
    .returning();
  if (!row) throw new TeamError("这篇已经处理过了，不能再改");
  return row;
}

/**
 * 通过：用官号发出（scheduledAt 为空立即发）。先把投稿标成「已通过」再发，两个人同时点也只发一次；
 * 发不出去（余额不足、X 授权失效等）就退回「等审批」，并把原因告诉点的人。
 */
export async function approve(userId: string, id: string, scheduledAt?: Date | null): Promise<{ sub: SubmissionRow; post: PostRow; handle: string }> {
  const { team } = await requireReviewer(userId);
  const { sub } = await getSubmission(userId, id);
  if (!team.officialUserId) throw new TeamError("团队还没有设置官号");
  const handle = await officialHandle(team);
  if (!handle) throw new TeamError("官号的 X 授权失效了，请官号连接人重新连接 X");
  const db = await getDb();
  const [claimed] = await db
    .update(schema.teamSubmissions)
    .set({ status: "approved", reviewerUserId: userId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.teamSubmissions.id, sub.id), eq(schema.teamSubmissions.status, "pending")))
    .returning();
  if (!claimed) throw new TeamError("这篇已经有人处理过了");
  let post: PostRow;
  try {
    post = await createJob(team.officialUserId, { tweets: claimed.tweets, scheduledAt: scheduledAt ?? null });
  } catch (e) {
    await db
      .update(schema.teamSubmissions)
      .set({ status: "pending", reviewerUserId: null, decidedAt: null, updatedAt: new Date() })
      .where(eq(schema.teamSubmissions.id, sub.id));
    throw e;
  }
  // 立即发但一条都没发出去（余额不足、X 报错等）：作废这次发布任务，投稿退回「等审批」，处理好可以再点通过
  if (post.status === "failed" && !post.postIds.length) {
    await db.update(schema.posts).set({ status: "canceled", updatedAt: new Date() }).where(eq(schema.posts.id, post.id));
    await db
      .update(schema.teamSubmissions)
      .set({ status: "pending", reviewerUserId: null, decidedAt: null, updatedAt: new Date() })
      .where(eq(schema.teamSubmissions.id, sub.id));
    throw new TeamPublishError(`没发出去：${post.error ?? "未知原因"}。投稿已退回「等审批」，处理好后可以再点通过。`, !!post.error?.includes("余额"));
  }
  const [row] = await db
    .update(schema.teamSubmissions)
    .set({ postId: post.id, updatedAt: new Date() })
    .where(eq(schema.teamSubmissions.id, sub.id))
    .returning();
  return { sub: row, post, handle };
}

export async function reject(userId: string, id: string, reason?: string): Promise<SubmissionRow> {
  await requireReviewer(userId);
  const { sub } = await getSubmission(userId, id);
  const db = await getDb();
  const [row] = await db
    .update(schema.teamSubmissions)
    .set({
      status: "rejected",
      reviewerUserId: userId,
      rejectReason: reason?.trim().slice(0, 300) || null,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.teamSubmissions.id, sub.id), eq(schema.teamSubmissions.status, "pending")))
    .returning();
  if (!row) throw new TeamError("这篇已经有人处理过了");
  return row;
}

/** 作者撤回自己还没审批的投稿 */
export async function withdraw(userId: string, id: string): Promise<SubmissionRow> {
  const { sub } = await getSubmission(userId, id);
  if (sub.authorUserId !== userId) throw new TeamError("只能撤回自己的投稿");
  const db = await getDb();
  const [row] = await db
    .update(schema.teamSubmissions)
    .set({ status: "withdrawn", updatedAt: new Date() })
    .where(and(eq(schema.teamSubmissions.id, sub.id), eq(schema.teamSubmissions.status, "pending")))
    .returning();
  if (!row) throw new TeamError("这篇已经处理过了");
  return row;
}

/** 团队里能审批的人（所有者、管理员） */
export async function reviewerIds(teamId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), inArray(schema.teamMembers.role, ["owner", "admin"])));
  return rows.map((r) => r.id);
}

/** 投稿后面跟着的发布任务（审批人和作者都能看结果） */
export async function submissionPost(sub: SubmissionRow): Promise<PostRow | null> {
  if (!sub.postId) return null;
  const db = await getDb();
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, sub.postId)).limit(1);
  return p ?? null;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "等审批",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

export function submissionView(s: SubmissionRow, post: PostRow | null, names: Map<string, string>) {
  return {
    id: s.id,
    tweets: s.tweets,
    note: s.note,
    status: s.status,
    statusLabel: STATUS_LABEL[s.status] ?? s.status,
    author: names.get(s.authorUserId) ?? "",
    reviewer: s.reviewerUserId ? (names.get(s.reviewerUserId) ?? "") : null,
    rejectReason: s.rejectReason,
    post: post && {
      status: post.status,
      scheduledAt: post.scheduledAt?.toISOString() ?? null,
      url: post.postIds[0] ? `https://x.com/${post.handle ?? "i"}/status/${post.postIds[0]}` : null,
      error: post.error,
    },
    createdAt: s.createdAt.toISOString(),
  };
}

export async function namesFor(ids: (string | null)[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const id of ids) if (id && !m.has(id)) m.set(id, await displayName(id));
  return m;
}
