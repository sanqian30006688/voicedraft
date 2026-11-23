import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError, UsageLimitError } from "@/lib/billing";
import { GenerationError } from "@/lib/llm";
import { getPromoLink } from "@/lib/promo-data";
import { PublishError } from "@/lib/publish";
import { deleteReply, generateFor, ownReply, sendReply, setReplyStatus } from "@/lib/replies";
import { XApiError } from "@/lib/x";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), text: z.string().max(2000), original: z.string().max(2000).optional() }),
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("regenerate"), promoId: z.string().uuid().optional() }),
  z.object({ action: z.literal("delete_x") }),
]);

export async function POST(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  const b = parsed.data;
  try {
    let item;
    if (b.action === "send") item = await sendReply(user.id, id, b.text, b.original);
    else if (b.action === "skip") item = await setReplyStatus(user.id, id, "skipped");
    else if (b.action === "restore") item = await setReplyStatus(user.id, id, "pending");
    else if (b.action === "delete_x") item = await deleteReply(user.id, id);
    else {
      const row = await ownReply(user.id, id);
      if (row.status === "sent") throw new PublishError("这条已经回复过了");
      const promo = await getPromoLink(user.id, b.promoId);
      if (b.promoId && !promo) throw new PublishError("找不到这条推广链接，可能已被删除");
      item = await generateFor(user.id, row, promo);
    }
    return Response.json({ item });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof UsageLimitError) return Response.json({ error: e.message }, { status: 429 });
    if (e instanceof PublishError || e instanceof XApiError || e instanceof GenerationError) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    throw e;
  }
}
