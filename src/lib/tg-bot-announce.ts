import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  AnnounceError,
  cancelAnnouncement,
  createManual,
  getAnnouncement,
  sendReviewCards,
  setWantsAnnouncements,
  startSending,
  updateBody,
  wantsAnnouncements,
} from "./announce";
import { isAdmin } from "./billing";
import { editMessage, sendMessage, type Keyboard } from "./tg-api";
import { clearAwait, getState, setState } from "./tg-bot-core";
import { BACK_ROW } from "./tg-bot-home";

/**
 * 机器人里的公告：
 * - 用户：「☰ 更多 → 🔔 更新通知」开关；每条公告下面的「🔕 不再接收」（an:off）
 * - 管理员：/notice（或 /gonggao）写一条公告 → 预览 → 发给所有用户；自动起草的更新公告也在这里审核（an:go / an:now / an:ed / an:x）
 */

async function isAdminUser(userId: string): Promise<boolean> {
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return !!u && (await isAdmin(u));
}

function prefsCard(on: boolean): { text: string; buttons: Keyboard } {
  return {
    text: on
      ? "🔔 更新通知：开\n有新功能、重要变化时，机器人会发一条消息告诉你（只在白天发，不会频繁打扰）。"
      : "🔕 更新通知：关\n新功能、重要变化不会再发消息给你。",
    buttons: [[on ? { text: "🔕 关掉", callback_data: "an:off" } : { text: "🔔 打开", callback_data: "an:on" }], BACK_ROW],
  };
}

const NEW_PROMPT =
  "📢 发公告\n把要发给所有用户的内容发给我（纯文字，最多 3500 字）。我先给你看预览，点了「发给所有用户」才会发。发 /cancel 取消。";

/** /notice /gonggao（管理员）、/notify（所有人） */
export async function handleAnnounceMenu(userId: string, chatId: string, cmd: string, rest: string): Promise<boolean> {
  if (cmd === "/notify") {
    await clearAwait(userId);
    const c = prefsCard(await wantsAnnouncements(userId));
    await sendMessage(chatId, c.text, { buttons: c.buttons });
    return true;
  }
  if (cmd !== "/notice" && cmd !== "/gonggao") return false;
  if (!(await isAdminUser(userId))) return false;
  if (!rest) {
    await setState(userId, { await: { kind: "announce_new" } });
    await sendMessage(chatId, NEW_PROMPT);
    return true;
  }
  await clearAwait(userId);
  await draftFromText(userId, chatId, rest);
  return true;
}

async function draftFromText(userId: string, chatId: string, text: string) {
  try {
    const ann = await createManual(userId, text);
    await sendReviewCards(ann, undefined, chatId);
  } catch (e) {
    await sendMessage(chatId, e instanceof AnnounceError ? e.message : "没存上，请再试一次");
  }
}

/** 等管理员发来公告内容 / 改好的文字 */
export async function handleAnnounceAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const { await: waiting } = await getState(userId);
  if (waiting?.kind === "announce_new") {
    await clearAwait(userId);
    await draftFromText(userId, chatId, text);
    return true;
  }
  if (waiting?.kind === "announce_edit") {
    await clearAwait(userId);
    try {
      const ann = await updateBody(waiting.annId, text);
      await sendReviewCards(ann);
    } catch (e) {
      await sendMessage(chatId, e instanceof AnnounceError ? e.message : "没改成，请再试一次");
    }
    return true;
  }
  return false;
}

/** an:xxx 按钮；不是这里的返回 null */
export async function handleAnnounceCallback(userId: string, chatId: string, action: string, a: string, b: string, mid: number): Promise<string | undefined | null> {
  if (action !== "an") return null;
  // 用户自己的开关
  if (a === "off" || a === "on" || a === "menu") {
    if (a !== "menu") await setWantsAnnouncements(userId, a === "on");
    const on = a === "menu" ? await wantsAnnouncements(userId) : a === "on";
    const c = prefsCard(on);
    if (mid) await editMessage(chatId, mid, c.text, c.buttons).catch(() => sendMessage(chatId, c.text, { buttons: c.buttons }));
    else await sendMessage(chatId, c.text, { buttons: c.buttons });
    return a === "menu" ? undefined : on ? "已打开更新通知" : "好的，以后不再发更新通知";
  }
  // 下面都是管理员的
  if (!(await isAdminUser(userId))) return "只有管理员能操作";
  try {
    switch (a) {
      case "go":
      case "now": {
        const ann = await startSending(b, a === "now" ? true : undefined);
        return ann.urgent ? "开始发了，发完告诉你" : "开始发了，按用户当地白天送达，发完告诉你";
      }
      case "ed": {
        const ann = await getAnnouncement(b);
        if (!ann || ann.status !== "draft") return "这条已经不能改了";
        await setState(userId, { await: { kind: "announce_edit", annId: b } });
        await sendMessage(chatId, `把改好的完整内容发给我（会整段替换）。现在的内容：\n\n${ann.body}\n\n发 /cancel 不改。`);
        return;
      }
      case "x":
        await cancelAnnouncement(b);
        return "好的，这条不发了";
    }
  } catch (e) {
    return e instanceof AnnounceError ? e.message : "操作失败，请再试一次";
  }
  return "这个按钮已经失效了";
}
