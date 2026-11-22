import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { withCharge } from "./billing";
import { loadStyleCardForDrafting, recentEdits } from "./data";
import { generateQuotes } from "./llm";
import type { PromoLink } from "./promo";
import { PublishError } from "./publish";
import { weightedLength } from "./text";
import { fetchBookmarks, getAccount, hasScope, lookupTweet, parseTweetId, type XAccount, type XTweet } from "./x";

/**
 * 灵感：X 书签和用户贴链接加进来的推文。
 * 用来找选题、写引用推文；不进「素材」，不参与风格学习。
 */

export type InspirationRow = typeof schema.inspirations.$inferSelect;

export const BOOKMARK_SCOPE = "bookmark.read";

async function requireAccount(userId: string): Promise<XAccount> {
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号，请先到「发布」页连接");
  if (acc.authError) throw new PublishError("X 授权已失效，请重新连接");
  return acc;
}

async function save(userId: string, source: "x_bookmark" | "x_link", tweets: XTweet[]): Promise<number> {
  if (!tweets.length) return 0;
  const db = await getDb();
  const rows = await db
    .insert(schema.inspirations)
    .values(
      tweets.map((t) => ({
        userId,
        source,
        tweetId: t.id,
        authorId: t.authorId,
        authorHandle: t.authorHandle,
        authorName: t.authorName,
        text: t.text,
        tweetedAt: t.createdAt,
      })),
    )
    .onConflictDoNothing({ target: [schema.inspirations.userId, schema.inspirations.tweetId] })
    .returning({ id: schema.inspirations.id });
  return rows.length;
}

/** 同步书签：只读新增的部分。需要账号授权里有书签权限。 */
export async function syncBookmarks(userId: string): Promise<{ added: number }> {
  const acc = await requireAccount(userId);
  if (!hasScope(acc, BOOKMARK_SCOPE)) {
    throw new PublishError("读取书签需要多授权一项权限，请点「重新连接 X」授权一次");
  }
  const db = await getDb();
  const known = await db
    .select({ tweetId: schema.inspirations.tweetId })
    .from(schema.inspirations)
    .where(eq(schema.inspirations.userId, userId));
  const tweets = await fetchBookmarks(acc, new Set(known.map((k) => k.tweetId)));
  return { added: await save(userId, "x_bookmark", tweets) };
}

/** 贴一条推文链接，读取后加进灵感 */
export async function addByLink(userId: string, input: string): Promise<InspirationRow> {
  const tweetId = parseTweetId(input);
  if (!tweetId) throw new PublishError("没认出推文链接，请贴 x.com/用户名/status/数字 这样的链接");
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(schema.inspirations)
    .where(and(eq(schema.inspirations.userId, userId), eq(schema.inspirations.tweetId, tweetId)))
    .limit(1);
  if (existing) return existing;
  const acc = await requireAccount(userId);
  const tweet = await lookupTweet(acc, tweetId);
  await save(userId, "x_link", [tweet]);
  return ownByTweet(userId, tweetId);
}

async function ownByTweet(userId: string, tweetId: string): Promise<InspirationRow> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.inspirations)
    .where(and(eq(schema.inspirations.userId, userId), eq(schema.inspirations.tweetId, tweetId)))
    .limit(1);
  if (!row) throw new PublishError("找不到这条灵感");
  return row;
}

export async function ownInspiration(userId: string, id: string): Promise<InspirationRow> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.inspirations)
    .where(and(eq(schema.inspirations.id, id), eq(schema.inspirations.userId, userId)))
    .limit(1);
  if (!row) throw new PublishError("找不到这条灵感");
  return row;
}

/** 为一条推文生成（或重新生成）引用推文候选 */
export async function generateQuotesFor(userId: string, item: InspirationRow, promo?: PromoLink | null) {
  const card = await loadStyleCardForDrafting(userId, item.text);
  if (!card) throw new PublishError("还没有风格卡，请先导入素材并生成风格卡");
  const edits = await recentEdits(userId, 10);
  const out = await withCharge(
    userId,
    "generate",
    () => generateQuotes(card, { source: item.text, authorHandle: item.authorHandle, count: 3 }, edits, promo),
    item.id,
  );
  const db = await getDb();
  const [row] = await db
    .update(schema.inspirations)
    .set({ quoteCandidates: out.filter((c) => weightedLength(c).valid), updatedAt: new Date() })
    .where(eq(schema.inspirations.id, item.id))
    .returning();
  return row;
}

export async function setInspirationStatus(userId: string, id: string, status: "new" | "used" | "dismissed") {
  const db = await getDb();
  const [row] = await db
    .update(schema.inspirations)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(schema.inspirations.id, id), eq(schema.inspirations.userId, userId)))
    .returning();
  if (!row) throw new PublishError("找不到这条灵感");
  return row;
}

/** 引用推文发出（或排进定时）后，把对应的灵感标记为「已用」 */
export async function markQuoted(userId: string, tweetId: string) {
  const db = await getDb();
  await db
    .update(schema.inspirations)
    .set({ status: "used", updatedAt: new Date() })
    .where(
      and(
        eq(schema.inspirations.userId, userId),
        eq(schema.inspirations.tweetId, tweetId),
        inArray(schema.inspirations.status, ["new", "dismissed"]),
      ),
    );
}

export async function deleteInspiration(userId: string, id: string) {
  const db = await getDb();
  await db
    .delete(schema.inspirations)
    .where(and(eq(schema.inspirations.id, id), eq(schema.inspirations.userId, userId)));
}
