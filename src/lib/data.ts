import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  cleanContent,
  detectLang,
  meaningfulLength,
  MIN_SAMPLE_CHARS,
  normalizeForHash,
  type RawSample,
  type SampleSource,
} from "./import";
import type { EditPair, StyleCard, StyleTraits } from "./style-card";
import { memoryForPrompt, recentOwn } from "./memory";
import { topicRelevance } from "./text";

/** 生成时最多带进提示词的样本数 */
const PROMPT_SAMPLE_LIMIT = 60;
/** 按主题挑选的相关原句数 */
const RELATED_LIMIT = 6;

const hash = (s: string) => createHash("sha256").update(normalizeForHash(s)).digest("hex");

export async function addSamples(userId: string, items: RawSample[], source: SampleSource) {
  const db = await getDb();
  let tooShort = 0;
  const seen = new Set<string>();
  const rows: (typeof schema.samples.$inferInsert)[] = [];
  for (const item of items) {
    const content = cleanContent(item.content);
    if (meaningfulLength(content) < MIN_SAMPLE_CHARS) {
      tooShort++;
      continue;
    }
    const contentHash = hash(content);
    if (seen.has(contentHash)) continue;
    seen.add(contentHash);
    rows.push({
      userId,
      content,
      contentHash,
      lang: detectLang(content),
      source,
      postedAt: item.postedAt ? new Date(item.postedAt) : null,
    });
  }
  let added = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = await db
      .insert(schema.samples)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing({ target: [schema.samples.userId, schema.samples.contentHash] })
      .returning({ id: schema.samples.id });
    added += inserted.length;
  }
  const duplicate = items.length - tooShort - added;
  return { added, duplicate, tooShort };
}

export async function listSamples(userId: string, limit = 1000) {
  const db = await getDb();
  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.samples)
      .where(eq(schema.samples.userId, userId))
      .orderBy(desc(schema.samples.pinned), desc(sql`coalesce(${schema.samples.postedAt}, ${schema.samples.createdAt})`))
      .limit(limit),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.samples).where(eq(schema.samples.userId, userId)),
  ]);
  return { items, total };
}

/** 素材里占多数的语言，风格卡按这个语言生成 */
export async function majorityLang(userId: string): Promise<"zh" | "en"> {
  const db = await getDb();
  const rows = await db
    .select({ lang: schema.samples.lang, n: sql<number>`count(*)::int` })
    .from(schema.samples)
    .where(and(eq(schema.samples.userId, userId), eq(schema.samples.excluded, false)))
    .groupBy(schema.samples.lang);
  const zh = rows.find((r) => r.lang === "zh")?.n ?? 0;
  const en = rows.find((r) => r.lang === "en")?.n ?? 0;
  return en > zh ? "en" : "zh";
}

export async function usableSamples(userId: string, lang: string) {
  const db = await getDb();
  return db
    .select({ id: schema.samples.id, content: schema.samples.content, pinned: schema.samples.pinned })
    .from(schema.samples)
    .where(and(eq(schema.samples.userId, userId), eq(schema.samples.excluded, false), eq(schema.samples.lang, lang)))
    .orderBy(desc(schema.samples.pinned), desc(sql`coalesce(${schema.samples.postedAt}, ${schema.samples.createdAt})`));
}

export async function getActiveCard(userId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.styleCards)
    .where(and(eq(schema.styleCards.userId, userId), eq(schema.styleCards.isActive, true)))
    .orderBy(desc(schema.styleCards.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function cardHistory(userId: string) {
  const db = await getDb();
  return db
    .select({
      id: schema.styleCards.id,
      version: schema.styleCards.version,
      lang: schema.styleCards.lang,
      source: schema.styleCards.source,
      isActive: schema.styleCards.isActive,
      createdAt: schema.styleCards.createdAt,
      traits: schema.styleCards.traits,
    })
    .from(schema.styleCards)
    .where(eq(schema.styleCards.userId, userId))
    .orderBy(desc(schema.styleCards.version))
    .limit(50);
}

/** 保存为新版本并设为当前版本（旧版本保留，可回滚） */
export async function saveCardVersion(userId: string, lang: string, traits: StyleTraits, source: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [{ maxVersion }] = await tx
      .select({ maxVersion: sql<number>`coalesce(max(${schema.styleCards.version}), 0)::int` })
      .from(schema.styleCards)
      .where(and(eq(schema.styleCards.userId, userId), eq(schema.styleCards.lang, lang)));
    await tx
      .update(schema.styleCards)
      .set({ isActive: false })
      .where(eq(schema.styleCards.userId, userId));
    const [row] = await tx
      .insert(schema.styleCards)
      .values({ userId, lang, version: maxVersion + 1, traits, source, isActive: true })
      .returning();
    return row;
  });
}

/** 钉住指定样本（生成风格卡时由模型挑出的代表句），只在用户还没有钉住任何样本时使用 */
export async function pinIfNonePinned(userId: string, ids: string[]) {
  if (!ids.length) return;
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.samples)
    .where(and(eq(schema.samples.userId, userId), eq(schema.samples.pinned, true)));
  if (n > 0) return;
  for (const id of ids) {
    await db
      .update(schema.samples)
      .set({ pinned: true })
      .where(and(eq(schema.samples.userId, userId), eq(schema.samples.id, id)));
  }
}

/**
 * 组装起草时用的风格卡：当前版本的描述 + 同语言样本（钉住的优先）。
 * 传入主题时，另外挑出与主题最相近的几条原句。
 */
export async function loadStyleCardForDrafting(userId: string, topic?: string): Promise<StyleCard | null> {
  const card = await getActiveCard(userId);
  if (!card) return null;
  const all = await usableSamples(userId, card.lang);
  const samples = all.slice(0, PROMPT_SAMPLE_LIMIT);
  const related = topic
    ? all
        .filter((s) => !s.pinned)
        .map((s) => ({ s, score: topicRelevance(topic, s.content) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, RELATED_LIMIT)
        .map((x) => x.s.content)
    : [];
  const mem = await memoryForPrompt(userId);
  const recent = mem.enabled ? await recentOwn(userId) : [];
  return {
    version: card.version,
    traits: card.traits,
    samples: samples.map((s) => s.content),
    pinned: samples.flatMap((s, i) => (s.pinned ? [i] : [])),
    related,
    memory: mem.memory,
    recent,
  };
}

export async function recentEdits(userId: string, limit = 10): Promise<EditPair[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.editLogs)
    .where(eq(schema.editLogs.userId, userId))
    .orderBy(desc(schema.editLogs.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({ original: r.original, edited: r.edited, at: r.createdAt.getTime() }));
}

export async function countEdits(userId: string) {
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.editLogs)
    .where(eq(schema.editLogs.userId, userId));
  return n;
}

/** 「越用越像」：累计这么多次新修改后，提示用户让 AI 总结规律 */
export const LEARN_THRESHOLD = 20;
export const LEARN_MIN = 5;

/** 上一次总结之后的新修改（按时间正序） */
export async function editsSinceLastLearning(userId: string) {
  const db = await getDb();
  const [last] = await db
    .select({ lastEditAt: schema.styleLearnings.lastEditAt })
    .from(schema.styleLearnings)
    .where(eq(schema.styleLearnings.userId, userId))
    .orderBy(desc(schema.styleLearnings.createdAt))
    .limit(1);
  const rows = await db
    .select({ original: schema.editLogs.original, edited: schema.editLogs.edited, createdAt: schema.editLogs.createdAt })
    .from(schema.editLogs)
    .where(
      last
        ? and(eq(schema.editLogs.userId, userId), gt(schema.editLogs.createdAt, last.lastEditAt))
        : eq(schema.editLogs.userId, userId),
    )
    .orderBy(asc(schema.editLogs.createdAt));
  return rows;
}

export async function pendingLearning(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.styleLearnings)
    .where(and(eq(schema.styleLearnings.userId, userId), eq(schema.styleLearnings.status, "pending")))
    .orderBy(desc(schema.styleLearnings.createdAt))
    .limit(1);
  return row ?? null;
}
