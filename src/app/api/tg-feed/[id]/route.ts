import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getItem, ITEM_STATUSES, updateItem } from "@/lib/tg-feed";

type Ctx = { params: Promise<{ id: string }> };
const idOk = (id: string) => z.string().uuid().safeParse(id).success;
const NOT_FOUND = () => Response.json({ error: "找不到这条内容" }, { status: 404 });

/** 一条灵感（起草页显示来源、算相似度用） */
export async function GET(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return NOT_FOUND();
  const item = await getItem(user.id, id);
  if (!item) return NOT_FOUND();
  return Response.json({
    id: item.id,
    text: item.text,
    url: item.url,
    author: item.author,
    points: item.points,
    status: item.status,
  });
}

const Patch = z.object({ status: z.enum(ITEM_STATUSES) });

/** 收藏 / 忽略 / 恢复 */
export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  if (!(await updateItem(user.id, id, parsed.data))) return NOT_FOUND();
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return NOT_FOUND();
  const db = await getDb();
  await db.delete(schema.feedItems).where(and(eq(schema.feedItems.id, id), eq(schema.feedItems.userId, user.id)));
  return Response.json({ ok: true });
}
