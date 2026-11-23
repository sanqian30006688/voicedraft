import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError } from "@/lib/billing";
import { PublishError } from "@/lib/publish";
import { checkMentions } from "@/lib/replies";
import { XApiError } from "@/lib/x";

/** 手动「检查新提及」 */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await checkMentions(user.id));
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof PublishError || e instanceof XApiError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
