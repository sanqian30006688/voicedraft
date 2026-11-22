import { splitSentences, weightedLength } from "./text";

/** 风格卡的「代码统计指标」：确定性计算，不调用 LLM。 */
export interface StyleMetrics {
  sampleCount: number;
  avgSentenceChars: number;
  p80SentenceChars: number;
  avgWeightedLength: number;
  exclamationPerPost: number;
  questionPerPost: number;
  emojiRate: number; // 含 emoji 的推文比例
  hashtagRate: number; // 含 # 的推文比例
}

const EMOJI = /\p{Extended_Pictographic}/u;

export function computeMetrics(samples: string[]): StyleMetrics {
  const posts = samples.map((s) => s.trim()).filter(Boolean);
  const n = posts.length || 1;
  const lens = posts
    .flatMap((p) => splitSentences(p))
    .map((s) => [...s.replace(/[\s\p{P}]/gu, "")].length)
    .sort((a, b) => a - b);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const count = (re: RegExp) => posts.reduce((acc, p) => acc + (p.match(re)?.length ?? 0), 0);
  return {
    sampleCount: posts.length,
    avgSentenceChars: Math.round(avg(lens)),
    p80SentenceChars: lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.8))] : 0,
    avgWeightedLength: Math.round(avg(posts.map((p) => weightedLength(p).weighted))),
    exclamationPerPost: +(count(/[!！]/g) / n).toFixed(2),
    questionPerPost: +(count(/[?？]/g) / n).toFixed(2),
    emojiRate: +(posts.filter((p) => EMOJI.test(p)).length / n).toFixed(2),
    hashtagRate: +(posts.filter((p) => /#\S/.test(p)).length / n).toFixed(2),
  };
}

/** 把指标转成给模型看的中文描述。 */
export function describeMetrics(m: StyleMetrics): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `样本 ${m.sampleCount} 条`,
    `平均句长 ${m.avgSentenceChars} 字，80% 的句子不超过 ${m.p80SentenceChars} 字`,
    `平均每条加权字数 ${m.avgWeightedLength}（上限 280）`,
    `每条平均感叹号 ${m.exclamationPerPost} 个、问号 ${m.questionPerPost} 个`,
    `含 emoji 的推文占 ${pct(m.emojiRate)}，含话题标签的占 ${pct(m.hashtagRate)}`,
  ].join("；");
}
