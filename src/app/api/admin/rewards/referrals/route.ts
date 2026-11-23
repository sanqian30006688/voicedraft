import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { decideReferral } from "@/lib/rewards";
import { notifyReferralApproved } from "@/lib/tg-bot-rewards";

const Body = z.object({ invitee: z.string().uuid(), approve: z.boolean() });

/** 后台审核一条待审核的邀请：通过就给双方发奖励 */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数不对" }, { status: 400 });
  const r = await decideReferral(parsed.data.invitee, parsed.data.approve);
  if (!r) return Response.json({ error: "这条已经处理过了" }, { status: 409 });
  if (parsed.data.approve) await notifyReferralApproved(parsed.data.invitee, r).catch(() => {});
  return Response.json({ ok: true });
}
