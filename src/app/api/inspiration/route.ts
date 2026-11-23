import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { addByLink, BOOKMARK_SCOPE, syncBookmarks } from "@/lib/inspiration";
import { PublishError } from "@/lib/publish";
import { getAccount, hasScope, XApiError } from "@/lib/x";

/** 灵感列表：?view=new（待处理）或 ?view=done（已用、不感兴趣） */
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const view = new URL(request.url).searchParams.get("view") === "done" ? "done" : "new";
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.inspirations)
    .where(
      and(
        eq(schema.inspirations.userId, user.id),
        inArray(schema.inspirations.status, view === "new" ? ["new"] : ["used", "dismissed"]),
      ),
    )
    .orderBy(desc(view === "new" ? schema.inspirations.createdAt : schema.inspirations.updatedAt))
    .limit(300);
  const acc = await getAccount(user.id);
  return Response.json({
    items,
    account: acc && {
      handle: acc.handle,
      authError: acc.authError,
      canReadBookmarks: hasScope(acc, BOOKMARK_SCOPE),
    },
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("add"), url: z.string().min(1).max(500) }),
]);

export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    if (parsed.data.action === "sync") return Response.json(await syncBookmarks(user.id));
    return Response.json({ item: await addByLink(user.id, parsed.data.url) });
  } catch (e) {
    if (e instanceof PublishError || e instanceof XApiError) {
      return Response.json({ error: e.message, kind: e instanceof XApiError ? e.kind : undefined }, { status: 422 });
    }
    throw e;
  }
}
