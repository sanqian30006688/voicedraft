import twitterText from "twitter-text";

/** X 加权字数：中日韩字符与 emoji 计 2，链接固定 23，上限 280。 */
export function weightedLength(text: string): { weighted: number; valid: boolean; max: number } {
  const r = twitterText.parseTweet(text);
  return { weighted: r.weightedLength, valid: r.valid, max: 280 };
}

/** X 会员一条推文的上限（加权字数） */
export const LONG_POST_MAX = 25_000;

/** 这条能不能发：普通账号 280，会员（long=true）25000 */
export function fitsPost(text: string, long = false): boolean {
  if (!long) return weightedLength(text).valid;
  return text.trim().length > 0 && twitterText.parseTweet(text).weightedLength <= LONG_POST_MAX;
}

const SENTENCE_END = /([。！？!?；;…]+|\.(?=\s)|\n+)/;

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&*+,;=%]+/gi;

/** 按中英文句末标点切句，标点留在句子末尾。链接里的 ? ! . 不会被当成句末。 */
export function splitSentences(text: string): string[] {
  const urls: string[] = [];
  const masked = text.replace(URL_RE, (m) => {
    // 链接末尾的英文句号、问号等算句末标点，不算链接的一部分
    const [, u, tail] = m.match(/^(.*?)([.,!?:;]*)$/)!;
    return `\u0000${urls.push(u) - 1}\u0000${tail}`;
  });
  const restore = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => urls[Number(i)]);
  const parts = masked.split(SENTENCE_END);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? "";
    const end = (parts[i + 1] ?? "").replace(/\n+/g, "");
    const s = (body + end).trim();
    if (s) out.push(restore(s));
  }
  return out;
}

/** 拼接句子：两侧都是拉丁字符时补一个空格，中文直接相连；链接前后总留空格，免得 X 识别不出。 */
export function joinSentences(sentences: string[]): string {
  return sentences.reduce((acc, s) => {
    if (!acc) return s;
    const needsSpace =
      (/[A-Za-z0-9.,!?]$/.test(acc) && /^[A-Za-z0-9]/.test(s)) || /^https?:\/\//i.test(s) || /https?:\/\/\S+$/i.test(acc);
    return acc + (needsSpace ? " " : "") + s;
  }, "");
}

/** 字符 3-gram 重合度（0–1），去掉标点与空白后计算。用于来源相似度检查。 */
export function trigramSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const A = grams(norm(a));
  const B = grams(norm(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * 话题相关度：主题与样本的字符 2-gram 重合数（按样本长度做轻微归一）。
 * 用于按主题挑选最相近的原句作为例句，不需要额外的向量服务。
 */
export function topicRelevance(topic: string, sample: string): number {
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const T = grams(norm(topic));
  const S = grams(norm(sample));
  if (!T.size || !S.size) return 0;
  let hit = 0;
  for (const g of T) if (S.has(g)) hit++;
  return hit / Math.sqrt(S.size);
}
