import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { savePlatformEnv } from "@/lib/platform-config";
import { callBot, isValidBotToken } from "@/lib/telegram";

/**
 * 平台方配置共享机器人：粘贴 @BotFather 给的 Token，验证后保存并立即生效（本机存 .env.local，服务器上加密存数据库）。
 * 普通用户不需要做这一步，只需要点「绑定 TG」。
 */
export async function POST(request: Request) {
  // X 应用密钥 / 平台机器人是整个平台共用的，只有管理员能改
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = z.object({ token: z.string().trim().max(100) }).safeParse(await request.json().catch(() => null));
  const token = parsed.success ? parsed.data.token : "";
  if (!isValidBotToken(token)) {
    return Response.json({ error: "Token 格式不对：应该像 123456789:AAH… 这样，一串数字 + 冒号 + 一串字母" }, { status: 400 });
  }
  try {
    const me = await callBot<{ username: string }>("getMe", {}, token);
    await savePlatformEnv(request, { TELEGRAM_BOT_TOKEN: token });
    return Response.json({ ok: true, username: me.username });
  } catch (e) {
    return Response.json({ error: `Telegram 不认这个 Token：${e instanceof Error ? e.message : e}` }, { status: 400 });
  }
}
