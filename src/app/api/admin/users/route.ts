import { requireAdmin } from "@/lib/admin";
import { searchUsers } from "@/lib/users-admin";

/** 后台找人：按用户编号、TG @用户名、邮箱、X 账号搜；不填就列最新注册的 */
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return Response.json(await searchUsers(q));
}
