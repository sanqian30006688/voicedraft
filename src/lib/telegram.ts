import "server-only";
import { isRetired } from "./platform-config";
import { isAdmin } from "./billing";
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fmtWait, hit } from "./rate-limit";
import { botToken, callBot, sendMessage, TelegramError } from "./tg-api";
import { handleTeamStart } from "./tg-bot-team";
import { BOT_COMMANDS, handleCallback, handleMenu, handleText, welcome, type CallbackQuery, type TgFrom } from "./tg-bot";
import { handleIncomingImage } from "./tg-bot-image";
import { handleDocument } from "./tg-bot-more";
import { addFeedItem } from "./tg-feed";
import { addGroupSource, groupOwners } from "./tg-bot-auto";
import { forgetAdminChat, isAdminChat, isGateChat, passGate, recheckGate, recordAdminChat } from "./tg-gate";
import { attachPendingTgReferral, rememberTgReferral } from "./rewards";
import { handleRefStart } from "./tg-bot-rewards";
import { bindTry, fileImportTry, floodCheck, isDoubleClick, shouldAnswerGroup } from "./tg-guard";

export { botToken, callBot, isValidBotToken, sendMessage, TelegramError } from "./tg-api";

/**
 * 平台统一的 TG 官方 Bot（Bot API）。
 * - 新用户直接在 TG 里点「开始」：自动开一个账号（不用去网页注册），编号照常分配
 * - 已在网页注册的用户点「绑定 TG」→ 得到 t.me/机器人?start=绑定码 链接 → 在 TG 里点「开始」即绑定
 * - 绑定后，用户转发给机器人的消息收进灵感池（只作选题素材，不进风格样本）
 * - 不用用户个人账号登录 TG
 * - 已绑定的用户把机器人拉进自己的群，这个群就成为他的信息源（群消息收进灵感池，可用于自动发帖）
 *
 * 本机运行时用长轮询（getUpdates）接收消息，不需要公网地址；
 * 部署到线上时可改用 webhook：/api/telegram/webhook。
 */

const BIND_CODE_TTL_MS = 10 * 60_000;

// ---------- 机器人信息 ----------

const g = globalThis as unknown as {
  __vdBot?: { token: string; username: string };
  __vdTgPoller?: { stop: boolean };
};

/** 机器人用户名（用来生成 t.me 链接），按 token 缓存 */
export async function botUsername(): Promise<string | null> {
  const token = botToken();
  if (!token) return null;
  if (g.__vdBot?.token === token) return g.__vdBot.username;
  const me = await callBot<{ username: string }>("getMe", {}, token);
  g.__vdBot = { token, username: me.username };
  return me.username;
}

// ---------- 绑定 ----------

export async function getBinding(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
  return row ?? null;
}

/** 生成一次性绑定码（10 分钟有效），返回打开机器人的链接 */
export async function createBindLink(userId: string): Promise<{ url: string; code: string; expiresAt: Date; username: string }> {
  const username = await botUsername();
  if (!username) throw new TelegramError("还没有配置 TG 机器人", 0);
  const code = randomBytes(12).toString("base64url");
  const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS);
  const db = await getDb();
  await db
    .insert(schema.tgBindings)
    .values({ userId, bindCode: code, bindCodeExpiresAt: expiresAt })
    .onConflictDoUpdate({ target: schema.tgBindings.userId, set: { bindCode: code, bindCodeExpiresAt: expiresAt } });
  return { url: `https://t.me/${username}?start=${code}`, code, expiresAt, username };
}

export async function unbind(userId: string) {
  const db = await getDb();
  const row = await getBinding(userId);
  await db.delete(schema.tgBindings).where(eq(schema.tgBindings.userId, userId));
  if (row?.chatId) {
    await sendMessage(row.chatId, "已在 VoiceDraft 里解除绑定。", { removeKeyboard: true }).catch(() => {});
  }
}

async function bindChat(code: string, chatId: string): Promise<"ok" | "expired"> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.tgBindings)
    .where(and(eq(schema.tgBindings.bindCode, code), gt(schema.tgBindings.bindCodeExpiresAt, new Date())))
    .limit(1);
  if (!row) return "expired";
  seenProfiles.delete(chatId);
  // 这个 TG 之前在机器人里自动开过账号：换成网页上注册的账号，告诉一声
  const [prev] = await db
    .select({ userId: schema.tgBindings.userId, email: schema.users.email })
    .from(schema.tgBindings)
    .innerJoin(schema.users, eq(schema.users.id, schema.tgBindings.userId))
    .where(eq(schema.tgBindings.chatId, chatId))
    .limit(1);
  if (prev && prev.userId !== row.userId && isTgOnlyEmail(prev.email)) {
    await sendMessage(chatId, "已换成你在网页上注册的账号。之前在机器人里自动开的那个账号不再使用。").catch(() => {});
  }
  // 一个 TG 账号只绑一个 VoiceDraft 账号：先解除它和别人的旧绑定
  await db.delete(schema.tgBindings).where(eq(schema.tgBindings.chatId, chatId));
  // 这个 VoiceDraft 账号之前绑的是另一个 TG：告诉旧的那边已经换绑，之后它收不到也操作不了
  if (row.chatId && row.chatId !== chatId) {
    await sendMessage(row.chatId, "这个 VoiceDraft 账号已经换绑到另一个 TG 账号，这里不再收到消息。", { removeKeyboard: true }).catch(() => {});
  }
  await db
    .insert(schema.tgBindings)
    .values({ userId: row.userId, chatId, boundAt: new Date() })
    .onConflictDoUpdate({
      target: schema.tgBindings.userId,
      set: { chatId, bindCode: null, bindCodeExpiresAt: null, boundAt: new Date(), botState: {} },
    });
  return "ok";
}

async function userForChat(chatId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ userId: schema.tgBindings.userId })
    .from(schema.tgBindings)
    .where(eq(schema.tgBindings.chatId, chatId))
    .limit(1);
  return row?.userId ?? null;
}

/** 机器人里自动开的账号用的占位邮箱（.invalid 是保留域名，不会真的发邮件） */
export const TG_EMAIL_DOMAIN = "tg.invalid";
export const isTgOnlyEmail = (email: string) => email.endsWith(`@${TG_EMAIL_DOMAIN}`);

/**
 * 没绑定的 TG 用户第一次来：自动开一个账号并绑上，不用先去网页注册。
 * 同一个 TG 号永远对应同一个自动账号（占位邮箱按 TG ID 生成），并发来几条消息也只开一个。
 * 新人赠送、必须进群、邀请关系照常走（赠送按 TG 号只给一次）。
 * 返回 null：全平台短时间内开号太多（防批量刷号），稍后再试。
 */
async function ensureTgAccount(chatId: string, from?: TgFrom): Promise<{ userId: string; created: boolean } | null> {
  const existing = await userForChat(chatId);
  if (existing) return { userId: existing, created: false };
  if (!hit("tg:signup:global", 120, 60_000).ok) return null;
  const db = await getDb();
  const email = `tg${chatId}@${TG_EMAIL_DOMAIN}`;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ").slice(0, 50) || from?.username || null;
  // 密码是不合法的占位值：这个账号没法用密码登录，网页版用机器人里的「/web」一次性登录链接
  await db.insert(schema.users).values({ email, name, passwordHash: "!tg-only" }).onConflictDoNothing({ target: schema.users.email });
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  try {
    await db
      .insert(schema.tgBindings)
      .values({ userId: u.id, chatId, boundAt: new Date() })
      .onConflictDoUpdate({ target: schema.tgBindings.userId, set: { chatId, bindCode: null, bindCodeExpiresAt: null, boundAt: new Date() } });
  } catch {
    // 同一时间另一条消息已经绑好了
    const again = await userForChat(chatId);
    if (again) return { userId: again, created: false };
    throw new Error("自动开账号失败");
  }
  seenProfiles.delete(chatId);
  return { userId: u.id, created: true };
}

const BUSY = "现在来的新朋友太多了，请 1 分钟后再点一次「开始」。";

/** 记下 TG 的 @用户名 / 显示名（后台按 @用户名 找人用）。同一个人资料没变就不写库 */
const seenProfiles = new Map<string, string>();
export async function noteTgProfile(chatId: string, from: TgFrom | undefined): Promise<void> {
  if (!from || from.is_bot || String(from.id) !== chatId) return;
  const username = from.username?.slice(0, 64) ?? null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 128) || null;
  const key = `${username ?? ""}|${name ?? ""}|${new Date().toISOString().slice(0, 13)}`;
  if (seenProfiles.get(chatId) === key) return;
  const db = await getDb();
  await db.update(schema.tgBindings).set({ tgUsername: username, tgName: name, lastSeenAt: new Date() }).where(eq(schema.tgBindings.chatId, chatId));
  if (seenProfiles.size > 50_000) seenProfiles.clear();
  seenProfiles.set(chatId, key);
}

// ---------- 处理消息 ----------

interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

type ForwardOrigin =
  | { type: "user" }
  | { type: "hidden_user" }
  | { type: "chat"; sender_chat: TgChat }
  | { type: "channel"; chat: TgChat; message_id: number };

interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgFrom;
  new_chat_members?: { id: number; is_bot?: boolean }[];
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  migrate_to_chat_id?: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  forward_origin?: ForwardOrigin;
  entities?: { type: string; url?: string; offset: number; length: number }[];
  caption_entities?: { type: string; url?: string; offset: number; length: number }[];
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: CallbackQuery;
  /** 频道里发的帖子：只用来发现「机器人是这个频道的管理员」 */
  channel_post?: { chat: TgChat };
  my_chat_member?: { chat: TgChat; from?: { id: number }; new_chat_member: { status: string; user?: { id: number } } };
}

/** 消息里的链接（文字链接优先），作为来源链接 */
function firstUrl(msg: TgMessage): string | null {
  const body = msg.text ?? msg.caption ?? "";
  for (const e of msg.entities ?? msg.caption_entities ?? []) {
    if (e.type === "text_link" && e.url) return e.url;
    if (e.type === "url") return body.slice(e.offset, e.offset + e.length);
  }
  return null;
}

async function onCallback(cq: CallbackQuery) {
  const chatId = cq.message ? String(cq.message.chat.id) : null;
  if (!chatId) return;
  // 先过防刷（只看内存，不查数据库）
  const v = floodCheck(chatId);
  if (v.action === "drop") return;
  if (v.action === "warn") {
    await callBot("answerCallbackQuery", { callback_query_id: cq.id, text: v.text, show_alert: true }).catch(() => {});
    return;
  }
  if (isDoubleClick(chatId, cq.data ?? "")) {
    await callBot("answerCallbackQuery", { callback_query_id: cq.id, text: "正在处理，别重复点～" }).catch(() => {});
    return;
  }
  // 没绑定的人点了按钮（比如旧消息上的）：自动开账号
  const acc = await ensureTgAccount(chatId, cq.from);
  const userId = acc?.userId ?? null;
  if (userId) await noteTgProfile(chatId, cq.from).catch(() => {});
  let note: string | undefined;
  try {
    if (acc?.created) {
      note = "账号已开好";
      if (await passGate(userId, chatId)) await welcome(chatId, "new", userId);
    } else if (cq.data === "gate:ok") {
      // 「我已加入」：重新查一遍，通过了就把提示换成菜单
      const r = await recheckGate(userId, chatId);
      note = r.note;
      if (r.ok) {
        if (cq.message) await callBot("deleteMessage", { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
        if (userId) await welcome(chatId, false, userId);
      }
    } else if (!userId) note = BUSY;
    // 公告下面的「不再接收」：还没过「必须加入频道」这一关的人也能点
    else if (!/^an:o(ff|n)$/.test(cq.data ?? "") && !(await passGate(userId, chatId))) note = "请先加入频道/群";
    else note = await handleCallback(userId, chatId, cq, (text) => addFeedItem(userId, { kind: "manual", text }));
  } finally {
    // 不管成功与否都要应答，否则按钮会一直转圈
    await callBot("answerCallbackQuery", { callback_query_id: cq.id, ...(note ? { text: note } : {}) }).catch(() => {});
  }
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.my_chat_member) return onMyChatMember(update.my_chat_member);
  if (update.channel_post) {
    // 能收到频道帖子说明机器人是这个频道的管理员（上线前就设好、没收到通知时补记）
    const c = update.channel_post.chat;
    if (!(await isAdminChat(String(c.id)))) await recordAdminChat({ id: String(c.id), title: c.title, type: c.type, username: c.username });
    return;
  }
  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);

  // 群：拉我进群的人已绑定时，这个群成为他的信息源；否则说明一下并退出
  if (msg.chat.type !== "private") {
    await onGroupMessage(msg);
    return;
  }

  // 防刷：查数据库之前先看这个聊天是不是在狂发
  const v = floodCheck(chatId);
  if (v.action === "drop") return;
  if (v.action === "warn") {
    await sendMessage(chatId, v.text).catch(() => {});
    return;
  }

  const text = (msg.text ?? msg.caption ?? "").trim();
  const command = !msg.forward_origin && text.startsWith("/") ? text.split(/\s+/) : null;

  if (command) {
    const name = command[0].replace(/@\w+$/, "").toLowerCase();
    if (name === "/start" || name === "/bind") {
      const code = command[1];
      if (!code) {
        const acc = await ensureTgAccount(chatId, msg.from);
        if (!acc) {
          await sendMessage(chatId, BUSY);
          return;
        }
        await noteTgProfile(chatId, msg.from).catch(() => {});
        if (acc.created) {
          if (await passGate(acc.userId, chatId)) await welcome(chatId, "new", acc.userId);
        } else if (await passGate(acc.userId, chatId)) await welcome(chatId, false, acc.userId);
        return;
      }
      // 防止有人反复试绑定码 / 邀请码
      const t = bindTry(chatId);
      if (!t.ok) {
        await sendMessage(chatId, `绑定试得太多次了，请 ${fmtWait(t.retryAfterMs)}后再试。`);
        return;
      }
      // 团队邀请链接：t.me/机器人?start=team_邀请码
      if (code.startsWith("team_")) {
        const acc = await ensureTgAccount(chatId, msg.from);
        if (!acc) {
          await sendMessage(chatId, BUSY);
          return;
        }
        if (acc.created) {
          await noteTgProfile(chatId, msg.from).catch(() => {});
          if (!(await passGate(acc.userId, chatId))) return;
          await welcome(chatId, "new", acc.userId);
        }
        await handleTeamStart(acc.userId, chatId, code.slice(5));
        return;
      }
      // 邀请链接：t.me/机器人?start=ref_邀请码
      if (code.startsWith("ref_")) {
        const acc = await ensureTgAccount(chatId, msg.from);
        if (!acc) {
          await sendMessage(chatId, BUSY);
          return;
        }
        await noteTgProfile(chatId, msg.from).catch(() => {});
        // 新开的账号直接挂上邀请关系；老用户点了朋友的链接，会被告知已经不算新用户。
        // 也记在这个 TG 上：之后改绑网页上注册的账号，邀请关系跟过去
        if (acc.created) await rememberTgReferral(chatId, code.slice(4)).catch(() => false);
        await handleRefStart(acc.userId, chatId, code.slice(4));
        if (await passGate(acc.userId, chatId)) await welcome(chatId, acc.created ? "new" : false, acc.userId);
        return;
      }
      const r = await bindChat(code, chatId);
      if (r === "ok") {
        // 绑定成功；开了「必须加入频道」的话，没加入的先看到加入提示，加入后才出菜单
        const uid = await userForChat(chatId);
        await noteTgProfile(chatId, msg.from).catch(() => {});
        // 绑定前点过朋友的邀请链接：现在挂上邀请关系
        if (uid) {
          const ref = await attachPendingTgReferral(uid, chatId).catch(() => null);
          if (ref === "ok") await sendMessage(chatId, "已记下是朋友邀请你来的 ✓ 你第一次充值到账后，你和朋友都会拿到奖励。").catch(() => {});
        }
        if (await passGate(uid, chatId)) await welcome(chatId, true, uid);
      }
      else await sendMessage(chatId, "这个绑定链接已过期或已用过。已在网页注册的，请回到 VoiceDraft 的「灵感 → TG」页重新点「绑定 TG」；没注册过的，直接发 /start 就能开始用。");
      return;
    }
    if (name === "/unbind") {
      const db = await getDb();
      const rows = await db.delete(schema.tgBindings).where(eq(schema.tgBindings.chatId, chatId)).returning();
      await sendMessage(chatId, rows.length ? "已解除绑定。" : "你还没有绑定。", { removeKeyboard: true });
      return;
    }
  }

  // 没绑定的人发来任何消息：自动开账号，先给欢迎和上手步骤
  const acc = await ensureTgAccount(chatId, msg.from);
  if (!acc) {
    await sendMessage(chatId, BUSY);
    return;
  }
  const userId = acc.userId;
  if (acc.created) {
    await noteTgProfile(chatId, msg.from).catch(() => {});
    if (await passGate(userId, chatId)) await welcome(chatId, "new", userId);
    return;
  }
  await noteTgProfile(chatId, msg.from).catch(() => {});
  // 必须先加入后台设置的频道 / 群
  if (!(await passGate(userId, chatId))) return;
  if (command) {
    if (!(await handleMenu(userId, chatId, text))) await welcome(chatId, false, userId);
    return;
  }
  // 自己发来的图片（照片或图片文件）：用来配图
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
  const imageDoc = msg.document?.mime_type?.startsWith("image/") ? msg.document : null;
  if ((photo || imageDoc) && !msg.forward_origin) {
    await handleIncomingImage(
      userId,
      chatId,
      photo
        ? { fileId: photo.file_id, mime: "image/jpeg", size: photo.file_size, caption: msg.caption }
        : { fileId: imageDoc!.file_id, mime: imageDoc!.mime_type!, size: imageDoc!.file_size, caption: msg.caption },
    );
    return;
  }
  // 自己发来的文件：当作素材导入（tweets.js / txt / csv）
  if (msg.document && !msg.forward_origin) {
    const t = fileImportTry(chatId);
    if (!t.ok) {
      await sendMessage(chatId, `文件发得太频繁了，请 ${fmtWait(t.retryAfterMs)}后再发。`);
      return;
    }
    await handleDocument(userId, chatId, msg.document);
    return;
  }
  if (!text) {
    await sendMessage(chatId, "这条没有文字，暂时只能收文字内容和图片。", msg.message_id);
    return;
  }

  // 自己打的字：菜单按钮、正在等的输入（主题、改写、时间…），或者问要起草还是收进灵感
  if (!msg.forward_origin) {
    await handleText(userId, chatId, text);
    return;
  }

  const origin = msg.forward_origin;
  let author: string | null = null;
  let url = firstUrl(msg);
  if (origin?.type === "channel") {
    author = origin.chat.title ?? origin.chat.username ?? null;
    if (origin.chat.username) url = `https://t.me/${origin.chat.username}/${origin.message_id}`;
  } else if (origin?.type === "chat") {
    author = origin.sender_chat.title ?? null;
  }
  // 转发自个人时不记录对方名字（隐私）

  const saved = await addFeedItem(userId, {
    kind: "tg_forward",
    text,
    url,
    author,
    publishedAt: new Date(msg.date * 1000),
  });
  if (!saved) {
    await sendMessage(chatId, "这条之前收过了。", msg.message_id);
    return;
  }
  const item = saved;
  await sendMessage(chatId, "已收进灵感 ✓", {
    replyTo: msg.message_id,
    buttons: item
      ? [
          [
            { text: "🔍 提炼要点", callback_data: `ip:${item}` },
            { text: "✍️ 用它起草", callback_data: `iw:${item}` },
          ],
        ]
      : undefined,
  });
}


// ---------- 机器人自己在群 / 频道里的身份变了 ----------

/**
 * 机器人被设为某个群 / 频道的管理员：记下来，后台「必须加入才能用」里可以直接点选，不用自己找群 ID。
 * 被移出或取消管理员：从候选里去掉。
 */
async function onMyChatMember(u: NonNullable<TgUpdate["my_chat_member"]>) {
  if (u.chat.type === "private") return;
  const id = String(u.chat.id);
  const st = u.new_chat_member.status;
  if (st === "administrator" || st === "creator") {
    await recordAdminChat({ id, title: u.chat.title, type: u.chat.type, username: u.chat.username });
    // 设管理员的是平台方（绑定的是管理员账号）：私聊告诉他下一步
    const who = u.from ? await userForChat(String(u.from.id)) : null;
    if (u.from && who && (await isPlatformAdmin(who))) {
      await sendMessage(
        String(u.from.id),
        `已成为「${u.chat.title ?? id}」的管理员 ✓\n如果要让用户必须加入这里才能用机器人：到网页「后台」→「必须关注频道 / 进群才能用机器人」，点选这个${u.chat.type === "channel" ? "频道" : "群"}并保存。`,
      ).catch(() => {});
    }
  } else if (st === "left" || st === "kicked" || st === "member" || st === "restricted") {
    await forgetAdminChat(id);
  }
}

// ---------- TG 群（信息源） ----------

const botId = () => Number((botToken() ?? "").split(":")[0]) || 0;

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return !!u && (await isAdmin(u));
}

/** 机器人在这个群里是不是管理员；是的话顺便记下来 */
async function botIsAdminHere(chatId: string): Promise<boolean> {
  if (await isAdminChat(chatId)) return true;
  try {
    const me = await callBot<{ status: string }>("getChatMember", { chat_id: chatId, user_id: botId() });
    if (me.status !== "administrator") return false;
    const info = await callBot<{ title?: string; type: string; username?: string }>("getChat", { chat_id: chatId }).catch(() => null);
    await recordAdminChat({ id: chatId, title: info?.title, type: info?.type ?? "supergroup", username: info?.username });
    return true;
  } catch {
    return false;
  }
}

async function onGroupMessage(msg: TgMessage) {
  const chatId = String(msg.chat.id);
  // 「必须进群才能用」的那个群：机器人在里面只为查成员，不收消息、不退群
  if (await isGateChat(chatId, msg.chat.username)) return;
  const joined = msg.group_chat_created || msg.supergroup_chat_created || msg.new_chat_members?.some((m) => m.id === botId());
  if (joined) {
    const owner = msg.from ? await userForChat(String(msg.from.id)) : null;
    if (!owner) {
      // 平台方把机器人直接设成了管理员（多半是「必须进群才能用」的群）：留下，不当信息源
      if (await botIsAdminHere(chatId)) return;
      if (shouldAnswerGroup(chatId)) {
        await sendMessage(chatId, "只有在用 VoiceDraft 的人才能把我拉进群当信息源。请先私聊我点「开始」，再把我拉进来。").catch(() => {});
      }
      await callBot("leaveChat", { chat_id: chatId }).catch(() => {});
      return;
    }
    const title = msg.chat.title ?? `群 ${chatId}`;
    await addGroupSource(owner, chatId, title);
    await sendMessage(
      chatId,
      "已把本群加为信息源 ✓\n群里的新消息会收进拉我进群那位的灵感池，可以用来按他的文风写推文。\n要读到所有消息，请把我设为群管理员（只需要「读消息」，不用其他权限）。",
    ).catch(() => {});
    const ownerChat = msg.from ? String(msg.from.id) : null;
    if (ownerChat) {
      await sendMessage(ownerChat, `已把群「${title}」加为信息源 ✓\n记得在群里把我设为管理员，否则我只能看到 @我 的消息。在「🤖 自动发帖 → 📋 信息源」里可以管理。`).catch(() => {});
    }
    return;
  }
  // 群升级成超级群时 id 会变，跟着改
  if (msg.migrate_to_chat_id) {
    const db = await getDb();
    await db
      .update(schema.sources)
      .set({ handle: String(msg.migrate_to_chat_id) })
      .where(and(eq(schema.sources.type, "tg_group"), eq(schema.sources.handle, chatId)));
    return;
  }
  const owners = await groupOwners(chatId);
  if (!owners.length) {
    // 机器人是这里的管理员（准备用作「必须进群」的群）：不收消息、不退群。
    // 现查一次而不是只看记录：机器人在新版上线前就被设为管理员时没收到通知，群里有人说话时补记下来
    if (await botIsAdminHere(chatId)) return;
    // 不是任何人的信息源（例如绑定的人删掉了这个源）：退出
    if (shouldAnswerGroup(chatId)) await callBot("leaveChat", { chat_id: chatId }).catch(() => {});
    return;
  }
  // 是别人的信息源，但机器人也可能是这里的管理员（准备用作「必须进群」的群）：每个群 10 分钟最多查一次，补记下来
  if (!(await isAdminChat(chatId)) && hit(`grp:admchk:${chatId}`, 1, 10 * 60_000).ok) await botIsAdminHere(chatId);
  if (msg.from?.is_bot) return;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (text.replace(/\s/g, "").length < 20 || text.startsWith("/")) return;
  // 刷屏的群：每个群每分钟最多收 30 条，多的静默丢掉
  if (!hit(`grp:${chatId}`, 30, 60_000).ok) return;
  const url = msg.chat.username ? `https://t.me/${msg.chat.username}/${msg.message_id}` : firstUrl(msg);
  for (const o of owners) {
    await addFeedItem(o.userId, {
      kind: "tg_group",
      text,
      url,
      author: o.title ?? msg.chat.title ?? null,
      publishedAt: new Date(msg.date * 1000),
      sourceId: o.id,
    });
  }
}

// ---------- 长轮询（本机运行） ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 本机运行时持续向 Telegram 拉取新消息。
 * 没配置机器人时每 10 秒看一次配置（在页面上保存后不用重启就会开始工作）。
 */
export function startTelegramPolling() {
  if (g.__vdTgPoller || process.env.TELEGRAM_WEBHOOK === "1") return;
  const state = { stop: false };
  g.__vdTgPoller = state;
  void (async () => {
    let offset: number | undefined;
    let lastToken: string | null = null;
    while (!state.stop) {
      const token = botToken();
      // 没配置机器人，或这一份已退役（机器人交给服务器上那份）
      if (!token || isRetired()) {
        await sleep(10_000);
        continue;
      }
      if (token !== lastToken) {
        lastToken = token;
        offset = undefined;
        // 用轮询就不能同时设置 webhook
        await callBot("deleteWebhook", {}, token).catch(() => {});
        await callBot("setMyCommands", { commands: BOT_COMMANDS }, token).catch(() => {});
      }
      try {
        const updates = await callBot<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message", "callback_query", "my_chat_member", "channel_post"] },
          token,
          35_000,
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await handleUpdate(u);
          } catch (e) {
            console.error("[telegram] 处理消息失败", e instanceof Error ? e.message : e);
          }
        }
      } catch (e) {
        const status = e instanceof TelegramError ? e.status : 0;
        // 401：token 不对；409：别处也在用这个机器人收消息
        if (status !== 0) console.error("[telegram]", e instanceof Error ? e.message : e);
        await sleep(status === 401 ? 60_000 : 5_000);
      }
    }
  })();
}
