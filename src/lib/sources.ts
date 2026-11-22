import "server-only";
import { and, eq, isNull as eqNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { affordable, charge, InsufficientBalanceError, requireBalance } from "./billing";
import { addFeedItem } from "./tg-feed";
import { ChannelError } from "./tg-channel";
import {
  discoverFeed,
  extractArticle,
  extractLinks,
  fetchPage,
  isFeed,
  normalizeUrl,
  pageTitle,
  parseFeed,
  WebError,
} from "./web-fetch";
import { fetchUserTweets, getAccount, lookupUser, parseXHandle, XApiError } from "./x";

/**
 * 网页、RSS、论坛列表页、单个链接、X 用户主页这些信息源：
 * 定时检查新内容，收进灵感池（feed_items），自动发帖从那里取。
 * TG 公开频道在 tg-feed.ts，TG 群在 telegram.ts（机器人被拉进群后收消息）。
 */

export type SourceRow = typeof schema.sources.$inferSelect;
export type WebKind = "rss" | "web" | "link" | "x_user";

/** 各类源默认多久检查一次（分钟） */
export const DEFAULT_INTERVAL: Record<string, number> = { tg_channel: 30, rss: 30, web: 60, x_user: 60 };
/** 首次订阅收进来的条数（其中带发布时间、够新的也会拿去自动发；没有时间的只进灵感池） */
const FIRST_FETCH = 5;
/** 列表页每次最多点开几篇新文章 */
const PAGE_NEW_MAX = 5;
const SEEN_KEEP = 300;
const MIN_TEXT = 20;

export class SourceError extends Error {}

export const SOURCE_LABEL: Record<string, string> = {
  tg_channel: "TG 频道",
  tg_group: "TG 群",
  x_user: "X 主页",
  rss: "RSS",
  web: "网页 / 论坛",
  link: "单篇链接",
};

/**
 * 用户填进来的东西是什么源：
 * X 主页、TG 频道交给各自的逻辑；其余按网址处理（mode=once 时只读这一篇）
 */
export function classifyInput(input: string): { kind: "x_user"; handle: string } | { kind: "tg"; value: string } | { kind: "url"; url: string } | null {
  const s = input.trim();
  const x = parseXHandle(s);
  if (x && (/(x|twitter)\.com\//i.test(s) || s.startsWith("@"))) return { kind: "x_user", handle: x };
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i.test(s)) return { kind: "tg", value: s };
  const url = normalizeUrl(s);
  return url ? { kind: "url", url } : null;
}

const remember = (seen: string[], urls: string[]) => [...urls, ...seen.filter((u) => !urls.includes(u))].slice(0, SEEN_KEEP);

async function insertSource(userId: string, values: Partial<typeof schema.sources.$inferInsert> & { type: string; handle: string }) {
  const db = await getDb();
  const [row] = await db
    .insert(schema.sources)
    .values({ userId, intervalMin: DEFAULT_INTERVAL[values.type] ?? 60, ...values })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new SourceError("这个信息源已经加过了");
  return row;
}

async function saveEntry(
  userId: string,
  src: SourceRow,
  e: { title?: string; text: string; url?: string | null; publishedAt?: Date | null; author?: string | null; kind?: "web" | "x_user"; media?: string[] },
) {
  const body = [e.title?.trim(), e.text.trim()].filter((x, i, a) => x && !(i === 1 && a[0] && x.startsWith(a[0]))).join("\n\n");
  if (body.replace(/\s/g, "").length < MIN_TEXT) return null;
  return addFeedItem(userId, {
    kind: e.kind ?? "web",
    text: body,
    url: e.url ?? null,
    author: e.author ?? src.title ?? null,
    publishedAt: e.publishedAt ?? null,
    sourceId: src.id,
    dedupe: src.type !== "link",
    media: e.media,
  });
}

// ---------- 添加 ----------

/** 添加网址：能找到 RSS 就订阅 RSS；否则当成列表页定时看新链接；once=true 时只读这一篇 */
export async function addUrlSource(userId: string, url: string, once = false): Promise<{ id: string; type: string; title: string; added: number }> {
  const page = await fetchPage(url);
  if (once) {
    const art = isFeed(page.body, page.contentType) ? null : extractArticle(page.body);
    if (!art || art.text.length < MIN_TEXT) throw new SourceError("这个网页里没读到正文（可能需要登录，或内容是用脚本加载的）");
    const row = await insertSource(userId, {
      type: "link",
      handle: page.url,
      url,
      title: art.title || new URL(page.url).hostname,
      enabled: false,
      autoSince: new Date(0),
      lastFetchedAt: new Date(),
    });
    const id = await saveEntry(userId, row, { title: art.title, text: art.text, url: page.url, author: new URL(page.url).hostname, publishedAt: art.publishedAt });
    return { id: row.id, type: "link", title: row.title ?? "", added: id ? 1 : 0 };
  }
  let feedUrl: string | null = null;
  let feedBody: string | null = null;
  if (isFeed(page.body, page.contentType)) {
    feedUrl = page.url;
    feedBody = page.body;
  } else {
    const found = discoverFeed(page.body, page.url);
    if (found) {
      try {
        const f = await fetchPage(found);
        if (isFeed(f.body, f.contentType)) {
          feedUrl = f.url;
          feedBody = f.body;
        }
      } catch {
        // 订阅地址读不到时退回按网页处理
      }
    }
  }
  if (feedUrl && feedBody) {
    const feed = parseFeed(feedBody, feedUrl);
    const row = await insertSource(userId, { type: "rss", handle: feedUrl, url, title: feed.title || pageTitle(page.body) || new URL(url).hostname });
    let added = 0;
    for (const e of feed.entries.slice(0, FIRST_FETCH)) if (await saveEntry(userId, row, { ...e, url: e.link })) added++;
    await finish(row.id, { seen: remember([], feed.entries.map((e) => e.link).filter(Boolean)) });
    return { id: row.id, type: "rss", title: row.title ?? "", added };
  }
  const links = extractLinks(page.body, page.url);
  if (links.length < 3) {
    throw new SourceError("这个页面上没找到文章列表。如果只是想用这一篇，请选「只用这一篇」；如果是论坛，请填版块列表页的网址。");
  }
  const row = await insertSource(userId, { type: "web", handle: page.url, url, title: pageTitle(page.body) || new URL(url).hostname });
  // 首次：最上面几篇读进灵感池，其余记为已见过
  const added = await readArticles(userId, row, links.slice(0, 3));
  await finish(row.id, { seen: remember([], links.map((l) => l.url)) });
  return { id: row.id, type: "web", title: row.title ?? "", added };
}

/** 添加 X 用户主页：要先连接 X；读推文按价目表扣费 */
export async function addXUser(userId: string, handle: string): Promise<{ id: string; type: string; title: string; added: number }> {
  const acc = await getAccount(userId);
  if (!acc) throw new SourceError("读取 X 主页要用你自己连接的 X 账号，请先到「发布」页连接 X");
  if (acc.authError) throw new SourceError("X 授权已失效，请到「发布」页重新连接");
  // 查账号本身 X 也要收一次费：先看余额，低于停用线的不查
  await requireBalance(userId, { source_read: 1 });
  const user = await lookupUser(acc, handle);
  if (user.id === acc.xUserId) throw new SourceError("这是你自己的账号，不能当信息源");
  const row = await insertSource(userId, { type: "x_user", handle: user.username, url: user.id, title: `${user.name} (@${user.username})` });
  const added = await readXUser(userId, row);
  return { id: row.id, type: "x_user", title: row.title ?? "", added };
}

async function finish(sourceId: string, patch: Partial<typeof schema.sources.$inferInsert> = {}) {
  const db = await getDb();
  const now = new Date();
  await db
    .update(schema.sources)
    .set({ lastFetchedAt: now, error: null, ...patch })
    .where(eq(schema.sources.id, sourceId));
  // 第一次读完才开始算「之后的新内容」，订阅时已有的旧内容不自动发。
  // 用数据库的时间：收进来的内容 createdAt 也是数据库时间，用程序的时间会因为时钟差或同一毫秒而把旧内容算成新的
  await db
    .update(schema.sources)
    .set({ autoSince: sql`now()` })
    .where(and(eq(schema.sources.id, sourceId), eqNull(schema.sources.autoSince)));
}

async function readArticles(userId: string, src: SourceRow, links: { url: string; title: string }[]) {
  let added = 0;
  for (const l of links) {
    try {
      const p = await fetchPage(l.url);
      const art = extractArticle(p.body);
      const text = art.text.length >= MIN_TEXT ? art.text : "";
      if (!text) continue;
      if (await saveEntry(userId, src, { title: art.title || l.title, text, url: p.url, publishedAt: art.publishedAt })) added++;
    } catch (e) {
      // 单篇读不到（robots 不让读、404）就跳过，不影响整个源
      if (!(e instanceof WebError)) throw e;
    }
  }
  return added;
}

async function readXUser(userId: string, src: SourceRow): Promise<number> {
  const acc = await getAccount(userId);
  if (!acc) throw new SourceError("X 账号已断开，请到「发布」页重新连接");
  if (!src.url) throw new SourceError("这个 X 主页的信息不完整，请删掉重新添加");
  // 先看余额（含停用线）再去 X 读：余额不够就一条都不读
  try {
    await requireBalance(userId, { source_read: 1 });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) throw new SourceError("余额不够了，充值后会继续读取这个 X 主页");
    throw e;
  }
  const tweets = await fetchUserTweets(acc, src.url, src.sinceId, Math.min(20, await affordable(userId, "source_read")));
  if (tweets.length) await charge(userId, "source_read", tweets.length, src.id, `读取 @${src.handle}`);
  let added = 0;
  for (const t of [...tweets].reverse()) {
    if (
      await saveEntry(userId, src, {
        kind: "x_user",
        text: t.text,
        url: `https://x.com/${t.authorHandle}/status/${t.id}`,
        author: `@${src.handle}`,
        publishedAt: t.createdAt,
        media: t.media,
      })
    ) {
      added++;
    }
  }
  await finish(src.id, tweets.length ? { sinceId: tweets[0].id } : {});
  return added;
}

// ---------- 定时检查 ----------

/** 检查一个网页类 / X 主页源的新内容，返回新收进来的条数 */
export async function refreshOther(userId: string, src: SourceRow): Promise<number> {
  const db = await getDb();
  try {
    if (src.type === "x_user") return await readXUser(userId, src);
    if (src.type === "link") {
      await finish(src.id);
      return 0;
    }
    const page = await fetchPage(src.handle);
    if (src.type === "rss") {
      const feed = parseFeed(page.body, page.url);
      const fresh = feed.entries.filter((e) => e.link && !src.seen.includes(e.link)).slice(0, 10);
      let added = 0;
      for (const e of fresh.reverse()) if (await saveEntry(userId, src, { ...e, url: e.link })) added++;
      await finish(src.id, { seen: remember(src.seen, feed.entries.map((e) => e.link).filter(Boolean)) });
      return added;
    }
    const links = extractLinks(page.body, page.url);
    const fresh = links.filter((l) => !src.seen.includes(l.url)).slice(0, PAGE_NEW_MAX);
    const added = await readArticles(userId, src, fresh);
    await finish(src.id, { seen: remember(src.seen, links.map((l) => l.url)) });
    return added;
  } catch (e) {
    const message =
      e instanceof WebError || e instanceof SourceError || e instanceof ChannelError || e instanceof XApiError
        ? e.message
        : "读取失败，稍后会自动重试";
    if (!(e instanceof WebError || e instanceof SourceError || e instanceof XApiError)) console.error("[sources]", e);
    await db.update(schema.sources).set({ lastFetchedAt: new Date(), error: message }).where(eq(schema.sources.id, src.id));
    throw e instanceof Error ? e : new Error(message);
  }
}

/** 网页、RSS、X 主页之类加进来时报的错，转成给用户看的话 */
export function sourceErrorText(e: unknown): string | null {
  if (e instanceof WebError || e instanceof SourceError || e instanceof ChannelError || e instanceof XApiError) return e.message;
  return null;
}

export async function setSourceAutopilot(userId: string, sourceId: string, autopilot: boolean) {
  const db = await getDb();
  await db
    .update(schema.sources)
    .set({ autopilot })
    .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.userId, userId)));
}

export async function setSourceInterval(userId: string, sourceId: string, intervalMin: number) {
  const db = await getDb();
  await db
    .update(schema.sources)
    .set({ intervalMin: Math.max(15, Math.min(24 * 60, Math.round(intervalMin))) })
    .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.userId, userId)));
}

/** 网页和机器人共用：按输入加一个信息源。mode=once 时网址只读这一篇 */
export async function addAnySource(userId: string, input: string, mode: "follow" | "once" = "follow") {
  const c = classifyInput(input);
  if (!c) throw new SourceError("没认出来。可以填网址、RSS 地址、论坛版块地址、x.com/用户名，或 t.me/频道名");
  if (c.kind === "x_user") return addXUser(userId, c.handle);
  if (c.kind === "tg") {
    const { parseChannelHandle } = await import("./tg-channel");
    const { addChannel } = await import("./tg-feed");
    const handle = parseChannelHandle(c.value);
    if (!handle) throw new SourceError("只能订阅公开频道（t.me/频道名）。TG 群请把机器人拉进群里，会自动加为信息源。");
    const r = await addChannel(userId, handle);
    return { id: r.id, type: "tg_channel", title: r.title, added: r.added };
  }
  return addUrlSource(userId, c.url, mode === "once");
}
