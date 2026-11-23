import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { draftFinalText } from "@/lib/draft-text";
import { MetaSchema, SentenceSchema as Sentence } from "@/lib/draft-schema";

type Ctx = { params: Promise<{ id: string }> };

const idOk = (id: string) => z.string().uuid().safeParse(id).success;

const Patch = z.object({
  topic: z.string().trim().min(1).max(500).optional(),
  mode: z.enum(["quick", "sentence", "single", "thread", "article"]).optional(),
  sentences: z.array(Sentence).max(60).optional(),
  meta: MetaSchema.optional(),
  status: z.enum(["draft", "copied"]).optional(),
});

export async function GET(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这篇草稿" }, { status: 404 });
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, user.id)))
    .limit(1);
  if (!row) return Response.json({ error: "找不到这篇草稿" }, { status: 404 });
  return Response.json({
    id: row.id,
    topic: row.topic,
    mode: row.mode,
    status: row.status,
    sentences: row.sentences,
    meta: row.meta,
    sourceItemId: row.sourceItemId,
    updatedAt: row.updatedAt,
  });
}

export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const { sentences, status, meta, ...rest } = parsed.data;
  const db = await getDb();
  // 成品文本依赖模式和附加信息；只改了其中一部分时，用库里的其余部分补齐
  let finalText: string | undefined;
  // 选好的配图由配图接口单独记，保存草稿时保留
  let keepImage: string | undefined;
  if (sentences || meta || rest.mode) {
    const [cur] = await db
      .select({ mode: schema.drafts.mode, sentences: schema.drafts.sentences, meta: schema.drafts.meta })
      .from(schema.drafts)
      .where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, user.id)))
      .limit(1);
    if (!cur) return Response.json({ error: "找不到这篇草稿" }, { status: 404 });
    keepImage = cur.meta?.imageId;
    finalText = draftFinalText(
      rest.mode ?? cur.mode,
      (sentences ?? cur.sentences).map((s) => s.text),
      meta ?? cur.meta,
    );
  }
  // 已排期 / 已发布的草稿，复制后状态不变
  if (status === "copied") {
    await db
      .update(schema.drafts)
      .set({ status })
      .where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, user.id), eq(schema.drafts.status, "draft")));
  }
  const rows = await db
    .update(schema.drafts)
    .set({
      ...rest,
      ...(status === "draft" ? { status } : {}),
      ...(sentences ? { sentences } : {}),
      ...(meta ? { meta: keepImage ? { ...meta, imageId: keepImage } : meta } : {}),
      ...(finalText !== undefined ? { finalText } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, user.id)))
    .returning({ id: schema.drafts.id });
  if (!rows.length) return Response.json({ error: "找不到这篇草稿" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const db = await getDb();
  await db.delete(schema.drafts).where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, user.id)));
  return Response.json({ ok: true });
}
