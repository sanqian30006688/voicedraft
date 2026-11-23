import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError, UsageLimitError } from "@/lib/billing";
import {
  deleteInspiration,
  generateQuotesFor,
  ownInspiration,
  setInspirationStatus,
} from "@/lib/inspiration";
import { GenerationError } from "@/lib/llm";
import { getPromoLink } from "@/lib/promo-data";
import { PublishError } from "@/lib/publish";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), promoId: z.string().uuid().optional() }),
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("used") }),
  z.object({ action: z.literal("delete") }),
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
    if (b.action === "delete") {
      await deleteInspiration(user.id, id);
      return Response.json({ ok: true });
    }
    if (b.action === "dismiss") return Response.json({ item: await setInspirationStatus(user.id, id, "dismissed") });
    if (b.action === "restore") return Response.json({ item: await setInspirationStatus(user.id, id, "new") });
    if (b.action === "used") return Response.json({ item: await setInspirationStatus(user.id, id, "used") });
    const row = await ownInspiration(user.id, id);
    const promo = await getPromoLink(user.id, b.promoId);
    if (b.promoId && !promo) throw new PublishError("找不到这条推广链接，可能已被删除");
    return Response.json({ item: await generateQuotesFor(user.id, row, promo) });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof UsageLimitError) return Response.json({ error: e.message }, { status: 429 });
    if (e instanceof PublishError || e instanceof GenerationError) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    throw e;
  }
}
