import { lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { authorizeUrl, connectMock, createPkce, isXConfigured, isXMock } from "@/lib/x";

/** 授权完成后可以回到的页面（默认「发布」页） */
const RETURN_PAGES = new Set(["/publish", "/inspiration"]);

/** 跳转到 X 授权页。授权状态存在数据库里，回调地址用 127.0.0.1 也能对上当前用户。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const next = url.searchParams.get("next") ?? "";
  const back = `${origin}${RETURN_PAGES.has(next) ? next : "/publish"}`;
  const user = await getCurrentUser();
  if (!user) return Response.redirect(`${origin}/login`, 302);
  if (!isXConfigured()) return Response.redirect(`${origin}/publish?x_error=${encodeURIComponent("还没有配置 X_CLIENT_ID")}`, 302);

  if (isXMock()) {
    await connectMock(user.id);
    return Response.redirect(`${back}?connected=1`, 302);
  }

  const { verifier, challenge, state } = createPkce();
  const db = await getDb();
  await db.delete(schema.xOauthStates).where(lt(schema.xOauthStates.expiresAt, new Date()));
  await db.insert(schema.xOauthStates).values({
    state,
    userId: user.id,
    codeVerifier: verifier,
    returnTo: back,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return Response.redirect(authorizeUrl(state, challenge), 302);
}
