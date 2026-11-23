import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fmtUsdt, postsLeft } from "./billing";
import { bonusPending } from "./tg-gate";
import { getActiveCard } from "./data";
import { editMessage, sendMessage, type Keyboard } from "./tg-api";
import { getState, setState } from "./tg-bot-core";
/** 预计还能发几条的一行字；不计费（返回 null）时不显示 */
function postsLeftLine(n: number | null): string | null {
  if (n === null) return null;
  return n > 0 ? `📝 预计还能发约 ${n} 条推文` : "📝 暂时不能发推文";
}
import { getAccount } from "./x";
import { createWebLoginLink } from "./web-login";

/**
 * 机器人的「门面」：底部 6 个按钮、新用户三步上手卡、「更多」和它下面的子菜单。
 *
 * 卡片样式统一：第一行图标 + 标题，正文最多几行，按钮一行最多 2 个，
 * 子菜单最后一行是「↩️ 返回」，在原消息上更新，不刷屏。
 */

export const MENU = {
  write: "✍️ 写推文",
  replies: "💬 回复",
  auto: "🤖 自动发",
  mine: "📂 我的内容",
  more: "☰ 更多",
} as const;

export const MENU_KEYBOARD = [
  [MENU.write, MENU.replies, MENU.auto],
  [MENU.mine, MENU.more],
];

/** 旧版菜单的按钮文字：老用户手机上的旧键盘还在，点了照样能用，顺便换成新菜单 */
export const LEGACY_MENU: Record<string, string> = {
  "✍️ 起草": "/draft",
  "💡 灵感": "/ideas",
  "📅 定时": "/queue",
  "📝 草稿": "/drafts",
  "📜 长文": "/long",
  "🎨 风格卡": "/card",
  "📥 素材": "/samples",
  "⚙️ 更多": "/more",
  "🤖 自动发帖": "/auto",
  "❓ 帮助": "/help",
  "🎁 签到": "/checkin",
};

/** 输入框旁「/」菜单里显示的命令（只放常用的；其他老命令照样能用） */
export const BOT_COMMANDS = [
  { command: "write", description: "写推文（短推、长推、串推、X 长文）" },
  { command: "replies", description: "待回复的 @我 和关注的人" },
  { command: "auto", description: "自动发：信息源和自动发帖" },
  { command: "mine", description: "我的内容：草稿和定时" },
  { command: "balance", description: "我的账号：用户编号" },
  { command: "checkin", description: "每日签到领奖励" },
  { command: "invite", description: "邀请好友，双方都有奖励" },
  { command: "more", description: "更多：文风、推广链接、X 账号、团队" },
  { command: "start", description: "主菜单和上手步骤" },
  { command: "cancel", description: "取消当前输入" },
];

export const BACK_ROW = [{ text: "↩️ 返回", callback_data: "hm:more" }];

export const HELP_TEXT =
  "👋 VoiceDraft 助手\n" +
  "直接发一个主题给我，我就按你的文风写 3 条，选一条就能发布或定时。\n\n" +
  `${MENU.write}：短推、长推、串推、X 长文，也能从灵感里挑\n` +
  `${MENU.replies}：有人 @你 或关注的人发帖时，给你回复候选\n` +
  `${MENU.auto}：订阅网站、频道等信息源，有新内容自动写好发\n` +
  `${MENU.mine}：草稿和定时发布\n` +
  `${MENU.more}：我的文风、推广链接、X 账号（互关检测）、团队、数据和排行、每日日报、更新通知\n\n` +
  "看到好内容转发给我，会收进灵感。/cancel 取消当前输入";

// ---------- 新用户三步上手 ----------

export interface Onboarding {
  xHandle: string | null;
  samples: number;
  hasCard: boolean;
  /** 还没连 X、连好能领的新人赠送（微 USDT），0 = 没有 */
  xGift?: number;
}

export async function onboarding(userId: string): Promise<Onboarding> {
  const db = await getDb();
  const [acc, card, [{ n }]] = await Promise.all([
    getAccount(userId),
    getActiveCard(userId),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.samples).where(eq(schema.samples.userId, userId)),
  ]);
  const xGift = acc ? 0 : await bonusPending(userId).catch(() => 0);
  return { xHandle: acc?.handle ?? null, samples: n, hasCard: !!card, xGift };
}

export const onboardingDone = (o: Onboarding) => !!o.xHandle && o.hasCard;

export function onboardingCard(o: Onboarding, estimate: string | null): { text: string; buttons: Keyboard } {
  const tick = (ok: boolean) => (ok ? "✅" : "⬜");
  const lines = [
    "👋 欢迎使用 VoiceDraft，三步就能开始：",
    "",
    "✅ 1. 开好账号",
    `${tick(!!o.xHandle)} 2. 连接你的 X 账号${o.xHandle ? `（@${o.xHandle}）` : `：点「🔑 连接 X」，在 X 页面上点授权，约 1 分钟${o.xGift ? `（连好送 ${fmtUsdt(o.xGift)} USDT）` : ""}`}`,
    `${tick(o.hasCard)} 3. 发我几条你写过的推文，我学你的文风${o.hasCard ? "" : o.samples ? `（已收到 ${o.samples} 条，点「🎨 生成文风」）` : "：点「📥 导入推文」"}`,
  ];
  if (estimate) lines.push("", `🎁 ${estimate}`);
  lines.push("", "做完后直接发个主题给我，我就按你的口吻写。");
  const row: Keyboard[number] = [];
  if (!o.xHandle) row.push({ text: "🔑 连接 X", callback_data: "xc" });
  if (!o.hasCard) row.push(o.samples ? { text: "🎨 生成文风", callback_data: "cg" } : { text: "📥 导入推文", callback_data: "sm" });
  return { text: lines.join("\n"), buttons: [row, [{ text: "↻ 刷新进度", callback_data: "hm:start" }]] };
}

/** 主菜单：先发底部按钮；没做完上手三步的，再发一张三步卡 */
/**
 * first：true = 刚用网页的绑定链接绑好；"new" = 刚在机器人里自动开了账号
 */
export async function welcome(chatId: string, first: boolean | "new" = false, userId?: string | null) {
  const left = userId ? postsLeftLine(await postsLeft(userId)) : null;
  const o = userId ? await onboarding(userId) : null;
  const hello =
    first === "new" ? `👋 欢迎！账号已经自动开好了${await userNoText(userId)}，不用去网页注册。下面是菜单 👇` : first ? "绑定成功 ✓ 下面是菜单 👇" : "菜单在下面 👇";
  if (o && !onboardingDone(o)) {
    await sendMessage(chatId, hello, { keyboard: MENU_KEYBOARD });
    const card = onboardingCard(o, left);
    await sendMessage(chatId, card.text, { buttons: card.buttons });
    return;
  }
  const text = (first === "new" ? `${hello}\n\n` : first ? "绑定成功 ✓\n\n" : "") + HELP_TEXT + (left ? `\n\n${left}` : "");
  await sendMessage(chatId, text, { keyboard: MENU_KEYBOARD });
}

async function userNoText(userId?: string | null) {
  if (!userId) return "";
  const db = await getDb();
  const [u] = await db.select({ no: schema.users.userNo }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return u ? `（编号 ${u.no}）` : "";
}

/**
 * 「我的账号」：/balance、/wallet、/id、/me 都到这里。
 * 开源版没有余额和充值，只显示用户编号（找客服时用）。
 */
export async function handleAccountMenu(userId: string, chatId: string, cmd: string): Promise<boolean> {
  if (cmd !== "/balance" && cmd !== "/wallet" && cmd !== "/id" && cmd !== "/me") return false;
  const db = await getDb();
  const [u] = await db.select({ no: schema.users.userNo }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const no = u?.no;
  await sendMessage(chatId, `🆔 用户编号：${no ?? "—"}（找客服时发这个号）\n\n这是开源自托管版，免费使用，没有余额、不用充值。`, {
    buttons: no ? [[{ text: "📋 复制用户编号", copy_text: { text: String(no) } }]] : undefined,
  });
  return true;
}

/** 「↻ 刷新进度」：在原卡片上更新；都做完了就换成「准备好了」 */
export async function refreshOnboarding(userId: string, chatId: string, mid: number) {
  const o = await onboarding(userId);
  if (onboardingDone(o)) {
    await editMessage(chatId, mid, `🎉 准备好了！已连接 @${o.xHandle}，文风也学好了。\n\n直接发个主题给我，或点「${MENU.write}」。`, []);
    return;
  }
  const card = onboardingCard(o, postsLeftLine(await postsLeft(userId)));
  await editMessage(chatId, mid, card.text, card.buttons);
}

// ---------- ✍️ 写推文 ----------

export const WRITE_BUTTONS: Keyboard = [
  [
    { text: "📜 长推 / 串推 / 长文", callback_data: "hm:long" },
    { text: "💡 从灵感挑", callback_data: "hm:ideas" },
  ],
];

// ---------- 📂 我的内容 ----------

export async function showMine(userId: string, chatId: string) {
  const db = await getDb();
  const [[{ drafts }], [{ queued }]] = await Promise.all([
    db
      .select({ drafts: sql<number>`count(*)::int` })
      .from(schema.drafts)
      .where(and(eq(schema.drafts.userId, userId), inArray(schema.drafts.status, ["draft", "copied"]), ne(schema.drafts.finalText, ""))),
    db
      .select({ queued: sql<number>`count(*)::int` })
      .from(schema.posts)
      .where(and(eq(schema.posts.userId, userId), inArray(schema.posts.status, ["scheduled", "paused"]))),
  ]);
  if (!drafts && !queued) {
    await sendMessage(chatId, `📂 我的内容\n还没有草稿和定时帖。点「${MENU.write}」写一条。`);
    return;
  }
  await sendMessage(chatId, `📂 我的内容\n草稿 ${drafts} 条 · 定时 ${queued} 条`, {
    buttons: [
      [
        { text: `📝 草稿（${drafts}）`, callback_data: "hm:drafts" },
        { text: `📅 定时（${queued}）`, callback_data: "hm:queue" },
      ],
    ],
  });
}

// ---------- ☰ 更多 ----------

const MORE_TEXT = "☰ 更多";
const MORE_BUTTONS: Keyboard = [
  [
    { text: "🎨 我的文风", callback_data: "hm:style" },
    { text: "🔗 推广链接", callback_data: "mp" },
  ],
  [
    { text: "🐦 X 账号", callback_data: "hm:x" },
    { text: "👥 团队", callback_data: "tm" },
  ],
  [
    { text: "📊 数据和排行", callback_data: "bm" },
    { text: "📰 每日日报", callback_data: "rp:m" },
  ],
  [
    { text: "🔔 更新通知", callback_data: "an:menu" },
    { text: "❓ 帮助", callback_data: "hp" },
  ],
];

export async function showMore(chatId: string, mid?: number) {
  if (mid) await editMessage(chatId, mid, MORE_TEXT, MORE_BUTTONS);
  else await sendMessage(chatId, MORE_TEXT, { buttons: MORE_BUTTONS });
}

/** 🎨 我的文风：风格卡、素材、盲测、账号记忆 */
export async function showStyleMenu(userId: string, chatId: string, mid: number) {
  const db = await getDb();
  const [card, [{ n }]] = await Promise.all([
    getActiveCard(userId),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.samples).where(eq(schema.samples.userId, userId)),
  ]);
  const text =
    "🎨 我的文风\n" +
    `素材 ${n} 条 · ${card ? `风格卡第 ${card.version} 版` : "还没有风格卡"}\n` +
    "素材是你写过的推文；风格卡是我从中总结的写法；账号记忆是你常聊什么、坚持和反对什么。";
  await editMessage(chatId, mid, text, [
    [
      { text: "🎨 风格卡", callback_data: "hm:card" },
      { text: "📥 导入素材", callback_data: "sm" },
    ],
    [
      { text: "🧪 风格盲测", callback_data: "bt" },
      { text: "🧠 账号记忆", callback_data: "mm" },
    ],
    BACK_ROW,
  ]);
}

/** 🐦 X 账号：连接状态、重连、书签和引用 */
export async function showXMenu(userId: string, chatId: string, mid: number) {
  const acc = await getAccount(userId);
  const text = acc
    ? `🐦 X 账号\n已连接 @${acc.handle}\nX 书签里的推文可以拿来写引用推文；「互关检测」找出没回关你、取关了你的人。`
    : "🐦 X 账号\n还没连接。连接后才能发布、定时和回复。";
  await editMessage(chatId, mid, text, [
    [
      { text: acc ? "🔑 重新连接" : "🔑 连接 X", callback_data: "xc" },
      { text: "🔖 书签和引用", callback_data: "xm" },
    ],
    ...(acc ? [[{ text: "🔍 互关检测", callback_data: "mu:h" }]] : []),
    BACK_ROW,
  ]);
}

// ---------- 连接 X 的结果 ----------

/** 在 TG 里点「连接 X」后授权完成的落地页：不用登录网页，只显示结果和「回到 Telegram」 */
export const TG_X_LANDING = "/x-connected";

/** 在 TG 里发起的 X 授权完成（或失败）后，告诉用户结果和下一步 */
export async function notifyXConnect(userId: string, result: { ok: true } | { ok: false; reason: string }) {
  const db = await getDb();
  const [b] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
  if (!b?.chatId) return;
  if (!result.ok) {
    await sendMessage(b.chatId, `⚠️ X 账号没连上：${result.reason}\n\n再点一次下面的按钮，重新授权就行。`, {
      buttons: [[{ text: "🔑 再试一次", callback_data: "xc" }]],
    });
    return;
  }
  const o = await onboarding(userId);
  if (o.hasCard) {
    await sendMessage(b.chatId, `✅ X 账号 @${o.xHandle} 连接好了！\n\n现在直接发个主题给我，我就按你的文风写，选好一条就能发到 X。`);
    return;
  }
  await sendMessage(
    b.chatId,
    `✅ X 账号 @${o.xHandle} 连接好了！\n\n` +
      "下一步：让我学你的文风。把你写过的推文发给我（10 条以上更好），我总结出你的写法，之后写出来才像你。",
    { buttons: [[o.samples ? { text: "🎨 生成文风", callback_data: "cg" } : { text: "📥 导入推文", callback_data: "sm" }]] },
  );
}

/** 第一次生成风格卡后：告诉用户可以开始写了；X 还没连的提醒一下 */
export async function nudgeAfterFirstCard(userId: string, chatId: string) {
  const o = await onboarding(userId);
  const example = "例如发「比特币又创新高，散户该不该追」";
  if (o.xHandle) {
    await sendMessage(chatId, `🎉 准备好了！现在直接发个主题给我，我按你的文风写 3 条。\n${example}`);
    return;
  }
  await sendMessage(chatId, `🎉 文风学好了！现在就能发主题让我写（${example}）。\n要直接发到 X，还差一步：连接你的 X 账号。`, {
    buttons: [[{ text: "🔑 连接 X", callback_data: "xc" }]],
  });
}

// ---------- 每个主按钮第一次点：一句「怎么用」 ----------

export const TIPS: Record<keyof typeof MENU, string> = {
  write: "💡 怎么用：发一句话主题就行，例如「比特币又创新高，散户该不该追」。我写 3 条，你挑一条，可以直接发、定时或再改。",
  replies:
    "💡 怎么用：有人 @你、或你关注的人发了新帖，我会写好回复候选推给你，你点「发送」才会发出。点「👀 关注的人」设置要盯谁，例如 @VitalikButerin。",
  auto:
    "💡 怎么用：先点「➕ 加信息源」，发一个网址或 TG 频道给我（例如 https://www.coindesk.com 或 @durov），再点「▶️ 开启」。建议先用「先确认」模式，每条发出前都问你。",
  mine: "💡 怎么用：没发出的草稿和排好时间的推文都在这里，点进去可以接着改、马上发或取消。",
  more: "💡 这里是设置：「🎨 我的文风」让我写得更像你；「🐦 X 账号」可以重连或换号；「🔗 推广链接」让推文自动带上你的群。",
};

/** 某个主按钮第一次被点：先发一句提示（之后不再发） */
export async function firstTip(userId: string, chatId: string, key: keyof typeof MENU) {
  const { tips = [] } = await getState(userId);
  if (tips.includes(key)) return;
  await setState(userId, { tips: [...tips, key] });
  await sendMessage(chatId, TIPS[key]);
}

// ---------- 🌐 网页版 ----------

/** 给一个一次性登录链接：机器人里开的账号没有密码，也能用网页版（数据和机器人里是同一份） */
export async function sendWebLogin(userId: string, chatId: string) {
  const link = await createWebLoginLink(userId);
  if (!link) {
    await sendMessage(chatId, "网页版暂时打不开，请稍后再试。");
    return;
  }
  await sendMessage(chatId, "🌐 网页版\n点下面的按钮直接登录，不用密码。链接 10 分钟内有效、只能用一次，别转发给别人。\n网页上和机器人里是同一个账号、同一份数据。", {
    buttons: [[{ text: "🌐 打开网页版", url: link }]],
  });
}
