import "server-only";
import { requireUser, type CurrentUser } from "./auth";
import { isAdmin } from "./billing";

/** 后台接口：只有管理员能用 */
export async function requireAdmin(): Promise<CurrentUser | Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!(await isAdmin(user))) return Response.json({ error: "只有管理员能打开后台" }, { status: 403 });
  return user;
}
