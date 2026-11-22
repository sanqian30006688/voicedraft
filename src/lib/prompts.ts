import type { PostShape } from "./source-check";
import { memoryPromptBlock } from "./memory-core";
import { computeMetrics, describeMetrics } from "./metrics";
import { hasPromo, promoPromptBlock, type PromoLink } from "./promo";
import type { EditPair, StyleCard } from "./style-card";

export type Task =
  | { kind: "full"; topic: string; count: number }
  | { kind: "next"; topic: string; sentences: string[]; count: number }
  | { kind: "alternatives"; topic: string; sentences: string[]; position: number; count: number }
  /** 带推广链接的收尾句（逐句模式里最后一步用） */
  | { kind: "promo"; topic: string; sentences: string[]; count: number };

/**
 * 系统提示：只放同一用户多次调用间不变的内容（风格卡、样本），
 * 便于提示词缓存。每次变化的内容（主题、已确定句子、最近修改）放在用户消息里。
 */
export function buildSystemPrompt(card: StyleCard): string {
  const t = card.traits;
  const metrics = describeMetrics(computeMetrics(card.samples));
  const pinned = card.pinned.map((i) => card.samples[i]).filter(Boolean);
  const others = card.samples.filter((_, i) => !card.pinned.includes(i)).slice(0, 30);
  return `你在帮一位用户起草 X（推特）推文。目标只有一个：写出来的句子要像这位用户本人写的，而不是像 AI 写的。

用户会从你给的候选里挑选、改写，最后由本人决定是否发布。所以每个候选都要有真实差异，让用户有得选。

# 这位用户的风格

## 统计指标（由代码从样本算出，请贴近这些数字）
${metrics}

## 定性描述
- 常用词 / 口头禅：${t.catchphrases.join("、") || "无"}（自然地用，不要每句都塞）
- 从不使用的词：${t.bannedWords.join("、") || "无"}（绝对不要出现）
- 开头方式：${t.openings}
- 观点表达：${t.stance}
- 幽默类型：${t.humor}
- 话题领域：${t.topics.join("、")}
- 其他：${t.notes}

## 最具代表性的原句
${pinned.map((s) => `- ${s}`).join("\n")}

## 更多样本
${others.map((s) => `- ${s}`).join("\n")}${memoryPromptBlock(card.memory, card.recent)}

# 写作规则
- 模仿的是语气、节奏、用词和判断方式，不是照抄样本里的句子或观点
- 不写空话套话，不用排比和总结式结尾，不加用户样本里没有的修辞习惯
- 中文推文的加权字数上限是 280（一个汉字计 2），整条推文大约不超过 140 个汉字
- 只输出推文正文，不加引号、编号、解释`;
}

function editsBlock(edits: EditPair[]): string {
  if (!edits.length) return "";
  return `\n\n# 用户最近对候选做过的修改（请从中学习偏好，后续候选直接朝这个方向写）
${edits.map((e) => `- 原候选：${e.original}\n  用户改成：${e.edited}`).join("\n")}`;
}

function relatedBlock(related: string[] | undefined): string {
  if (!related?.length) return "";
  return `\n\n# 用户写过的、和这次主题最接近的原句（参考语气和角度，不要照抄）
${related.map((s) => `- ${s}`).join("\n")}`;
}

/**
 * promo：这篇要带的推广链接（没有就不带）。
 * - full：每条候选结尾都带上
 * - promo：写带推广的收尾句
 * - alternatives：被替换的那句本来就带着链接时，替换候选也要带
 * - next：不带，提醒模型别自己加链接（推广留给最后一步）
 */
export function buildUserPrompt(task: Task, edits: EditPair[], related?: string[], promo?: PromoLink | null): string {
  const head = `主题 / 想表达的观点：${task.topic}${relatedBlock(related)}`;
  switch (task.kind) {
    case "full":
      return `${head}

请写 ${task.count} 条完整推文候选。每条 1–4 句，角度或切入方式彼此明显不同（例如一条下结论、一条讲经历、一条反问）。${
        promo ? promoPromptBlock(promo, "每条候选的结尾") : ""
      }${editsBlock(edits)}`;
    case "promo":
      return `${head}

已经确定的句子（按顺序）：
${task.sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}

请给出 ${task.count} 个「收尾句」候选，每个只写一句，接在上面之后，顺带引出下面的推广，彼此说法不同。${
        promo ? promoPromptBlock(promo, "这句") : ""
      }${editsBlock(edits)}`;
    case "next": {
      if (task.sentences.length === 0) {
        return `${head}

请给出 ${task.count} 个「开头句」候选，每个只写一句，开头方式彼此不同。${editsBlock(edits)}`;
      }
      return `${head}

已经确定的句子（按顺序）：
${task.sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}

请给出 ${task.count} 个「下一句」候选，每个只写一句，要能自然接在上面之后，彼此方向不同。如果你认为推文已经完整，其中一个候选可以是简短的收尾句。${
        promo ? "\n\n不要写任何链接或群号，推广会在最后单独加；推广句大约占 40–60 加权字数，正文留出这部分余量。" : ""
      }${editsBlock(edits)}`;
    }
    case "alternatives": {
      const target = task.sentences[task.position];
      const keepPromo = promo && hasPromo(target, promo);
      return `${head}

整条推文目前是（按顺序）：
${task.sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}

请为第 ${task.position + 1} 句「${target}」写 ${task.count} 个替换候选。每个只写一句，要和前后句衔接，彼此不同，也不要和原句雷同。${
        keepPromo ? promoPromptBlock(promo, "每个替换候选") : ""
      }${editsBlock(edits)}`;
    }
  }
}

export interface ReplyTask {
  /** 对方的推文 */
  incoming: string;
  authorHandle: string;
  /** 对方回复的那条推文（通常是用户本人的推文），没有时为 null */
  inReplyTo: string | null;
  count: number;
  /** timeline：对方是用户关注的人，没有 @ 用户，是用户主动去对方帖子下回复 */
  source?: "mention" | "timeline";
}

export function buildReplyPrompt(task: ReplyTask, edits: EditPair[]): string {
  if (task.source === "timeline") return buildFollowReplyPrompt(task, edits);
  return `有人在 X 上 @ 了这位用户${task.inReplyTo ? "，回复的是这条推文" : ""}。
${task.inReplyTo ? `\n用户的原推文：${task.inReplyTo}\n` : ""}
@${task.authorHandle} 写道：${task.incoming}

先判断要不要回：广告、引流、垃圾内容、人身攻击或明显的挑衅，设 skip 为 true 并用几个字说明原因，candidates 留空。
否则以这位用户本人的口吻写 ${task.count} 条回复候选，方向彼此不同（例如一条直接回答、一条补充观点、一条简短回应）。
要求：
- 回复要短，通常一两句，像真人随手回的，不寒暄、不说「感谢您的提问」
- 针对对方说的具体内容回应，不说空话
- 不要在开头加 @用户名，X 会自动处理
- 每条加权字数不超过 280${editsBlock(edits)}`;
}

/** 关注的人发的帖子：对方没有 @ 用户，用户主动去回复，要像同圈子的人自然插一句 */
function buildFollowReplyPrompt(task: ReplyTask, edits: EditPair[]): string {
  return `这位用户关注的 @${task.authorHandle} 在 X 上发了下面这条推文，对方并没有 @ 这位用户。用户想在下面回复一句。

@${task.authorHandle} 写道：${task.incoming}

先判断值不值得回：广告、抽奖、引流、纯转发链接、政治或争议很大的话题、对方在吐槽或情绪低落时不适合陌生人插话、或者这位用户没什么可补充的，设 skip 为 true 并用几个字说明原因，candidates 留空。
否则以这位用户本人的口吻写 ${task.count} 条回复候选，方向彼此不同（例如一条补充自己的经验、一条提出一个具体问题、一条简短表态并给理由）。
要求：
- 像同一个圈子的人随手接一句，有自己的内容，不吹捧、不说「说得太好了」「学到了」这类空话
- 不推销、不提自己的产品或账号、不带链接、不求关注或互关
- 回复要短，通常一两句
- 不要在开头加 @用户名，X 会自动处理
- 每条加权字数不超过 280${editsBlock(edits)}`;
}

export interface QuoteTask {
  /** 被引用的推文 */
  source: string;
  authorHandle: string;
  count: number;
}

export function buildQuotePrompt(task: QuoteTask, edits: EditPair[]): string {
  return `这位用户想在 X 上「引用推文」：转发 @${task.authorHandle} 的下面这条推文，并在上面加一段自己的话。原推文会以卡片形式显示在下方，读者能看到原文。

@${task.authorHandle} 的原推文：
${task.source}

请以这位用户本人的口吻写 ${task.count} 条引用时附上的话，角度彼此不同（例如一条表态赞同或反对并给理由、一条补充自己的经历或例子、一条提出追问或延伸）。
要求：
- 说用户自己的看法，不要复述、改写或总结原推文，原文读者已经能看到
- 不要以「转发」「引用」「这条说得好」之类开头，不加 @用户名，不贴原推文链接
- 通常一到三句，像真人随手写的
- 每条加权字数不超过 280${editsBlock(edits)}`;
}

export interface SourceTask {
  /** 采集到的原文 */
  source: string;
  /** 来源说明，例如「X 用户 @abc」「网站 example.com」 */
  origin: string;
  /** 用户给自动发帖写的额外要求 */
  instruction: string;
  /** 和原文的最大重合度（0–1），超过会被丢掉 */
  maxOverlap: number;
  /** 要不要给原文链接留位置（链接在 X 上按 23 计） */
  linkReserve: boolean;
  count: number;
  /** 最近的帖子里用得太多的词，这次不要再用 */
  avoid?: string[];
  /** 写一条还是写成串推、写多长（按原文信息量定） */
  shape?: PostShape;
}

function shapeBlock(shape: PostShape | undefined): string {
  if (!shape || shape.kind === "single")
    return `\n\n每个候选是一条推文（tweets 里只放一条）。长度跟原文的信息量走：${shape?.target ?? "大约 50–135 个汉字"}。`;
  if (shape.kind === "long")
    return `\n\n原文内容比较多，用户是 X 会员，一条推文可以写长。每个候选写成一条长推（tweets 里只放一条），${shape.target}：
- 开头一两句交代清楚是什么事、为什么值得看
- 然后按原文的顺序把要点讲清楚，原文的关键信息、数字、步骤都要保留，不要压缩成一句话；可以分段，段之间空一行
- 最后收个尾（总结或一句很短的态度）`;
  return `\n\n原文内容比较多，一条装不下，每个候选写成一串 ${shape.min}–${shape.max} 条的串推（tweets 里按顺序放每一条）：
- 第一条交代清楚是什么事、为什么值得看，单独看也能懂
- 后面按原文的顺序把要点讲清楚，原文的关键信息、数字、步骤都要保留，不要压缩成一句话
- 最后一条收个尾（总结或一句很短的态度）
- 每条都是完整的句子，不要把一句话拆到两条里；不要写「1/3」「🧵」这类编号`;
}

export function buildSourcePrompt(task: SourceTask, edits: EditPair[]): string {
  return `下面是从「${task.origin}」采集到的一段内容。请用这位用户本人的说话方式，把原文要表达的内容重新说一遍，写成 ${task.count} 个可以直接发在 X 上的候选，供用户挑一个。${shapeBlock(task.shape)}

核心是忠于原文：原文讲了什么事、什么观点，帖子就讲什么，只是换成用户自己的说法。
- 不要把原文当灵感去发挥别的观点，不要换主题，不要扩展成原文没说的结论
- 不要编造用户的个人经历、身份、数据或例子（例如「我之前做过……」「我们团队……」），原文里没有的一律不写
- 可以在最后加半句很短的态度（例如赞同、提醒），但不能喧宾夺主
- ${task.count} 个候选讲的是同一个意思，只是说法不同，不要写成 ${task.count} 个不同的论点
- 不要为了写短把原文的关键信息丢掉，也不要只挑原文的一句话来说（那是断章取义）

采集到的内容：
${task.source.slice(0, 6000)}

最重要的：读者没看过上面的原文，只看到你写的。所以都必须：
- 自己就能看懂：先交代清楚说的是哪件事（什么东西、谁、发生了什么），再说看法。不要用「这类事」「这个」「他们」这种没有前文就不知道指什么的说法
- 是一个完整的意思：有头有尾，最后一句要把话说完，不能停在半句、逗号或省略号上
- 读起来顺：像中文母语者随手写的，句子之间有逻辑；原文是英文时按意思用中文重新说，不要逐字翻译，专有名词可以保留英文
- 句子要完整连贯，不要写成断断续续的短语堆砌

其他要求：
- 用自己的话转述，不照抄原文句子，整体和原文的字面重合必须低于 ${Math.round(task.maxOverlap * 100)}%（换说法，但意思要准确）
- 不写「据报道」「刚看到一篇文章」「转自」这类开头，不提原作者名字和 @用户名
- 不编造原文里没有的事实${task.avoid?.length ? `\n- 下面这些词最近的帖子里用得太多了，读者已经看腻，这次一个都不要用（也不要换个近义词套同样的句式）：${task.avoid.join("、")}` : ""}
- 不要每次都用同样的开头或口头禅（例如「说白了」「说实话」「真正」「本质上」），候选之间也不要用同样的词起头
- ${task.shape?.kind === "long" ? "长推不受 280 字限制，但不要超过上面说的长度" : "每一条推文加权字数不超过 280（一个汉字算 2，一条最多约 135 个汉字）"}${task.linkReserve ? "，最后一条结尾会另外附上原文链接（按 23 计），要留出余量，不要自己写链接" : "，不要写任何链接"}

如果原文信息太少、看不出在说什么（例如只有一句口号、只有链接或图片说明、只是在回复别人、广告抽奖），或者涉及色情、成人、性暗示、赌博、血腥暴力，就把 skip 设为 true、写明原因，candidates 留空，不要硬写。${task.instruction.trim() ? `\n\n用户的额外要求：${task.instruction.trim()}` : ""}${editsBlock(edits)}`;
}

export interface ReviewTask {
  source: string;
  candidates: string[];
  /** 最近已经发过 / 排好的帖子，用来判断是不是同一个观点又说了一遍 */
  recent?: string[];
}

/** 让模型以普通读者的眼光检查候选：通不通顺、话说没说完、不看原文能不能看懂 */
export function buildReviewPrompt(task: ReviewTask): string {
  return `你是一个挑剔的中文读者。下面几条推文是根据一段原文写的，但发出去以后，读者看不到原文。请逐条打分（1–5 分，5 最好）：
- fluent 通顺：读起来自然，像中文母语者写的，没有病句、生硬翻译腔、断断续续的短语
- complete 完整：话说完了，有头有尾，没有停在半句
- standalone 独立可懂：不看原文也知道在说哪件事、想表达什么
- faithful 忠于原文：讲的就是原文的事和观点，没有跑题、没有借题发挥成别的观点、没有编造原文里没有的经历、数据或结论
- unsafe 不安全：内容涉及色情、成人、性暗示、赌博、血腥暴力时填 true
- repeat 重复：如果和下面「最近已经发过的帖子」里任何一条讲的是同一件事或同一个观点（哪怕措辞不同），填 true

原文（只给你参考，读者看不到）：
${task.source.slice(0, 3000)}

${task.recent?.length ? `最近已经发过的帖子：\n${task.recent.map((r) => `- ${r.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}\n\n` : ""}候选：
${task.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

严格打分：只要有一处让人读不懂、需要猜，就不能给 4 分以上。issue 用一句话说最大的问题，没有就留空。`;
}
