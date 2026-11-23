import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";

const Patch = z.object({ excluded: z.boolean().optional(), pinned: z.boolean().optional() });

type Ctx = { params: Promise<{ id: string }> };

const idOk = (id: string) => z.string().uuid().safeParse(id).success;

export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const db = await getDb();
  const rows = await db
    .update(schema.samples)
    .set(parsed.data)
    .where(and(eq(schema.samples.id, id), eq(schema.samples.userId, user.id)))
    .returning({ id: schema.samples.id });
  if (!rows.length) return Response.json({ error: "找不到这条素材" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const db = await getDb();
  await db.delete(schema.samples).where(and(eq(schema.samples.id, id), eq(schema.samples.userId, user.id)));
  return Response.json({ ok: true });
}
