import "server-only";
import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { costMinus, getConfig, InsufficientBalanceError, postsCost, refund, requireBalance, reserve } from "./billing";
import { fitsPost } from "./text";
import { createPost, deletePost, getAccount, hasScope, uploadMedia, XApiError } from "./x";

/** 一个串推最多几条 */
export const MAX_THREAD = 25;
/** 「发布中」超过这么久还没结束，视为中断 */
const STALE_MS = 10 * 60_000;

export type PostRow = typeof schema.posts.$inferSelect;

export class PublishError extends Error {}

/** long=true：X 会员，一条可以超过 280 */
export function validateTweets(tweets: string[], long = false): string[] {
  const list = tweets.map((t) => t.trim());
  if (!list.length || list.some((t) => !t)) throw new PublishError("有空的推文，请先补上内容");
  if (list.length > MAX_THREAD) throw new PublishError(`串推最多 ${MAX_THREAD} 条`);
  const over = list.findIndex((t) => !fitsPost(t, long));
  if (over >= 0) {
    throw new PublishError(list.length > 1 ? `第 ${over + 1} 条超过 280 加权字数` : "超过 280 加权字数");
  }
  return list;
}

async function setDraftStatus(userId: string, draftId: string | null, status: string) {
  if (!draftId) return;
  const db = await getDb();
  await db
    .update(schema.drafts)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)));
}

export const MEDIA_SCOPE_MESSAGE = "要发带图的帖子，需要重新连接一次 X（新加了「上传图片」的权限），连好后再发。";

/** 新建发布任务。scheduledAt 为空时立即发布并返回结果。imageId 是配图，挂在第一条上 */
export async function createJob(
  userId: string,
  input: { tweets: string[]; draftId?: string | null; scheduledAt?: Date | null; quoteTweetId?: string | null; imageId?: string | null },
): Promise<PostRow> {
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("还没有连接 X 账号");
  const tweets = validateTweets(input.tweets, acc.premium === true);
  if (acc.authError) throw new PublishError("X 授权已失效，请到「发布」页重新连接");
  const db = await getDb();
  let imageId = input.imageId ?? null;
  if (imageId) {
    // 只能用自己的图
    const [img] = await db
      .select({ id: schema.images.id })
      .from(schema.images)
      .where(and(eq(schema.images.id, imageId), eq(schema.images.userId, userId)))
      .limit(1);
    if (!img) throw new PublishError("找不到这张配图，请重新配一张");
    if (!hasScope(acc, "media.write")) throw new PublishError(MEDIA_SCOPE_MESSAGE);
    imageId = img.id;
  }
  let draftId = input.draftId ?? null;
  if (draftId) {
    const [d] = await db
      .select({ id: schema.drafts.id })
      .from(schema.drafts)
      .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)))
      .limit(1);
    draftId = d?.id ?? null;
  }
  const scheduled = input.scheduledAt ?? null;
  if (scheduled && scheduled.getTime() < Date.now() - 60_000) throw new PublishError("定时时间已经过去了");
  // 发帖费：单条按条收（带链接的另算），串推按整串收。定时帖到点发出时会再检查一次余额。
  await requireBalance(userId, postsCost(tweets, tweets.length, (await getConfig()).threadIncluded));
  const [row] = await db
    .insert(schema.posts)
    .values({
      userId,
      draftId,
      tweets,
      status: scheduled ? "scheduled" : "publishing",
      scheduledAt: scheduled,
      quoteTweetId: input.quoteTweetId ?? null,
      imageId,
      handle: acc.handle,
      xUserId: acc.xUserId,
      attempts: scheduled ? 0 : 1,
    })
    .returning();
  if (scheduled) {
    await setDraftStatus(userId, draftId, "scheduled");
    return row;
  }
  return runJob(row);
}

/** 逐条发出；串推中途失败时记下已发出的部分，重试从断点继续 */
async function runJob(job: PostRow): Promise<PostRow> {
  const db = await getDb();
  const acc = await getAccount(job.userId);
  const ids = [...job.postIds];
  const update = async (values: Partial<typeof schema.posts.$inferInsert>) => {
    const [row] = await db
      .update(schema.posts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.posts.id, job.id))
      .returning();
    return row;
  };
  if (!acc) return update({ status: "failed", error: "X 账号已断开，请重新连接后重试" });
  if (job.xUserId && acc.xUserId !== job.xUserId) {
    await setDraftStatus(job.userId, job.draftId, "draft");
    return update({
      status: "failed",
      error: `排期时用的是 @${job.handle ?? "原账号"}，现在连接的是 @${acc.handle}，为免发错账号已停止。确认无误后可重新排期。`,
    });
  }
  // 先把这次要发的钱扣下来（同一个人同时发很多条也不会扣成负数），没发出的最后退回。
  // 串推中途失败后重试：之前发出的部分已经收过了，这次只收差额
  const included = (await getConfig()).threadIncluded;
  const full = postsCost(job.tweets, job.tweets.length, included);
  const owed = (sent: number) => costMinus(full, postsCost(job.tweets, sent, included));
  let hold;
  try {
    hold = await reserve(job.userId, owed(ids.length), job.id);
  } catch (e) {
    if (!(e instanceof InsufficientBalanceError)) throw e;
    await setDraftStatus(job.userId, job.draftId, "draft");
    return update({ status: "failed", error: `${e.message}充值后点「重试」即可。` });
  }
  try {
    // 配图挂在第一条上：第一条还没发出时先把图传上去
    let mediaIds: string[] | undefined;
    if (job.imageId && ids.length === 0) {
      if (!hasScope(acc, "media.write")) throw new XApiError(MEDIA_SCOPE_MESSAGE, "forbidden", 403);
      const [img] = await db
        .select({ data: schema.images.data, mime: schema.images.mime })
        .from(schema.images)
        .where(and(eq(schema.images.id, job.imageId), eq(schema.images.userId, job.userId)))
        .limit(1);
      if (!img) throw new XApiError("配图找不到了（可能已过期清理），请重新配一张再发", "not_found", 404);
      mediaIds = [await uploadMedia(acc, img.data, img.mime)];
    }
    for (let i = ids.length; i < job.tweets.length; i++) {
      const id = await createPost(
        acc,
        job.tweets[i],
        i > 0 ? ids[i - 1] : undefined,
        i === 0 ? (job.quoteTweetId ?? undefined) : undefined,
        i === 0 ? mediaIds : undefined,
      );
      ids.push(id);
      await update({ postIds: ids });
    }
    await setDraftStatus(job.userId, job.draftId, "published");
    return update({ status: "published", postIds: ids, publishedAt: new Date(), handle: acc.handle, error: null });
  } catch (e) {
    // 没发出的部分退回（按发出了几条重新算该收多少）
    await refund(hold, owed(ids.length));
    const msg = e instanceof XApiError ? e.message : "发布失败，请稍后重试";
    if (!(e instanceof XApiError)) console.error(e);
    const partial =
      ids.length > 0 ? `已发出前 ${ids.length} 条，第 ${ids.length + 1} 条失败：${msg}。重试会从第 ${ids.length + 1} 条继续。` : msg;
    // 定时任务遇到限流：按 X 给的恢复时间顺延，不算失败
    if (e instanceof XApiError && e.kind === "rate_limit" && e.resetAt && job.scheduledAt) {
      return update({
        status: "scheduled",
        scheduledAt: new Date(e.resetAt.getTime() + 30_000),
        postIds: ids,
        error: `${partial}已自动顺延。`,
      });
    }
    await setDraftStatus(job.userId, job.draftId, "draft");
    return update({ status: "failed", postIds: ids, error: partial });
  }
}

/** 定时任务：发出所有到点的帖子，返回每条的结果 */
export async function runDuePosts(): Promise<PostRow[]> {
  const db = await getDb();
  const now = new Date();
  await db
    .update(schema.posts)
    .set({
      status: "failed",
      error: "发布过程被中断（应用可能重启了）。请先到 X 上确认是否已经发出，再决定是否重试。",
      updatedAt: now,
    })
    .where(and(eq(schema.posts.status, "publishing"), lt(schema.posts.updatedAt, new Date(now.getTime() - STALE_MS))));
  // 先把到点的任务改成「发布中」，同一任务不会被发两次
  const due = await db
    .update(schema.posts)
    .set({ status: "publishing", updatedAt: now })
    .where(and(eq(schema.posts.status, "scheduled"), lte(schema.posts.scheduledAt, now)))
    .returning();
  const results: PostRow[] = [];
  for (const job of due) {
    await db
      .update(schema.posts)
      .set({ attempts: job.attempts + 1 })
      .where(eq(schema.posts.id, job.id));
    results.push(await runJob(job));
  }
  return results;
}

async function ownJob(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.id, id), eq(schema.posts.userId, userId)))
    .limit(1);
  if (!row) throw new PublishError("找不到这条发布记录");
  return row;
}

/** 失败后重试（串推从断点继续） */
export async function retryJob(userId: string, id: string) {
  await ownJob(userId, id);
  const db = await getDb();
  const [claimed] = await db
    .update(schema.posts)
    .set({ status: "publishing", error: null, updatedAt: new Date() })
    .where(and(eq(schema.posts.id, id), eq(schema.posts.status, "failed")))
    .returning();
  if (!claimed) throw new PublishError("只有失败的任务可以重试");
  await db.update(schema.posts).set({ attempts: claimed.attempts + 1 }).where(eq(schema.posts.id, id));
  return runJob(claimed);
}

/** 取消定时，或修改定时时间 / 内容 */
export async function updateScheduled(
  userId: string,
  id: string,
  change: { cancel?: boolean; scheduledAt?: Date; tweets?: string[] },
) {
  const job = await ownJob(userId, id);
  const db = await getDb();
  if (change.cancel) {
    const rows = await db
      .update(schema.posts)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(and(eq(schema.posts.id, id), inArray(schema.posts.status, ["scheduled", "paused", "failed"])))
      .returning();
    if (!rows.length) throw new PublishError("这条已经发出或正在发布，不能取消");
    await setDraftStatus(job.userId, job.draftId, "draft");
    return rows[0];
  }
  if (job.postIds.length && change.tweets) throw new PublishError("串推已发出一部分，不能再改内容");
  if (change.scheduledAt && change.scheduledAt.getTime() < Date.now() - 60_000) {
    throw new PublishError("定时时间已经过去了");
  }
  const rows = await db
    .update(schema.posts)
    .set({
      ...(change.scheduledAt ? { scheduledAt: change.scheduledAt } : {}),
      ...(change.tweets ? { tweets: validateTweets(change.tweets) } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.posts.id, id), eq(schema.posts.status, "scheduled")))
    .returning();
  if (!rows.length) throw new PublishError("只有还没发出的定时任务可以修改");
  return rows[0];
}

/** 从 X 上删除已发出的推文（串推从最后一条往前删） */
export async function deleteFromX(userId: string, id: string) {
  const job = await ownJob(userId, id);
  if (!job.postIds.length) throw new PublishError("这条还没有发出");
  const acc = await getAccount(userId);
  if (!acc) throw new PublishError("X 账号已断开，请重新连接后再删除");
  const ids = [...job.postIds];
  const db = await getDb();
  while (ids.length) {
    await deletePost(acc, ids[ids.length - 1]);
    ids.pop();
    await db.update(schema.posts).set({ postIds: ids, updatedAt: new Date() }).where(eq(schema.posts.id, id));
  }
  const [row] = await db
    .update(schema.posts)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(schema.posts.id, id))
    .returning();
  await setDraftStatus(job.userId, job.draftId, "draft");
  return row;
}

// ---------- 一键管理所有还没发的定时帖 ----------

export type BulkAction = "pause" | "resume" | "cancel" | "delay";

/** 还没发出的定时帖：排着的、暂停的各几条，最早一条什么时候 */
export async function queueSummary(userId: string) {
  const db = await getDb();
  const rows = await db
    .select({ status: schema.posts.status, at: schema.posts.scheduledAt })
    .from(schema.posts)
    .where(and(eq(schema.posts.userId, userId), inArray(schema.posts.status, ["scheduled", "paused"])));
  const times = rows.filter((r) => r.status === "scheduled" && r.at).map((r) => new Date(r.at!).getTime());
  return {
    scheduled: rows.filter((r) => r.status === "scheduled").length,
    paused: rows.filter((r) => r.status === "paused").length,
    next: times.length ? new Date(Math.min(...times)) : null,
  };
}

/**
 * 一次处理本人所有还没发的定时帖：
 * - pause：全部暂停（到点也不发），时间保留；
 * - resume：全部恢复，已经过点的整体往后挪，第一条在 2 分钟后，彼此间隔不变；
 * - delay：排着的和暂停的都往后推 minutes 分钟；
 * - cancel：全部取消（发帖费本来就是发出时才扣，取消不扣钱）。
 * 返回处理了几条。
 */
export async function bulkSchedule(userId: string, action: BulkAction, minutes = 0): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const mine = eq(schema.posts.userId, userId);
  if (action === "pause") {
    const rows = await db
      .update(schema.posts)
      .set({ status: "paused", updatedAt: now })
      .where(and(mine, eq(schema.posts.status, "scheduled")))
      .returning({ id: schema.posts.id });
    return rows.length;
  }
  if (action === "cancel") {
    const rows = await db
      .update(schema.posts)
      .set({ status: "canceled", updatedAt: now })
      .where(and(mine, inArray(schema.posts.status, ["scheduled", "paused"])))
      .returning({ draftId: schema.posts.draftId });
    for (const r of rows) await setDraftStatus(userId, r.draftId, "draft");
    return rows.length;
  }
  const statuses = action === "resume" ? ["paused"] : ["scheduled", "paused"];
  const rows = await db
    .select({ id: schema.posts.id, at: schema.posts.scheduledAt, status: schema.posts.status })
    .from(schema.posts)
    .where(and(mine, inArray(schema.posts.status, statuses)))
    .orderBy(asc(schema.posts.scheduledAt));
  if (!rows.length) return 0;
  let shift = action === "delay" ? Math.max(0, Math.round(minutes)) * 60_000 : 0;
  if (action === "resume") {
    const first = rows[0].at ? new Date(rows[0].at).getTime() : now.getTime();
    const start = now.getTime() + 2 * 60_000;
    shift = Math.max(0, start - first);
  }
  for (const r of rows) {
    const base = r.at ? new Date(r.at).getTime() : now.getTime();
    await db
      .update(schema.posts)
      .set({
        scheduledAt: new Date(base + shift),
        ...(action === "resume" ? { status: "scheduled" } : {}),
        updatedAt: now,
      })
      .where(and(eq(schema.posts.id, r.id), mine, eq(schema.posts.status, r.status)));
  }
  return rows.length;
}
