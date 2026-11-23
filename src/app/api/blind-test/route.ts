import { requireUser } from "@/lib/auth";
import { blindHistory, createBlindTest, styleErrorResponse } from "@/lib/style-actions";

/** 历史盲测结果 */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json({ items: await blindHistory(user.id) });
}

/** 新建一次盲测：随机抽 5 条真实推文，AI 各写一条同话题的，打乱顺序 */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await createBlindTest(user.id));
  } catch (err) {
    return styleErrorResponse(err, "生成盲测失败，请稍后重试");
  }
}
