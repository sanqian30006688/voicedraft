import "server-only";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fmtUsdt, setSetting } from "./billing";
import { DEFAULT_TZ, localDayHour, validTz } from "./daily-report";
import { sendMessage, TelegramError, type Keyboard } from "./tg-api";
import { bonusPending, missingChats } from "./tg-gate";

/**
 * 提醒还没连 X 的人去连 X（连好了才能直接发帖，新人还能领赠送）。
 * - 绑定 TG 满 3 天后第一次提醒，之后每 3 天一次，最多 5 次（大约两周），之后不再打扰
 * - 每条提醒都带「不再提醒」按钮；用户把机器人屏蔽了也自动停
 * - 只在用户当地 10 点到 21 点之间发；还没加入必须加入的频道 / 群的人先不提醒
 * 记录在 app_settings 的 xnudge:<userId>：{ n: 已提醒次数, last: 上次时间, off: 不再提醒 }
 */

export const NUDGE_EVERY_MS = 3 * 86400_000;
export const NUDGE_MAX = 5;
const SEND_FROM_HOUR = 10;
const SEND_TO_HOUR = 21;
/** 一轮最多发多少条，免得一下子触发 Telegram 的频率限制 */
const PER_RUN = 30;
const CHECK_MS = 60 * 60_000;

export interface NudgeState {
  n: number;
  last?: string;
  off?: boolean;
}

const key = (userId: string) => `xnudge:${userId}`;

const g = globalThis as unknown as { __vdXNudgeCheck?: number };

export function nudgeText(n: number, bonusMicro: number): { text: string; buttons: Keyboard } {
  const gift = bonusMicro > 0 ? `\n\n🎁 连好之后，新用户赠送的 ${fmtUsdt(bonusMicro)} USDT 马上到账。` : "";
  const head = n === 0 ? "👋 你还没连接 X 账号。" : "👋 提醒一下：你的 X 账号还没连接。";
  return {
    text: `${head}\n连上之后，写好的推文可以一键发到 X，也能定时发、自动回复。在 X 页面点一下授权就行，大约 1 分钟。${gift}`,
    buttons: [[{ text: "🔑 连接 X", callback_data: "xc" }], [{ text: "🔕 不再提醒", callback_data: "xn:off" }]],
  };
}

/** 用户点了「不再提醒」 */
export async function stopNudges(userId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.appSettings.value }).from(schema.appSettings).where(eq(schema.appSettings.key, key(userId))).limit(1);
  const cur = (row?.value as NudgeState | undefined) ?? { n: 0 };
  await setSetting(key(userId), { ...cur, off: true });
}

/** 定时任务每次都调用；实际每小时最多扫一次 */
export async function runXNudges(now = new Date(), force = false): Promise<number> {
  if (!force && g.__vdXNudgeCheck && now.getTime() - g.__vdXNudgeCheck < CHECK_MS) return 0;
  g.__vdXNudgeCheck = now.getTime();
  const db = await getDb();
  // 绑了 TG 满 3 天、还没连 X 的人
  const rows = await db
    .select({
      userId: schema.tgBindings.userId,
      chatId: schema.tgBindings.chatId,
      tz: schema.dailyReportSettings.tz,
      apTz: schema.autopilotSettings.tz,
    })
    .from(schema.tgBindings)
    .leftJoin(schema.xAccounts, eq(schema.xAccounts.userId, schema.tgBindings.userId))
    .leftJoin(schema.dailyReportSettings, eq(schema.dailyReportSettings.userId, schema.tgBindings.userId))
    .leftJoin(schema.autopilotSettings, eq(schema.autopilotSettings.userId, schema.tgBindings.userId))
    .where(
      and(
        isNotNull(schema.tgBindings.chatId),
        isNull(schema.xAccounts.id),
        lt(schema.tgBindings.boundAt, new Date(now.getTime() - NUDGE_EVERY_MS)),
      ),
    );
  if (!rows.length) return 0;
  const states = new Map(
    (await db.select({ k: schema.appSettings.key, v: schema.appSettings.value }).from(schema.appSettings).where(sql`${schema.appSettings.key} like 'xnudge:%'`)).map(
      (r) => [r.k, r.v as NudgeState],
    ),
  );
  let sent = 0;
  for (const r of rows) {
    if (sent >= PER_RUN) break;
    if (!r.chatId) continue;
    const st = states.get(key(r.userId)) ?? { n: 0 };
    if (st.off || st.n >= NUDGE_MAX) continue;
    if (st.last && now.getTime() - Date.parse(st.last) < NUDGE_EVERY_MS) continue;
    const tz = r.tz ?? (r.apTz && validTz(r.apTz) ? r.apTz : DEFAULT_TZ);
    const { hour } = localDayHour(now, tz);
    if (hour < SEND_FROM_HOUR || hour >= SEND_TO_HOUR) continue;
    // 还没过「必须加入频道」这一关的，点了按钮也用不了，先不提醒
    if ((await missingChats(r.chatId).catch(() => [])).length) continue;
    // 先记下这次，发失败也不马上重试，免得刷屏
    const next: NudgeState = { n: st.n + 1, last: now.toISOString() };
    try {
      const t = nudgeText(st.n, await bonusPending(r.userId, r.chatId));
      await setSetting(key(r.userId), next);
      await sendMessage(r.chatId, t.text, { buttons: t.buttons });
      sent++;
    } catch (e) {
      // 用户把机器人删了 / 屏蔽了：以后不再发
      if (e instanceof TelegramError && e.status === 403) await setSetting(key(r.userId), { ...next, off: true }).catch(() => {});
      else console.error("[x-nudge] 提醒发送失败", e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
