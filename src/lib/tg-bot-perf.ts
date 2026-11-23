import "server-only";
import { CAP_CHOICES, MIN_SOURCE_CHOICES, getHotSettings, saveHotSettings } from "./hot-topics";
import { tzLabel } from "./daily-report";
import { insightLines } from "./post-metrics-core";
import { myInsights } from "./post-metrics";
import { editMessage, sendMessage, type Keyboard } from "./tg-api";

/**
 * 机器人里的「📈 发帖效果」（在「📊 数据和排行」里，/perf）和「🔥 热点提醒」设置（在「🤖 自动发」里，/hot）。
 */

async function show(chatId: string, mid: number | undefined, text: string, buttons: Keyboard) {
  if (mid) await editMessage(chatId, mid, text, buttons);
  else await sendMessage(chatId, text, { buttons });
}

export async function showPerf(userId: string, chatId: string, mid?: number) {
  const { insights, tz } = await myInsights(userId);
  await show(chatId, mid, insightLines(insights, tzLabel(tz)).join("\n"), [
    [
      { text: "✍️ 写一条", callback_data: "bm:write" },
      { text: "↩️ 数据和排行", callback_data: "bm" },
    ],
  ]);
}

export async function showHot(userId: string, chatId: string, mid?: number) {
  const s = await getHotSettings(userId);
  const text =
    `🔥 热点提醒：${s.enabled ? "开着 ✅" : "关着"}\n\n` +
    `你订阅的信息源里，${s.minSources} 个以上同时在说同一件事，我就推给你，点一下就能趁热写一条。\n` +
    `每天最多推 ${s.dailyCap} 条。只看你自己的信息源，不额外收费；写的时候按正常扣。`;
  await show(chatId, mid, text, [
    [{ text: s.enabled ? "🔕 关掉" : "🔔 打开", callback_data: `ht:on:${s.enabled ? 0 : 1}` }],
    MIN_SOURCE_CHOICES.map((n) => ({ text: n === s.minSources ? `· ${n} 个源 ·` : `${n} 个源`, callback_data: `ht:n:${n}` })),
    CAP_CHOICES.map((n) => ({ text: n === s.dailyCap ? `· 每天 ${n} 条 ·` : `每天 ${n} 条`, callback_data: `ht:c:${n}` })),
    [{ text: "↩️ 返回", callback_data: "au" }],
  ]);
}

/** pf / ht 按钮；不是这里的返回 null */
export async function handlePerfCallback(userId: string, chatId: string, action: string, a: string, b: string, mid: number): Promise<string | undefined | null> {
  if (action === "pf") {
    // pf:e 是从「📊 数据和排行」点进来的，在原消息上换；日报里点的发一条新的，不把日报盖掉
    await showPerf(userId, chatId, a === "e" ? mid : undefined);
    return;
  }
  if (action !== "ht") return null;
  if (a === "on") await saveHotSettings(userId, { enabled: b === "1" });
  else if (a === "n") await saveHotSettings(userId, { minSources: Number(b) });
  else if (a === "c") await saveHotSettings(userId, { dailyCap: Number(b) });
  // 从热点卡片上点「⚙️ 提醒设置」时发一条新的，不把热点盖掉；ht:m 是从「🤖 自动发」点进来的
  await showHot(userId, chatId, a ? mid : undefined);
  return a && a !== "m" ? "已保存" : undefined;
}
