import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getActiveCard } from "@/lib/data";
import { MetaSchema, SentenceSchema } from "@/lib/draft-schema";
import { draftFinalText } from "@/lib/draft-text";
import { getItem, updateItem } from "@/lib/tg-feed";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.drafts.id,
      topic: schema.drafts.topic,
      mode: schema.drafts.mode,
      status: schema.drafts.status,
      finalText: schema.drafts.finalText,
      updatedAt: schema.drafts.updatedAt,
    })
    .from(schema.drafts)
    .where(eq(schema.drafts.userId, user.id))
    .orderBy(desc(schema.drafts.updatedAt))
    .limit(200);
  return Response.json({ items: rows });
}

const Create = z.object({
  topic: z.string().trim().min(1).max(500),
  mode: z.enum(["quick", "sentence", "single", "thread", "article"]),
  sentences: z.array(SentenceSchema).max(60),
  meta: MetaSchema.optional(),
  sourceItemId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const card = await getActiveCard(user.id);
  const db = await getDb();
  const { sourceItemId, ...fields } = parsed.data;
  // 来源只能是自己灵感池里的内容；起草后标记为「已用」
  const source = sourceItemId ? await getItem(user.id, sourceItemId) : null;
  if (source && source.status !== "saved") await updateItem(user.id, source.id, { status: "used" });
  const [row] = await db
    .insert(schema.drafts)
    .values({
      userId: user.id,
      ...fields,
      sourceItemId: source?.id ?? null,
      finalText: draftFinalText(
        parsed.data.mode,
        parsed.data.sentences.map((s) => s.text),
        parsed.data.meta,
      ),
      styleCardVersion: card?.version ?? null,
    })
    .returning({ id: schema.drafts.id });
  return Response.json({ id: row.id });
}
