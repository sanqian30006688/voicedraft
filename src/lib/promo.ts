/**
 * 推广链接（TG 群、QQ 群等）：用户保存若干条，生成内容时选一条带上。
 * 这个文件前后端共用，不要引入只能在服务端用的模块。
 */

export const PROMO_KINDS = ["tg", "qq", "discord", "wechat", "other"] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

export const PROMO_KIND_LABEL: Record<PromoKind, string> = {
  tg: "TG 群",
  qq: "QQ 群",
  discord: "Discord",
  wechat: "微信群",
  other: "其他",
};

/**
 * 默认怎么带推广：
 * - always：每篇都默认带上「默认链接」（可在生成前改）
 * - ask：每篇生成前自己选一个，默认不带
 * - off：不带，生成页不显示推广选项
 */
export const PROMO_MODES = ["always", "ask", "off"] as const;
export type PromoMode = (typeof PROMO_MODES)[number];

export const PROMO_MODE_LABEL: Record<PromoMode, string> = {
  always: "每篇都带（默认用下面标了「默认」的那条）",
  ask: "每篇自己选一个",
  off: "不带",
};

export interface PromoLink {
  id: string;
  kind: PromoKind;
  name: string;
  /** 链接，或者群号这类要原样出现的文字 */
  url: string;
  /** 可选的引导语，例如「想一起聊的进群」 */
  blurb: string;
}

export interface PromoSettings {
  mode: PromoMode;
  defaultId: string | null;
}

/** 链接本身是否已经出现在文本里 */
export function hasPromo(text: string, link: Pick<PromoLink, "url">): boolean {
  return text.includes(link.url.trim());
}

/** 模型没写进去时用的兜底推广句 */
export function fallbackPromoLine(link: PromoLink): string {
  const lead = link.blurb.trim() || `${PROMO_KIND_LABEL[link.kind]}「${link.name}」：`;
  // 链接前留空格，避免和中文粘在一起导致 X 识别不出链接
  const url = link.url.trim();
  return /^https?:\/\//i.test(url) || !/[：:]$/.test(lead) ? `${lead} ${url}` : `${lead}${url}`;
}

/** 确保文本里带着推广链接，没有就在末尾另起一行补上 */
export function ensurePromo(text: string, link: PromoLink): string {
  if (hasPromo(text, link)) return text;
  return `${text.trimEnd()}\n${fallbackPromoLine(link)}`;
}

/**
 * 给模型的推广要求。where 说明推广放在哪里，例如「这条推文的结尾」「串推的最后一条」。
 * 放在用户消息里（不进系统提示），不影响风格卡部分的提示词缓存。
 */
export function promoPromptBlock(link: PromoLink, where: string, opts: { tweetLimit?: boolean } = {}): string {
  const isUrl = /^https?:\/\//i.test(link.url.trim());
  const limit =
    opts.tweetLimit === false
      ? ""
      : `\n- 推广句也计入 280 加权字数${isUrl ? "（链接在 X 上固定按 23 计）" : ""}，正文要相应写短，整体不能超`;
  return `

# 推广（${where}要带上）
用户想顺带推广下面这个${PROMO_KIND_LABEL[link.kind]}：
- 名称：${link.name}
- ${isUrl ? "链接" : "群号 / 联系方式"}：${link.url.trim()}${link.blurb.trim() ? `\n- 用户写的引导语（可以照用，也可以按上文改得更顺）：${link.blurb.trim()}` : ""}

要求：
- 在${where}用这位用户自己的口吻写一句引导，和上文自然衔接，像本人顺口一提，不要写成广告腔，不用「重磅」「福利」「速来」这类词
- ${isUrl ? "链接" : "群号"}必须原样出现一次，一个字符都不能改，不加括号、引号或 markdown${isUrl ? "；链接前后用空格或换行隔开，不要和中文直接相连" : ""}${limit}`;
}
