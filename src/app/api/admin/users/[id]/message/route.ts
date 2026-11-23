import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { adminMessage, AdminActionError } from "@/lib/users-admin";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ text: z.string().max(3500) });

/** 通过机器人给这个用户发一条客服消息 */
export async function POST(request: Request, { params }: Ctx) {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(id).success) return Response.json({ error: "请写消息内容" }, { status: 400 });
  try {
    await adminMessage(id, parsed.data.text);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AdminActionError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
