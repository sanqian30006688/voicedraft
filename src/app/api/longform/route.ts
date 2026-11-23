import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError, longformItem, requireActive, UsageLimitError, withCharge } from "@/lib/billing";
import { loadStyleCardForDrafting, recentEdits } from "@/lib/data";
import { GenerationError, isMock } from "@/lib/llm";
import { generateLong, type LongTask } from "@/lib/longform";
import { getPromoLink } from "@/lib/promo-data";

const format = z.enum(["single", "thread", "article"]);
const outlinedFormat = z.enum(["thread", "article"]);
const length = z.enum(["short", "medium", "long"]);
const topic = z.string().trim().min(1).max(500);
const notes = z.string().max(4000).default("");

const Body = z.object({
  task: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("outline"), format: outlinedFormat, length, topic, notes }),
    z.object({
      kind: z.literal("candidates"),
      format: z.literal("single"),
      length,
      topic,
      notes,
      count: z.number().int().min(1).max(5),
    }),
    z.object({
      kind: z.literal("write"),
      format: outlinedFormat,
      length,
      topic,
      notes,
      title: z.string().max(300),
      outline: z.array(z.string().min(1).max(500)).min(1).max(20),
    }),
    z.object({
      kind: z.literal("rewrite"),
      format,
      topic,
      notes,
      title: z.string().max(300),
      parts: z.array(z.string().max(3000)).min(1).max(60),
      position: z.number().int().min(0),
      instruction: z.string().max(300).default(""),
      count: z.number().int().min(1).max(5),
    }),
  ]),
  /** 要带的推广链接 id，不带就不传 */
  promoId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const task = parsed.data.task as LongTask;
  if (task.kind === "rewrite" && task.position >= task.parts.length) {
    return Response.json({ error: "段落位置超出范围" }, { status: 400 });
  }
  const promo = await getPromoLink(user.id, parsed.data.promoId);
  if (parsed.data.promoId && !promo) {
    return Response.json({ error: "找不到这条推广链接，可能已被删除" }, { status: 404 });
  }
  const card = await loadStyleCardForDrafting(user.id, task.topic);
  if (!card) {
    return Response.json({ error: "还没有风格卡，请先导入素材并生成风格卡" }, { status: 409 });
  }
  try {
    const edits = await recentEdits(user.id, 10);
    // 计费：写成一篇按形式分三档（单条长推候选 / 串推全文 / X 长文全文）；改写一段按「生成」扣；列提纲不扣
    const item = longformItem(task);
    const run = () => generateLong(card, task, edits, promo);
    if (!item) await requireActive(user.id, "outline");
    const result = item ? await withCharge(user.id, item, run) : await run();
    return Response.json({ ...result, mock: isMock() });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return Response.json({ error: err.message, needTopup: true }, { status: 402 });
    if (err instanceof UsageLimitError) return Response.json({ error: err.message }, { status: 429 });
    if (err instanceof GenerationError) return Response.json({ error: err.message }, { status: 422 });
    console.error(err);
    return Response.json({ error: "生成失败，请稍后重试。" }, { status: 502 });
  }
}
