import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError, UsageLimitError } from "@/lib/billing";
import { checkTimeline } from "@/lib/follow-replies";
import { PublishError } from "@/lib/publish";
import { XApiError } from "@/lib/x";

/** 手动「检查关注的人」：读关注的人的新帖子，挑出值得回的写好候选（只生成，不发出） */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await checkTimeline(user.id, { manual: true }));
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof UsageLimitError) return Response.json({ error: e.message }, { status: 429 });
    if (e instanceof PublishError || e instanceof XApiError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
