import { requireAdmin } from "@/lib/admin";
import { botToken } from "@/lib/tg-api";
import { isXConfigured, isXMock, redirectUri } from "@/lib/x";

/** 后台：平台密钥的配置状态（开源版没有计费设置，这里只报各家密钥配没配） */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  return Response.json({
    platform: {
      xConfigured: isXConfigured(),
      xMock: isXMock(),
      redirectUri: redirectUri(),
      tgConfigured: !!botToken(),
      aiConfigured: !!process.env.ANTHROPIC_API_KEY,
      imageAiConfigured: !!process.env.GEMINI_API_KEY,
    },
  });
}
