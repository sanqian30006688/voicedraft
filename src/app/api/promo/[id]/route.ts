import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { PromoLinkFields } from "@/lib/promo-data";

type Ctx = { params: Promise<{ id: string }> };

const idOk = (id: string) => z.string().uuid().safeParse(id).success;

export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这条推广链接" }, { status: 404 });
  const parsed = PromoLinkFields.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "格式不对" }, { status: 400 });
  }
  const db = await getDb();
  const updated = await db
    .update(schema.promoLinks)
    .set(parsed.data)
    .where(and(eq(schema.promoLinks.id, id), eq(schema.promoLinks.userId, user.id)))
    .returning({ id: schema.promoLinks.id });
  if (!updated.length) return Response.json({ error: "找不到这条推广链接" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这条推广链接" }, { status: 404 });
  const db = await getDb();
  // 默认链接被删时，promo_settings.default_link_id 由外键自动置空
  await db
    .delete(schema.promoLinks)
    .where(and(eq(schema.promoLinks.id, id), eq(schema.promoLinks.userId, user.id)));
  return Response.json({ ok: true });
}
