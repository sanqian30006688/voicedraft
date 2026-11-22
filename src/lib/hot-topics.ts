import "server-only";
import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { HOT_WINDOW_HOURS, hotClusters, type HotCluster } from "./hot-topics-core";
import { sendMessage, type Keyboard } from "./tg-api";

/**
 * 热点提醒：好几个信息源（频道、网站、X 主页…）同时在说同一件事时，推到 TG：「现在可以写这个」。
 * 只看客户自己订阅的信息源收进来的内容，纯代码判断，不调 AI、不收费；点「用它起草」才按正常价格扣。
 */

export interface HotSettings {
  enabled: boolean;
  /** 几个不同的信息源在说才算热点 */
  minSources: number;
  /** 每 24 小时最多推几条 */
  dailyCap: number;
}

export const HOT_DEFAULTS: HotSettings = { enabled: true, minSources: 3, dailyCap: 3 };
export const MIN_SOURCE_CHOICES = [2, 3, 4, 5] as const;
export const CAP_CHOICES = [1, 3, 5] as const;

/** 两轮之间至少隔多久 */
const EVERY_MS = 10 * 60_000;
const g = globalThis as unknown as { __vdHotAt?: number };

export async function getHotSettings(userId: string): Promise<HotSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.hotTopicSettings).where(eq(schema.hotTopicSettings.userId, userId)).limit(1);
  return row ? { enabled: row.enabled, minSources: row.minSources, dailyCap: row.dailyCap } : { ...HOT_DEFAULTS };
}

export async function saveHotSettings(userId: string, patch: Partial<HotSettings>): Promise<HotSettings> {
  const cur = await getHotSettings(userId);
  const next: HotSettings = {
    enabled: patch.enabled ?? cur.enabled,
    minSources: patch.minSources !== undefined && (MIN_SOURCE_CHOICES as readonly number[]).includes(patch.minSources) ? patch.minSources : cur.minSources,
    dailyCap: patch.dailyCap !== undefined && (CAP_CHOICES as readonly number[]).includes(patch.dailyCap) ? patch.dailyCap : cur.dailyCap,
  };
  const db = await getDb();
  await db
    .insert(schema.hotTopicSettings)
    .values({ userId, ...next })
    .onConflictDoUpdate({ target: schema.hotTopicSettings.userId, set: { ...next, updatedAt: new Date() } });
  return next;
}

/** 跨来源去重时，没收进来的那条是哪个信息源发的：记在已有的那条上（同一个源只记一次） */
export async function noteAlsoSeen(itemId: string, sourceId: string | null, author: string | null) {
  if (!sourceId) return;
  const db = await getDb();
  const entry = JSON.stringify([{ sourceId, author }]);
  await db
    .update(schema.feedItems)
    .set({ alsoSeen: sql`${schema.feedItems.alsoSeen} || ${entry}::jsonb` })
    .where(
      and(
        eq(schema.feedItems.id, itemId),
        sql`coalesce(${schema.feedItems.sourceId}::text, '') <> ${sourceId}`,
        sql`not (${schema.feedItems.alsoSeen} @> ${JSON.stringify([{ sourceId }])}::jsonb)`,
      ),
    );
}

/** 这位客户现在够热、还没推过的话题 */
export async function findHot(userId: string, minSources: number, now = new Date()): Promise<HotCluster[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.feedItems.id,
      sourceId: schema.feedItems.sourceId,
      text: schema.feedItems.text,
      createdAt: schema.feedItems.createdAt,
      alsoSeen: schema.feedItems.alsoSeen,
      hotAt: schema.feedItems.hotAt,
    })
    .from(schema.feedItems)
    .where(
      and(
        eq(schema.feedItems.userId, userId),
        isNotNull(schema.feedItems.sourceId),
        gte(schema.feedItems.createdAt, new Date(now.getTime() - HOT_WINDOW_HOURS * 3600_000)),
      ),
    )
    .limit(400);
  // 忽略掉的那条不推，但别的源说同一件事的照样算数
  const dismissed = new Set(
    (
      await db
        .select({ id: schema.feedItems.id })
        .from(schema.feedItems)
        .where(and(eq(schema.feedItems.userId, userId), eq(schema.feedItems.status, "dismissed"), gte(schema.feedItems.createdAt, new Date(now.getTime() - HOT_WINDOW_HOURS * 3600_000))))
    ).map((r) => r.id),
  );
  return hotClusters(rows, minSources).filter((c) => !c.members.some((m) => dismissed.has(m.id)));
}

/** 过去 24 小时推过几条 */
async function sentToday(userId: string, now: Date): Promise<number> {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.feedItems)
    .where(and(eq(schema.feedItems.userId, userId), isNotNull(schema.feedItems.hotSources), gte(schema.feedItems.hotAt, new Date(now.getTime() - 86400_000))));
  return n;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function hotCard(userId: string, c: HotCluster): Promise<{ text: string; buttons: Keyboard }> {
  const db = await getDb();
  const names = c.sourceIds.length
    ? (
        await db
          .select({ id: schema.sources.id, title: schema.sources.title, handle: schema.sources.handle })
          .from(schema.sources)
          .where(and(eq(schema.sources.userId, userId), inArray(schema.sources.id, c.sourceIds)))
      ).map((s) => s.title || s.handle)
    : [];
  const shown = names.slice(0, 4).join("、") + (names.length > 4 ? ` 等 ${names.length} 个` : "");
  const lines = [`🔥 热点：${c.sources} 个信息源都在说这件事`];
  if (shown) lines.push(`来源：${shown}`);
  lines.push("", clip(c.lead.text.trim(), 500), "", "趁热写一条？");
  return {
    text: lines.join("\n"),
    buttons: [
      [
        { text: "✍️ 用它起草", callback_data: `iw:${c.lead.id}` },
        { text: "🔍 提炼要点", callback_data: `ip:${c.lead.id}` },
      ],
      [
        { text: "🙈 不感兴趣", callback_data: `ix:${c.lead.id}` },
        { text: "⚙️ 提醒设置", callback_data: "ht" },
      ],
    ],
  };
}

/** 把这个话题标为已推过（整组都标，后面再来的同一件事也不会再推） */
async function markSent(c: HotCluster, now: Date) {
  const db = await getDb();
  await db
    .update(schema.feedItems)
    .set({ hotAt: now })
    .where(inArray(schema.feedItems.id, c.members.map((m) => m.id)));
  await db.update(schema.feedItems).set({ hotSources: c.sources }).where(eq(schema.feedItems.id, c.lead.id));
}

/** 定时任务：给开着热点提醒、绑了 TG 的客户检查一遍。返回推了几条 */
export async function runHotTopics(now = new Date(), force = false): Promise<number> {
  if (!force && g.__vdHotAt && now.getTime() - g.__vdHotAt < EVERY_MS) return 0;
  g.__vdHotAt = now.getTime();
  const db = await getDb();
  // 最近有新内容进来、并且至少有 2 个信息源的客户
  const users = await db
    .select({ userId: schema.feedItems.userId, chatId: schema.tgBindings.chatId })
    .from(schema.feedItems)
    .innerJoin(schema.tgBindings, eq(schema.tgBindings.userId, schema.feedItems.userId))
    .where(
      and(
        isNotNull(schema.feedItems.sourceId),
        ne(schema.feedItems.status, "dismissed"),
        gte(schema.feedItems.createdAt, new Date(now.getTime() - HOT_WINDOW_HOURS * 3600_000)),
        sql`(select count(*) from ${schema.sources} s where s.user_id = ${schema.feedItems.userId}) >= 2`,
      ),
    )
    .groupBy(schema.feedItems.userId, schema.tgBindings.chatId);
  let sent = 0;
  for (const { userId, chatId } of users) {
    if (!chatId) continue;
    try {
      const s = await getHotSettings(userId);
      if (!s.enabled) continue;
      let room = s.dailyCap - (await sentToday(userId, now));
      if (room <= 0) continue;
      for (const c of await findHot(userId, s.minSources, now)) {
        if (room <= 0) break;
        // 先标记再推：推送失败也不会每 10 分钟重复推
        await markSent(c, now);
        const card = await hotCard(userId, c);
        await sendMessage(chatId, card.text, { buttons: card.buttons }).catch(() => {});
        room--;
        sent++;
      }
    } catch (e) {
      console.error("[hot-topics]", e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
