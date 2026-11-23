import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { addSamples, listSamples } from "@/lib/data";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { items, total } = await listSamples(user.id);
  return Response.json({
    total,
    items: items.map((s) => ({
      id: s.id,
      content: s.content,
      lang: s.lang,
      source: s.source,
      postedAt: s.postedAt,
      excluded: s.excluded,
      pinned: s.pinned,
    })),
  });
}

const ImportBody = z.object({
  source: z.enum(["paste", "file", "x_archive"]),
  items: z
    .array(z.object({ content: z.string().max(5000), postedAt: z.string().optional() }))
    .min(1)
    .max(2000),
});

/** 导入一批素材（大文件由浏览器分批发送，每批最多 2000 条） */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = ImportBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "导入内容格式不对" }, { status: 400 });
  const result = await addSamples(user.id, parsed.data.items, parsed.data.source);
  return Response.json(result);
}

/** 删除全部素材 */
export async function DELETE() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const db = await getDb();
  await db.delete(schema.samples).where(eq(schema.samples.userId, user.id));
  return Response.json({ ok: true });
}
