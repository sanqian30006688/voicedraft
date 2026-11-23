import { requireUser } from "@/lib/auth";
import { backfillSourceImages } from "@/lib/autopilot";
import { PublishError } from "@/lib/publish";
import { InsufficientBalanceError } from "@/lib/billing";

/** 给已经排进定时的自动帖补原图（只动本人的） */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await backfillSourceImages(user.id));
  } catch (e) {
    if (e instanceof PublishError || e instanceof InsufficientBalanceError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
