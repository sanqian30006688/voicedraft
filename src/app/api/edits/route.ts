import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";

const Body = z.object({
  original: z.string().min(1).max(1000),
  edited: z.string().min(1).max(1000),
  draftId: z.string().uuid().optional(),
});

/** 记录一次「候选原文 → 用户改写」，下次生成会带上最近 10 次 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.original === parsed.data.edited) {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  const db = await getDb();
  const { draftId, ...pair } = parsed.data;
  // 只关联属于本人的草稿
  const owned = draftId
    ? (
        await db
          .select({ id: schema.drafts.id })
          .from(schema.drafts)
          .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, user.id)))
      ).length > 0
    : false;
  await db.insert(schema.editLogs).values({ userId: user.id, ...pair, draftId: owned ? draftId : null });
  return Response.json({ ok: true });
}
