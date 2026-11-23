import { startSession } from "@/lib/auth";
import { consumeWebLogin } from "@/lib/web-login";

/** 机器人里 /web 给的一次性登录链接 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = await consumeWebLogin(url.searchParams.get("t") ?? "");
  if (!userId) return Response.redirect(`${url.origin}/login?error=${encodeURIComponent("登录链接已过期或用过了，请在机器人里重新发 /web")}`, 302);
  await startSession(userId);
  return Response.redirect(`${url.origin}/`, 302);
}
