import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";

/** 回复队列：?view=todo（待回复、失败）或 ?view=done（已回复、已跳过） */
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const view = new URL(request.url).searchParams.get("view") === "done" ? "done" : "todo";
  const statuses = view === "todo" ? ["pending", "failed", "sending"] : ["sent", "skipped", "deleted"];
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.replyItems)
    .where(and(eq(schema.replyItems.userId, user.id), inArray(schema.replyItems.status, statuses)))
    .orderBy(desc(view === "todo" ? schema.replyItems.createdAt : schema.replyItems.updatedAt))
    .limit(200);
  return Response.json({ items });
}
