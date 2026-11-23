import "server-only";
import { checkTimeline, FOLLOW_CAPS, FOLLOW_INTERVALS, saveFollowSettings } from "./follow-replies";
import { editMessage, sendMessage, type Keyboard } from "./tg-api";
import { clearAwait, getState, sendErr, setState } from "./tg-bot-core";
import { sendConnectX } from "./tg-bot-more";
import { getAccount, type XAccount } from "./x";

/**
 * 机器人里的「关注的人」：开关、检查间隔、每天上限、只挑哪些账号 / 关键词、现在检查。
 * 挑出来的帖子和 @我 一样，以回复卡片推送，点「发送」才发出。
 */

const fmtMin = (m: number) => (m < 60 ? `${m} 分钟` : `${m / 60} 小时`);
const list = (xs: string[], empty: string) => (xs.length ? xs.join("、") : empty);

function followText(acc: XAccount): string {
  return [
    "👀 给关注的人写回复",
    "",
    "我会读你「正在关注」里的新帖子，挑出值得回的，用你的口吻写好回复候选推给你。对方没有 @你，所以不会自动发出，每条都要你点「发送」。不私信、不关注、不点赞、不转推。",
    "",
    `自动检查：${acc.timelineEnabled ? `开，每 ${fmtMin(acc.timelineIntervalMin)}一次` : "关"}`,
    `每天最多：${acc.timelineDailyCap} 条`,
    `只挑这些账号：${list(acc.timelineHandles.map((h) => `@${h}`), "不限（关注的所有人）")}`,
    `只挑含这些关键词的：${list(acc.timelineKeywords, "不限")}`,
    ...(acc.timelinePausedReason ? ["", `⚠️ ${acc.timelinePausedReason}`] : []),
  ].join("\n");
}

function followButtons(acc: XAccount): Keyboard {
  return [
    [
      { text: acc.timelineEnabled ? "⏸ 关闭自动检查" : "▶️ 打开自动检查", callback_data: `ft:${acc.timelineEnabled ? 0 : 1}` },
      { text: "🔄 现在检查", callback_data: "ftc" },
    ],
    FOLLOW_INTERVALS.map((m) => ({ text: `${m === acc.timelineIntervalMin ? "✓ " : ""}每${fmtMin(m)}`, callback_data: `fi:${m}` })),
    FOLLOW_CAPS.map((n) => ({ text: `${n === acc.timelineDailyCap ? "✓ " : ""}每天${n}条`, callback_data: `fc:${n}` })),
    [
      { text: "👤 设置账号", callback_data: "fh" },
      { text: "🔑 设置关键词", callback_data: "fk" },
    ],
  ];
}

export async function showFollow(userId: string, chatId: string, editMid?: number) {
  const acc = await getAccount(userId);
  if (!acc) {
    await sendConnectX(userId, chatId, "还没有连接 X 账号。");
    return;
  }
  if (editMid) await editMessage(chatId, editMid, followText(acc), followButtons(acc));
  else await sendMessage(chatId, followText(acc), { buttons: followButtons(acc) });
}

/** 关注的人相关的按钮；返回 null 表示不是这里的按钮 */
export async function handleFollowCallback(
  userId: string,
  chatId: string,
  action: string,
  a: string,
  mid: number,
): Promise<string | undefined | null> {
  switch (action) {
    case "fs":
      await showFollow(userId, chatId);
      return;
    case "ft":
      await saveFollowSettings(userId, { timelineEnabled: a === "1" });
      await showFollow(userId, chatId, mid);
      return a === "1" ? "已打开" : "已关闭";
    case "fi": {
      const m = Number(a);
      if (!(FOLLOW_INTERVALS as readonly number[]).includes(m)) return "这个按钮已经失效了";
      await saveFollowSettings(userId, { timelineIntervalMin: m });
      await showFollow(userId, chatId, mid);
      return;
    }
    case "fc": {
      const n = Number(a);
      if (!(FOLLOW_CAPS as readonly number[]).includes(n)) return "这个按钮已经失效了";
      await saveFollowSettings(userId, { timelineDailyCap: n });
      await showFollow(userId, chatId, mid);
      return;
    }
    case "fh":
      await setState(userId, { await: { kind: "follow_handles" } });
      await sendMessage(chatId, "发给我要盯的账号，用逗号或空格隔开，不用写 @（例如：paulg, naval）。发「清空」表示关注的所有人都可以。发 /cancel 取消。");
      return;
    case "fk":
      await setState(userId, { await: { kind: "follow_keywords" } });
      await sendMessage(chatId, "发给我关键词，用逗号隔开（例如：AI，写作，独立开发）。发「清空」表示不限。发 /cancel 取消。");
      return;
    case "ftc":
      await runCheck(userId, chatId);
      return;
  }
  return null;
}

/** 手动检查：读一次，挑出来的帖子马上以回复卡片推过来 */
async function runCheck(userId: string, chatId: string) {
  try {
    const r = await checkTimeline(userId, { manual: true });
    if (r.added) {
      // 动态引入，避免和 tg-bot 互相引用
      const { notifyNewReplies } = await import("./tg-bot");
      await sendMessage(chatId, `读了 ${r.read} 条，挑出 ${r.added} 条，回复候选如下（点「发送」才会发出）：`);
      await notifyNewReplies(userId);
    } else {
      await sendMessage(chatId, r.message ?? `读了 ${r.read} 条，没有挑到合适的。可以放宽账号或关键词。`);
    }
  } catch (e) {
    await sendErr(chatId, e);
  }
}

function splitInput(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 100);
}

/** 等用户发来账号 / 关键词；不是这里在等的返回 false */
export async function handleFollowAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const { await: waiting } = await getState(userId);
  if (waiting?.kind !== "follow_handles" && waiting?.kind !== "follow_keywords") return false;
  await clearAwait(userId);
  const clear = /^(清空|无|不限)$/.test(text.trim());
  const items = clear ? [] : splitInput(text).map((x) => x.slice(0, 50));
  if (waiting.kind === "follow_handles") {
    await saveFollowSettings(userId, { timelineHandles: items.map((h) => h.replace(/^@/, "")).filter((h) => /^\w{1,15}$/.test(h)) });
  } else {
    await saveFollowSettings(userId, { timelineKeywords: items });
  }
  await sendMessage(chatId, "已保存 ✓");
  await showFollow(userId, chatId);
  return true;
}
