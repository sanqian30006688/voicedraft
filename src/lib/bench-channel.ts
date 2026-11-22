import "server-only";
import { channelBoardText, reportSlot } from "./benchmark-core";
import { leaderboard } from "./benchmark";
import { getSetting, setSetting } from "./billing";
import { botUsername } from "./telegram";
import { sendMessage, TelegramError } from "./tg-api";
import { getGate, normalizeChat } from "./tg-gate";

/**
 * 每周一北京时间 10 点，把「本周涨粉榜」发到平台的 TG 频道（后台打开才发）。
 * 只列本人自愿公开上榜的账号；不满 MIN_ENTRIES 个就这周不发，免得榜单太空。
 * 频道没填时用「必须关注频道」里的第一个。机器人要是那个频道的管理员才能发。
 */

const KEY = "bench_channel";
export const MIN_ENTRIES = 3;
/** 发送时刻过去超过这么久就不补发 */
const LATE_MS = 12 * 3600_000;

export interface BenchChannelConfig {
  enabled: boolean;
  /** @频道用户名 或 -100 开头的数字 ID；空 = 用「必须关注频道」的第一个 */
  chat: string;
  lastPostedAt: string | null;
  lastError: string | null;
}

export async function getBenchChannel(): Promise<BenchChannelConfig> {
  const s = (await getSetting<Partial<BenchChannelConfig>>(KEY)) ?? {};
  return { enabled: !!s.enabled, chat: s.chat ?? "", lastPostedAt: s.lastPostedAt ?? null, lastError: s.lastError ?? null };
}

export class BenchChannelError extends Error {}

export async function saveBenchChannel(next: { enabled: boolean; chat: string }) {
  const cur = await getBenchChannel();
  const chat = next.chat.trim();
  if (chat && !normalizeChat(chat)) throw new BenchChannelError(`「${chat}」看不懂：公开频道填 @用户名 或 t.me/用户名，私密频道填 -100 开头的数字 ID`);
  await setSetting(KEY, { ...cur, enabled: next.enabled, chat: chat ? normalizeChat(chat)! : "" });
}

/** 实际要发到哪个频道 */
export async function targetChat(cfg?: BenchChannelConfig): Promise<string | null> {
  const c = cfg ?? (await getBenchChannel());
  if (c.chat) return c.chat;
  const gate = await getGate();
  return gate.chats.find((x) => x.chat)?.chat ?? null;
}

export type PostResult = { ok: true; chat: string; count: number } | { ok: false; reason: string };

/** 发一次榜单。force = 后台点「现在发一次」，不看时间、不看是否打开 */
export async function postBoardToChannel(now = new Date(), force = false): Promise<PostResult> {
  const cfg = await getBenchChannel();
  if (!force) {
    if (!cfg.enabled) return { ok: false, reason: "没打开" };
    const slot = reportSlot(now);
    if (now.getTime() - slot.getTime() > LATE_MS) return { ok: false, reason: "不在发送时间" };
    if (cfg.lastPostedAt && new Date(cfg.lastPostedAt) >= slot) return { ok: false, reason: "这周已经发过" };
  }
  const chat = await targetChat(cfg);
  const save = (patch: Partial<BenchChannelConfig>) => setSetting(KEY, { ...cfg, ...patch });
  if (!chat) {
    if (!force) await save({ lastPostedAt: now.toISOString(), lastError: "没有填频道" });
    return { ok: false, reason: "还没填频道，也没设置「必须关注频道」" };
  }
  const entries = await leaderboard("", null, now);
  if (entries.length < MIN_ENTRIES) {
    const reason = `公开上榜的账号只有 ${entries.length} 个，满 ${MIN_ENTRIES} 个才发`;
    if (!force) await save({ lastPostedAt: now.toISOString(), lastError: reason });
    return { ok: false, reason };
  }
  try {
    await sendMessage(chat, channelBoardText(entries, await botUsername().catch(() => null)));
    await save({ lastPostedAt: now.toISOString(), lastError: null });
    return { ok: true, chat, count: Math.min(entries.length, 10) };
  } catch (e) {
    const reason =
      e instanceof TelegramError ? `发不出去：${e.message}（机器人要是这个频道的管理员，并且有发消息的权限）` : `发不出去：${e instanceof Error ? e.message : e}`;
    await save({ lastPostedAt: force ? cfg.lastPostedAt : now.toISOString(), lastError: reason });
    return { ok: false, reason };
  }
}
