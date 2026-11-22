import { joinThread, splitThread } from "./source-check";
import Anthropic from "@anthropic-ai/sdk";
import { usageFetch } from "./usage";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ensurePromo, fallbackPromoLine, hasPromo, promoPromptBlock, type PromoLink } from "./promo";
import {
  buildQuotePrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  buildSourcePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type QuoteTask,
  type ReplyTask,
  type SourceTask,
  type Task,
} from "./prompts";
import type { AccountMemory } from "./memory-core";
import type { EditPair, StyleCard, StyleTraits } from "./style-card";

const Candidates = z.object({
  candidates: z.array(z.string()).describe("候选文本，每项一条"),
});

/**
 * 模型集中在这里。生成、回复、长文、风格分析等影响文案质量的任务用 MODEL（默认 Sonnet 5.5）；
 * 评分、分类、提炼要点这类简单任务用 LIGHT_MODEL（默认 Haiku 5.5），便宜很多。
 * 可用环境变量 CLAUDE_MODEL / CLAUDE_MODEL_LIGHT 覆盖；这里读取时才取值，改了环境变量不用改代码。
 */
export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
export const LIGHT_MODEL = process.env.CLAUDE_MODEL_LIGHT || "claude-haiku-5-5";

/** 没有配置 API 密钥时使用演示数据，方便先看界面。设置 MOCK_LLM=1 可强制演示模式。 */
export function isMock(): boolean {
  return process.env.MOCK_LLM === "1" || !process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
// 后台换了 AI 密钥时重新建客户端
let clientKey: string | undefined;
function getClient() {
  if (!client || clientKey !== process.env.ANTHROPIC_API_KEY) {
    clientKey = process.env.ANTHROPIC_API_KEY;
    // 顺手记下 token 用量，算平台方的 AI 成本（经营日报用）
    client = new Anthropic({ fetch: usageFetch });
  }
  return client;
}

export class GenerationError extends Error {}

/** 这类任务的候选里必须带推广链接 */
function mustCarryPromo(task: Task, promo: PromoLink | null | undefined): promo is PromoLink {
  if (!promo) return false;
  if (task.kind === "full" || task.kind === "promo") return true;
  return task.kind === "alternatives" && hasPromo(task.sentences[task.position] ?? "", promo);
}

export async function generateCandidates(
  card: StyleCard,
  task: Task,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<string[]> {
  const out = isMock() ? mockCandidates(task, promo) : await callCandidates(card, task, edits, promo);
  // 模型偶尔会漏掉或改坏链接，兜底补在末尾，保证链接原样出现
  return mustCarryPromo(task, promo) ? out.map((c) => ensurePromo(c, promo)) : out;
}

async function callCandidates(
  card: StyleCard,
  task: Task,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<string[]> {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    // 候选生成要快：低 effort。风格分析等任务以后再用更高 effort。
    output_config: { effort: "low", format: betaZodOutputFormat(Candidates) },
    // 被安全分类器拒绝时自动换模型重试
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      {
        type: "text",
        text: buildSystemPrompt(card),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildUserPrompt(task, edits, card.related, promo) }],
  });

  if (response.stop_reason === "refusal") {
    throw new GenerationError("模型拒绝了这个请求，换个说法试试。");
  }
  const out = response.parsed_output?.candidates
    ?.map((s) => s.trim())
    .filter(Boolean);
  if (!out?.length) throw new GenerationError("没有生成可用的候选，请重试。");
  return out.slice(0, task.count);
}

function mockCandidates(task: Task, promo?: PromoLink | null): string[] {
  const t = task.topic.trim() || "这件事";
  if (task.kind === "promo") {
    if (!promo) return [];
    const line = fallbackPromoLine(promo);
    return [`想接着聊的，${line}`, `我平时在群里聊得更多： ${promo.url.trim()}`, line].slice(0, task.count);
  }
  const pool = {
    full: [
      `说白了，${t}这件事，难的从来不是开始。是第三个月还愿意做。`,
      `其实我对${t}的看法很简单：先做出来，再谈方法论。`,
      `为什么大家都在聊${t}，却很少有人真的动手？我猜是因为动手就会暴露问题。`,
    ],
    next: [
      `我自己试过一次，结论是：没想象中那么难。`,
      `问题在于，大多数人只想听结果。`,
      `所以我现在的做法是，先砍掉一半。`,
    ],
    open: [
      `关于${t}，我说句可能不太好听的。`,
      `${t}这事，我想了一周。`,
      `你有没有发现，${t}越火，做成的人越少？`,
    ],
    alt: [
      `换个角度说，这本来就是个筛选。`,
      `坦白讲，我也是踩过坑才明白。`,
      `这不是能力问题，是耐心问题。`,
    ],
  };
  const list =
    task.kind === "full"
      ? pool.full
      : task.kind === "next"
        ? task.sentences.length === 0
          ? pool.open
          : pool.next
        : pool.alt;
  return list.slice(0, task.count).map((s) => `${s}`);
}

const StyleAnalysis = z.object({
  catchphrases: z.array(z.string()).describe("用户反复使用的词或口头禅，3–8 个，必须真实出现在样本里"),
  bannedWords: z
    .array(z.string())
    .describe("用户从不使用、且 AI 写作常见的词或套话，5–10 个，用来避免 AI 腔"),
  openings: z.string().describe("开头方式，一句话"),
  stance: z.string().describe("观点表达方式，一句话"),
  humor: z.string().describe("幽默类型，一句话；没有明显幽默就写「很少开玩笑」"),
  topics: z.array(z.string()).describe("常写的话题领域，3–6 个"),
  notes: z.string().describe("其他明显习惯：标点、emoji、话题标签、换行、中英混排等，一两句话"),
  representative: z.array(z.number().int()).describe("最能代表这位用户风格的样本编号，5–8 个"),
});

export type StyleAnalysisResult = z.infer<typeof StyleAnalysis>;

/** 分析用户样本，生成风格卡的定性描述，并挑出代表句 */
export async function analyzeStyle(samples: string[], lang: "zh" | "en"): Promise<StyleAnalysisResult> {
  if (isMock()) return mockAnalysis(samples);

  const list = samples.map((s, i) => `[${i}] ${s}`).join("\n");
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "medium", format: betaZodOutputFormat(StyleAnalysis) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你是一位文字风格分析师。你会读一个人在 X（推特）上写的推文，总结出他的写作风格，供另一个模型模仿。描述要具体、可执行，避免「真诚」「有深度」这类空泛形容词。只根据样本下结论，不要编造。描述一律用中文写。",
    messages: [
      {
        role: "user",
        content: `下面是这位用户的 ${samples.length} 条${lang === "zh" ? "中文" : "英文"}推文样本，方括号里是编号：

${list}

请分析他的写作风格。`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝分析这些样本。");
  const out = response.parsed_output;
  if (!out) throw new GenerationError("风格分析没有返回结果，请重试。");
  return {
    ...out,
    representative: [...new Set(out.representative)].filter((i) => i >= 0 && i < samples.length).slice(0, 8),
  };
}

function mockAnalysis(samples: string[]): StyleAnalysisResult {
  return {
    catchphrases: ["说白了", "其实"],
    bannedWords: ["赋能", "深入探讨", "总而言之", "抓手", "闭环"],
    openings: "（演示）常以结论开头",
    stance: "（演示）直接下判断",
    humor: "（演示）偶尔自嘲",
    topics: ["（演示）请配置 API 密钥后重新生成"],
    notes: "演示模式生成的风格卡，内容是固定的。",
    representative: samples.slice(0, 5).map((_, i) => i),
  };
}

const LearnResult = z.object({
  observations: z
    .array(z.string())
    .describe("从修改里看出的规律，每条一句话，具体可执行，例如「总把『非常』删掉」「喜欢把长句拆成两句」；2–6 条"),
  catchphrases: z.array(z.string()),
  bannedWords: z.array(z.string()),
  openings: z.string(),
  stance: z.string(),
  humor: z.string(),
  topics: z.array(z.string()),
  notes: z.string(),
});

export interface LearnOutput {
  observations: string[];
  traits: StyleTraits;
}

/** 根据「候选原文 → 用户改写」总结规律，并给出更新后的风格卡描述 */
export async function learnFromEdits(traits: StyleTraits, edits: EditPair[]): Promise<LearnOutput> {
  if (isMock()) {
    return {
      observations: ["（演示）你常把长句拆成两句", "（演示）你会删掉「非常」「真的」这类加强语气的词"],
      traits: { ...traits, notes: `${traits.notes}；（演示）偏好短句，少用加强语气的词` },
    };
  }
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "medium", format: betaZodOutputFormat(LearnResult) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你是一位文字风格分析师。用户在用 AI 起草推文，会把 AI 给的候选句改成自己的说法。你要从这些改动里找出稳定的偏好，并据此更新他的风格卡。只总结反复出现、有把握的规律；偶然一次的改动不算。保留风格卡里仍然成立的内容，只做必要的增删改。描述一律用中文。",
    messages: [
      {
        role: "user",
        content: `当前风格卡：
${JSON.stringify(traits, null, 2)}

最近的 ${edits.length} 次修改（AI 原句 → 用户改成）：
${edits.map((e, i) => `${i + 1}. ${e.original}\n   → ${e.edited}`).join("\n")}

请总结规律，并给出更新后的完整风格卡。`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝了这个请求。");
  const out = response.parsed_output;
  if (!out) throw new GenerationError("没有总结出结果，请重试。");
  const { observations, ...rest } = out;
  return { observations, traits: rest };
}

const BlindResult = z.object({
  items: z.array(z.string()).describe("与输入顺序一一对应的新推文"),
});

/**
 * 风格盲测：针对每条真实推文，写一条同话题的新推文。
 * card 里不应包含这些真实推文，避免模型照抄。
 */
export async function generateBlindTwins(card: StyleCard, real: string[]): Promise<string[]> {
  if (isMock()) {
    return real.map((_, i) => `（演示）这是第 ${i + 1} 条 AI 写的推文，配置 API 密钥后才是真正的盲测。`);
  }
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(BlindResult) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: buildSystemPrompt(card), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `下面是这位用户写过的 ${real.length} 条推文。请针对每一条，用同样的话题写一条新的推文，要像他本人写的。
要求：不要复述原句的具体说法和例子；长度与原句接近；按顺序一一对应，共 ${real.length} 条。

${real.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝了这个请求。");
  const items = response.parsed_output?.items?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (items.length < real.length) throw new GenerationError("生成的条数不够，请重试。");
  return items.slice(0, real.length);
}

const ReplyResult = z.object({
  skip: z.boolean().describe("广告、垃圾内容、人身攻击等不值得回复时为 true"),
  skipReason: z.string().describe("skip 为 true 时用几个字说明原因，否则留空"),
  candidates: z.array(z.string()).describe("回复候选，每项一条；skip 为 true 时为空"),
});

export interface ReplyOutput {
  skip: boolean;
  skipReason: string;
  candidates: string[];
}

/** 自动回复：用风格卡为一条提及 / 评论写回复候选，并判断是否该跳过 */
export async function generateReplies(
  card: StyleCard,
  task: ReplyTask,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<ReplyOutput> {
  const out = await callReplies(card, task, edits, promo);
  return promo ? { ...out, candidates: out.candidates.map((c) => ensurePromo(c, promo)) } : out;
}

async function callReplies(
  card: StyleCard,
  task: ReplyTask,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<ReplyOutput> {
  if (isMock()) {
    if (/福利|领取|链接|加微/.test(task.incoming)) return { skip: true, skipReason: "（演示）疑似广告", candidates: [] };
    return {
      skip: false,
      skipReason: "",
      candidates: [
        "说白了就是别想太多，先做。",
        "其实我也没坚持得多好，只是没停下来。",
        "这个可以单独写一条，回头展开。",
      ].slice(0, task.count),
    };
  }
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: betaZodOutputFormat(ReplyResult) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: buildSystemPrompt(card), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildReplyPrompt(task, edits) + (promo ? promoPromptBlock(promo, "每条回复的结尾") : "") }],
  });
  if (response.stop_reason === "refusal") return { skip: true, skipReason: "模型拒绝回复这条内容", candidates: [] };
  const out = response.parsed_output;
  if (!out) throw new GenerationError("没有生成回复候选，请重试。");
  return {
    skip: out.skip,
    skipReason: out.skipReason.trim(),
    candidates: out.candidates.map((s) => s.trim()).filter(Boolean).slice(0, task.count),
  };
}

/** 引用推文：用风格卡为一条别人的推文写「引用时附上的话」候选 */
export async function generateQuotes(
  card: StyleCard,
  task: QuoteTask,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<string[]> {
  const out = isMock()
    ? [
        "（演示）同意一半。我自己的经验是，先砍掉一半想法，剩下的才做得完。",
        "（演示）说白了，这事难的不是知道，是第三个月还在做。",
        "（演示）想追问一句：如果连这个都做不到，是方法问题还是根本不想做？",
      ].slice(0, task.count)
    : await callQuotes(card, task, edits, promo);
  // 推广放在最后一条
  return promo
    ? out.map((c) => {
        const parts = splitThread(c);
        parts[parts.length - 1] = ensurePromo(parts[parts.length - 1], promo);
        return joinThread(parts);
      })
    : out;
}

async function callQuotes(card: StyleCard, task: QuoteTask, edits: EditPair[], promo?: PromoLink | null): Promise<string[]> {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: "low", format: betaZodOutputFormat(Candidates) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: buildSystemPrompt(card), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildQuotePrompt(task, edits) + (promo ? promoPromptBlock(promo, "每条的结尾") : "") }],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝了这个请求，换一条推文试试。");
  const out = response.parsed_output?.candidates?.map((s) => s.trim()).filter(Boolean);
  if (!out?.length) throw new GenerationError("没有生成可用的候选，请重试。");
  return out.slice(0, task.count);
}

const Points = z.object({
  points: z.array(z.string()).describe("3–5 个要点，每个一句话"),
});

/**
 * 灵感池：从一段外部内容里提炼 3–5 个可以拿来写推文的要点 / 角度。
 * 只提炼观点和事实，不改写原文，避免变成洗稿。
 */
export async function extractPoints(text: string, topics: string[] = []): Promise<string[]> {
  if (isMock()) {
    const first = text.replace(/\s+/g, " ").slice(0, 40);
    return [`（演示）这条内容在说：${first}…`, "（演示）你可以从自己的经历出发谈谈这件事", "（演示）这件事对你所在领域意味着什么"];
  }
  const response = await getClient().beta.messages.parse({
    model: LIGHT_MODEL,
    max_tokens: 1500,
    output_config: { effort: "low", format: betaZodOutputFormat(Points) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你帮一位推特作者从外部素材里找选题。读完素材，提炼 3–5 个值得写成推文的要点或切入角度。\n" +
      "要求：\n- 每个要点一句话，用中文，写成「可以表达的观点 / 可以讨论的问题」，而不是复述原文\n" +
      "- 不要照抄原文句子，不要写成推文成品\n- 角度彼此不同，例如：核心事实、反直觉之处、对普通人的影响、可以反驳的地方",
    messages: [
      {
        role: "user",
        content: `${topics.length ? `作者常写的领域：${topics.join("、")}（优先挑和这些相关的角度）\n\n` : ""}素材：\n${text.slice(0, 6000)}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝处理这条内容。");
  const points = response.parsed_output?.points?.map((s) => s.trim()).filter(Boolean);
  if (!points?.length) throw new GenerationError("没有提炼出要点，请重试。");
  return points.slice(0, 5);
}

const SourceCandidates = z.object({
  skip: z.boolean().describe("原文信息太少、写不出能让人看懂的帖子时为 true"),
  skipReason: z.string().describe("skip 为 true 时的原因，几个字；否则留空"),
  candidates: z
    .array(z.object({ tweets: z.array(z.string()).describe("这个候选的推文，按顺序；写一条时只放一条") }))
    .describe("候选；skip 时留空"),
});

/** 原文没法写（信息太少等），不算出错，不重试 */
export class SourceSkip extends Error {}

/** 自动发帖：根据采集到的内容，用风格卡写几条推文候选 */
export async function generateFromSource(card: StyleCard, task: SourceTask, edits: EditPair[], promo?: PromoLink | null): Promise<string[]> {
  let out: string[];
  if (isMock()) {
    const gist = task.source.replace(/\s+/g, "").slice(0, 12);
    out = [
      `（演示）说白了，「${gist}」这类事，真正决定结果的是有没有人愿意坚持做三个月。`,
      `（演示）我的看法有点不一样：热闹的时候最该慢一点，先想清楚自己要什么。`,
    ]
      .map((t) => (task.shape?.kind === "thread" ? joinThread([t, "（演示）第二条：把原文剩下的要点按顺序讲完。"]) : t))
      .slice(0, task.count);
  } else {
    const response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: task.shape && task.shape.kind !== "single" ? 8000 : 3000,
      // 要写得通顺、意思完整，不用最低档
      output_config: { effort: "medium", format: betaZodOutputFormat(SourceCandidates) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: buildSystemPrompt(card), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildSourcePrompt(task, edits) + (promo ? promoPromptBlock(promo, "每条的结尾") : "") }],
    });
    if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝处理这条内容。");
    const parsed = response.parsed_output;
    if (parsed?.skip) throw new SourceSkip(`原文没法写成能看懂的帖子：${parsed.skipReason || "信息太少"}`);
    out = (parsed?.candidates ?? []).map((c) => joinThread(c.tweets)).filter(Boolean);
    if (!out.length) throw new GenerationError("没有生成可用的候选。");
    out = out.slice(0, task.count);
  }
  return promo ? out.map((c) => ensurePromo(c, promo)) : out;
}

const Review = z.object({
  reviews: z.array(
    z.object({
      fluent: z.number().int().describe("通顺 1–5"),
      complete: z.number().int().describe("完整 1–5"),
      standalone: z.number().int().describe("独立可懂 1–5"),
      faithful: z.number().int().describe("忠于原文 1–5"),
      repeat: z.boolean().describe("和最近发过的某条是同一个观点"),
      unsafe: z.boolean().describe("涉及色情、成人、性暗示、赌博、血腥暴力"),
      issue: z.string().describe("最大的问题，一句话；没有就留空"),
    }),
  ),
});

export interface ReadabilityScore {
  fluent: number;
  complete: number;
  standalone: number;
  faithful: number;
  repeat: boolean;
  unsafe: boolean;
  issue: string;
}

/** 读者视角检查：每条候选通不通顺、说没说完、不看原文能不能看懂、忠不忠于原文（1–5 分），和最近发过的是不是同一个观点 */
export async function reviewReadability(source: string, candidates: string[], recent: string[] = []): Promise<ReadabilityScore[]> {
  if (isMock()) return candidates.map(() => ({ fluent: 5, complete: 5, standalone: 5, faithful: 5, repeat: false, unsafe: false, issue: "" }));
  const response = await getClient().beta.messages.parse({
    model: LIGHT_MODEL,
    max_tokens: 1500,
    output_config: { effort: "low", format: betaZodOutputFormat(Review) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: buildReviewPrompt({ source, candidates, recent: recent.slice(0, 20) }) }],
  });
  const list = response.parsed_output?.reviews ?? [];
  // 检查本身出问题时不拦（代码检查还在），按中等分处理
  return candidates.map((_, i) => list[i] ?? { fluent: 3, complete: 3, standalone: 3, faithful: 3, repeat: false, unsafe: false, issue: "没能检查" });
}

const MemoryResult = z.object({
  persona: z.string().describe("一两句话：这个账号是谁、一贯在说什么。只根据推文下结论"),
  topics: z.array(z.string()).describe("经常讨论的话题，3–10 个，按出现多少排序"),
  positions: z.array(z.string()).describe("反复表达过的观点或立场，每条一句话，写成「认为……」，3–10 条；必须在推文里有依据"),
  opposes: z.array(z.string()).describe("明确反对或批评过的观点，每条一句话，写成「反对……」；没有就留空"),
  phrasing: z.array(z.string()).describe("喜欢的表达方式：常用句式、比喻、口吻、结构，每条一句话，3–8 条"),
  avoid: z.array(z.string()).describe("从来不碰的话题或说法（只写有把握的），没有就留空"),
});

/**
 * 账号记忆：读本人的推文，总结这个账号经常聊什么、坚持和反对什么、喜欢怎么说。
 * current 是之前的记忆；userEdited 时用户亲手改过，那里面的条目要原样保留。
 */
export async function summarizeMemory(current: AccountMemory, posts: string[], userEdited: boolean): Promise<AccountMemory> {
  if (isMock()) {
    return {
      persona: current.persona || "（演示）一个爱讲实操经验、说话直接的账号",
      topics: current.topics.length ? current.topics : ["（演示）个人成长", "（演示）做产品"],
      positions: current.positions.length ? current.positions : ["（演示）认为先做出来比想清楚更重要"],
      opposes: current.opposes.length ? current.opposes : ["（演示）反对只谈方法论不动手"],
      phrasing: current.phrasing.length ? current.phrasing : ["（演示）常用「说白了」引出结论"],
      avoid: current.avoid,
    };
  }
  const hasCurrent = !!(current.persona || current.topics.length || current.positions.length);
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: "medium", format: betaZodOutputFormat(MemoryResult) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你在为一个 X（推特）账号整理「账号记忆」，供另一个模型以后替这个账号写推文时参考，让账号的人设、观点和说话方式前后一致。" +
      "只根据推文里真实出现的内容下结论，不要编造、不要拔高；观点要具体到能用来判断一条新推文有没有跑偏。描述一律用中文。",
    messages: [
      {
        role: "user",
        content: `${
          hasCurrent
            ? `之前的账号记忆：\n${JSON.stringify(current, null, 2)}\n\n${
                userEdited
                  ? "这份记忆用户亲手改过：里面的每一条都必须原样保留，只能补充新的。"
                  : "保留仍然成立的内容，根据推文增删改。"
              }\n\n`
            : ""
        }这个账号的 ${posts.length} 条推文（越靠前越新）：
${posts.map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}

请整理账号记忆。`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝整理这些推文。");
  const out = response.parsed_output;
  if (!out) throw new GenerationError("没有整理出结果，请重试。");
  if (!userEdited) return out;
  // 用户改过的条目，模型漏了也补回来
  const keep = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    persona: current.persona || out.persona,
    topics: keep(current.topics, out.topics),
    positions: keep(current.positions, out.positions),
    opposes: keep(current.opposes, out.opposes),
    phrasing: keep(current.phrasing, out.phrasing),
    avoid: keep(current.avoid, out.avoid),
  };
}

const ImagePlanSchema = z.object({
  tag: z.string().describe("左上角的小标签，2–6 个字，例如「开源项目速览」「数据速读」「一句话观点」"),
  title: z.string().describe("图上的大标题，中文，不超过 22 个字；有专有名词时写成「名称：一句话说明」"),
  points: z.array(z.string()).describe("3–4 个要点，每个不超过 24 个字，是读者一眼能看懂的事实或结论"),
  source: z.string().describe("资料来源名称（例如「GitHub · 项目说明」「路透社」），只写名称不写链接；不知道就留空"),
  scene: z
    .string()
    .describe(
      "给 AI 画图用的英文画面描述（60–120 词）：具体画什么、构图、光线、风格。画面里不能有任何文字、字母、数字、Logo、水印、界面截图，也不要画真实人物的长相",
    ),
  people: z.boolean().describe("内容的主角是不是真实存在的具体人物（名人、政要、网红等）"),
});
export type ImagePlan = z.infer<typeof ImagePlanSchema>;

/**
 * 配图：读懂帖子（和可选的参考图），给出信息卡的文字和 AI 画图的画面描述。
 * 参考图只用来「看懂内容」：要点用自己的话写，不照抄图上的句子，不复刻原图构图。
 */
const SourceImageCheck = z.object({
  kind: z
    .enum(["screenshot", "chart", "product", "document", "meme", "photo", "artwork", "news_photo", "person", "other"])
    .describe("图片类型"),
  watermark: z.boolean().describe("有没有别人的水印、署名或 Logo 角标"),
  nsfw: z.boolean().describe("有没有色情、裸露、性暗示、血腥暴力内容"),
  matches: z.boolean().describe("图片内容和帖子说的是不是同一件事"),
  reason: z.string().describe("一句话说明"),
});

export interface SourceImageVerdict {
  usable: boolean;
  kind: string;
  reason: string;
}

/** 可以拿来配图的图片类型：截图、图表、产品界面、文档、梗图；摄影、手绘插画、新闻照片、人物照片不用 */
const REUSABLE_KINDS = new Set(["screenshot", "chart", "product", "document", "meme"]);

/**
 * 原帖的图能不能拿来配图：只用截图、图表、产品界面、文档、梗图这类信息性的图；
 * 摄影、手绘 / 插画等原创作品、新闻现场照片、能认出具体人的照片、带别人水印的都不用
 */
export async function classifySourceImage(img: { mime: string; base64: string }, text: string): Promise<SourceImageVerdict> {
  if (isMock()) return { usable: true, kind: "screenshot", reason: "（演示）截图" };
  const response = await getClient().beta.messages.parse({
    model: LIGHT_MODEL,
    max_tokens: 600,
    output_config: { effort: "low", format: betaZodOutputFormat(SourceImageCheck) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你判断一张图片属于哪一类，用来决定能不能把它当配图转发。类型：\n" +
      "- screenshot：软件、网页、聊天、推文的截图\n- chart：图表、数据图、表格\n- product：产品照片或产品界面、官方宣传图\n" +
      "- document：文档、公告、论文、代码\n- meme：梗图、表情包\n- photo：摄影作品、风景、街拍、美食等照片\n" +
      "- artwork：手绘、插画、设计作品、AI 画作等原创作品\n- news_photo：新闻现场照片\n- person：主体是能认出来的具体某个人\n- other：其他\n" +
      "拿不准时选更保守的类型（photo / artwork / person）。",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: img.mime as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: img.base64 } },
          { type: "text", text: `这张图所在的帖子：\n${text.slice(0, 1500)}` },
        ],
      },
    ],
  });
  const out = response.parsed_output;
  if (!out) return { usable: false, kind: "other", reason: "没能判断" };
  if (out.nsfw) return { usable: false, kind: out.kind, reason: "图片涉及色情或暴力" };
  const usable = REUSABLE_KINDS.has(out.kind) && !out.watermark && out.matches;
  return { usable, kind: out.kind, reason: out.reason };
}

export async function planImage(text: string, ref?: { mime: string; base64: string } | null): Promise<ImagePlan> {
  if (isMock()) {
    const gist = text.replace(/\s+/g, " ").trim();
    return {
      tag: "要点速览",
      title: Array.from(gist).slice(0, 18).join("") || "（演示）标题",
      points: ["（演示）第一个要点", "（演示）第二个要点", "（演示）第三个要点"],
      source: "",
      scene: "A calm minimalist desk by a window at sunrise, soft light, flat illustration, no text",
      people: false,
    };
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (ref) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: ref.mime as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: ref.base64 },
    });
  }
  content.push({ type: "text", text: `${ref ? "上面是参考图（只用来看懂内容）。\n\n" : ""}帖子内容：\n${text.slice(0, 6000)}` });
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: betaZodOutputFormat(ImagePlanSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你帮一位中文推特作者给帖子配图。配图有两种：一种是信息卡（程序把标题和要点排版成图），一种是 AI 画的无字插图。\n" +
      "要求：\n- 标题和要点用简体中文，忠于帖子和参考图里的事实，数字、名称一个字都不能错\n" +
      "- 用自己的话概括，不照抄原文句子\n- 参考图里的 Logo、截图、照片都不要复刻；画面描述要画一张全新的、构图不同的图\n" +
      "- 画面描述里绝不能出现文字、字母、数字、Logo、水印，也不画真实人物的长相",
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝处理这条内容。");
  const out = response.parsed_output;
  if (!out?.title) throw new GenerationError("没有读懂内容，请重试。");
  return out;
}
