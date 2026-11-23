import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError, UsageLimitError, withCharge } from "@/lib/billing";
import { loadStyleCardForDrafting, recentEdits } from "@/lib/data";
import { generateCandidates, GenerationError, isMock } from "@/lib/llm";
import type { Task } from "@/lib/prompts";
import { getPromoLink } from "@/lib/promo-data";
import { scoreForCard } from "@/lib/quality";

const Body = z.object({
  task: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("full"), topic: z.string().min(1).max(500), count: z.number().int().min(1).max(5) }),
    z.object({
      kind: z.literal("next"),
      topic: z.string().min(1).max(500),
      sentences: z.array(z.string().max(300)).max(30),
      count: z.number().int().min(1).max(5),
    }),
    z.object({
      kind: z.literal("alternatives"),
      topic: z.string().min(1).max(500),
      sentences: z.array(z.string().max(300)).min(1).max(30),
      position: z.number().int().min(0),
      count: z.number().int().min(1).max(5),
    }),
    z.object({
      kind: z.literal("promo"),
      topic: z.string().min(1).max(500),
      sentences: z.array(z.string().max(300)).max(30),
      count: z.number().int().min(1).max(5),
    }),
  ]),
  /** 这篇要带的推广链接 id，不带就不传 */
  promoId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  const { task, promoId } = parsed.data;
  if (task.kind === "alternatives" && task.position >= task.sentences.length) {
    return Response.json({ error: "句子位置超出范围" }, { status: 400 });
  }
  const promo = await getPromoLink(user.id, promoId);
  if (promoId && !promo) return Response.json({ error: "找不到这条推广链接，可能已被删除" }, { status: 404 });
  if (task.kind === "promo" && !promo) return Response.json({ error: "请先选一个推广链接" }, { status: 400 });
  const card = await loadStyleCardForDrafting(user.id, task.topic);
  if (!card) {
    return Response.json({ error: "还没有风格卡，请先导入素材并生成风格卡" }, { status: 409 });
  }
  try {
    const edits = await recentEdits(user.id, 10);
    const candidates = await withCharge(user.id, "generate", () => generateCandidates(card, task as Task, edits, promo));
    // 完整推文才打质量分；逐句模式的单句看不出整体
    const quality = task.kind === "full" ? scoreForCard(card, candidates) : undefined;
    return Response.json({ candidates, quality, mock: isMock() });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return Response.json({ error: err.message, needTopup: true }, { status: 402 });
    if (err instanceof UsageLimitError) return Response.json({ error: err.message }, { status: 429 });
    if (err instanceof GenerationError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    console.error(err);
    return Response.json({ error: "生成失败，请稍后重试。" }, { status: 502 });
  }
}
