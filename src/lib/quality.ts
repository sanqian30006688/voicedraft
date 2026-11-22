import { computeMetrics, type StyleMetrics } from "./metrics";
import type { StyleCard } from "./style-card";
import { splitSentences, trigramSimilarity, weightedLength } from "./text";

/**
 * 内容质量分（0–100）：纯代码打分，不调 AI、不收费。
 * 看的是「像不像本人」和「是不是空话」：
 * - 和本人平时的长度、句长、感叹号 / emoji / 话题标签习惯差多少
 * - 有没有 AI 腔套话、本人从不用的词
 * - 和最近发过的是不是在说同一件事（重复）
 * - 超字数直接判不合格
 */

export interface QualityCtx {
  metrics: StyleMetrics;
  bannedWords: string[];
  /** 本人最近发过的推文 */
  recent: string[];
}

export interface Quality {
  score: number;
  level: "good" | "ok" | "weak";
  notes: string[];
}

/** AI 写作里常见、真人很少这么写的套话 */
export const AI_CLICHES = [
  "总而言之",
  "综上所述",
  "值得注意的是",
  "不得不说",
  "让我们",
  "在这个时代",
  "在当今",
  "赋能",
  "抓手",
  "闭环",
  "深入探讨",
  "至关重要",
  "不可或缺",
  "毋庸置疑",
  "一起来看看",
  "你怎么看？",
  "干货",
  "In conclusion",
  "It's worth noting",
  "Let's dive",
  "delve",
  "game-changer",
];

export const QUALITY_GOOD = 80;
export const QUALITY_OK = 60;

const EMOJI = /\p{Extended_Pictographic}/u;

export function qualityCtx(samples: string[], bannedWords: string[], recent: string[]): QualityCtx {
  return { metrics: computeMetrics(samples), bannedWords, recent };
}

/** 按风格卡（样本、不用的词、最近发过的）给几条候选打分 */
export function scoreForCard(card: Pick<StyleCard, "samples" | "traits" | "recent">, texts: string[], opts: { long?: boolean } = {}): Quality[] {
  const ctx = qualityCtx(card.samples, card.traits.bannedWords, card.recent ?? []);
  return texts.map((t) => scoreText(t, ctx, opts));
}

export function scoreText(text: string, ctx: QualityCtx, opts: { long?: boolean } = {}): Quality {
  const notes: string[] = [];
  let score = 100;
  const body = text.replace(/https?:\/\/\S+/g, "").trim();
  const m = ctx.metrics;

  if (!opts.long && !weightedLength(text).valid) {
    return { score: 0, level: "weak", notes: ["超过 280 字，发不出去"] };
  }

  // 太短：没有内容
  const chars = [...body.replace(/[\s\p{P}\p{S}]/gu, "")].length;
  if (chars < 8) {
    score -= 25;
    notes.push("太短，几乎没说什么");
  }

  // 长度和本人平时差太多（长文不看）
  if (!opts.long && m.sampleCount >= 5 && m.avgWeightedLength > 0) {
    const w = weightedLength(text).weighted;
    const ratio = w / m.avgWeightedLength;
    if (ratio > 2.2 || ratio < 0.35) {
      score -= 12;
      notes.push(ratio > 1 ? "比你平时写的长很多" : "比你平时写的短很多");
    }
  }

  // 句子太长
  if (m.p80SentenceChars > 0) {
    const longOnes = splitSentences(body).filter((s) => [...s.replace(/[\s\p{P}]/gu, "")].length > m.p80SentenceChars * 1.8).length;
    if (longOnes) {
      score -= Math.min(15, longOnes * 6);
      notes.push("有句子比你平时长很多");
    }
  }

  // AI 套话、本人不用的词
  const lower = body.toLowerCase();
  const cliches = AI_CLICHES.filter((w) => lower.includes(w.toLowerCase()));
  const banned = ctx.bannedWords.filter((w) => w.trim() && body.includes(w.trim()));
  const bad = [...new Set([...banned, ...cliches])];
  if (bad.length) {
    score -= Math.min(48, bad.length * 12);
    notes.push(`有 AI 腔或你不用的词：${bad.slice(0, 3).join("、")}`);
  }

  // 感叹号、emoji、话题标签：本人几乎不用却用了
  if (m.sampleCount >= 5) {
    const excl = (body.match(/[!！]/g) ?? []).length;
    if (excl >= 2 && m.exclamationPerPost < 0.3) {
      score -= 8;
      notes.push("感叹号比你平时多");
    }
    if (EMOJI.test(body) && m.emojiRate < 0.1) {
      score -= 8;
      notes.push("你平时几乎不用 emoji");
    }
    if (/#\S/.test(body) && m.hashtagRate < 0.1) {
      score -= 8;
      notes.push("你平时几乎不加话题标签");
    }
  }

  // 和最近发过的重复
  let worst = 0;
  for (const r of ctx.recent) worst = Math.max(worst, trigramSimilarity(body, r));
  if (worst >= 0.6) {
    score -= 40;
    notes.push("和你最近发过的一条几乎一样");
  } else if (worst >= 0.4) {
    score -= 18;
    notes.push("和你最近发过的有点重复");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= QUALITY_GOOD ? "good" : score >= QUALITY_OK ? "ok" : "weak";
  return { score, level, notes };
}

export const QUALITY_LABEL: Record<Quality["level"], string> = { good: "好", ok: "可用", weak: "建议换" };

export function qualityLine(q: Quality): string {
  return `质量 ${q.score}（${QUALITY_LABEL[q.level]}）${q.notes.length ? `：${q.notes.join("；")}` : ""}`;
}

/** TG 里候选标题后面的一小段，例如「 · 质量 85」；有扣分原因时另起一行 */
export function qualityTag(q: Quality): string {
  return ` · 质量 ${q.score}${q.level === "good" ? "" : `（${q.notes.slice(0, 2).join("；")}）`}`;
}
