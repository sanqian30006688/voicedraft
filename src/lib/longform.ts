import Anthropic from "@anthropic-ai/sdk";
import { usageFetch } from "./usage";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { GenerationError, isMock, MODEL } from "./llm";
import { computeMetrics, describeMetrics } from "./metrics";
import { ensurePromo, hasPromo, promoPromptBlock, type PromoLink } from "./promo";
import type { EditPair, StyleCard } from "./style-card";

/**
 * 长文生成：三种形式
 * - single：单条长推，一条推文写 100–300 字；超过 280 加权字数（约 140 个汉字）需要 X Premium
 * - thread：串推（线程），每条单独发，每条受 280 加权字数限制
 * - article：X 长文（Articles），有标题、小标题和配图位置，不受 280 限制
 *
 * 流程：
 * - single：主题 → 3 条整条候选 → 选一条 → 对任意一段「换这段」/ 直接改字
 * - thread / article：主题 → 提纲（可改）→ 按提纲写全文 → 对任意一段「换这段」/ 直接改字
 */

export type LongFormat = "single" | "thread" | "article";
export type LongLength = "short" | "medium" | "long";

export type LongTask =
  | { kind: "outline"; format: LongFormat; length: LongLength; topic: string; notes: string }
  | { kind: "candidates"; format: "single"; length: LongLength; topic: string; notes: string; count: number }
  | {
      kind: "write";
      format: LongFormat;
      length: LongLength;
      topic: string;
      notes: string;
      title: string;
      outline: string[];
    }
  | {
      kind: "rewrite";
      format: LongFormat;
      topic: string;
      notes: string;
      title: string;
      parts: string[];
      position: number;
      instruction: string;
      count: number;
    };

export interface LongResult {
  title: string;
  /**
   * outline：提纲要点；candidates：单条长推的整条候选；
   * write：串推的每一条 / 长文的每一段（小标题以「## 」开头，配图位置以「[配图] 」开头）；rewrite：替换候选
   */
  items: string[];
}

export const LENGTH_SPEC: Record<LongFormat, Record<LongLength, string>> = {
  single: { short: "约 100 字", medium: "约 200 字", long: "约 300 字" },
  thread: { short: "4–6 条", medium: "7–10 条", long: "11–15 条" },
  article: { short: "约 800 字", medium: "约 1500 字", long: "约 3000 字" },
};

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

/** 系统提示：风格卡 + 样本 + 长文写作规则。同一用户、同一形式下不变，便于缓存。 */
function buildLongSystemPrompt(card: StyleCard, format: LongFormat): string {
  const t = card.traits;
  const metrics = describeMetrics(computeMetrics(card.samples));
  const pinned = card.pinned.map((i) => card.samples[i]).filter(Boolean);
  const others = card.samples.filter((_, i) => !card.pinned.includes(i)).slice(0, 30);
  const formatRules =
    format === "single"
      ? `# 形式：单条长推
- 一条推文单独发出，篇幅比普通推文长（100–300 字），但仍然是一条推文，不是文章
- 不要标题，不要小标题，不要编号列表
- 第一句就是钩子：在时间线上被折叠时只露出前两三行，开头要让人想点「显示更多」
- 可以用空行分成 2–4 小段，每段 1–3 句，节奏像这位用户平时的推文
- 结尾收在一个判断或一个具体做法上，不写「总而言之」「欢迎讨论」`
      : format === "thread"
      ? `# 形式：串推（X 线程）
- 由多条推文组成，每条单独发出，读者在时间线上一条条往下刷
- 每条推文的加权字数必须 ≤ 280（一个汉字计 2），也就是每条不超过约 130 个汉字，宁短勿长
- 第一条是钩子：单独看也要让人想点开，直接抛出结论、反常识的判断或具体的场景，不写「今天聊聊」「一个线程」这种预告
- 每条只讲一个点，读者只看这一条也能看懂
- 最后一条收住，可以是一句判断或一个具体建议，不写「以上」「总结一下」「欢迎转发」
- 不要在正文里加「1/」「🧵」之类的编号，编号由软件加`
      : `# 形式：X 长文（Articles）
- 有一个标题，正文分成若干段，可以用 2–5 个小标题分节
- 标题要具体、像这位用户会起的标题，不用「深度解析」「万字长文」「干货」这种词
- 开头一两段直接进入正题，不写背景铺垫和「本文将介绍」
- 段落短，每段 1–4 句，像推文一样好读
- 结尾落在一个判断或一个具体做法上，不写「总而言之」「希望对你有帮助」
- 在适合放图的地方单独插入一项配图位置，以「[配图] 」开头，后面一句话写建议放什么图（例如：后台数据截图、手绘流程图、现场照片），全文 1–3 处；只放真正能帮读者看懂的图，不放装饰图`;

  return `你在帮一位用户写一篇发在 X（推特）上的长内容。目标只有一个：读起来要像这位用户本人写的，而不是像 AI 写的。

用户会逐段挑选、改写，最后由本人决定是否发布。

# 这位用户的风格（来自这位用户的短推文，长内容里也要保持同样的语气）

## 统计指标（由代码从样本算出，句长和标点习惯请贴近这些数字）
${metrics}

## 定性描述
- 常用词 / 口头禅：${t.catchphrases.join("、") || "无"}（全文自然地出现几次即可，不要每段都塞）
- 从不使用的词：${t.bannedWords.join("、") || "无"}（绝对不要出现）
- 开头方式：${t.openings}
- 观点表达：${t.stance}
- 幽默类型：${t.humor}
- 话题领域：${t.topics.join("、")}
- 其他：${t.notes}

## 最具代表性的原句
${pinned.map((s) => `- ${s}`).join("\n")}

## 更多样本
${others.map((s) => `- ${s}`).join("\n")}

${formatRules}

# 写作规则
- 模仿的是语气、节奏、用词和判断方式，不是照抄样本里的句子或观点
- 不写空话套话，不用排比，不加用户样本里没有的修辞习惯
- 用户给的观点和材料是骨架，要写具体：举例子、给数字、讲经历，但不要编造具体的数据来源或真实人物的言论
- 只输出正文，不加引号、解释或「以下是」`;
}

function editsBlock(edits: EditPair[]): string {
  if (!edits.length) return "";
  return `\n\n# 用户最近对候选做过的修改（从中学习偏好，直接朝这个方向写）
${edits.map((e) => `- 原候选：${e.original}\n  用户改成：${e.edited}`).join("\n")}`;
}

function head(task: { topic: string; notes?: string }) {
  const notes = task.notes?.trim();
  return `主题 / 想表达的观点：${task.topic}${notes ? `\n\n用户补充的要点或材料：\n${notes}` : ""}`;
}

/** 推广放在哪里：写全文时放在串推最后一条 / 长文最后一段；换某段时只在原文带链接时保留 */
function longPromoBlock(task: LongTask, promo: PromoLink | null | undefined): string {
  if (!promo) return "";
  if (task.kind === "candidates") {
    return promoPromptBlock(promo, "每条候选的最后一段", { tweetLimit: false });
  }
  if (task.kind === "write") {
    return task.format === "thread"
      ? promoPromptBlock(promo, "串推的最后一条")
      : promoPromptBlock(promo, "长文的最后一段", { tweetLimit: false });
  }
  if (task.kind === "rewrite" && hasPromo(task.parts[task.position] ?? "", promo)) {
    return promoPromptBlock(promo, "每个替换版本", { tweetLimit: task.format === "thread" });
  }
  return "";
}

function buildLongUserPrompt(task: LongTask, edits: EditPair[], promo?: PromoLink | null): string {
  const promoBlock = longPromoBlock(task, promo);
  switch (task.kind) {
    case "outline": {
      const spec = LENGTH_SPEC[task.format][task.length];
      return task.format === "thread"
        ? `${head(task)}

请为一条 ${spec} 的串推列提纲：按顺序，每条推文一个要点，每个要点用一句话写清这条要讲什么（不是写正文）。title 写一句话概括整条串推的核心观点。`
        : `${head(task)}

请为一篇 ${spec} 的长文列提纲：给出标题，再按顺序列出 4–8 个要点，每个要点一句话写清这部分要讲什么（不是写正文）。`;
    }
    case "candidates":
      return `${head(task)}

请写 ${task.count} 条单条长推候选，每条${LENGTH_SPEC.single[task.length]}，放在 items 里。角度或结构彼此明显不同（例如一条先下结论再讲经历、一条从一个具体场景切入、一条拆一个常见误区）。段落之间用空行隔开。title 留空。${promoBlock}${editsBlock(edits)}`;
    case "write": {
      const spec = LENGTH_SPEC[task.format][task.length];
      const outline = task.outline.map((p, i) => `${i + 1}. ${p}`).join("\n");
      return task.format === "thread"
        ? `${head(task)}

核心观点：${task.title}

提纲（用户已确认，按这个顺序写，每个要点写成一条推文；如果某个要点太大可以拆成两条）：
${outline}

请写出完整串推，${spec}。items 里每项是一条推文。title 原样返回核心观点。${promoBlock}${editsBlock(edits)}`
        : `${head(task)}

标题：${task.title}

提纲（用户已确认，按这个顺序写）：
${outline}

请写出完整长文，${spec}。title 写最终标题（可以在原标题基础上改得更好）。items 里每项是一段正文；小标题单独作为一项，以「## 」开头。${promoBlock}${editsBlock(edits)}`;
    }
    case "rewrite": {
      const unit = task.format === "thread" ? "条" : "段";
      const label = task.format === "single" ? "" : `${task.format === "thread" ? "核心观点" : "标题"}：${task.title}\n\n`;
      const all = task.parts.map((p, i) => `[${i + 1}] ${p}`).join("\n");
      const target = task.parts[task.position];
      const extra = task.instruction.trim() ? `\n\n用户对这${unit}的要求：${task.instruction.trim()}` : "";
      return `${head(task)}

${label}全文目前是（方括号里是第几${unit}）：
${all}

请为第 ${task.position + 1} ${unit}写 ${task.count} 个替换版本，放在 items 里。要和前后衔接，彼此不同，也不要和原文雷同。${
        target.startsWith("## ")
          ? "这是一个小标题，替换版本也以「## 」开头。"
          : target.startsWith("[配图]")
            ? "这是一个配图位置，替换版本也以「[配图] 」开头，换一种更合适的配图建议。"
            : ""
      }${task.format === "thread" ? "每个版本的加权字数必须 ≤ 280。" : ""}title 原样返回。${extra}${promoBlock}${editsBlock(edits)}`;
    }
  }
}

const Output = z.object({
  title: z.string().describe("标题或核心观点"),
  items: z.array(z.string()).describe("按顺序的各项内容"),
});

export async function generateLong(
  card: StyleCard,
  task: LongTask,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<LongResult> {
  const result = isMock() ? mockLong(task) : await callLong(card, task, edits, promo);
  return withPromo(task, result, promo);
}

/** 模型漏掉链接时兜底补上：全文补在最后一条 / 最后一段，换段时补在每个版本末尾 */
function withPromo(task: LongTask, result: LongResult, promo: PromoLink | null | undefined): LongResult {
  if (!promo || !longPromoBlock(task, promo)) return result;
  if (task.kind === "rewrite" || task.kind === "candidates") {
    return { ...result, items: result.items.map((x) => ensurePromo(x, promo)) };
  }
  if (result.items.some((x) => hasPromo(x, promo))) return result;
  const items = [...result.items];
  const last = items.length - 1;
  if (last < 0 || items[last].startsWith("## ") || items[last].startsWith("[配图]")) items.push(ensurePromo("", promo).trim());
  else items[last] = ensurePromo(items[last], promo);
  return { ...result, items };
}

async function callLong(
  card: StyleCard,
  task: LongTask,
  edits: EditPair[],
  promo?: PromoLink | null,
): Promise<LongResult> {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: task.kind === "write" ? 16000 : task.kind === "candidates" ? 8000 : 4000,
    // 写全文 / 整条长推要质量：medium；列提纲、换段要快：low
    output_config: {
      effort: task.kind === "write" || task.kind === "candidates" ? "medium" : "low",
      format: betaZodOutputFormat(Output),
    },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: buildLongSystemPrompt(card, task.format), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildLongUserPrompt(task, edits, promo) }],
  });

  if (response.stop_reason === "refusal") throw new GenerationError("模型拒绝了这个请求，换个说法试试。");
  if (response.stop_reason === "max_tokens") throw new GenerationError("内容太长没写完，试试选短一点的篇幅。");
  const out = response.parsed_output;
  const items = out?.items.map((s) => s.trim()).filter(Boolean) ?? [];
  if (!out || !items.length) throw new GenerationError("没有生成可用的内容，请重试。");
  return {
    title: out.title.trim(),
    items: task.kind === "rewrite" || task.kind === "candidates" ? items.slice(0, task.count) : items,
  };
}

function mockLong(task: LongTask): LongResult {
  const t = task.topic.trim() || "这件事";
  if (task.kind === "candidates") {
    return {
      title: "",
      items: [
        `说白了，${t}这件事，难的从来不是开始。是第三个月还愿意做。\n\n我第一次做的时候，前两周每天都很兴奋。第三周开始，就找各种理由拖。后来我才明白，前两个月的反馈最有迷惑性：增长快，是因为基数小。\n\n所以我现在只做一件事：先定一个能坚持 90 天的最小动作，别的都往后放。`,
        `上周有人问我${t}到底该怎么开始。\n\n我的回答可能不太好听：先别看教程。你收藏的那些方法论，九成用不上。真正有用的，是你自己做砸一次以后留下的那点感觉。\n\n做出来，再谈方法。`,
        `关于${t}，最常见的误区是想一步到位。\n\n我见过太多人花一个月搭框架，第二个月就放弃了。其实砍掉一半，只留最核心的那部分，反而走得更远。\n\n（演示模式：配置 API 密钥后会按你的风格卡生成真实内容。）`,
      ].slice(0, task.count),
    };
  }
  if (task.kind === "outline") {
    return task.format === "thread"
      ? {
          title: `${t}，难的不是开始，是坚持到第三个月`,
          items: [
            `钩子：大多数人在${t}上失败，不是因为方法不对`,
            "我自己踩过的第一个坑",
            "为什么前两个月的反馈最具迷惑性",
            "我现在的做法：先砍掉一半",
            "收尾：给想开始的人一个具体建议",
          ],
        }
      : {
          title: `关于${t}，我想了一年才想明白的事`,
          items: ["开头：一个反常识的结论", "我是怎么走到这一步的", "大家最常见的三个误区", "我现在的做法", "结尾：一个具体建议"],
        };
  }
  if (task.kind === "write") {
    return task.format === "thread"
      ? {
          title: task.title,
          items: [
            `说白了，${t}这件事，难的从来不是开始。是第三个月还愿意做。`,
            "我第一次做的时候，前两周每天都很兴奋。第三周开始，就找各种理由拖。",
            "前两个月的反馈最有迷惑性：增长快，是因为基数小。你以为找到了方法，其实只是运气。",
            "所以我现在的做法是，先砍掉一半。只留一件每天都能做完的小事。",
            `如果你也想开始${t}，别先定目标。先定一个你确定能坚持 90 天的最小动作。`,
          ],
        }
      : {
          title: task.title,
          items: [
            `其实我对${t}的看法很简单：先做出来，再谈方法论。`,
            "这句话我说了很多次，但每次都有人问：那方法论什么时候谈？",
            "## 我是怎么走到这一步的",
            "[配图] 一年前收藏夹的截图，几百篇文章堆在一起",
            "一年前我也是那个到处找方法的人。收藏了几百篇文章，一篇都没用上。",
            "## 最常见的误区",
            "第一，想得太多。第二，做得太大。第三，放弃得太早。",
            "## 我现在的做法",
            "每天只做一件小事，做完就停。听起来很笨，但这是我唯一坚持下来的办法。",
            "（演示模式：配置 API 密钥后会按你的风格卡生成真实内容。）",
          ],
        };
  }
  const target = task.parts[task.position] ?? "";
  if (target.startsWith("[配图]")) {
    return { title: task.title, items: ["[配图] 一张前后对比图", "[配图] 手绘的流程草图", "[配图] 后台数据截图"].slice(0, task.count) };
  }
  const isHeading = target.startsWith("## ");
  return {
    title: task.title,
    items: (isHeading
      ? ["## 换个角度说", "## 我踩过的坑", "## 真正有用的一件事"]
      : ["换个角度说，这本来就是个筛选。", "坦白讲，我也是踩过坑才明白。", "这不是能力问题，是耐心问题。"]
    ).slice(0, task.count),
  };
}
