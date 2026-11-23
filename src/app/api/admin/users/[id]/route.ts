import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { userDetail } from "@/lib/users-admin";

type Ctx = { params: Promise<{ id: string }> };

/** 一个用户的详情：余额、充值、用量、团队、邀请 */
export async function GET(_request: Request, { params }: Ctx) {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "找不到这个用户" }, { status: 404 });
  const d = await userDetail(id);
  if (!d) return Response.json({ error: "找不到这个用户" }, { status: 404 });
  return Response.json(d);
}
