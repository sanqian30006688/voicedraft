import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { exchangeCode, saveAccount, XApiError } from "@/lib/x";
import { notifyXConnect, TG_X_LANDING } from "@/lib/tg-bot-home";

/** X 授权完成后回到这里：用授权码换令牌，加密保存，再跳回「发布」页 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const db = await getDb();
  const [row] = state
    ? await db.select().from(schema.xOauthStates).where(eq(schema.xOauthStates.state, state)).limit(1)
    : [];
  if (row) await db.delete(schema.xOauthStates).where(eq(schema.xOauthStates.state, state));
  // returnTo 是授权完成后要回到的页面；旧版本只存了域名，补上「发布」页
  const target = row?.returnTo ? (new URL(row.returnTo).pathname === "/" ? `${row.returnTo}/publish` : row.returnTo) : `${url.origin}/publish`;
  // 从 TG 机器人发起的：结果同时发到机器人里，告诉下一步
  const fromTg = !!row?.returnTo && new URL(row.returnTo).pathname === TG_X_LANDING;
  const back = async (q: string, error?: string) => {
    if (fromTg && row) await notifyXConnect(row.userId, error ? { ok: false, reason: error } : { ok: true }).catch(() => {});
    return Response.redirect(`${target}?${q}`, 302);
  };
  const fail = (reason: string) => back(`x_error=${encodeURIComponent(reason)}`, reason);

  if (!row || row.expiresAt < new Date()) return fail("授权链接已过期（10 分钟有效）");
  // 这个浏览器登录的是另一个 VoiceDraft 账号：不能把 X 账号绑给发起授权的那个人
  // （防止有人把自己的授权链接发给别人点，借机拿到别人的 X 账号）。
  // 没登录时允许：在 TG 机器人里点「连接 X」的情况。
  const current = await getCurrentUser();
  if (current && current.id !== row.userId) {
    return fail("这个授权链接是另一个账号发起的，已拒绝。请在自己的账号里重新点「连接 X」");
  }
  if (!code) {
    return fail(url.searchParams.get("error") === "access_denied" ? "你在 X 页面上点了取消" : "X 没有返回授权码");
  }
  try {
    const token = await exchangeCode(code, row.codeVerifier);
    await saveAccount(row.userId, token);
    return back("connected=1");
  } catch (e) {
    console.error(e);
    return fail(e instanceof XApiError ? e.message.replace(/[。.]$/, "") : "连接 X 失败，请重试");
  }
}
