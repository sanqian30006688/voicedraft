import { ban, bannedFor, count, fmtWait, hit, hitAll } from "./rate-limit";

/**
 * TG 机器人防刷。每条消息/按钮在查数据库之前先过这里，只看内存里的计数，挡掉的几乎不花成本。
 *
 * - 同一个聊天：10 秒内最多 10 下、1 分钟内最多 40 下（正常人手点碰不到）
 * - 超了：第一次提醒「太快了」，之后静默丢弃
 * - 10 分钟里反复超限 15 次：临时封禁，10 分钟起，一天内再犯逐级加长到 24 小时；封禁期间完全不理
 * - 同一个按钮 3 秒内重复点：只算一次（防止连点扣两次钱）
 */

export const TG_LIMITS = {
  burst: { limit: 10, windowMs: 10_000 },
  minute: { limit: 40, windowMs: 60_000 },
  strikesToBan: 15,
  strikeWindowMs: 10 * 60_000,
  warnEveryMs: 30_000,
  sameButtonMs: 3_000,
  bindTries: { limit: 5, windowMs: 10 * 60_000 },
  fileImports: { limit: 5, windowMs: 10 * 60_000 },
  // 没绑定的人：每个聊天 5 分钟最多回一次「请先绑定」，全平台每分钟最多回 60 次
  unboundReplyMs: 5 * 60_000,
  unboundRepliesPerMinute: 60,
} as const;

export type FloodVerdict = { action: "ok" } | { action: "warn"; text: string } | { action: "drop" };

const banKey = (chatId: string) => `tg:${chatId}`;

export function floodCheck(chatId: string, now = Date.now()): FloodVerdict {
  if (bannedFor(banKey(chatId), now) > 0) return { action: "drop" };
  const r = hitAll(
    [
      { key: `tg:s:${chatId}`, ...TG_LIMITS.burst },
      { key: `tg:m:${chatId}`, ...TG_LIMITS.minute },
    ],
    now,
  );
  if (r.ok) return { action: "ok" };

  hit(`tg:over:${chatId}`, TG_LIMITS.strikesToBan, TG_LIMITS.strikeWindowMs, now);
  if (count(`tg:over:${chatId}`, TG_LIMITS.strikeWindowMs, now) >= TG_LIMITS.strikesToBan) {
    const ms = ban(banKey(chatId), now);
    return { action: "warn", text: `检测到刷屏，机器人暂停响应你 ${fmtWait(ms)}。到时间后会自动恢复。` };
  }
  if (hit(`tg:warned:${chatId}`, 1, TG_LIMITS.warnEveryMs, now).ok) {
    return { action: "warn", text: `操作太快了，请 ${fmtWait(r.retryAfterMs)}后再试。` };
  }
  return { action: "drop" };
}

/** 同一个按钮几秒内又点了一次 */
export function isDoubleClick(chatId: string, data: string, now = Date.now()): boolean {
  return !hit(`tg:cb:${chatId}:${data.slice(0, 64)}`, 1, TG_LIMITS.sameButtonMs, now).ok;
}

/** 给没绑定的人回「请先绑定」吗（不回就静默忽略） */
export function shouldAnswerUnbound(chatId: string, now = Date.now()): boolean {
  if (count(`tg:nb:${chatId}`, TG_LIMITS.unboundReplyMs, now) >= 1) return false;
  if (!hit("tg:nb:all", TG_LIMITS.unboundRepliesPerMinute, 60_000, now).ok) return false;
  hit(`tg:nb:${chatId}`, 1, TG_LIMITS.unboundReplyMs, now);
  return true;
}

/** 被拉进群：每个群一小时内只回一次并退群 */
export function shouldAnswerGroup(chatId: string, now = Date.now()): boolean {
  return hit(`tg:grp:${chatId}`, 1, 3600_000, now).ok;
}

export function bindTry(chatId: string, now = Date.now()) {
  return hit(`tg:bind:${chatId}`, TG_LIMITS.bindTries.limit, TG_LIMITS.bindTries.windowMs, now);
}

export function fileImportTry(chatId: string, now = Date.now()) {
  return hit(`tg:file:${chatId}`, TG_LIMITS.fileImports.limit, TG_LIMITS.fileImports.windowMs, now);
}

// ---------- webhook 去重 ----------

const seen = ((globalThis as { __vdTgSeen?: Set<number> }).__vdTgSeen ??= new Set<number>());

/**
 * Telegram 没等到 webhook 回应时会重发同一条更新；被截获的请求也可能被重放。
 * 同一个 update_id 只处理一次（记最近 5000 个）。
 */
export function firstTimeSeen(updateId: number): boolean {
  if (seen.has(updateId)) return false;
  seen.add(updateId);
  if (seen.size > 5000) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  return true;
}
