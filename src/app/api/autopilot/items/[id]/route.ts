import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { approveAuto, editAuto, rewriteAuto, skipAuto } from "@/lib/autopilot";
import { InsufficientBalanceError, UsageLimitError } from "@/lib/billing";
import { GenerationError } from "@/lib/llm";
import { PublishError } from "@/lib/publish";
import { XApiError } from "@/lib/x";

type Ctx = { params: Promise<{ id: string }> };

/** 处理一条自动帖：排进定时 / 立即发 / 改 / 换个写法 / 跳过 */
export async function POST(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = z
    .object({ action: z.enum(["approve", "now", "edit", "rewrite", "skip"]), text: z.string().max(2000).optional() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(id).success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const { action, text } = parsed.data;
  try {
    if (action === "approve" || action === "now") {
      if (text !== undefined) await editAuto(user.id, id, text);
      const r = await approveAuto(user.id, id, { now: action === "now" });
      return Response.json({ ok: true, status: r.row.status, error: r.job.error });
    }
    if (action === "edit") return Response.json({ ok: true, item: await editAuto(user.id, id, text ?? "") });
    if (action === "rewrite") return Response.json({ ok: true, item: await rewriteAuto(user.id, id) });
    await skipAuto(user.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof PublishError || e instanceof InsufficientBalanceError || e instanceof UsageLimitError || e instanceof GenerationError || e instanceof XApiError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    console.error(e);
    return Response.json({ error: "操作失败，请稍后重试" }, { status: 500 });
  }
}
