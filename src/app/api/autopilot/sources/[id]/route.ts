import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { fmtWait, hit } from "@/lib/rate-limit";
import { setSourceAutopilot, setSourceInterval, sourceErrorText } from "@/lib/sources";
import { refreshSource, removeSource, setSourceEnabled } from "@/lib/tg-feed";

type Ctx = { params: Promise<{ id: string }> };
const idOk = (id: string) => z.string().uuid().safeParse(id).success;

/** 立即检查一次 */
export async function POST(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这个信息源" }, { status: 404 });
  const r = hit(`src:refresh:${user.id}`, 30, 3600_000);
  if (!r.ok) return Response.json({ error: `点得太频繁了，请 ${fmtWait(r.retryAfterMs)}后再试` }, { status: 429 });
  try {
    return Response.json({ added: await refreshSource(user.id, id) });
  } catch (e) {
    return Response.json({ error: sourceErrorText(e) ?? (e instanceof Error ? e.message : "读取失败") }, { status: 502 });
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = z
    .object({ autopilot: z.boolean().optional(), enabled: z.boolean().optional(), intervalMin: z.number().int().min(15).max(1440).optional() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success || !idOk(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  if (parsed.data.autopilot !== undefined) await setSourceAutopilot(user.id, id, parsed.data.autopilot);
  if (parsed.data.enabled !== undefined) await setSourceEnabled(user.id, id, parsed.data.enabled);
  if (parsed.data.intervalMin !== undefined) await setSourceInterval(user.id, id, parsed.data.intervalMin);
  return Response.json({ ok: true });
}

/** 删除；已收进灵感的内容保留 */
export async function DELETE(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!idOk(id)) return Response.json({ error: "找不到这个信息源" }, { status: 404 });
  await removeSource(user.id, id, true);
  return Response.json({ ok: true });
}
