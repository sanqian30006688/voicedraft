import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createLearning, decideLearning, styleErrorResponse } from "@/lib/style-actions";

/** 让 AI 根据上次总结之后的修改，生成风格卡更新建议（待用户确认） */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    const row = await createLearning(user.id);
    return Response.json({ id: row.id });
  } catch (err) {
    return styleErrorResponse(err, "总结失败，请稍后重试");
  }
}

const Decide = z.object({ id: z.string().uuid(), action: z.enum(["accept", "dismiss"]) });

/** 采纳（写入风格卡新版本）或忽略建议 */
export async function PATCH(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Decide.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    const { version } = await decideLearning(user.id, parsed.data.id, parsed.data.action);
    return Response.json({ ok: true, version });
  } catch (err) {
    return styleErrorResponse(err, "保存失败，请稍后重试");
  }
}
