import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { botUsername } from "@/lib/telegram";
import { adminChats, diagnoseGate, gateErrors, GateConfigError, getGate, MAX_GATE_CHATS, saveGate } from "@/lib/tg-gate";

/** 后台：「必须关注频道 / 进群才能用机器人」 */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  return Response.json({
    gate: await getGate(),
    errors: gateErrors(),
    adminChats: await adminChats(),
    botUsername: await botUsername().catch(() => null),
  });
}

const Chat = z.object({
  chat: z.string().trim().max(200),
  title: z.string().trim().max(60).optional(),
  invite: z.string().trim().max(300).optional(),
});
const Body = z.object({ enabled: z.boolean(), chats: z.array(Chat).max(MAX_GATE_CHATS) });

/** 保存；保存前自动检测一遍，顺便把频道名记下来（按钮上显示） */
export async function PUT(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "填得不对，请检查" }, { status: 400 });
  const chats = parsed.data.chats.filter((c) => c.chat || c.invite);
  try {
    const diag = await diagnoseGate(chats);
    const named = chats.map((c, i) => ({ ...c, title: c.title || diag[i]?.title }));
    await saveGate({ enabled: parsed.data.enabled, chats: named });
    return Response.json({ ok: true, diag });
  } catch (e) {
    if (e instanceof GateConfigError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** 只检测不保存 */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "填得不对，请检查" }, { status: 400 });
  return Response.json({ diag: await diagnoseGate(parsed.data.chats.filter((c) => c.chat)) });
}
