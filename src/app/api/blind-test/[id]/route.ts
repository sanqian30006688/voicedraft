import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { styleErrorResponse, submitBlindTest } from "@/lib/style-actions";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ guesses: z.array(z.number().int().min(0)).max(20) });

/** 提交答案：guesses 是用户认为「AI 写的」条目下标 */
export async function POST(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  try {
    const { texts: _texts, ...result } = await submitBlindTest(user.id, id, parsed.data.guesses);
    void _texts;
    return Response.json(result);
  } catch (err) {
    return styleErrorResponse(err, "提交失败，请稍后重试");
  }
}
