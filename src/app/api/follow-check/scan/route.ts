import { requireUser } from "@/lib/auth";
import { runScan } from "@/lib/follow-check";
import { followCheckError } from "@/lib/follow-check-http";

/** 用户确认后扫描一次（先按估算扣钱，读完多退少补，失败全退） */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await runScan(user.id));
  } catch (e) {
    return followCheckError(e);
  }
}
