import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { z } from "zod";
import { PROMO_KINDS, type PromoKind, type PromoLink, type PromoMode, type PromoSettings } from "./promo";

/** 新增 / 修改推广链接时的字段校验 */
export const PromoLinkFields = z.object({
  kind: z.enum(PROMO_KINDS),
  name: z.string().trim().min(1, "请填名称").max(50),
  // 可以是链接，也可以是群号这类文字；链接里不能有空格
  url: z
    .string()
    .trim()
    .min(1, "请填链接或群号")
    .max(300)
    .refine((s) => !(/^https?:\/\//i.test(s) && /\s/.test(s)), "链接里不能有空格"),
  blurb: z.string().trim().max(100).default(""),
});

const toLink = (r: typeof schema.promoLinks.$inferSelect): PromoLink => ({
  id: r.id,
  kind: r.kind as PromoKind,
  name: r.name,
  url: r.url,
  blurb: r.blurb,
});

export async function listPromoLinks(userId: string): Promise<PromoLink[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.promoLinks)
    .where(eq(schema.promoLinks.userId, userId))
    .orderBy(asc(schema.promoLinks.createdAt));
  return rows.map(toLink);
}

/** 按 id 取一条推广链接，只能取到自己的 */
export async function getPromoLink(userId: string, id: string | undefined | null): Promise<PromoLink | null> {
  if (!id) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.promoLinks)
    .where(and(eq(schema.promoLinks.id, id), eq(schema.promoLinks.userId, userId)))
    .limit(1);
  return row ? toLink(row) : null;
}

export async function getPromoSettings(userId: string): Promise<PromoSettings> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.promoSettings)
    .where(eq(schema.promoSettings.userId, userId))
    .limit(1);
  return { mode: (row?.mode as PromoMode) ?? "ask", defaultId: row?.defaultLinkId ?? null };
}

export async function savePromoSettings(userId: string, patch: Partial<PromoSettings>) {
  const db = await getDb();
  const current = await getPromoSettings(userId);
  const next = { ...current, ...patch };
  await db
    .insert(schema.promoSettings)
    .values({ userId, mode: next.mode, defaultLinkId: next.defaultId })
    .onConflictDoUpdate({
      target: schema.promoSettings.userId,
      set: { mode: next.mode, defaultLinkId: next.defaultId },
    });
  return next;
}
