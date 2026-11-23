import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { saveFollowSettings } from "@/lib/follow-replies";
import { decrypt } from "@/lib/secret";
import { getAccount, isXConfigured, isXMock, redirectUri, revokeToken } from "@/lib/x";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const acc = await getAccount(user.id);
  return Response.json({
    configured: isXConfigured(),
    mock: isXMock(),
    redirectUri: redirectUri(),
    account: acc && {
      handle: acc.handle,
      name: acc.name,
      authError: acc.authError,
      autoReplyEnabled: acc.autoReplyEnabled,
      autoReplyIntervalMin: acc.autoReplyIntervalMin,
      skipKeywords: acc.skipKeywords,
      skipHandles: acc.skipHandles,
      maxRounds: acc.maxRounds,
      lastCheckedAt: acc.lastCheckedAt,
      pausedUntil: acc.pausedUntil,
      pausedReason: acc.pausedReason,
      timelineEnabled: acc.timelineEnabled,
      timelineIntervalMin: acc.timelineIntervalMin,
      timelineKeywords: acc.timelineKeywords,
      timelineHandles: acc.timelineHandles,
      timelineDailyCap: acc.timelineDailyCap,
      timelineReadLimit: acc.timelineReadLimit,
      timelineCheckedAt: acc.timelineCheckedAt,
      timelinePausedReason: acc.timelinePausedReason,
    },
  });
}

const Patch = z.object({
  autoReplyEnabled: z.boolean().optional(),
  autoReplyIntervalMin: z.number().int().min(5).max(1440).optional(),
  skipKeywords: z.array(z.string().trim().min(1).max(50)).max(100).optional(),
  skipHandles: z.array(z.string().trim().min(1).max(50)).max(500).optional(),
  maxRounds: z.number().int().min(0).max(50).optional(),
  timelineEnabled: z.boolean().optional(),
  timelineIntervalMin: z.number().int().min(30).max(1440).optional(),
  timelineKeywords: z.array(z.string().trim().min(1).max(50)).max(100).optional(),
  timelineHandles: z.array(z.string().trim().min(1).max(50)).max(500).optional(),
  timelineDailyCap: z.number().int().min(1).max(50).optional(),
  timelineReadLimit: z.number().int().min(5).max(100).optional(),
});

export async function PATCH(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const { timelineEnabled, timelineIntervalMin, timelineKeywords, timelineHandles, timelineDailyCap, timelineReadLimit, ...mention } = parsed.data;
  const follow = { timelineEnabled, timelineIntervalMin, timelineKeywords, timelineHandles, timelineDailyCap, timelineReadLimit };
  if (Object.values(follow).some((v) => v !== undefined) && !(await saveFollowSettings(user.id, follow))) {
    return Response.json({ error: "还没有连接 X 账号" }, { status: 404 });
  }
  const db = await getDb();
  const rows = await db
    .update(schema.xAccounts)
    .set({
      ...mention,
      // 手动重新开启时清掉之前的暂停原因
      ...(mention.autoReplyEnabled ? { pausedReason: null, pausedUntil: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.xAccounts.userId, user.id))
    .returning({ id: schema.xAccounts.id });
  if (!rows.length) return Response.json({ error: "还没有连接 X 账号" }, { status: 404 });
  return Response.json({ ok: true });
}

/** 断开 X 账号：撤销令牌并删除本地保存的令牌。未发出的定时任务会在发布时失败，可重新连接后重试。 */
export async function DELETE() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const acc = await getAccount(user.id);
  if (acc) {
    try {
      await revokeToken(decrypt(acc.accessTokenEnc));
    } catch {
      // 撤销失败不影响断开
    }
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.id, acc.id));
  }
  return Response.json({ ok: true });
}
