/**
 * 自动发帖的两道代码检查（不花钱、不调模型）：
 * - 原文有没有足够的信息可写（只有链接、表情、@ 和话题标签的不写）
 * - 写出来的帖子是不是停在半句
 */

const URL_RE = /https?:\/\/\S+/gi;
const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g;

/** 去掉链接、@用户名、#话题、表情和标点后，还剩多少「实际内容」（一个汉字 1 分，一个外文单词 2 分） */
export function substance(text: string): number {
  const plain = text
    .replace(URL_RE, " ")
    .replace(/(^|\s)RT\s+@\w+:?/g, " ")
    .replace(/[@＠][\w.]+/g, " ")
    .replace(/[#＃][^\s#＃]+/g, " ");
  const cjk = plain.match(CJK_RE)?.length ?? 0;
  const words = plain.replace(CJK_RE, " ").match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0;
  return cjk + words * 2;
}

export const MIN_SUBSTANCE = 20;

/** 明显的色情 / 成人内容关键词（先用免费的关键词挡一道，模型再挡一道） */
const ADULT_RE =
  /(色情|黄片|黄网|成人视频|成人影片|av女优|女优|裸聊|约炮|一夜情|援交|嫖娼|卖淫|裸照|无码视频|福利姬|做爱|性爱|情色|成人网站|onlyfans|porn|nsfw|hentai|nudes|sex\s?cam|escort)/i;

export function isAdult(text: string): boolean {
  return ADULT_RE.test(text);
}

/** 原文能不能写：不能就返回原因（不扣费，直接跳过） */
export function sourceProblem(text: string): string | null {
  const t = text.trim();
  if (isAdult(t)) return "原文涉及色情 / 成人内容，不写";
  if (/^RT\s+@/i.test(t)) return "原文是转推，不是原创内容";
  if (substance(t) < MIN_SUBSTANCE) return "原文信息太少（只有一两句话、链接或图片），写出来别人看不懂，没有写";
  return null;
}

/** 文字里的第一个链接（用来在原文太短时去读链接里的文章） */
export function firstUrl(text: string): string | null {
  return text.match(URL_RE)?.[0]?.replace(/[)）\].,，。]+$/, "") ?? null;
}

const CUT_END = /[，,、：:；;（(「『“‘《【—…]$|\.\.\.$|(和|与|及|或|但|把|被|因为|所以|如果|虽然|而且|不过|以及|比如)$/;

/**
 * 帖子是不是没说完：看最后一行正文（跳过带链接的行，那是附上的原文链接或推广）
 * 结尾停在逗号、冒号、省略号、连词上，就算没说完
 */
export function looksCut(text: string, skip: string[] = []): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\//i.test(l) && !skip.some((s) => s && l.includes(s)));
  const last = lines.at(-1);
  if (!last) return false;
  // 结尾的表情和话题标签不算
  const core = last.replace(/(\s*[#＃][^\s#＃]+)+$/u, "").replace(/[\p{Extended_Pictographic}️‍\s]+$/u, "");
  if (!core) return false;
  return CUT_END.test(core);
}

/** 太常见、算不上「口头禅」的词，不提醒 */
const COMMON = new Set(
  "我们 你们 他们 自己 一个 这个 那个 没有 什么 就是 可以 不是 真的 因为 所以 但是 如果 时候 现在 已经 还是 而是 这样 那样 怎么 为什么 很多 一些 知道 觉得 不会 不能 需要 应该 能够 进行 之后 之前 今天 大家 东西 事情 问题 the and that this with for you are have was not but"
    .split(" "),
);

/**
 * 最近的帖子里反复出现的词（口头禅、套话）：
 * 一个词出现在至少 3 条、并且至少四分之一的帖子里，就算用得太多。
 * 返回最常见的几个，长词优先（「说白了」比「说白」更有用）。
 */
export function overusedPhrases(texts: string[], max = 8): string[] {
  const docs = texts.map((t) => t.replace(URL_RE, " ")).filter((t) => t.trim());
  if (docs.length < 5) return [];
  const need = Math.max(3, Math.ceil(docs.length / 4));
  const df = new Map<string, number>();
  for (const d of docs) {
    const grams = new Set<string>();
    for (const run of d.match(/[㐀-鿿]+/g) ?? []) {
      for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= run.length; i++) grams.add(run.slice(i, i + n));
    }
    for (const w of d.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) ?? []) grams.add(w);
    for (const g of grams) df.set(g, (df.get(g) ?? 0) + 1);
  }
  const hot = [...df].filter(([g, c]) => c >= need && !COMMON.has(g));
  // 被同样常见的更长词包含的短词去掉
  const kept = hot.filter(([g, c]) => !hot.some(([h, hc]) => h !== g && h.length > g.length && h.includes(g) && hc >= c * 0.8));
  kept.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return kept.slice(0, max).map(([g]) => g);
}

/** 一条里用了几个「用得太多的词」 */
export function overuseHits(text: string, phrases: string[]): string[] {
  const t = text.toLowerCase();
  return phrases.filter((p) => t.includes(p.toLowerCase()));
}

// ---------- 写多长 ----------

/** 串推在一段文字里的分隔：单独一行 --- */
export const THREAD_SEP = "\n\n---\n\n";
export const splitThread = (text: string): string[] =>
  text
    .split(/\n\s*-{3,}\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean);
export const joinThread = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(THREAD_SEP);

export type PostShape =
  | { kind: "single"; target: string }
  /** X 会员：一条长推（可以超过 280） */
  | { kind: "long"; target: string }
  | { kind: "thread"; min: number; max: number };

/**
 * 按原文的信息量决定写多长：短消息写一条；内容多的写满一条；
 * 长文不硬压成一两句（会断章取义）：X 会员写成一条长推，不是会员写成串推。
 * allowLong=false 时最多写满一条。
 */
export function postShape(source: string, o: { premium: boolean; allowLong: boolean }): PostShape {
  const n = substance(source);
  if (n < 90) return { kind: "single", target: "跟原文差不多的信息量，大约 50–110 个汉字" };
  if (n < 180 || !o.allowLong) return { kind: "single", target: "写满一条，大约 100–135 个汉字，把原文的主要信息都说到" };
  if (o.premium) {
    const target = n < 700 ? "大约 150–300 个汉字" : n < 1600 ? "大约 250–450 个汉字，可以分几段" : "大约 350–600 个汉字，分几段写";
    return { kind: "long", target };
  }
  if (n < 700) return { kind: "thread", min: 2, max: 3 };
  if (n < 1600) return { kind: "thread", min: 3, max: 5 };
  return { kind: "thread", min: 4, max: 6 };
}
