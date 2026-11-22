import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { adminUserIds, getSetting, setSetting, deleteSetting } from "./billing";
import { CHANGELOG, type ChangelogEntry } from "./changelog";
import { DEFAULT_TZ, localDayHour, validTz } from "./daily-report";
import { editMessage, sendMessage, TelegramError, type Keyboard } from "./tg-api";

/**
 * 功能更新和公告：通过机器人群发给所有绑定了 TG 的用户。
 *
 * 两种来源：
 * - 自动：src/lib/changelog.ts 里新加的更新记录，上线后自动合成一份「功能更新」草稿。
 *   默认（review）发到管理员的 TG，点「发给所有用户」才群发；auto 模式下等 30 分钟（期间上线的更新合并成一条）自动发；off 不起草。
 * - 手动：管理员在网页后台或机器人里（/notice）写好发出。
 *
 * 不打扰用户：
 * - 只在用户当地 9 点到 22 点之间送达（紧急公告除外），晚上排着等第二天
 * - 每条都带「🔕 不再接收」；也能在「☰ 更多 → 🔔 更新通知」里开关
 * - 用户停用了机器人（403）记为 blocked，不重试
 * - 按 Telegram 的群发限制分批：每轮最多 300 条、每条间隔 40ms（约 25 条 / 秒），碰到 429 就停下等它说的秒数
 */

export type AnnounceMode = "review" | "auto" | "off";
export interface AnnounceConfig {
  mode: AnnounceMode;
  /** auto 模式：最后一条更新上线后等多少分钟再发（期间的更新合并成一条） */
  delayMin: number;
}
export const DEFAULT_ANNOUNCE: AnnounceConfig = { mode: "review", delayMin: 30 };
const CONFIG_KEY = "announce_config";
const SEEN_KEY = "changelog_seen";
const optKey = (userId: string) => `annoff:${userId}`;

const SEND_FROM_HOUR = 9;
const SEND_TO_HOUR = 22;
const PER_RUN = 300;
const GAP_MS = 40;
/** 发了 3 天还没送到的（一直没到白天、或一直失败）就不发了 */
const GIVE_UP_MS = 3 * 86400_000;
const SYNC_EVERY_MS = 5 * 60_000;

export const AUTO_HEAD = "📢 功能更新";
export const MANUAL_HEAD = "📢 平台公告";
const FOOTER = "\n\n——\n不想收到这类通知，点下面「🔕 不再接收」。";
export const OPT_OUT_BUTTONS: Keyboard = [[{ text: "🔕 不再接收", callback_data: "an:off" }]];

export class AnnounceError extends Error {}

const g = globalThis as unknown as { __vdAnnSync?: number; __vdAnnPauseUntil?: number };

export type Announcement = typeof schema.announcements.$inferSelect;

// ---------- 设置 ----------

export async function getAnnounceConfig(): Promise<AnnounceConfig> {
  return { ...DEFAULT_ANNOUNCE, ...((await getSetting<Partial<AnnounceConfig>>(CONFIG_KEY)) ?? {}) };
}

export async function saveAnnounceConfig(patch: Partial<AnnounceConfig>): Promise<AnnounceConfig> {
  const next = { ...(await getAnnounceConfig()), ...patch };
  await setSetting(CONFIG_KEY, next);
  return next;
}

/** 用户自己的开关：true = 接收（默认） */
export async function wantsAnnouncements(userId: string): Promise<boolean> {
  return !(await getSetting<boolean>(optKey(userId)));
}

export async function setWantsAnnouncements(userId: string, on: boolean) {
  if (on) await deleteSetting(optKey(userId));
  else await setSetting(optKey(userId), true);
}

// ---------- 起草 ----------

export function entrySection(e: Pick<ChangelogEntry, "title" | "text">): string {
  return `🆕 ${e.title}\n${e.text}`;
}

export function composeAuto(entries: Pick<ChangelogEntry, "title" | "text">[]): string {
  return `${AUTO_HEAD}\n\n${entries.map(entrySection).join("\n\n")}`;
}

/** 用户收到的完整文字（正文 + 末尾一句怎么关） */
export function deliveredText(body: string): string {
  return `${body.trim()}${FOOTER}`;
}

const MAX_BODY = 3500;
function cleanBody(text: string): string {
  const t = text.trim();
  if (!t) throw new AnnounceError("公告内容不能为空");
  if (t.length > MAX_BODY) throw new AnnounceError(`公告太长了（最多 ${MAX_BODY} 字）`);
  return t;
}

/**
 * 看看 changelog 里有没有还没通知过的更新；有的话并进当前的自动草稿（没有就新建一份）。
 * 第一次运行时（还没有记录）也照样起草，管理员自己决定发不发。
 */
export async function syncChangelog(entries: ChangelogEntry[] = CHANGELOG): Promise<Announcement | null> {
  const seen = new Set((await getSetting<string[]>(SEEN_KEY)) ?? []);
  const fresh = entries.filter((e) => !seen.has(e.id));
  if (!fresh.length) return null;
  await setSetting(SEEN_KEY, [...seen, ...fresh.map((e) => e.id)]);
  const cfg = await getAnnounceConfig();
  if (cfg.mode === "off") return null;
  const db = await getDb();
  const [cur] = await db
    .select()
    .from(schema.announcements)
    .where(and(eq(schema.announcements.source, "auto"), eq(schema.announcements.status, "draft")))
    .orderBy(desc(schema.announcements.createdAt))
    .limit(1);
  let ann: Announcement;
  if (cur) {
    // 管理员可能改过文字：新的更新接在后面，不覆盖
    [ann] = await db
      .update(schema.announcements)
      .set({
        body: `${cur.body.trim()}\n\n${fresh.map(entrySection).join("\n\n")}`,
        entryIds: [...cur.entryIds, ...fresh.map((e) => e.id)],
        updatedAt: new Date(),
      })
      .where(eq(schema.announcements.id, cur.id))
      .returning();
  } else {
    [ann] = await db
      .insert(schema.announcements)
      .values({ source: "auto", body: composeAuto(fresh), entryIds: fresh.map((e) => e.id) })
      .returning();
  }
  await sendReviewCards(ann, cfg);
  return ann;
}

/** 管理员手写一条（先存成草稿） */
export async function createManual(adminId: string | null, text: string, urgent = false): Promise<Announcement> {
  let body = cleanBody(text);
  if (!body.startsWith("📢")) body = `${MANUAL_HEAD}\n\n${body}`;
  const db = await getDb();
  const [ann] = await db.insert(schema.announcements).values({ source: "manual", body, urgent, createdBy: adminId }).returning();
  return ann;
}

export async function getAnnouncement(id: string): Promise<Announcement | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.announcements).where(eq(schema.announcements.id, id)).limit(1);
  return row ?? null;
}

async function mustDraft(id: string): Promise<Announcement> {
  const ann = await getAnnouncement(id);
  if (!ann) throw new AnnounceError("找不到这条公告");
  if (ann.status === "sending") throw new AnnounceError("这条已经在发了");
  if (ann.status === "sent") throw new AnnounceError("这条已经发完了");
  if (ann.status === "cancelled") throw new AnnounceError("这条已经取消了");
  return ann;
}

export async function updateBody(id: string, text: string): Promise<Announcement> {
  await mustDraft(id);
  const db = await getDb();
  const [ann] = await db
    .update(schema.announcements)
    .set({ body: cleanBody(text), updatedAt: new Date() })
    .where(eq(schema.announcements.id, id))
    .returning();
  return ann;
}

/** 开始群发（真正的发送在定时任务里分批进行） */
export async function startSending(id: string, urgent?: boolean): Promise<Announcement> {
  const cur = await mustDraft(id);
  const db = await getDb();
  const [ann] = await db
    .update(schema.announcements)
    .set({ status: "sending", urgent: urgent ?? cur.urgent, sendStartedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.announcements.id, id), eq(schema.announcements.status, "draft")))
    .returning();
  if (!ann) throw new AnnounceError("这条已经在发了");
  await markReviewCards(ann, `✅ 已开始群发${ann.urgent ? "（紧急，马上发）" : "（按用户当地 9 点到 22 点送达）"}`);
  return ann;
}

/** 不发了：草稿直接作废；发到一半的停下（已经发出去的收不回） */
export async function cancelAnnouncement(id: string): Promise<Announcement> {
  const cur = await getAnnouncement(id);
  if (!cur) throw new AnnounceError("找不到这条公告");
  if (cur.status === "sent" || cur.status === "cancelled") throw new AnnounceError(cur.status === "sent" ? "这条已经发完了" : "这条已经取消了");
  const db = await getDb();
  const [ann] = await db
    .update(schema.announcements)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.announcements.id, id))
    .returning();
  await markReviewCards(ann, cur.status === "sending" ? "⏹ 已停止群发" : "🗑 这条不发了");
  return ann;
}

// ---------- 统计 ----------

/** 现在会收到公告的人数（绑定了 TG、没关通知） */
export async function recipientCount(): Promise<number> {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.tgBindings)
    .leftJoin(schema.appSettings, sql`${schema.appSettings.key} = 'annoff:' || ${schema.tgBindings.userId}`)
    .where(and(isNotNull(schema.tgBindings.chatId), isNull(schema.appSettings.key)));
  return n;
}

export interface DeliveryStats {
  sent: number;
  blocked: number;
  failed: number;
}

export async function deliveryStats(ids: string[]): Promise<Map<string, DeliveryStats>> {
  const out = new Map<string, DeliveryStats>();
  if (!ids.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ id: schema.announcementDeliveries.announcementId, status: schema.announcementDeliveries.status, n: sql<number>`count(*)::int` })
    .from(schema.announcementDeliveries)
    .where(inArray(schema.announcementDeliveries.announcementId, ids))
    .groupBy(schema.announcementDeliveries.announcementId, schema.announcementDeliveries.status);
  for (const id of ids) out.set(id, { sent: 0, blocked: 0, failed: 0 });
  for (const r of rows) {
    const s = out.get(r.id)!;
    if (r.status === "sent" || r.status === "blocked" || r.status === "failed") s[r.status] = r.n;
  }
  return out;
}

export async function listAnnouncements(limit = 20): Promise<(Announcement & { stats: DeliveryStats })[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.announcements).orderBy(desc(schema.announcements.createdAt)).limit(limit);
  const stats = await deliveryStats(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, stats: stats.get(r.id)! }));
}

// ---------- 管理员 TG 卡片 ----------

async function adminChats(): Promise<{ userId: string; chatId: string }[]> {
  const admins = await adminUserIds();
  if (!admins.length) return [];
  const db = await getDb();
  const rows = await db
    .select({ userId: schema.tgBindings.userId, chatId: schema.tgBindings.chatId })
    .from(schema.tgBindings)
    .where(and(inArray(schema.tgBindings.userId, admins), isNotNull(schema.tgBindings.chatId)));
  return rows.filter((r): r is { userId: string; chatId: string } => !!r.chatId);
}

export async function reviewCard(ann: Announcement, cfg?: AnnounceConfig): Promise<{ text: string; buttons: Keyboard }> {
  const n = await recipientCount();
  const c = cfg ?? (await getAnnounceConfig());
  const head =
    ann.source === "auto"
      ? c.mode === "auto"
        ? `📝 根据这次上线的更新写了一条公告，${c.delayMin} 分钟后自动发给 ${n} 位用户（这期间再上线的更新会合并进来）。不想发就点「不发」。`
        : `📝 根据这次上线的更新写了一条公告，要发给 ${n} 位用户吗？`
      : `📝 公告草稿，将发给 ${n} 位用户。`;
  return {
    text: `${head}\n按用户当地时间 9 点到 22 点送达，晚上的第二天早上再收到；「现在就发」不等白天。\n\n————— 用户会看到 —————\n${deliveredText(ann.body)}`,
    buttons: [
      [
        { text: "✅ 发给所有用户", callback_data: `an:go:${ann.id}` },
        { text: "⚡ 现在就发", callback_data: `an:now:${ann.id}` },
      ],
      [
        { text: "✏️ 改文字", callback_data: `an:ed:${ann.id}` },
        { text: "🗑 不发", callback_data: `an:x:${ann.id}` },
      ],
    ],
  };
}

/** 把草稿发到每位管理员的 TG；同一条之前发过的卡片标成「已更新」 */
export async function sendReviewCards(ann: Announcement, cfg?: AnnounceConfig, only?: string) {
  const chats = (await adminChats()).filter((c) => !only || c.chatId === only);
  if (!chats.length) return;
  await markReviewCards(ann, "（内容有更新，见下面新的一条）", only);
  const card = await reviewCard(ann, cfg);
  const cards: { chatId: string; mid: number }[] = ann.reviewCards.filter((c) => only && c.chatId !== only);
  for (const c of chats) {
    try {
      const r = await sendMessage(c.chatId, card.text, { buttons: card.buttons });
      cards.push({ chatId: c.chatId, mid: r.message_id });
    } catch (e) {
      console.error("[announce] 发给管理员失败", e instanceof Error ? e.message : e);
    }
  }
  const db = await getDb();
  await db.update(schema.announcements).set({ reviewCards: cards }).where(eq(schema.announcements.id, ann.id));
}

/** 管理员卡片上的按钮换成一句状态，免得重复点 */
async function markReviewCards(ann: Announcement, note: string, only?: string) {
  for (const c of ann.reviewCards) {
    if (only && c.chatId !== only) continue;
    await editMessage(c.chatId, c.mid, `${note}\n\n${deliveredText(ann.body)}`).catch(() => {});
  }
}

// ---------- 群发 ----------

function retryAfter(e: TelegramError): number {
  const m = e.message.match(/retry after (\d+)/i);
  return m ? Number(m[1]) : 30;
}

async function finish(ann: Announcement) {
  const db = await getDb();
  const [done] = await db
    .update(schema.announcements)
    .set({ status: "sent", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.announcements.id, ann.id), eq(schema.announcements.status, "sending")))
    .returning();
  if (!done) return;
  const s = (await deliveryStats([ann.id])).get(ann.id)!;
  const first = ann.body.split("\n").find((l) => l.trim() && !l.startsWith("📢")) ?? "";
  const text =
    `📢 公告发完了：送达 ${s.sent} 人` +
    (s.blocked ? `，${s.blocked} 人停用了机器人` : "") +
    (s.failed ? `，${s.failed} 人没发成功` : "") +
    `。\n「${first.slice(0, 40)}」`;
  for (const c of await adminChats()) await sendMessage(c.chatId, text).catch(() => {});
}

/** 把 sending 状态的公告往下发一批；返回这一轮发出的条数 */
export async function deliverBatch(now = new Date(), opts: { gapMs?: number; perRun?: number } = {}): Promise<number> {
  if (g.__vdAnnPauseUntil && now.getTime() < g.__vdAnnPauseUntil) return 0;
  const gap = opts.gapMs ?? GAP_MS;
  let budget = opts.perRun ?? PER_RUN;
  const db = await getDb();
  const sending = await db
    .select()
    .from(schema.announcements)
    .where(eq(schema.announcements.status, "sending"))
    .orderBy(asc(schema.announcements.sendStartedAt));
  let sent = 0;
  for (const ann of sending) {
    if (budget <= 0) break;
    const D = schema.announcementDeliveries;
    const rows = await db
      .select({
        userId: schema.tgBindings.userId,
        chatId: schema.tgBindings.chatId,
        tz: schema.dailyReportSettings.tz,
        apTz: schema.autopilotSettings.tz,
      })
      .from(schema.tgBindings)
      .leftJoin(D, and(eq(D.announcementId, ann.id), eq(D.userId, schema.tgBindings.userId)))
      .leftJoin(schema.appSettings, sql`${schema.appSettings.key} = 'annoff:' || ${schema.tgBindings.userId}`)
      .leftJoin(schema.dailyReportSettings, eq(schema.dailyReportSettings.userId, schema.tgBindings.userId))
      .leftJoin(schema.autopilotSettings, eq(schema.autopilotSettings.userId, schema.tgBindings.userId))
      .where(and(isNotNull(schema.tgBindings.chatId), isNull(D.userId), isNull(schema.appSettings.key)))
      .orderBy(asc(schema.tgBindings.boundAt));
    if (!rows.length || (ann.sendStartedAt && now.getTime() - ann.sendStartedAt.getTime() > GIVE_UP_MS)) {
      await finish(ann);
      continue;
    }
    const text = deliveredText(ann.body);
    for (const r of rows) {
      if (budget <= 0) break;
      if (!r.chatId) continue;
      if (!ann.urgent) {
        const tz = r.tz ?? (r.apTz && validTz(r.apTz) ? r.apTz : DEFAULT_TZ);
        const { hour } = localDayHour(now, tz);
        if (hour < SEND_FROM_HOUR || hour >= SEND_TO_HOUR) continue;
      }
      budget--;
      let status = "sent";
      let error: string | null = null;
      try {
        await sendMessage(r.chatId, text, { buttons: OPT_OUT_BUTTONS });
        sent++;
      } catch (e) {
        if (e instanceof TelegramError && e.status === 429) {
          // 被 Telegram 限速：这一轮到此为止，等它说的秒数再继续（这个人下一轮再发）
          g.__vdAnnPauseUntil = now.getTime() + retryAfter(e) * 1000;
          return sent;
        }
        // 403 停用了机器人 / 400 找不到这个聊天：以后也发不到
        status = e instanceof TelegramError && (e.status === 403 || e.status === 400) ? "blocked" : "failed";
        error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      await db.insert(D).values({ announcementId: ann.id, userId: r.userId, status, error }).onConflictDoNothing();
      if (gap) await new Promise((res) => setTimeout(res, gap));
    }
    // 不在发送时段而跳过的人还在，下一轮再看；全发完了就收尾
    const [{ left }] = await db
      .select({ left: sql<number>`count(*)::int` })
      .from(schema.tgBindings)
      .leftJoin(D, and(eq(D.announcementId, ann.id), eq(D.userId, schema.tgBindings.userId)))
      .leftJoin(schema.appSettings, sql`${schema.appSettings.key} = 'annoff:' || ${schema.tgBindings.userId}`)
      .where(and(isNotNull(schema.tgBindings.chatId), isNull(D.userId), isNull(schema.appSettings.key)));
    if (!left) await finish(ann);
  }
  return sent;
}

/** auto 模式：自动草稿最后一次更新过了 delayMin 分钟就开始发 */
async function autoStart(now: Date) {
  const cfg = await getAnnounceConfig();
  if (cfg.mode !== "auto") return;
  const db = await getDb();
  const drafts = await db
    .select()
    .from(schema.announcements)
    .where(and(eq(schema.announcements.source, "auto"), eq(schema.announcements.status, "draft")));
  for (const d of drafts) {
    if (now.getTime() - d.updatedAt.getTime() >= cfg.delayMin * 60_000) await startSending(d.id).catch(() => {});
  }
}

/** 定时任务每次都调用：看看有没有新的更新记录（5 分钟一次）、到点的自动公告、接着群发 */
export async function runAnnouncements(now = new Date(), force = false): Promise<number> {
  if (force || !g.__vdAnnSync || now.getTime() - g.__vdAnnSync >= SYNC_EVERY_MS) {
    g.__vdAnnSync = now.getTime();
    await syncChangelog();
    await autoStart(now);
  }
  return deliverBatch(now);
}

/** 测试用：清掉限速暂停和同步时间 */
export function resetAnnounceTimers() {
  g.__vdAnnSync = undefined;
  g.__vdAnnPauseUntil = undefined;
}
