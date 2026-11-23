import "server-only";
import { and, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addBalance, fmtUsdt, itemLabel, ledgerLabel, MICRO, toMicro } from "./billing";
import { sendMessage } from "./tg-api";
import { afterTopup } from "./tg-bot-rewards";

/**
 * 后台「用户」页：按用户编号 / TG @用户名 / 邮箱 / X 账号找人，看余额、充值、用量、团队、邀请，
 * 手动充值或调整余额（必须写原因，记在用户的明细里，并记下是哪位管理员做的），通过机器人给用户发消息。
 * 只给管理员用：所有入口都在 /api/admin/users 下，先过 requireAdmin。
 */

/** 用户自己的编号（机器人「余额」和网页「账号」里显示） */
export async function userNo(userId: string): Promise<number | null> {
  const db = await getDb();
  const [u] = await db.select({ n: schema.users.userNo }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return u?.n ?? null;
}

export interface UserRow {
  id: string;
  no: number;
  email: string;
  name: string | null;
  tgUsername: string | null;
  tgName: string | null;
  tgBound: boolean;
  xHandle: string | null;
  balance: string;
  topupTotal: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** 搜索框里的内容 → 查询条件。纯数字按编号；@开头按 TG 用户名；带 @ 的按邮箱；其余在邮箱、TG、X、名字里模糊找 */
export function parseQuery(raw: string): { kind: "no"; no: number } | { kind: "tg"; name: string } | { kind: "text"; text: string } | null {
  const q = raw.trim().replace(/^(?:用户)?编号[:：]?\s*/, "");
  if (!q) return null;
  const n = q.replace(/^[#Uu]/, "");
  if (/^\d{1,9}$/.test(n)) return { kind: "no", no: Number(n) };
  const tg = q.match(/^(?:https?:\/\/)?(?:t\.me\/|@)([A-Za-z0-9_]{3,64})$/);
  if (tg) return { kind: "tg", name: tg[1] };
  return { kind: "text", text: q.slice(0, 100) };
}

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchUsers(raw: string, limit = 50): Promise<{ rows: UserRow[]; total: number }> {
  const db = await getDb();
  const U = schema.users;
  const B = schema.tgBindings;
  const X = schema.xAccounts;
  const p = parseQuery(raw);
  let where;
  if (!p) where = undefined;
  else if (p.kind === "no") where = eq(U.userNo, p.no);
  else if (p.kind === "tg") where = or(sql`lower(${B.tgUsername}) = ${p.name.toLowerCase()}`, sql`lower(${X.handle}) = ${p.name.toLowerCase()}`);
  else {
    const like = `%${esc(p.text)}%`;
    where = or(ilike(U.email, like), ilike(U.name, like), ilike(B.tgUsername, like), ilike(B.tgName, like), ilike(X.handle, like), eq(B.chatId, p.text));
  }
  const rows = await db
    .select({
      id: U.id,
      no: U.userNo,
      email: U.email,
      name: U.name,
      createdAt: U.createdAt,
      tgUsername: B.tgUsername,
      tgName: B.tgName,
      chatId: B.chatId,
      lastSeenAt: B.lastSeenAt,
      xHandle: X.handle,
      balance: schema.wallets.balanceMicro,
    })
    .from(U)
    .leftJoin(B, eq(B.userId, U.id))
    .leftJoin(X, eq(X.userId, U.id))
    .leftJoin(schema.wallets, eq(schema.wallets.userId, U.id))
    .where(where)
    .orderBy(desc(U.userNo))
    .limit(limit);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(U);
  const ids = rows.map((r) => r.id);
  const paid = ids.length
    ? await db
        .select({ userId: schema.ledger.userId, sum: sql<string>`coalesce(sum(${schema.ledger.amountMicro}), 0)` })
        .from(schema.ledger)
        .where(and(inArray(schema.ledger.userId, ids), eq(schema.ledger.kind, "topup")))
        .groupBy(schema.ledger.userId)
    : [];
  const paidOf = new Map(paid.map((r) => [r.userId, Number(r.sum)]));
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      no: r.no,
      email: r.email,
      name: r.name,
      tgUsername: r.tgUsername,
      tgName: r.tgName,
      tgBound: !!r.chatId,
      xHandle: r.xHandle,
      balance: fmtUsdt(r.balance ?? 0),
      topupTotal: fmtUsdt(paidOf.get(r.id) ?? 0),
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    })),
  };
}

/** 一个用户的详细情况 */
export async function userDetail(userId: string) {
  const db = await getDb();
  const U = schema.users;
  const L = schema.ledger;
  const [u] = await db
    .select({ id: U.id, no: U.userNo, email: U.email, name: U.name, createdAt: U.createdAt })
    .from(U)
    .where(eq(U.id, userId))
    .limit(1);
  if (!u) return null;
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const [[tg], [x], [wallet], ledgerRows, topups, [sums], usage, [membership], [invitedBy], invites] = await Promise.all([
    db.select().from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1),
    db
      .select({ handle: schema.xAccounts.handle, name: schema.xAccounts.name, authError: schema.xAccounts.authError, createdAt: schema.xAccounts.createdAt })
      .from(schema.xAccounts)
      .where(eq(schema.xAccounts.userId, userId))
      .limit(1),
    db.select().from(schema.wallets).where(eq(schema.wallets.userId, userId)).limit(1),
    db.select().from(L).where(eq(L.userId, userId)).orderBy(desc(L.createdAt)).limit(50),
    db.select().from(schema.topups).where(eq(schema.topups.userId, userId)).orderBy(desc(schema.topups.createdAt)).limit(20),
    db
      .select({
        topup: sql<string>`coalesce(sum(${L.amountMicro}) filter (where ${L.kind} = 'topup'), 0)`,
        topups: sql<number>`count(*) filter (where ${L.kind} = 'topup')::int`,
        spent: sql<string>`coalesce(-sum(${L.amountMicro}) filter (where ${L.kind} in ('charge', 'refund')), 0)`,
        spent30: sql<string>`coalesce(-sum(${L.amountMicro}) filter (where ${L.kind} in ('charge', 'refund') and ${L.createdAt} >= ${since30.toISOString()}::timestamptz), 0)`,
        adjust: sql<string>`coalesce(sum(${L.amountMicro}) filter (where ${L.kind} = 'adjust'), 0)`,
        bonus: sql<string>`coalesce(sum(${L.amountMicro}) filter (where ${L.kind} = 'bonus'), 0)`,
      })
      .from(L)
      .where(eq(L.userId, userId)),
    db
      .select({ item: L.item, n: sql<number>`coalesce(sum(${L.quantity}), 0)::int`, micro: sql<string>`coalesce(-sum(${L.amountMicro}), 0)` })
      .from(L)
      .where(and(eq(L.userId, userId), eq(L.kind, "charge"), gte(L.createdAt, since30)))
      .groupBy(L.item)
      .orderBy(sql`3 desc`),
    db
      .select({ teamId: schema.teamMembers.teamId, role: schema.teamMembers.role, teamName: schema.teams.name, ownerId: schema.teams.ownerUserId })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(eq(schema.teamMembers.userId, userId))
      .limit(1),
    db
      .select({ inviterId: schema.referrals.inviterUserId, status: schema.referrals.status, no: U.userNo, email: U.email })
      .from(schema.referrals)
      .innerJoin(U, eq(U.id, schema.referrals.inviterUserId))
      .where(eq(schema.referrals.inviteeUserId, userId))
      .limit(1),
    db
      .select({ id: U.id, no: U.userNo, email: U.email, status: schema.referrals.status, at: schema.referrals.createdAt })
      .from(schema.referrals)
      .innerJoin(U, eq(U.id, schema.referrals.inviteeUserId))
      .where(eq(schema.referrals.inviterUserId, userId))
      .orderBy(desc(schema.referrals.createdAt))
      .limit(50),
  ]);
  let team: { name: string; role: string; members: number; ownerNo: number | null } | null = null;
  if (membership) {
    const [[{ members }], [owner]] = await Promise.all([
      db.select({ members: sql<number>`count(*)::int` }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, membership.teamId)),
      db.select({ no: U.userNo }).from(U).where(eq(U.id, membership.ownerId)).limit(1),
    ]);
    team = { name: membership.teamName, role: membership.role, members, ownerNo: owner?.no ?? null };
  }
  // 管理员操作记在 ref_id（admin:邮箱），后台显示是谁做的
  const by = (refId: string | null) => (refId?.startsWith("admin:") ? refId.slice(6) : null);
  return {
    user: { id: u.id, no: u.no, email: u.email, name: u.name, createdAt: u.createdAt.toISOString() },
    tg: tg
      ? {
          bound: !!tg.chatId,
          chatId: tg.chatId,
          username: tg.tgUsername,
          name: tg.tgName,
          boundAt: tg.boundAt?.toISOString() ?? null,
          lastSeenAt: tg.lastSeenAt?.toISOString() ?? null,
        }
      : null,
    x: x ? { handle: x.handle, name: x.name, ok: !x.authError, connectedAt: x.createdAt.toISOString() } : null,
    wallet: {
      balance: fmtUsdt(wallet?.balanceMicro ?? 0),
      bonus: fmtUsdt(wallet?.bonusMicro ?? 0),
      bonusExpiresAt: wallet?.bonusExpiresAt?.toISOString() ?? null,
    },
    totals: {
      topup: fmtUsdt(Number(sums.topup)),
      topups: sums.topups,
      spent: fmtUsdt(Number(sums.spent)),
      spent30: fmtUsdt(Number(sums.spent30)),
      adjust: fmtUsdt(Number(sums.adjust)),
      bonus: fmtUsdt(Number(sums.bonus)),
    },
    usage30: usage.map((r) => ({ item: r.item ?? "", label: itemLabel(r.item) || r.item || "其他", count: r.n, amount: fmtUsdt(Number(r.micro)) })),
    ledger: ledgerRows.map((r) => ({
      at: r.createdAt.toISOString(),
      kind: r.kind,
      text: ledgerLabel(r),
      amount: (r.amountMicro >= 0 ? "+" : "") + fmtUsdt(r.amountMicro),
      balanceAfter: fmtUsdt(r.balanceAfterMicro),
      note: r.note,
      by: by(r.refId),
    })),
    topups: topups.map((t) => ({
      at: t.createdAt.toISOString(),
      chain: t.chain,
      due: fmtUsdt(t.dueMicro),
      received: t.receivedMicro != null ? fmtUsdt(t.receivedMicro) : null,
      status: t.status,
      txid: t.txid,
    })),
    team,
    invitedBy: invitedBy ? { id: invitedBy.inviterId, no: invitedBy.no, email: invitedBy.email, status: invitedBy.status } : null,
    invites: invites.map((r) => ({ id: r.id, no: r.no, email: r.email, status: r.status, at: r.at.toISOString() })),
  };
}

export class AdminActionError extends Error {}

/**
 * 管理员手动改余额：
 * - topup：用户用别的方式付了钱（例如私下转账），算作一次真实充值，计入收入，也会触发首充奖励、邀请奖励
 * - adjust：补偿、退款、扣回，不算收入（金额可正可负）
 * 原因写进明细（用户能看到），ref_id 记下是哪位管理员做的。
 */
export async function adminCredit(
  admin: { email: string },
  userId: string,
  input: { amount: number; kind: "topup" | "adjust"; note: string; notify: boolean },
): Promise<{ balance: string }> {
  const amountMicro = toMicro(input.amount);
  if (!Number.isFinite(input.amount) || amountMicro === 0 || Math.abs(amountMicro) > 100_000 * MICRO) throw new AdminActionError("金额不对");
  if (input.kind === "topup" && amountMicro < 0) throw new AdminActionError("手动充值只能是正数；要扣钱请选「调整」");
  const note = input.note.trim().slice(0, 200);
  if (!note) throw new AdminActionError("请写原因");
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) throw new AdminActionError("找不到这个用户");
  const balance = await addBalance(userId, amountMicro, {
    kind: input.kind,
    note,
    refId: `admin:${admin.email}`,
  });
  if (input.kind === "topup") await afterTopup(userId, amountMicro, null).catch(() => null);
  if (input.notify) {
    const chatId = await tgChatOf(userId);
    if (chatId) {
      const head = input.kind === "topup" ? "充值到账 ✓" : amountMicro > 0 ? "余额已补发 ✓" : "余额已调整";
      await sendMessage(chatId, `${head}\n${amountMicro > 0 ? "+" : ""}${fmtUsdt(amountMicro)} USDT（${note}）\n当前余额 ${fmtUsdt(balance)} USDT`).catch(() => {});
    }
  }
  return { balance: fmtUsdt(balance) };
}

async function tgChatOf(userId: string): Promise<string | null> {
  const db = await getDb();
  const [b] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
  return b?.chatId ?? null;
}

/** 通过机器人给用户发一条消息（以「客服消息」开头，用户知道是平台发的） */
export async function adminMessage(userId: string, text: string): Promise<void> {
  const body = text.trim().slice(0, 3500);
  if (!body) throw new AdminActionError("消息不能为空");
  const chatId = await tgChatOf(userId);
  if (!chatId) throw new AdminActionError("这个用户还没绑定 TG，发不了");
  try {
    await sendMessage(chatId, `📮 客服消息\n\n${body}`);
  } catch (e) {
    throw new AdminActionError(`发送失败：${e instanceof Error ? e.message : String(e)}（可能用户把机器人停用了）`);
  }
}
