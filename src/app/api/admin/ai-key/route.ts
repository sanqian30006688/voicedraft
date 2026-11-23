import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { savePlatformEnv } from "@/lib/platform-config";

/** 管理员填写 Anthropic API Key（AI 生成用），保存后立即生效 */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = z
    .object({ key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_\-]{20,300}$/) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "格式不对：应该是 sk-ant- 开头的一长串" }, { status: 400 });
  await savePlatformEnv(request, { ANTHROPIC_API_KEY: parsed.data.key });
  return Response.json({ ok: true });
}
