import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { AnnounceError, createManual, getAnnounceConfig, listAnnouncements, recipientCount, saveAnnounceConfig, startSending } from "@/lib/announce";

/** 后台：功能更新和公告（设置、草稿、发送记录） */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const [config, recipients, items] = await Promise.all([getAnnounceConfig(), recipientCount(), listAnnouncements(20)]);
  return Response.json({ config, recipients, items });
}

const Config = z.object({ mode: z.enum(["review", "auto", "off"]), delayMin: z.number().int().min(0).max(24 * 60) });

/** 改自动公告的方式 */
export async function PUT(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Config.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "有一项填得不对，请检查" }, { status: 400 });
  return Response.json({ config: await saveAnnounceConfig(parsed.data) });
}

const Create = z.object({ body: z.string(), urgent: z.boolean().default(false), send: z.boolean().default(false) });

/** 手写一条公告：send=true 直接开始群发，否则存成草稿 */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "公告内容不对，请检查" }, { status: 400 });
  try {
    let ann = await createManual(user.id, parsed.data.body, parsed.data.urgent);
    if (parsed.data.send) ann = await startSending(ann.id);
    return Response.json({ ok: true, announcement: ann });
  } catch (e) {
    if (e instanceof AnnounceError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
