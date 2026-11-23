import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { savePlatformEnv } from "@/lib/platform-config";

/** 管理员填写 Google Gemini API Key（AI 配图用），保存后立即生效 */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = z
    .object({ key: z.string().trim().regex(/^[A-Za-z0-9_\-]{30,200}$/) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "格式不对：应该是一长串字母数字（通常 AIza 开头）" }, { status: 400 });
  await savePlatformEnv(request, { GEMINI_API_KEY: parsed.data.key });
  return Response.json({ ok: true });
}
