import "server-only";

/** Telegram Bot API 的底层调用（发消息、按钮等），被绑定逻辑和机器人功能共用 */

// TELEGRAM_API_URL 只在测试时用来指向模拟服务
const API = process.env.TELEGRAM_API_URL || "https://api.telegram.org";

export function botToken(): string | null {
  const t = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return t ? t : null;
}

export function isValidBotToken(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/.test(token);
}

export class TelegramError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function callBot<T>(method: string, params: Record<string, unknown> = {}, token = botToken(), timeoutMs = 15_000): Promise<T> {
  if (!token) throw new TelegramError("还没有配置 TG 机器人", 0);
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TelegramError("连不上 Telegram，请检查网络", 0);
  }
  const data = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
  if (!data?.ok) throw new TelegramError(data?.description || `Telegram 返回错误 ${res.status}`, res.status);
  return data.result as T;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  /** 点一下把这段文字复制到剪贴板（Telegram 新版客户端支持） */
  copy_text?: { text: string };
}

export type Keyboard = InlineButton[][];

/** 发消息；buttons 是消息下方的按钮，keyboard 是输入框下方的常驻菜单 */
export function sendMessage(
  chatId: string,
  text: string,
  opts: { replyTo?: number; buttons?: Keyboard; keyboard?: string[][]; removeKeyboard?: boolean; html?: boolean } | number = {},
) {
  const o = typeof opts === "number" ? { replyTo: opts } : opts;
  return callBot<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: text.length > 4000 ? `${text.slice(0, 3990)}…` : text,
    link_preview_options: { is_disabled: true },
    ...(o.html ? { parse_mode: "HTML" } : {}),
    ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    ...(o.buttons
      ? { reply_markup: { inline_keyboard: o.buttons } }
      : o.keyboard
        ? { reply_markup: { keyboard: o.keyboard.map((row) => row.map((t) => ({ text: t }))), resize_keyboard: true, is_persistent: true } }
        : o.removeKeyboard
          ? { reply_markup: { remove_keyboard: true } }
          : {}),
  });
}

/** 改已发出的消息（文字和按钮）；buttons 为空数组时去掉按钮 */
export function editMessage(chatId: string, messageId: number, text: string, buttons: Keyboard = []) {
  return callBot("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.length > 4000 ? `${text.slice(0, 3990)}…` : text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
  }).catch(() => {});
}

/** 只去掉 / 替换消息下方的按钮 */
export function editButtons(chatId: string, messageId: number, buttons: Keyboard = []) {
  return callBot("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: buttons },
  }).catch(() => {});
}

/** 发一张图片（PNG），caption 是图片下面的说明（最多 1024 字） */
export function sendPhoto(
  chatId: string,
  png: Uint8Array,
  caption: string,
  opts: { buttons?: Keyboard; html?: boolean } = {},
): Promise<{ message_id: number }> {
  return sendFile("sendPhoto", "photo", chatId, png, "image/png", "qr.png", caption, opts);
}

/** 以「文件」形式发图（不会被 Telegram 压缩），用于下载原图 */
export function sendDocument(
  chatId: string,
  data: Uint8Array,
  mime: string,
  filename: string,
  caption: string,
  opts: { buttons?: Keyboard; html?: boolean } = {},
): Promise<{ message_id: number }> {
  return sendFile("sendDocument", "document", chatId, data, mime, filename, caption, opts);
}

async function sendFile(
  method: "sendPhoto" | "sendDocument",
  field: "photo" | "document",
  chatId: string,
  data: Uint8Array,
  mime: string,
  filename: string,
  caption: string,
  opts: { buttons?: Keyboard; html?: boolean },
): Promise<{ message_id: number }> {
  const token = botToken();
  if (!token) throw new TelegramError("还没有配置 TG 机器人", 0);
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", caption.length > 1024 ? `${caption.slice(0, 1020)}…` : caption);
  if (opts.html) form.set("parse_mode", "HTML");
  if (opts.buttons) form.set("reply_markup", JSON.stringify({ inline_keyboard: opts.buttons }));
  form.set(field, new Blob([new Uint8Array(data)], { type: mime }), filename);
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new TelegramError("连不上 Telegram，请检查网络", 0);
  }
  const body = (await res.json().catch(() => null)) as { ok: boolean; result?: { message_id: number }; description?: string } | null;
  if (!body?.ok || !body.result) throw new TelegramError(body?.description || `Telegram 返回错误 ${res.status}`, res.status);
  return body.result;
}

/** 下载用户发给机器人的文件（图片等） */
export async function downloadFile(fileId: string, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array> {
  const file = await callBot<{ file_path: string; file_size?: number }>("getFile", { file_id: fileId });
  if ((file.file_size ?? 0) > maxBytes) throw new TelegramError("文件太大了", 413);
  const res = await fetch(`${API}/file/bot${botToken()}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new TelegramError(`下载失败（${res.status}）`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** 更新一张卡片（HTML）：图片消息改说明，文字消息改正文；内容没变时什么也不做 */
export async function editCard(chatId: string, messageId: number, html: string, buttons: Keyboard = []): Promise<void> {
  const reply_markup = { inline_keyboard: buttons };
  try {
    await callBot("editMessageCaption", { chat_id: chatId, message_id: messageId, caption: html.slice(0, 1024), parse_mode: "HTML", reply_markup });
  } catch (e) {
    if (e instanceof TelegramError && /not modified/i.test(e.message)) return;
    await callBot("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup,
    }).catch(() => {});
  }
}
