import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { savePlatformEnv } from "@/lib/platform-config";

const Body = z.object({
  clientId: z.string().trim().min(10).max(200).regex(/^[A-Za-z0-9_\-.:]+$/),
  clientSecret: z.string().trim().min(10).max(300).regex(/^[A-Za-z0-9_\-.:]+$/),
});

/** 在「发布」页粘贴 X 开发者后台的 Client ID 和 Secret，保存后立即生效（本机存 .env.local，服务器上加密存数据库） */
export async function POST(request: Request) {
  // X 应用密钥 / 平台机器人是整个平台共用的，只有管理员能改
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Client ID 或 Client Secret 格式不对，请确认复制完整、没有多余空格" }, { status: 400 });
  }
  await savePlatformEnv(request, { X_CLIENT_ID: parsed.data.clientId, X_CLIENT_SECRET: parsed.data.clientSecret });
  return Response.json({ ok: true });
}
