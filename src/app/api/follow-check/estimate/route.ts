import { requireUser } from "@/lib/auth";
import { estimateScan } from "@/lib/follow-check";
import { followCheckError } from "@/lib/follow-check-http";

/** 扫描前：这次要读多少人、预计扣多少 */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await estimateScan(user.id));
  } catch (e) {
    return followCheckError(e);
  }
}
