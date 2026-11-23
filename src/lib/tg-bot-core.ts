import "server-only";
import { RenderError } from "./image-render";
import { ImageError } from "./images";
import { FollowCheckError } from "./follow-check";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { BotState } from "@/db/schema";
import { InsufficientBalanceError, UsageLimitError } from "./billing";
import { loadStyleCardForDrafting } from "./data";
import { GenerationError } from "./llm";
import { getPromoLink, getPromoSettings } from "./promo-data";
import { PublishError } from "./publish";
import { StyleError } from "./style-actions";
import { sendMessage, type Keyboard } from "./tg-api";
import { TeamError, TeamPublishError } from "./team";
import { XApiError } from "./x";

/** 机器人各功能共用的状态读写和小工具 */

// ---------- 状态 ----------

export async function getState(userId: string): Promise<BotState> {
  const db = await getDb();
  const [row] = await db
    .select({ s: schema.tgBindings.botState })
    .from(schema.tgBindings)
    .where(eq(schema.tgBindings.userId, userId))
    .limit(1);
  return row?.s ?? {};
}

export async function setState(userId: string, patch: Partial<BotState>) {
  const db = await getDb();
  const next = { ...(await getState(userId)), ...patch };
  for (const k of Object.keys(next) as (keyof BotState)[]) if (next[k] === undefined) delete next[k];
  await db.update(schema.tgBindings).set({ botState: next }).where(eq(schema.tgBindings.userId, userId));
}

export const clearAwait = (userId: string) => setState(userId, { await: undefined });

// ---------- 小工具 ----------

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function fmtTime(d: Date) {
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function tweetUrl(handle: string | null, id: string) {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`;
}

/** 把出错原因翻成给用户看的一句话 */
export function errText(e: unknown): string {
  if (
    e instanceof PublishError ||
    e instanceof GenerationError ||
    e instanceof XApiError ||
    e instanceof StyleError ||
    e instanceof InsufficientBalanceError ||
    e instanceof UsageLimitError ||
    e instanceof TeamError ||
    e instanceof ImageError ||
    e instanceof FollowCheckError ||
    e instanceof RenderError
  ) {
    return e.message;
  }
  console.error("[tg-bot]", e);
  return "出了点问题，请稍后再试。";
}

/** 出错时消息下方的按钮（开源版没有充值入口，恒为空） */
export function errButtons(e: unknown): Keyboard {
  void e;
  return [];
}

/** 把出错原因发给用户 */
export async function sendErr(chatId: string, e: unknown) {
  await sendMessage(chatId, errText(e));
}

export async function ensureCard(userId: string, chatId: string, topic?: string) {
  const card = await loadStyleCardForDrafting(userId, topic);
  if (!card) {
    await sendMessage(chatId, "✍️ 写之前我得先学会你的文风。\n把你写过的推文发给我（10 条以上更好），我总结出你的写法，再写出来才像你。", {
      buttons: [[{ text: "📥 导入推文", callback_data: "sm" }, { text: "🎨 生成文风", callback_data: "cg" }]],
    });
  }
  return card;
}

/** 起草时要带的推广链接：「每篇都带」时用默认链接；force 表示用户在「每篇自己选」时点了「带推广重写」 */
export async function defaultPromo(userId: string, force = false) {
  const settings = await getPromoSettings(userId);
  return settings.mode === "always" || (force && settings.mode === "ask") ? getPromoLink(userId, settings.defaultId) : null;
}

/** 「每篇自己选」且有默认链接时，候选下方给一个「带推广重写」按钮 */
export async function canAskPromo(userId: string) {
  const settings = await getPromoSettings(userId);
  return settings.mode === "ask" && !!settings.defaultId && !!(await getPromoLink(userId, settings.defaultId));
}

