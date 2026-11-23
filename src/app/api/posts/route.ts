import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError } from "@/lib/billing";
import { markQuoted } from "@/lib/inspiration";
import { createJob, MAX_THREAD, PublishError } from "@/lib/publish";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.posts)
    .where(eq(schema.posts.userId, user.id))
    .orderBy(desc(schema.posts.createdAt))
    .limit(200);
  return Response.json({ items });
}

const Create = z.object({
  tweets: z.array(z.string().max(2000)).min(1).max(MAX_THREAD),
  draftId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  /** 引用推文：被引用推文的 id */
  quoteTweetId: z.string().regex(/^\d{1,25}$/).optional(),
  /** 配图（挂在第一条上） */
  imageId: z.string().uuid().optional(),
});

/** 立即发布（scheduledAt 为空）或进入定时队列。前端在用户二次确认后才调用。 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    const job = await createJob(user.id, {
      tweets: parsed.data.tweets,
      draftId: parsed.data.draftId,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
      quoteTweetId: parsed.data.quoteTweetId,
      imageId: parsed.data.imageId,
    });
    if (parsed.data.quoteTweetId && (job.status === "published" || job.status === "scheduled")) {
      await markQuoted(user.id, parsed.data.quoteTweetId);
    }
    return Response.json({ item: job });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof PublishError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
