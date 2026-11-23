import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addBalanceTx, getConfig, getSetting, isAdmin, setSetting, toMicro, fmtUsdt } from "./billing";
import { botToken, callBot, sendMessage, TelegramError, type Keyboard } from "./tg-api";
import { hit } from "./rate-limit";

/**
 * 「必须关注频道 / 进群才能用」：后台填好频道或群，机器人用 getChatMember 查这个人在不在里面。
 * 机器人必须是那个频道的管理员（群里至少是成员，建议也设管理员），否则 Telegram 不告诉它谁在里面。
 *
 * 查不了的时候（机器人不是管理员、频道填错、Telegram 连不上）放行，并在后台显示原因：
 * 宁可漏挡几个人，也不能因为设置出错把所有用户都挡在外面。
 */

export interface GateChat {
  /** @用户名（公开频道 / 群）或 -100 开头的数字 ID（私密群） */
  chat: string;
  /** 显示在按钮上的名字；检测时自动取频道名 */
  title?: string;
  /** 加入链接：公开的自动用 t.me/用户名；私密群要填邀请链接 */
  invite?: string;
}

export interface GateConfig {
  enabled: boolean;
  chats: GateChat[];
}

const KEY = "tg_gate";
export const MAX_GATE_CHATS = 3;

export async function getGate(): Promise<GateConfig> {
  const saved = (await getSetting<Partial<GateConfig>>(KEY)) ?? {};
  return { enabled: !!saved.enabled, chats: Array.isArray(saved.chats) ? saved.chats : [] };
}

export class GateConfigError extends Error {}

/**
 * 把后台填的东西整理成 @用户名 或数字 ID：
 * 「@abc」「abc」「t.me/abc」「https://t.me/abc」→ @abc；「-1001234」→ -1001234；
 * 「t.me/+xxxx」这种邀请链接本身查不出是哪个群，要另外填 ID。
 */
export function normalizeChat(input: string): string | null {
  const s = input.trim();
  if (/^-?\d{5,20}$/.test(s)) return s;
  const m = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)\/?$/i) ?? s.match(/^@?([A-Za-z][A-Za-z0-9_]{3,31})$/);
  if (m && !/^(joinchat|c|s)$/i.test(m[1])) return `@${m[1]}`;
  return null;
}

export function joinUrl(c: GateChat): string | null {
  if (c.invite && /^https:\/\/t\.me\//i.test(c.invite)) return c.invite;
  return c.chat.startsWith("@") ? `https://t.me/${c.chat.slice(1)}` : null;
}

export async function saveGate(next: GateConfig) {
  const chats: GateChat[] = [];
  const seen = await adminChats();
  for (const raw of next.chats.slice(0, MAX_GATE_CHATS)) {
    const c = { ...raw, chat: raw.chat.trim(), invite: raw.invite?.trim() || undefined };
    if (!c.chat && !c.invite) continue;
    // 私密群的邀请链接填到了第一栏：挪到邀请链接那栏
    if (isInviteLink(c.chat)) {
      c.invite = c.invite || c.chat;
      c.chat = "";
    }
    if (c.invite && isInviteLink(c.invite)) c.invite = toInviteUrl(c.invite);
    let title = c.title?.trim() || undefined;
    if (!c.chat) {
      // 只有邀请链接：用机器人被设为管理员的那个私密群（只有一个时自动选上）
      const priv = seen.filter((x) => !x.username && !chats.some((y) => y.chat === x.id));
      if (priv.length !== 1) {
        throw new GateConfigError(
          priv.length
            ? "机器人在好几个私密群里当管理员，请在下面「机器人是管理员的群」里点一下要用的那个"
            : "还没找到这个群：请先在 TG 群里把机器人设为管理员，等几秒刷新这一页，再保存",
        );
      }
      c.chat = priv[0].id;
      title = title || priv[0].title;
    }
    const chat = normalizeChat(c.chat);
    if (!chat) throw new GateConfigError(`「${c.chat}」看不懂：公开频道填 @用户名 或 t.me/用户名；私密群直接贴邀请链接（t.me/+ 开头）`);
    const invite = c.invite;
    if (invite && !/^https:\/\/t\.me\/\S+$/i.test(invite)) throw new GateConfigError("邀请链接应该是 https://t.me/ 开头");
    if (!chat.startsWith("@") && !invite) throw new GateConfigError("私密群没有公开链接，请把群的邀请链接（t.me/+ 开头）也贴上，用户才能点进去");
    chats.push({ chat, title, invite });
  }
  if (next.enabled && !chats.length) throw new GateConfigError("打开了「必须加入才能用」，但还没填频道或群");
  await setSetting(KEY, { enabled: next.enabled, chats });
  memberCache.clear();
}

// ---------- 机器人被设为管理员的群 / 频道（后台点选，不用自己找群 ID） ----------

export interface SeenChat {
  id: string;
  title: string;
  type: string;
  username?: string;
  at: string;
}

const SEEN_KEY = "tg_gate_seen";

/** 机器人被设为某个群 / 频道的管理员时记下来；最多记 20 个 */
export async function recordAdminChat(c: { id: string; title?: string; type: string; username?: string }) {
  const list = (await getSetting<SeenChat[]>(SEEN_KEY)) ?? [];
  const next = [
    { id: c.id, title: c.title || c.id, type: c.type, username: c.username, at: new Date().toISOString() },
    ...list.filter((x) => x.id !== c.id),
  ].slice(0, 20);
  await setSetting(SEEN_KEY, next);
}

/** 机器人不再是管理员 / 被移出：从候选里去掉 */
export async function forgetAdminChat(id: string) {
  const list = (await getSetting<SeenChat[]>(SEEN_KEY)) ?? [];
  if (list.some((x) => x.id === id)) await setSetting(SEEN_KEY, list.filter((x) => x.id !== id));
}

/** 机器人是管理员的群 / 频道（不含用户自己加的信息源群，那些不给平台方看） */
export async function adminChats(): Promise<SeenChat[]> {
  const list = (await getSetting<SeenChat[]>(SEEN_KEY)) ?? [];
  if (!list.length) return [];
  const db = await getDb();
  const sources = await db
    .select({ h: schema.sources.handle, id: schema.users.id, email: schema.users.email })
    .from(schema.sources)
    .innerJoin(schema.users, eq(schema.users.id, schema.sources.userId))
    .where(eq(schema.sources.type, "tg_group"));
  // 平台方自己的信息源群照样列出来（常见：平台方已绑定 TG，把机器人拉进自己的群时它顺便成了信息源）
  const used = new Set<string>();
  for (const r of sources) if (!(await isAdmin({ id: r.id, email: r.email }))) used.add(r.h);
  return list.filter((x) => !used.has(x.id));
}

export async function isAdminChat(id: string): Promise<boolean> {
  return ((await getSetting<SeenChat[]>(SEEN_KEY)) ?? []).some((x) => x.id === id);
}

/** 「https://t.me/+xxxx」「t.me/joinchat/xxxx」这种私密邀请链接 */
export const isInviteLink = (s: string) => /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)[\w-]+\/?$/i.test(s.trim());

const toInviteUrl = (s: string) => {
  const t = s.trim().replace(/^(?:https?:\/\/)?(?:telegram\.me|t\.me)\//i, "");
  return `https://t.me/${t.replace(/\/$/, "")}`;
};

// ---------- 查成员 ----------

type MemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

/** 在里面：是 / 不是 / 查不了（机器人没权限等，放行） */
type Check = "in" | "out" | "unknown";

// 查到「在里面」记 10 分钟，免得每条消息都去问 Telegram；不在的不记，用户一加入马上就能用
const MEMBER_TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __vdGateCache?: Map<string, number>; __vdGateErr?: Map<string, string> };
const memberCache = (g.__vdGateCache ??= new Map<string, number>());
/** 最近一次查不了的原因（给后台看） */
const lastError = (g.__vdGateErr ??= new Map<string, string>());

export function resetGateCache() {
  memberCache.clear();
  lastError.clear();
}

export function gateErrors(): Record<string, string> {
  return Object.fromEntries(lastError);
}

async function checkOne(chat: string, tgUserId: string): Promise<Check> {
  const key = `${chat}|${tgUserId}`;
  const until = memberCache.get(key);
  if (until && until > Date.now()) return "in";
  try {
    const m = await callBot<{ status: MemberStatus; is_member?: boolean }>("getChatMember", { chat_id: chat, user_id: Number(tgUserId) }, botToken(), 8_000);
    lastError.delete(chat);
    const inside = m.status === "creator" || m.status === "administrator" || m.status === "member" || (m.status === "restricted" && m.is_member !== false);
    if (inside) memberCache.set(key, Date.now() + MEMBER_TTL_MS);
    else memberCache.delete(key);
    return inside ? "in" : "out";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 「user not found」/「participant_id_invalid」：这个人从来没进过，算不在
    if (/user not found|participant_id_invalid|member not found/i.test(msg)) return "out";
    lastError.set(chat, msg);
    console.error("[tg-gate] 查不了是否已加入", chat, msg);
    return "unknown";
  }
}

/** 这个 TG 用户还没加入的频道 / 群（空 = 都加入了，或门槛没开） */
export async function missingChats(tgUserId: string): Promise<GateChat[]> {
  const gate = await getGate();
  if (!gate.enabled || !gate.chats.length) return [];
  const missing: GateChat[] = [];
  for (const c of gate.chats) if ((await checkOne(c.chat, tgUserId)) === "out") missing.push(c);
  return missing;
}

/** 管理员不用加入（方便测试和自己用） */
async function exempt(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return !!u && (await isAdmin(u));
}

export function gateText(missing: GateChat[]): { text: string; buttons: Keyboard } {
  const names = missing.map((c) => `「${c.title || c.chat}」`).join("、");
  const buttons: Keyboard = missing
    .map((c) => {
      const url = joinUrl(c);
      return url ? [{ text: `👉 加入 ${c.title || c.chat}`, url }] : null;
    })
    .filter((r): r is { text: string; url: string }[] => !!r);
  buttons.push([{ text: "✅ 我已加入", callback_data: "gate:ok" }]);
  return {
    text: `使用机器人前，请先加入${names}。\n加入后点下面「✅ 我已加入」就能开始用。`,
    buttons,
  };
}

/**
 * 机器人处理一条私聊消息 / 按钮之前调用：通过返回 true；没通过就发提示（同一个人 20 秒内最多发一次）并返回 false。
 * 私聊里 chatId 就是这个人的 TG 用户 ID。
 */
export async function passGate(userId: string | null, chatId: string): Promise<boolean> {
  const missing = await missingChats(chatId);
  if (!missing.length) {
    if (userId) await grantNewUserBonus(userId, { gatePassed: true }).catch((e) => console.error("[tg-gate] 赠送失败", e));
    return true;
  }
  if (await exempt(userId)) return true;
  if (hit(`gate:tip:${chatId}`, 1, 20_000).ok) {
    const t = gateText(missing);
    await sendMessage(chatId, t.text, { buttons: t.buttons }).catch(() => {});
  }
  return false;
}

/** 用户点「我已加入」：重新查一遍。返回按钮上方弹出的小提示 */
export async function recheckGate(userId: string | null, chatId: string): Promise<{ ok: boolean; note: string }> {
  // 防止狂点：每人 10 秒最多查 3 次
  if (!hit(`gate:re:${chatId}`, 3, 10_000).ok) return { ok: false, note: "点得太快了，稍等几秒再点" };
  for (const c of (await getGate()).chats) memberCache.delete(`${c.chat}|${chatId}`);
  const missing = await missingChats(chatId);
  if (missing.length) {
    return { ok: false, note: `还没检测到你加入${missing.map((c) => `「${c.title || c.chat}」`).join("、")}，加入后再点一次` };
  }
  if (userId) await grantNewUserBonus(userId, { gatePassed: true }).catch((e) => console.error("[tg-gate] 赠送失败", e));
  return { ok: true, note: "已确认加入 ✓" };
}

// ---------- 后台检测 ----------

export interface GateDiag {
  chat: string;
  ok: boolean;
  title?: string;
  /** 给管理员看的说明 */
  text: string;
}

/** 后台「检测」：机器人能不能查这个频道 / 群的成员（是不是管理员） */
export async function diagnoseGate(chats: GateChat[]): Promise<GateDiag[]> {
  if (!botToken()) return chats.map((c) => ({ chat: c.chat, ok: false, text: "还没配置 TG 机器人" }));
  const botId = Number((botToken() ?? "").split(":")[0]);
  const out: GateDiag[] = [];
  const seen = await adminChats();
  for (const c of chats) {
    let chat = normalizeChat(c.chat);
    if (!chat && (isInviteLink(c.chat) || (!c.chat.trim() && c.invite))) {
      const priv = seen.filter((x) => !x.username);
      if (priv.length === 1) chat = priv[0].id;
      else {
        out.push({
          chat: c.chat || c.invite || "",
          ok: false,
          text: priv.length ? "机器人在好几个私密群里当管理员，请在下面点选要用的那个" : "还没找到这个群：请先在群里把机器人设为管理员，等几秒刷新这一页",
        });
        continue;
      }
    }
    if (!chat) {
      out.push({ chat: c.chat, ok: false, text: "看不懂：公开频道填 @用户名 或 t.me/用户名；私密群直接贴邀请链接（t.me/+ 开头）" });
      continue;
    }
    try {
      const info = await callBot<{ title?: string; type: string }>("getChat", { chat_id: chat });
      const me = await callBot<{ status: MemberStatus }>("getChatMember", { chat_id: chat, user_id: botId });
      const admin = me.status === "administrator" || me.status === "creator";
      const isChannel = info.type === "channel";
      const ok = admin || (!isChannel && me.status === "member");
      out.push({
        chat,
        ok,
        title: info.title,
        text: admin
          ? `正常：机器人是「${info.title}」的管理员，可以检查成员`
          : ok
            ? `可以用：机器人在群「${info.title}」里，但建议设为管理员更稳`
            : `机器人还不是「${info.title}」的管理员。请在${isChannel ? "频道" : "群"}设置 → 管理员 → 添加管理员，搜机器人用户名加进去（权限全部可以关掉）`,
      });
    } catch (e) {
      const msg = e instanceof TelegramError ? e.message : String(e);
      out.push({
        chat,
        ok: false,
        text: /chat not found/i.test(msg)
          ? "找不到这个频道/群：检查用户名有没有填错；私密群需要先把机器人拉进去"
          : /not enough rights|member list is inaccessible|administrator/i.test(msg)
            ? "机器人还不是管理员。请把机器人加为频道/群管理员（权限全部可以关掉）"
            : `Telegram 返回：${msg}`,
      });
    }
  }
  return out;
}

/** 这个群是不是门槛用的频道 / 群（机器人在里面只是为了查成员，不当信息源、不退群） */
export async function isGateChat(chatId: string, username?: string): Promise<boolean> {
  const gate = await getGate();
  return gate.chats.some((c) => c.chat === chatId || (!!username && c.chat.toLowerCase() === `@${username.toLowerCase()}`));
}

// ---------- 新用户赠送 ----------

/** 用来让事务整体回滚（「领过」的记号一个都不留） */
class AlreadyGranted extends Error {}

/**
 * 新用户赠送：TG 和 X 都绑好（开了门槛还要加入频道）才到账。两件事哪件后做完，就在那时候发。
 * 每个 VoiceDraft 账号、每个 TG 号、每个 X 账号都只送一次——
 * 换邮箱注册新号再绑同一个 TG，或者把 X 从老号解绑再绑到新号，都不会再送。
 * 三个「领过」的记号和加钱在同一个事务里，同时触发也只会成功一次；没送成就一个记号都不留，
 * 以后换一个没领过的 X 账号还能领。
 *
 * gatePassed：调用方刚查过门槛（机器人收到消息时）就传 true，省一次查询。
 */
export async function grantNewUserBonus(userId: string, opts: { gatePassed?: boolean } = {}): Promise<number> {
  const cfg = await getConfig();
  const amount = toMicro(cfg.signupBonus);
  if (amount <= 0) return 0;
  const db = await getDb();
  // 便宜的预检：大部分消息都会走到这里，已经领过的、还没连 X 的直接返回
  const [done] = await db.select({ k: schema.appSettings.key }).from(schema.appSettings).where(eq(schema.appSettings.key, `bonus:u:${userId}`)).limit(1);
  if (done) return 0;
  const [x] = await db.select({ xUserId: schema.xAccounts.xUserId, authError: schema.xAccounts.authError }).from(schema.xAccounts).where(eq(schema.xAccounts.userId, userId)).limit(1);
  if (!x || x.authError) return 0;
  const [tg] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
  const tgUserId = tg?.chatId;
  if (!tgUserId) return 0;
  if (!opts.gatePassed && (await missingChats(tgUserId)).length && !(await exempt(userId))) return 0;

  const keys = [`bonus:u:${userId}`, `bonus:tg:${tgUserId}`, `bonus:x:${x.xUserId}`];
  let granted = 0;
  try {
    granted = await db.transaction(async (tx) => {
      // 以前已经送过的账号（网页注册时送的、或者按老规则绑 TG 时送的）不再送
      const [old] = await tx
        .select({ id: schema.ledger.id })
        .from(schema.ledger)
        .where(and(eq(schema.ledger.userId, userId), eq(schema.ledger.kind, "bonus"), eq(schema.ledger.note, "新用户赠送")))
        .limit(1);
      if (old) throw new AlreadyGranted();
      for (const key of keys) {
        const r = await tx
          .insert(schema.appSettings)
          .values({ key, value: { userId, tgUserId, xUserId: x.xUserId, at: new Date().toISOString() } })
          .onConflictDoNothing()
          .returning({ k: schema.appSettings.key });
        if (!r.length) throw new AlreadyGranted();
      }
      await addBalanceTx(tx, userId, amount, { kind: "bonus", note: "新用户赠送", refId: `tg:${tgUserId}|x:${x.xUserId}` });
      return amount;
    });
  } catch (e) {
    if (e instanceof AlreadyGranted) return 0;
    throw e;
  }
  if (granted) {
    await sendMessage(tgUserId, `🎁 TG 和 X 都绑好了，新用户赠送 ${fmtUsdt(granted)} USDT 已到账，可以直接试用。`).catch(() => {});
  }
  return granted;
}

/** 这个人还能不能领新人赠送（还能领就返回金额，提醒里、三步卡上提一句「连好 X 送多少」） */
export async function bonusPending(userId: string, tgUserId?: string | null): Promise<number> {
  const cfg = await getConfig();
  const amount = toMicro(cfg.signupBonus);
  if (amount <= 0) return 0;
  const db = await getDb();
  if (tgUserId === undefined) {
    const [tg] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
    tgUserId = tg?.chatId ?? null;
  }
  const keys = [`bonus:u:${userId}`, ...(tgUserId ? [`bonus:tg:${tgUserId}`] : [])];
  const [m] = await db.select({ k: schema.appSettings.key }).from(schema.appSettings).where(inArray(schema.appSettings.key, keys)).limit(1);
  if (m) return 0;
  const [old] = await db
    .select({ id: schema.ledger.id })
    .from(schema.ledger)
    .where(and(eq(schema.ledger.userId, userId), eq(schema.ledger.kind, "bonus"), eq(schema.ledger.note, "新用户赠送")))
    .limit(1);
  return old ? 0 : amount;
}
