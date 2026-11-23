import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getActiveCard } from "@/lib/data";
import { getItem, updateItem } from "@/lib/tg-feed";
import { extractPoints, GenerationError } from "@/lib/llm";
import { InsufficientBalanceError, requireActive, UsageLimitError } from "@/lib/billing";

type Ctx = { params: Promise<{ id: string }> };

/** 让 AI 从这条内容里提炼 3–5 个要点 */
export async function POST(_request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "找不到这条内容" }, { status: 404 });
  const item = await getItem(user.id, id);
  if (!item) return Response.json({ error: "找不到这条内容" }, { status: 404 });
  try {
    await requireActive(user.id, "points");
    const card = await getActiveCard(user.id);
    const points = await extractPoints(item.text, card?.traits.topics ?? []);
    await updateItem(user.id, id, { points });
    return Response.json({ points });
  } catch (err) {
    if (err instanceof GenerationError) return Response.json({ error: err.message }, { status: 422 });
    if (err instanceof InsufficientBalanceError) return Response.json({ error: err.message, needTopup: true }, { status: 402 });
    if (err instanceof UsageLimitError) return Response.json({ error: err.message }, { status: 429 });
    console.error(err);
    return Response.json({ error: "提炼失败，请稍后重试。" }, { status: 502 });
  }
}
