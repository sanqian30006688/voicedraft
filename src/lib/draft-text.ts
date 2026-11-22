import type { DraftMeta } from "@/db/schema";
import { joinSentences } from "./text";

/** 草稿模式：起草页（quick / sentence）和长文页（single / thread / article） */
export const LONG_MODES = ["single", "thread", "article"] as const;
export type LongMode = (typeof LONG_MODES)[number];
export const isLongMode = (mode: string): mode is LongMode => (LONG_MODES as readonly string[]).includes(mode);

export const isHeading = (s: string) => s.startsWith("## ");
export const isImage = (s: string) => s.startsWith("[配图]");
export const stripHeading = (s: string) => s.replace(/^##\s+/, "");
export const stripImage = (s: string) => s.replace(/^\[配图\]\s*/, "");

/** 串推的每一条，可选在末尾加 1/n 编号 */
export function threadTweets(parts: string[], numbered: boolean): string[] {
  return parts.map((t, i) => (numbered ? `${t}\n\n${i + 1}/${parts.length}` : t));
}

/** X 长文复制用的纯文本：标题、正文，小标题去掉 ##，配图位置换成提示行 */
export function articleText(title: string, parts: string[]): string {
  return [title.trim(), ...parts.map((p) => (isImage(p) ? `【此处插图：${stripImage(p)}】` : stripHeading(p)))]
    .filter(Boolean)
    .join("\n\n");
}

/** 草稿的成品文本：草稿箱列表展示和「复制」用 */
export function draftFinalText(mode: string, texts: string[], meta?: DraftMeta | null): string {
  switch (mode) {
    case "single":
      return texts.join("\n\n");
    case "thread":
      return threadTweets(texts, meta?.numbered ?? true).join("\n\n---\n\n");
    case "article":
      return articleText(meta?.title ?? "", texts);
    default:
      return joinSentences(texts);
  }
}
