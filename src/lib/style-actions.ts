import "server-only";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  editsSinceLastLearning,
  getActiveCard,
  LEARN_MIN,
  loadStyleCardForDrafting,
  majorityLang,
  pinIfNonePinned,
  saveCardVersion,
  usableSamples,
} from "./data";
import { analyzeStyle, generateBlindTwins, GenerationError, learnFromEdits } from "./llm";
import { InsufficientBalanceError, requireActive, UsageLimitError } from "./billing";

/**
 * 风格卡与盲测的操作，网页接口和 TG 机器人共用。
 * 出错时抛 StyleError（给用户看的说明）或 GenerationError。
 */
export class StyleError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const MIN_SAMPLES = 5;
const MAX_ANALYZE = 200;
const MAX_EDITS = 50;
export const BLIND_PAIRS = 5;

/** 生成 / 重新生成风格卡（保存为新版本） */
export async function generateStyleCard(userId: string) {
  const lang = await majorityLang(userId);
  const samples = (await usableSamples(userId, lang)).slice(0, MAX_ANALYZE);
  if (samples.length < MIN_SAMPLES) {
    throw new StyleError(`至少需要 ${MIN_SAMPLES} 条素材才能生成风格卡，建议 30 条以上`);
  }
  await requireActive(userId, "style");
  const { representative, ...traits } = await analyzeStyle(
    samples.map((s) => s.content),
    lang,
  );
  const row = await saveCardVersion(userId, lang, traits, "generated");
  await pinIfNonePinned(
    userId,
    representative.map((i) => samples[i]?.id).filter((x): x is string => !!x),
  );
  return { version: row.version, analyzed: samples.length };
}

/** 根据上次总结之后的修改，生成风格卡更新建议（待用户确认） */
export async function createLearning(userId: string) {
  const card = await getActiveCard(userId);
  if (!card) throw new StyleError("还没有风格卡", 409);
  const edits = await editsSinceLastLearning(userId);
  if (edits.length < LEARN_MIN) throw new StyleError(`至少需要 ${LEARN_MIN} 次新修改才能总结`);
  await requireActive(userId, "learn");
  const recent = edits.slice(-MAX_EDITS);
  const out = await learnFromEdits(
    card.traits,
    recent.map((e) => ({ original: e.original, edited: e.edited, at: e.createdAt.getTime() })),
  );
  const db = await getDb();
  // 旧的未处理建议作废
  await db
    .update(schema.styleLearnings)
    .set({ status: "dismissed" })
    .where(and(eq(schema.styleLearnings.userId, userId), eq(schema.styleLearnings.status, "pending")));
  const [row] = await db
    .insert(schema.styleLearnings)
    .values({
      userId,
      editCount: recent.length,
      lastEditAt: recent[recent.length - 1].createdAt,
      suggestion: out,
      baseVersion: card.version,
    })
    .returning();
  return row;
}

/** 采纳（写入风格卡新版本）或忽略建议 */
export async function decideLearning(userId: string, id: string, action: "accept" | "dismiss") {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.styleLearnings)
    .where(
      and(
        eq(schema.styleLearnings.id, id),
        eq(schema.styleLearnings.userId, userId),
        eq(schema.styleLearnings.status, "pending"),
      ),
    )
    .limit(1);
  if (!row) throw new StyleError("这条建议已经处理过了", 404);
  let version: number | undefined;
  if (action === "accept") {
    const card = await getActiveCard(userId);
    const saved = await saveCardVersion(userId, card?.lang ?? "zh", row.suggestion.traits, "learned");
    version = saved.version;
  }
  await db
    .update(schema.styleLearnings)
    .set({ status: action === "accept" ? "accepted" : "dismissed" })
    .where(eq(schema.styleLearnings.id, row.id));
  return { version };
}

/** 回滚：把某个历史版本的内容另存为一个新版本，历史记录不丢 */
export async function rollbackCard(userId: string, cardId: string) {
  const db = await getDb();
  const [old] = await db
    .select()
    .from(schema.styleCards)
    .where(and(eq(schema.styleCards.id, cardId), eq(schema.styleCards.userId, userId)))
    .limit(1);
  if (!old) throw new StyleError("找不到这个版本", 404);
  const row = await saveCardVersion(userId, old.lang, old.traits, "rollback");
  return { version: row.version, from: old.version };
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 新建一次盲测：随机抽 5 条真实推文，AI 各写一条同话题的，打乱顺序 */
export async function createBlindTest(userId: string) {
  const active = await getActiveCard(userId);
  if (!active) throw new StyleError("还没有风格卡，请先生成", 409);
  const pool = await usableSamples(userId, active.lang);
  if (pool.length < BLIND_PAIRS * 2) throw new StyleError(`至少需要 ${BLIND_PAIRS * 2} 条素材才能做盲测`);
  const real = shuffle(pool)
    .slice(0, BLIND_PAIRS)
    .map((s) => s.content);
  const card = await loadStyleCardForDrafting(userId);
  if (!card) throw new StyleError("还没有风格卡", 409);
  await requireActive(userId, "blind");
  // 把被测的真实推文从提示词样本里去掉，避免 AI 照抄
  const hidden = new Set(real);
  const kept = card.samples.map((s, i) => ({ s, i })).filter((x) => !hidden.has(x.s));
  const cardForTest = {
    ...card,
    // 「最近发过的」可能就是被测的真实推文，盲测时不带
    recent: [],
    samples: kept.map((x) => x.s),
    pinned: kept.flatMap((x, j) => (card.pinned.includes(x.i) ? [j] : [])),
  };
  const ai = await generateBlindTwins(cardForTest, real);
  const items = shuffle([...real.map((text) => ({ text, isAi: false })), ...ai.map((text) => ({ text, isAi: true }))]);
  const db = await getDb();
  const [row] = await db
    .insert(schema.blindTests)
    .values({ userId, styleCardVersion: active.version, items })
    .returning({ id: schema.blindTests.id });
  return { id: row.id, items: items.map((i) => i.text), aiCount: BLIND_PAIRS };
}

/**
 * 提交答案：guesses 是用户认为「AI 写的」条目下标。
 * 误判率 = 判断错的条数 / 总条数。越高说明 AI 写得越像本人。
 */
export async function submitBlindTest(userId: string, id: string, guesses: number[]) {
  const db = await getDb();
  const [test] = await db
    .select()
    .from(schema.blindTests)
    .where(and(eq(schema.blindTests.id, id), eq(schema.blindTests.userId, userId), isNull(schema.blindTests.completedAt)))
    .limit(1);
  if (!test) throw new StyleError("这次盲测不存在或已经提交过了", 404);
  const guessed = new Set(guesses.filter((g) => g >= 0 && g < test.items.length));
  const wrong = test.items.filter((item, i) => item.isAi !== guessed.has(i)).length;
  const misjudgeRate = Math.round((wrong / test.items.length) * 100);
  await db
    .update(schema.blindTests)
    .set({ guesses: [...guessed], misjudgeRate, completedAt: new Date() })
    .where(eq(schema.blindTests.id, test.id));
  return { misjudgeRate, wrong, total: test.items.length, answers: test.items.map((i) => i.isAi), texts: test.items.map((i) => i.text) };
}

export async function blindHistory(userId: string, limit = 30) {
  const db = await getDb();
  return db
    .select({
      id: schema.blindTests.id,
      styleCardVersion: schema.blindTests.styleCardVersion,
      misjudgeRate: schema.blindTests.misjudgeRate,
      completedAt: schema.blindTests.completedAt,
    })
    .from(schema.blindTests)
    .where(and(eq(schema.blindTests.userId, userId), isNotNull(schema.blindTests.completedAt)))
    .orderBy(desc(schema.blindTests.completedAt))
    .limit(limit);
}

/** 接口里统一把 StyleError / GenerationError 转成响应 */
export function styleErrorResponse(err: unknown, fallback: string): Response {
  if (err instanceof StyleError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof GenerationError) return Response.json({ error: err.message }, { status: 422 });
  if (err instanceof InsufficientBalanceError) return Response.json({ error: err.message, needTopup: true }, { status: 402 });
  if (err instanceof UsageLimitError) return Response.json({ error: err.message }, { status: 429 });
  console.error(err);
  return Response.json({ error: fallback }, { status: 502 });
}
