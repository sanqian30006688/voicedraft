import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { endSession, requireUser } from "@/lib/auth";
import { countEdits, editsSinceLastLearning, getActiveCard, LEARN_THRESHOLD } from "@/lib/data";
import { canUse, fmtUsdt, getBalance, getConfig, isAdmin, teamLink } from "@/lib/billing";
import { isMock } from "@/lib/llm";
import { getAccount, isXConfigured } from "@/lib/x";
import { userNo } from "@/lib/users-admin";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const db = await getDb();
  const [[{ samples }], card, edits, newEdits, xAcc, balance, admin, cfg] = await Promise.all([
    db
      .select({ samples: sql<number>`count(*)::int` })
      .from(schema.samples)
      .where(eq(schema.samples.userId, user.id)),
    getActiveCard(user.id),
    countEdits(user.id),
    editsSinceLastLearning(user.id),
    getAccount(user.id),
    getBalance(user.id),
    isAdmin(user),
    getConfig(),
  ]);
  const [usable, team, no] = await Promise.all([canUse(user.id), teamLink(user.id), userNo(user.id)]);
  return Response.json({
    user: { ...user, no },
    samples,
    edits,
    learnReady: newEdits.length >= LEARN_THRESHOLD,
    card: card ? { version: card.version, lang: card.lang } : null,
    mock: isMock(),
    xConfigured: isXConfigured(),
    x: xAcc && { handle: xAcc.handle, authError: xAcc.authError },
    balance: fmtUsdt(balance),
    billing: cfg.enabled && !(admin && !cfg.chargeAdmin),
    // 团队成员：团队额度还能用就不算余额不足
    lowBalance: cfg.enabled && !(admin && !cfg.chargeAdmin) && !usable,
    team: team && { role: team.role },
    admin,
  });
}

/** 删除账号及全部数据（素材、风格卡、修改记录、会话、X 授权、发布记录都随用户级联删除） */
export async function DELETE() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const db = await getDb();
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await endSession();
  return Response.json({ ok: true });
}
