import { requireUser } from "@/lib/auth";
import { MemoryError, refreshMemory } from "@/lib/memory";
import { styleErrorResponse } from "@/lib/style-actions";

/** 马上重新整理一次账号记忆（不收费，每天有次数上限） */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    await refreshMemory(user.id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof MemoryError) return Response.json({ error: err.message }, { status: err.status });
    return styleErrorResponse(err, "整理失败，请稍后重试");
  }
}
