import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { affordable, charge, InsufficientBalanceError, postItem, refund, requireBalance, reserve, UsageLimitError, withCharge } from "./billing";
import { loadStyleCardForDrafting, recentEdits } from "./data";
import { generateReplies, GenerationError } from "./llm";
import type { PromoLink } from "./promo";
import { PublishError } from "./publish";
import { weightedLength } from "./text";
import { createPost, deletePost, fetchMentions, getAccount, XApiError, type XAccount } from "./x";

/** 每次检查最多为多少条新提及生成候选，其余的可以在页面上手动生成 */
const GENERATE_LIMIT = 10;

export type ReplyRow = typeof schema.replyItems.$inferSelect;

function matchSkipRule(acc: XAccount, handle: string, text: string): string | null {
  const h = handle.toLowerCase();
  if (acc.skipHandles.some((x) => x.replace(/^@/, "").toLowerCase() === h)) return `在不回复名单里（@${handle}）`;
  const kw = acc.skipKeywords.find((k) => k && text.toLowerCase().includes(k.toLowerCase()));
  return kw ? `含关键词「${kw}」` : null;
}

/**
 * 拉取新的提及 / 评论，进入待回复队列，并生成回复候选。
 * 只读不发：每条回复都要用户在「回复」页确认后才发出。
 */
export async function checkMentions(userId: string): Promise<{ added: number; message?: string }> {
  // 同一个人同时只拉一次（手动点「检查」和定时任务撞上时，不重复读、不重复扣）
  if (checking.has(userId)) return { added: 0, message: "正在拉取中，请稍等" };
  checking.add(userId);
  try {
    return await checkMentionsLocked(userId);
  } finally {
    checking.delete(userId);
  }
}

const checking = ((globalThis as { __vdChecking?: Set<string> }).__vdChecking ??= new Set<string>());

async function checkMentionsLocked(userId: string): Promise<{ added: number; message?: string }> {
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号");
  if (acc.authError) throw new PublishError("X 授权已失效，请重新连接");
  const db = await getDb();
  const now = new Date();
  if (acc.pausedUntil && acc.pausedUntil > now) {
    return { added: 0, message: acc.pausedReason ?? "已暂停" };
  }

  // 每读一条 @我 按价目表扣费；余额不够读一条就先不读。最多读余额够付的条数，余额不会扣成负数
  await requireBalance(userId, { mention_read: 1 });
  let fetched;
  try {
    fetched = await fetchMentions(acc, acc.mentionsSinceId, await affordable(userId, "mention_read"));
  } catch (e) {
    if (e instanceof XApiError && e.kind === "rate_limit") {
      await db
        .update(schema.xAccounts)
        .set({ pausedUntil: e.resetAt, pausedReason: e.message, lastCheckedAt: now })
        .where(eq(schema.xAccounts.id, acc.id));
      return { added: 0, message: e.message };
    }
    if (e instanceof XApiError && (e.kind === "credits" || e.kind === "forbidden")) {
      // 额度不足或没有读取权限：关掉自动拉取，避免反复失败
      await db
        .update(schema.xAccounts)
        .set({ autoReplyEnabled: false, pausedReason: e.message, lastCheckedAt: now })
        .where(eq(schema.xAccounts.id, acc.id));
    }
    throw e;
  }

  await charge(userId, "mention_read", fetched.items.length, undefined, "拉取 @我");
  let added = 0;
  for (const m of fetched.items) {
    if (m.authorId === acc.xUserId) continue; // 自己的推文
    let skipReason = matchSkipRule(acc, m.authorHandle, m.text);
    if (!skipReason && m.conversationId && acc.maxRounds > 0) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.replyItems)
        .where(
          and(
            eq(schema.replyItems.userId, userId),
            eq(schema.replyItems.conversationId, m.conversationId),
            eq(schema.replyItems.status, "sent"),
          ),
        );
      if (n >= acc.maxRounds) skipReason = `同一对话已回复 ${n} 轮`;
    }
    const rows = await db
      .insert(schema.replyItems)
      .values({
        userId,
        tweetId: m.id,
        conversationId: m.conversationId,
        authorId: m.authorId,
        authorHandle: m.authorHandle,
        authorName: m.authorName,
        text: m.text,
        inReplyToText: m.inReplyToText,
        tweetedAt: m.createdAt,
        status: skipReason ? "skipped" : "pending",
        skipReason,
      })
      .onConflictDoNothing({ target: [schema.replyItems.userId, schema.replyItems.tweetId] })
      .returning({ id: schema.replyItems.id });
    added += rows.length;
  }
  await db
    .update(schema.xAccounts)
    .set({
      mentionsSinceId: fetched.newestId ?? acc.mentionsSinceId,
      lastCheckedAt: now,
      pausedUntil: null,
      pausedReason: null,
    })
    .where(eq(schema.xAccounts.id, acc.id));

  // 为还没有候选的待回复条目生成候选
  const todo = await db
    .select()
    .from(schema.replyItems)
    .where(
      and(
        eq(schema.replyItems.userId, userId),
        eq(schema.replyItems.status, "pending"),
        sql`jsonb_array_length(${schema.replyItems.candidates}) = 0`,
      ),
    )
    .orderBy(asc(schema.replyItems.createdAt))
    .limit(GENERATE_LIMIT);
  for (const item of todo) {
    try {
      await generateFor(userId, item);
    } catch (e) {
      if (!(e instanceof GenerationError || e instanceof PublishError || e instanceof InsufficientBalanceError || e instanceof UsageLimitError)) console.error(e);
      break; // 没有风格卡或模型出错时，留给用户手动生成
    }
  }
  return { added };
}

/** 为一条提及生成（或重新生成）回复候选 */
/** promo：用户手动「换一批」时选了推广链接才带；自动拉取生成的候选不带 */
export async function generateFor(userId: string, item: ReplyRow, promo?: PromoLink | null): Promise<ReplyRow> {
  const card = await loadStyleCardForDrafting(userId, item.text);
  if (!card) throw new PublishError("还没有风格卡，请先导入素材并生成风格卡");
  const edits = await recentEdits(userId, 10);
  const out = await withCharge(
    userId,
    "reply",
    () =>
      generateReplies(
        card,
        {
          incoming: stripLeadingMentions(item.text),
          authorHandle: item.authorHandle,
          inReplyTo: item.inReplyToText,
          count: 3,
          source: item.source === "timeline" ? "timeline" : "mention",
        },
        edits,
        promo,
      ),
    item.id,
  );
  const db = await getDb();
  const [row] = await db
    .update(schema.replyItems)
    .set(
      out.skip
        ? { status: "skipped", skipReason: `AI 判断：${out.skipReason || "不建议回复"}`, updatedAt: new Date() }
        : { candidates: out.candidates.filter((c) => weightedLength(c).valid), updatedAt: new Date() },
    )
    .where(eq(schema.replyItems.id, item.id))
    .returning();
  return row;
}

/** 去掉推文开头自动带上的 @用户名，方便模型看清对方说了什么 */
function stripLeadingMentions(text: string): string {
  return text.replace(/^(\s*@\w+)+\s*/, "").trim() || text;
}

export async function ownReply(userId: string, id: string): Promise<ReplyRow> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.replyItems)
    .where(and(eq(schema.replyItems.id, id), eq(schema.replyItems.userId, userId)))
    .limit(1);
  if (!row) throw new PublishError("找不到这条提及");
  return row;
}

/** 用户确认后发出回复。original 是用户改写前选中的候选，用来记录修改偏好。 */
export async function sendReply(userId: string, id: string, text: string, original?: string): Promise<ReplyRow> {
  const reply = text.trim();
  if (!reply) throw new PublishError("回复内容是空的");
  if (!weightedLength(reply).valid) throw new PublishError("超过 280 加权字数");
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号");
  const hold = await reserve(userId, { [postItem(reply)]: 1 }, id);
  const db = await getDb();
  // 同一条只回复一次：先占住
  const [claimed] = await db
    .update(schema.replyItems)
    .set({ status: "sending", updatedAt: new Date() })
    .where(
      and(
        eq(schema.replyItems.id, id),
        eq(schema.replyItems.userId, userId),
        inArray(schema.replyItems.status, ["pending", "failed", "skipped"]),
      ),
    )
    .returning();
  if (!claimed) {
    await refund(hold);
    throw new PublishError("这条已经回复过了");
  }
  try {
    const postId = await createPost(acc, reply, claimed.tweetId);
    const [row] = await db
      .update(schema.replyItems)
      .set({ status: "sent", replyText: reply, replyPostId: postId, error: null, updatedAt: new Date() })
      .where(eq(schema.replyItems.id, id))
      .returning();
    if (original && original.trim() !== reply) {
      await db.insert(schema.editLogs).values({ userId, original: original.trim(), edited: reply });
    }
    return row;
  } catch (e) {
    await refund(hold);
    const msg = e instanceof XApiError ? e.message : "发送失败，请稍后重试";
    if (!(e instanceof XApiError)) console.error(e);
    await db
      .update(schema.replyItems)
      .set({ status: "failed", replyText: reply, error: msg, updatedAt: new Date() })
      .where(eq(schema.replyItems.id, id));
    throw new PublishError(msg);
  }
}

export async function setReplyStatus(userId: string, id: string, status: "skipped" | "pending") {
  const db = await getDb();
  const [row] = await db
    .update(schema.replyItems)
    .set({ status, skipReason: status === "skipped" ? "手动跳过" : null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.replyItems.id, id),
        eq(schema.replyItems.userId, userId),
        inArray(schema.replyItems.status, ["pending", "failed", "skipped"]),
      ),
    )
    .returning();
  if (!row) throw new PublishError("这条已经回复过了");
  return row;
}

/** 从 X 上删除已发出的回复 */
export async function deleteReply(userId: string, id: string) {
  const item = await ownReply(userId, id);
  if (item.status !== "sent" || !item.replyPostId) throw new PublishError("这条还没有回复");
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("X 账号已断开，请重新连接后再删除");
  await deletePost(acc, item.replyPostId);
  const db = await getDb();
  const [row] = await db
    .update(schema.replyItems)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(schema.replyItems.id, id))
    .returning();
  return row;
}
