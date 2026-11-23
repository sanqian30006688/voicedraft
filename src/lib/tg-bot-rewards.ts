import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getConfig, postsLeft } from "./billing";
import { attachReferral, checkin, checkinStatus, inviteAmounts, inviteStats, onTopup, postsText, referralCode, rememberTgReferral, getRewardsConfig, type AttachResult, type TopupRewards } from "./rewards";
import { sendMessage, type Keyboard } from "./tg-api";
import { publicUrl } from "./platform-config";

/**
 * 机器人里的「🎁 签到」：点一下就签到，顺便看邀请链接。
 * 不给用户看金额，奖励都换算成「≈ 多发几条」。
 */

async function chatOf(userId: string): Promise<string | null> {
  const db = await getDb();
  const [b] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
  return b?.chatId ?? null;
}

async function tell(userId: string, text: string) {
  const chat = await chatOf(userId);
  if (chat) await sendMessage(chat, text).catch(() => {});
}

const leftLine = (n: number | null) => (n === null ? null : `现在预计还能发 ${n} 条。`);

const INVITE_BUTTON: Keyboard = [[{ text: "👥 邀请好友拿奖励", callback_data: "rw:inv" }]];

export async function doCheckin(userId: string, chatId: string) {
  const [r, rc, cfg] = await Promise.all([checkin(userId), getRewardsConfig(), getConfig()]);
  if (r.status === "off") {
    await sendMessage(chatId, "签到活动暂时没有开放。", { buttons: INVITE_BUTTON });
    return;
  }
  const rule = `规则：每天签到送 ≈${postsText(cfg, Math.round(rc.checkin * 1e6))}，连签 ${rc.streakDays} 天再送 ≈${postsText(cfg, Math.round(rc.streakBonus * 1e6))}。断签从头算。`;
  const lines: string[] = [];
  if (r.status === "already") {
    lines.push(`今天已经签过了 ✓ 已连续签到 ${r.streak} 天，明天再来。`);
    const st = await checkinStatus(userId);
    if (st.piggyMicro > 0) lines.push(`存钱罐里攒了 ≈${postsText(cfg, st.piggyMicro)}，第一次充值后一起到账。`);
  } else {
    lines.push(`签到成功 ✓ 已连续签到 ${r.streak} 天`);
    if (r.streakBonus) lines.push(`🎉 连签 ${rc.streakDays} 天，额外奖励已送上！`);
    if (r.held) {
      lines.push(
        r.amountMicro > 0
          ? `奖励已存进存钱罐，现在攒了 ≈${postsText(cfg, r.piggyMicro)}。第一次充值到账后一起发给你。`
          : `存钱罐已经满了（≈${postsText(cfg, r.piggyMicro)}），第一次充值后一起到账，之后签到直接到账。`,
      );
    } else {
      const left = leftLine(await postsLeft(userId));
      if (left) lines.push(`奖励已到账，${left}`);
    }
  }
  lines.push("", rule, `签到和邀请送的额度用的时候先扣，${rc.expireDays} 天内没再拿到新奖励、又没用完的会过期。`);
  await sendMessage(chatId, lines.join("\n"), { buttons: INVITE_BUTTON });
}

async function inviteLink(userId: string): Promise<string | null> {
  const { botUsername } = await import("./telegram");
  const username = await botUsername().catch(() => null);
  if (!username) return null;
  return `https://t.me/${username}?start=ref_${await referralCode(userId)}`;
}

export async function showInvite(userId: string, chatId: string) {
  const [rc, cfg, stats, link] = await Promise.all([getRewardsConfig(), getConfig(), inviteStats(userId), inviteLink(userId)]);
  if (!link) {
    await sendMessage(chatId, "机器人还没配置好，暂时不能生成邀请链接。");
    return;
  }
  const ex = inviteAmounts(rc, Math.round(cfg.minTopup * 1e6));
  const lines = [
    "👥 邀请好友",
    "",
    "把下面的链接发给朋友，他点开就能用机器人：",
    link,
    "",
    `好友第一次充值到账后：你得到他首充的 ${rc.invitePct}%（例如他充 ${cfg.minTopup} USDT，你得到 ≈${postsText(cfg, ex.inviter)}），最多 ≈${postsText(cfg, Math.round(rc.inviteMax * 1e6))}；好友自己也额外得到 ≈${postsText(cfg, ex.invitee)}。`,
    "自己邀请自己的小号不算。",
    "",
    `已邀请：${stats.rewarded} 人拿到奖励，${stats.pending} 人还在等首充。`,
  ];
  if (stats.earnedMicro > 0) lines.push(`邀请一共给你带来 ≈${postsText(cfg, stats.earnedMicro)}。`);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("我在用这个机器人按自己的文风写推、自动发推，推荐给你：")}`;
  await sendMessage(chatId, lines.join("\n"), { buttons: [[{ text: "📤 转发给朋友", url: share }]] });
}

/** 菜单按钮或 /checkin、/invite；返回 true 表示已处理 */
export async function handleRewardsMenu(userId: string, chatId: string, text: string, cmd: string, label: string): Promise<boolean> {
  if (text === label || cmd === "/checkin") await doCheckin(userId, chatId);
  else if (cmd === "/invite") await showInvite(userId, chatId);
  else return false;
  return true;
}

export async function handleRewardsCallback(userId: string, chatId: string, action: string, a: string): Promise<boolean> {
  if (action !== "rw") return false;
  if (a === "inv") await showInvite(userId, chatId);
  else if (a === "ci") await doCheckin(userId, chatId);
  return true;
}

const ATTACH_TEXT: Record<AttachResult, string> = {
  ok: "已记下是朋友邀请你来的 ✓ 你第一次充值到账后，你和邀请你的朋友都会拿到奖励。",
  invalid: "这个邀请链接无效。",
  self: "不能邀请自己哦。",
  already: "你已经填过邀请人了。",
  old: "邀请奖励只给刚注册的新用户，你的账号不算新用户了。",
};

/** TG 的 start=ref_邀请码 */
export async function handleRefStart(userId: string | null, chatId: string, code: string): Promise<"bound" | "unbound"> {
  if (userId) {
    const r = await attachReferral(userId, code, "tg");
    await sendMessage(chatId, ATTACH_TEXT[r]).catch(() => {});
    return "bound";
  }
  const ok = await rememberTgReferral(chatId, code);
  const base = publicUrl();
  const signup = base ? `${base}/signup?ref=${encodeURIComponent(code)}` : null;
  await sendMessage(
    chatId,
    ok
      ? `欢迎！朋友邀请你来用 VoiceDraft：按你的文风写推、自动发推。\n\n第一步：先注册一个账号${signup ? `：\n${signup}` : "（打开 VoiceDraft 网页注册）"}\n第二步：在网页「灵感 → TG」页点「绑定 TG」，回到这里按「开始」。\n\n绑定后就记下是朋友邀请的，你第一次充值后你们都有奖励。`
      : "这个邀请链接无效。请先在 VoiceDraft 网页注册，再点「绑定 TG」。",
  );
  return "unbound";
}

/** 充值到账后：解锁存钱罐、处理邀请奖励，并在 TG 里通知。出错只记日志，不影响充值本身 */
export async function afterTopup(userId: string, amountMicro: number, fromAddress: string | null): Promise<TopupRewards | null> {
  try {
    const r = await onTopup(userId, amountMicro, fromAddress);
    const cfg = await getConfig();
    if (r.piggyMicro > 0) await tell(userId, `🐷 签到存钱罐解锁：≈${postsText(cfg, r.piggyMicro)} 已到账。之后签到直接到账。`);
    if (r.referral?.status === "rewarded") {
      await tell(userId, `🎁 你是朋友邀请来的，首充奖励 ≈${postsText(cfg, r.referral.inviteeMicro)} 已到账。`);
      await tell(r.referral.inviterId, `🎉 你邀请的好友完成了首充，邀请奖励 ≈${postsText(cfg, r.referral.inviterMicro)} 已到账！`);
    }
    return r;
  } catch (e) {
    console.error("[rewards] 充值后发奖励失败", e);
    return null;
  }
}

/** 后台审核通过后通知双方 */
export async function notifyReferralApproved(inviteeId: string, r: { inviterId: string; inviterMicro: number; inviteeMicro: number }) {
  const cfg = await getConfig();
  await tell(inviteeId, `🎁 你是朋友邀请来的，首充奖励 ≈${postsText(cfg, r.inviteeMicro)} 已到账。`);
  await tell(r.inviterId, `🎉 你邀请的好友完成了首充，邀请奖励 ≈${postsText(cfg, r.inviterMicro)} 已到账！`);
}
