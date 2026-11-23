import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { setIgnored, unfollowOne } from "@/lib/follow-check";
import { followCheckError } from "@/lib/follow-check-http";

const Body = z.object({ action: z.enum(["unfollow", "ignore", "unignore"]) });

/** 对名单里的一个人：取关（一次只取关这一个）、忽略、恢复 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !/^[\w-]{1,40}$/.test(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    if (parsed.data.action === "unfollow") {
      const p = await unfollowOne(user.id, id);
      return Response.json({ ok: true, handle: p.handle });
    }
    const ok = await setIgnored(user.id, id, parsed.data.action === "ignore");
    if (!ok) return Response.json({ error: "名单里没有这个人了" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    return followCheckError(e);
  }
}
