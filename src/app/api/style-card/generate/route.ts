import { requireUser } from "@/lib/auth";
import { generateStyleCard, styleErrorResponse } from "@/lib/style-actions";

/** 生成 / 重新生成风格卡（保存为新版本） */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await generateStyleCard(user.id));
  } catch (err) {
    return styleErrorResponse(err, "生成风格卡失败，请稍后重试");
  }
}
