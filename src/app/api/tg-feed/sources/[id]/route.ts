import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { refreshSource, removeSource, setSourceEnabled } from "@/lib/tg-feed";

type Ctx = { params: Promise<{ id: string }> };
const idOk = (id: string) => z.string().uuid().safeParse(id).success;

/** 立即检查这个频道的新消息 */
export async function POST(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这个频道" }, { status: 404 });
  try {
    const added = await refreshSource(user.id, id);
    return Response.json({ added });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "读取失败" }, { status: 502 });
  }
}

/** 暂停 / 恢复自动检查 */
export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success || !idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  await setSourceEnabled(user.id, id, parsed.data.enabled);
  return Response.json({ ok: true });
}

/** 取消订阅；?keep=1 时保留已收进来的内容 */
export async function DELETE(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这个频道" }, { status: 404 });
  await removeSource(user.id, id, new URL(request.url).searchParams.get("keep") === "1");
  return Response.json({ ok: true });
}
