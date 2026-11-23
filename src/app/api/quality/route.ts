import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { loadStyleCardForDrafting } from "@/lib/data";
import { scoreForCard } from "@/lib/quality";

const Body = z.object({ text: z.string().min(1).max(5000), long: z.boolean().optional() });

/** 给一段草稿打质量分（纯代码计算，不调 AI、不收费） */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const card = await loadStyleCardForDrafting(user.id);
  if (!card) return Response.json({ error: "还没有风格卡" }, { status: 409 });
  const [quality] = scoreForCard(card, [parsed.data.text], { long: parsed.data.long });
  return Response.json({ quality });
}
