import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { InsufficientBalanceError, requireActive, UsageLimitError } from "./billing";
import { summarizeMemory } from "./llm";
import {
  cleanMemory,
  EMPTY_MEMORY,
  isEmptyMemory,
  MEMORY_READ_LIMIT,
  needsRefresh,
  RECENT_LIMIT,
  type AccountMemory,
} from "./memory-core";

/**
 * 账号记忆：从本人的推文（导入的素材 + 通过本产品发出去的帖子）里，
 * 让 AI 总结这个账号经常聊什么、坚持和反对什么、喜欢怎么说。每次生成都会带上（见 data.ts 的 loadStyleCardForDrafting）。
 *
 * - 第一次：有风格卡后，后台自动整理一次
 * - 之后：本人推文每多 10 条，后台自动再整理（不收费，算在「不单独收费的 AI 功能」里，每天有次数上限）
 * - 用户可以手动改；改过之后自动整理只增补，不删用户写的
 * - 可以关掉：关掉后生成时不带记忆
 */

export type MemoryRow = typeof schema.accountMemories.$inferSelect;

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function getMemoryRow(userId: string): Promise<MemoryRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.accountMemories).where(eq(schema.accountMemories.userId, userId)).limit(1);
  return row ?? null;
}

/** 本人推文：通过本产品发出去的帖子（最新在前）+ 导入的素材（最新在前） */
export async function ownPosts(userId: string, limit = MEMORY_READ_LIMIT): Promise<{ published: string[]; samples: string[] }> {
  const db = await getDb();
  const posts = await db
    .select({ tweets: schema.posts.tweets })
    .from(schema.posts)
    .where(and(eq(schema.posts.userId, userId), eq(schema.posts.status, "published")))
    .orderBy(desc(schema.posts.publishedAt))
    .limit(limit);
  const published = posts.map((p) => p.tweets.join("\n")).filter(Boolean);
  const samples = await db
    .select({ content: schema.samples.content })
    .from(schema.samples)
    .where(and(eq(schema.samples.userId, userId), eq(schema.samples.excluded, false)))
    .orderBy(desc(sql`coalesce(${schema.samples.postedAt}, ${schema.samples.createdAt})`))
    .limit(Math.max(0, limit - published.length));
  return { published, samples: samples.map((s) => s.content) };
}

/** 本人推文一共多少条（用来判断要不要再整理） */
export async function ownPostCount(userId: string): Promise<number> {
  const db = await getDb();
  const [{ a }] = await db
    .select({ a: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(and(eq(schema.posts.userId, userId), eq(schema.posts.status, "published")));
  const [{ b }] = await db
    .select({ b: sql<number>`count(*)::int` })
    .from(schema.samples)
    .where(and(eq(schema.samples.userId, userId), eq(schema.samples.excluded, false)));
  return a + b;
}

/** 最近发过的几条：优先用通过本产品发出去的，不够再用最新的素材 */
export async function recentOwn(userId: string, limit = RECENT_LIMIT): Promise<string[]> {
  const { published, samples } = await ownPosts(userId, limit);
  return [...published, ...samples].slice(0, limit);
}

/** 生成时用的记忆：enabled 为 false 表示用户关掉了（这时也不带「最近发过的」）；memory 还没整理出来时为 null */
export async function memoryForPrompt(userId: string): Promise<{ enabled: boolean; memory: AccountMemory | null }> {
  const row = await getMemoryRow(userId);
  if (!row) return { enabled: true, memory: null };
  if (!row.enabled) return { enabled: false, memory: null };
  const m = cleanMemory(row.memory);
  return { enabled: true, memory: isEmptyMemory(m) ? null : m };
}

/** 整理一次记忆（调 AI） */
export async function refreshMemory(userId: string): Promise<MemoryRow> {
  const db = await getDb();
  const { published, samples } = await ownPosts(userId);
  const all = [...published, ...samples];
  if (all.length < 5) throw new MemoryError("本人推文太少（至少 5 条），先在「素材」里导入一些自己写过的推文");
  const row = await getMemoryRow(userId);
  await requireActive(userId, "memory");
  const total = await ownPostCount(userId);
  const current = row ? cleanMemory(row.memory) : EMPTY_MEMORY;
  const next = cleanMemory(await summarizeMemory(current, all, row?.source === "edited"));
  const values = { memory: next, postsAtBuild: total, builtAt: new Date(), error: null, updatedAt: new Date() };
  const [saved] = await db
    .insert(schema.accountMemories)
    .values({ userId, source: "auto", enabled: true, ...values })
    .onConflictDoUpdate({ target: schema.accountMemories.userId, set: values })
    .returning();
  return saved;
}

/** 用户手动改记忆 */
export async function saveMemory(userId: string, patch: { memory?: Partial<AccountMemory>; enabled?: boolean }): Promise<MemoryRow> {
  const db = await getDb();
  const row = await getMemoryRow(userId);
  const memory = patch.memory ? cleanMemory(patch.memory) : row ? cleanMemory(row.memory) : EMPTY_MEMORY;
  const set = {
    memory,
    enabled: patch.enabled ?? row?.enabled ?? true,
    ...(patch.memory ? { source: "edited" } : {}),
    updatedAt: new Date(),
  };
  const [saved] = await db
    .insert(schema.accountMemories)
    .values({ userId, postsAtBuild: 0, ...set })
    .onConflictDoUpdate({ target: schema.accountMemories.userId, set })
    .returning();
  return saved;
}

/**
 * 定时任务：有风格卡、记忆没关、本人推文够多且还没整理过（或新增了 10 条）的客户，后台整理一次。
 * 每轮最多处理几位，免得一次调太多 AI。出错记下来，下一次新增够了再试。
 */
export async function refreshDueMemories(max = 3): Promise<number> {
  const db = await getDb();
  const users = await db
    .selectDistinct({ userId: schema.styleCards.userId })
    .from(schema.styleCards)
    .where(eq(schema.styleCards.isActive, true));
  let done = 0;
  for (const { userId } of users) {
    if (done >= max) break;
    const row = await getMemoryRow(userId);
    if (row && !row.enabled) continue;
    const total = await ownPostCount(userId);
    if (total < 5 || !needsRefresh(total, row)) continue;
    try {
      await refreshMemory(userId);
      done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "整理失败";
      // 记下这次的条数，等再多 10 条才重试，免得每 30 秒重试
      await db
        .insert(schema.accountMemories)
        .values({ userId, memory: row?.memory ?? EMPTY_MEMORY, postsAtBuild: total, builtAt: row?.builtAt ?? new Date(0), error: msg })
        .onConflictDoUpdate({ target: schema.accountMemories.userId, set: { postsAtBuild: total, error: msg, updatedAt: new Date() } });
      if (!(e instanceof InsufficientBalanceError || e instanceof UsageLimitError || e instanceof MemoryError)) {
        console.error("[memory]", e);
      }
    }
  }
  return done;
}
