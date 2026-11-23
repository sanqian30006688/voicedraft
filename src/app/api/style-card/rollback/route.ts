import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rollbackCard, styleErrorResponse } from "@/lib/style-actions";

const Body = z.object({ id: z.string().uuid() });

/** 回滚：把某个历史版本的内容另存为一个新版本，历史记录不丢 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    return Response.json(await rollbackCard(user.id, parsed.data.id));
  } catch (err) {
    return styleErrorResponse(err, "恢复失败，请稍后重试");
  }
}
