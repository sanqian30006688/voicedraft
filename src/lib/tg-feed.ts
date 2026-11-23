import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { normalizeForHash } from "./import";
import { ChannelError, fetchChannel } from "./tg-channel";
import { trigramSimilarity } from "./text";
import { noteAlsoSeen } from "./hot-topics";

/**
 * 灵感池：从 TG 转发、公开频道等外部来源收进来的内容。
 * 只作为选题素材，不会进入风格样本（素材页）。
 */

export const ITEM_STATUSES = ["new", "saved", "dismissed", "used"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** 每个频道每隔多久检查一次新消息 */
export const CHANNEL_INTERVAL_MIN = 30;
/** 首次订阅时收进来的最近消息条数 */
const FIRST_FETCH = 10;
const MIN_TEXT = 10;
const MAX_TEXT = 8000;

export interface NewItem {
  kind: "tg_forward" | "tg_channel" | "tg_group" | "web" | "x_user" | "manual";
  text: string;
  url?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  sourceId?: string | null;
  /** false：不做跨来源去重（用户主动加的单个链接） */
  dedupe?: boolean;
  /** 原帖里的图片地址 */
  media?: string[];
}

const hashOf = (text: string) => createHash("sha256").update(normalizeForHash(text)).digest("hex");

/** 跨来源去重：最近这么多小时里收进来的内容都比 */
export const DEDUPE_HOURS = 72;
/** 和已有内容的字面重合度达到这个比例，算同一件事 */
export const DEDUPE_THRESHOLD = 0.6;
/** 只比开头这么多字（长文章看开头就够判断是不是同一篇） */
const DEDUPE_CHARS = 1500;

const dedupeKey = (s: string) => s.replace(/https?:\/\/\S+/g, "").slice(0, DEDUPE_CHARS);

/**
 * 跨来源去重：同一件事经常被好几个频道、网站、X 账号同时发。
 * 自动收进来的内容，和这位客户最近 72 小时从别的来源收进来的某条内容重合 60% 以上，就当作重复不收，
 * 灵感池里不会出现两遍，自动发帖也不会把同一件事发两次。用户自己手动转发、粘贴的不过滤。
 * 太短的内容（去掉标点不到 20 个字）不比，免得误伤。
 */
export async function findNearDuplicate(userId: string, text: string, sourceId: string | null = null): Promise<string | null> {
  const key = dedupeKey(text);
  if (key.replace(/[\s\p{P}\p{S}]/gu, "").length < 20) return null;
  const db = await getDb();
  const since = new Date(Date.now() - DEDUPE_HOURS * 3600_000);
  const recent = await db
    .select({ id: schema.feedItems.id, text: schema.feedItems.text })
    .from(schema.feedItems)
    .where(
      and(
        eq(schema.feedItems.userId, userId),
        sql`${schema.feedItems.createdAt} >= ${since.toISOString()}`,
        // 同一个源里的不比：同一个网站 / 频道的文章常用同一套模板，容易误判
        sourceId ? or(isNull(schema.feedItems.sourceId), ne(schema.feedItems.sourceId, sourceId)) : undefined,
      ),
    )
    .orderBy(desc(schema.feedItems.createdAt))
    .limit(500);
  for (const r of recent) {
    if (trigramSimilarity(key, dedupeKey(r.text)) >= DEDUPE_THRESHOLD) return r.id;
  }
  return null;
}

/** 收进一条，返回新条目的 id；内容重复（包括别的来源已经收过同一件事）时返回 null */
export async function addFeedItem(userId: string, item: NewItem): Promise<string | null> {
  const text = item.text.trim().slice(0, MAX_TEXT);
  if (!text) return null;
  if (item.dedupe !== false && item.kind !== "manual" && item.kind !== "tg_forward") {
    const dup = await findNearDuplicate(userId, text, item.sourceId ?? null);
    if (dup) {
      // 不重复收，但记下「这个源也在说」，用来判断热点
      await noteAlsoSeen(dup, item.sourceId ?? null, item.author ?? null).catch(() => {});
      return null;
    }
  }
  const db = await getDb();
  const rows = await db
    .insert(schema.feedItems)
    .values({
      userId,
      sourceId: item.sourceId ?? null,
      kind: item.kind,
      text,
      contentHash: hashOf(text),
      url: item.url ?? null,
      author: item.author ?? null,
      publishedAt: item.publishedAt ?? null,
      media: (item.media ?? []).slice(0, 4),
    })
    .onConflictDoNothing()
    .returning({ id: schema.feedItems.id });
  return rows[0]?.id ?? null;
}

export async function listItems(userId: string, opts: { status?: string; sourceId?: string } = {}) {
  const db = await getDb();
  const conds = [eq(schema.feedItems.userId, userId)];
  if (opts.status === "saved") conds.push(eq(schema.feedItems.status, "saved"));
  else if (opts.status === "dismissed") conds.push(eq(schema.feedItems.status, "dismissed"));
  else conds.push(ne(schema.feedItems.status, "dismissed"));
  if (opts.sourceId === "forward") conds.push(isNull(schema.feedItems.sourceId));
  else if (opts.sourceId) conds.push(eq(schema.feedItems.sourceId, opts.sourceId));
  return db
    .select({
      id: schema.feedItems.id,
      kind: schema.feedItems.kind,
      text: schema.feedItems.text,
      url: schema.feedItems.url,
      author: schema.feedItems.author,
      publishedAt: schema.feedItems.publishedAt,
      points: schema.feedItems.points,
      status: schema.feedItems.status,
      sourceId: schema.feedItems.sourceId,
      createdAt: schema.feedItems.createdAt,
    })
    .from(schema.feedItems)
    .where(and(...conds))
    .orderBy(desc(sql`coalesce(${schema.feedItems.publishedAt}, ${schema.feedItems.createdAt})`))
    .limit(200);
}

export async function getItem(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.feedItems)
    .where(and(eq(schema.feedItems.id, id), eq(schema.feedItems.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function updateItem(userId: string, id: string, patch: { status?: ItemStatus; points?: string[] }) {
  const db = await getDb();
  const rows = await db
    .update(schema.feedItems)
    .set(patch)
    .where(and(eq(schema.feedItems.id, id), eq(schema.feedItems.userId, userId)))
    .returning({ id: schema.feedItems.id });
  return rows[0]?.id ?? null;
}

// ---------- 公开频道 ----------

export async function listSources(userId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.userId, userId))
    .orderBy(schema.sources.createdAt);
}

/** 订阅一个公开频道：先读一次确认能读到，再保存，并收进最近几条 */
export async function addChannel(userId: string, handle: string) {
  const page = await fetchChannel(handle);
  const db = await getDb();
  const [row] = await db
    .insert(schema.sources)
    .values({ userId, type: "tg_channel", handle: page.handle, title: page.title })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ChannelError(`已经订阅过 @${page.handle}`);
  const added = await saveChannelPosts(userId, row.id, page.title, page.posts.slice(-FIRST_FETCH));
  await db
    .update(schema.sources)
    .set({ cursor: page.posts.at(-1)?.id ?? 0, lastFetchedAt: new Date(), error: null })
    .where(eq(schema.sources.id, row.id));
  return { id: row.id, title: page.title, added };
}

async function saveChannelPosts(
  userId: string,
  sourceId: string,
  title: string,
  posts: { text: string; url: string; publishedAt: Date | null; media?: string[] }[],
) {
  let added = 0;
  for (const p of posts) {
    if (p.text.replace(/\s/g, "").length < MIN_TEXT) continue;
    if (await addFeedItem(userId, { kind: "tg_channel", text: p.text, url: p.url, author: title, publishedAt: p.publishedAt, sourceId, media: p.media })) {
      added++;
    }
  }
  return added;
}

/** 检查一个频道的新消息 */
export async function refreshSource(userId: string, sourceId: string): Promise<number> {
  const db = await getDb();
  const [src] = await db
    .select()
    .from(schema.sources)
    .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.userId, userId)))
    .limit(1);
  if (!src) throw new ChannelError("找不到这个频道");
  if (src.type === "tg_group") return 0; // 群消息由机器人实时收，不用定时读
  if (src.type !== "tg_channel") {
    const { refreshOther } = await import("./sources");
    return refreshOther(userId, src);
  }
  try {
    const page = await fetchChannel(src.handle);
    const cursor = src.cursor ?? 0;
    const fresh = page.posts.filter((p) => p.id > cursor);
    const added = await saveChannelPosts(userId, src.id, page.title, fresh);
    await db
      .update(schema.sources)
      .set({
        title: page.title,
        cursor: Math.max(cursor, page.posts.at(-1)?.id ?? 0),
        lastFetchedAt: new Date(),
        error: null,
      })
      .where(eq(schema.sources.id, src.id));
    return added;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(schema.sources).set({ lastFetchedAt: new Date(), error: message }).where(eq(schema.sources.id, src.id));
    throw e;
  }
}

/** 定时任务：检查到点的频道 */
export async function refreshDueSources(): Promise<number> {
  const db = await getDb();
  const due = await db
    .select({ id: schema.sources.id, userId: schema.sources.userId })
    .from(schema.sources)
    .where(
      and(
        eq(schema.sources.enabled, true),
        notInArray(schema.sources.type, ["tg_group", "link"]),
        or(
          isNull(schema.sources.lastFetchedAt),
          sql`${schema.sources.lastFetchedAt} < now() - make_interval(mins => ${schema.sources.intervalMin})`,
        ),
      ),
    )
    .orderBy(sql`${schema.sources.lastFetchedAt} nulls first`)
    .limit(20);
  let n = 0;
  for (const s of due) {
    try {
      n += await refreshSource(s.userId, s.id);
    } catch (e) {
      console.error("[inspiration] 读取信息源失败", e instanceof Error ? e.message : e);
    }
  }
  return n;
}

export async function removeSource(userId: string, sourceId: string, keepItems: boolean) {
  const db = await getDb();
  if (keepItems) {
    // 保留已收进来的内容：只断开和频道的关联
    await db
      .update(schema.feedItems)
      .set({ sourceId: null })
      .where(and(eq(schema.feedItems.userId, userId), eq(schema.feedItems.sourceId, sourceId)));
  }
  await db.delete(schema.sources).where(and(eq(schema.sources.id, sourceId), eq(schema.sources.userId, userId)));
}

export async function setSourceEnabled(userId: string, sourceId: string, enabled: boolean) {
  const db = await getDb();
  await db
    .update(schema.sources)
    .set({ enabled, ...(enabled ? { lastFetchedAt: null } : {}) })
    .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.userId, userId)));
}

/** 清空「已忽略」的内容 */
export async function clearDismissed(userId: string) {
  const db = await getDb();
  await db
    .delete(schema.feedItems)
    .where(and(eq(schema.feedItems.userId, userId), inArray(schema.feedItems.status, ["dismissed"])));
}
