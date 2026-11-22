import "server-only";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { refund, requireActive, reserve, withAiSlot, type PriceKey } from "./billing";
import { classifySourceImage, planImage, type ImagePlan } from "./llm";
import { normalizeSpec, randomStyle, renderCard, THEMES, type Aspect, type CardSpec, type Theme } from "./image-render";
import { getAccount } from "./x";

/**
 * 配图。原则：别人的图只拿来「看懂」，不拿来「用」。
 * - 信息卡：AI 读懂帖子（和参考图）→ 写出标题和要点 → 程序用中文字体排版。字一个都不会错。
 * - AI 画图：AI 按画面描述画一张无字的新图，标题由程序叠上去。涉及真实人物的不画，改做信息卡。
 * - 自己的图：用户发来的图直接用。
 */

export class ImageError extends Error {}

export type ImageRow = typeof schema.images.$inferSelect;
export type ImageInfo = Omit<ImageRow, "data" | "bg">;

export interface RefImage {
  mime: string;
  base64: string;
}

const REF_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** 参考图 / 自己的图最大多少（X 单图上限 5MB） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function checkRef(ref: RefImage | null | undefined): RefImage | null {
  if (!ref) return null;
  if (!REF_MIMES.includes(ref.mime)) throw new ImageError("只支持 PNG、JPG、WebP、GIF 图片");
  if (ref.base64.length * 0.75 > MAX_IMAGE_BYTES) throw new ImageError("图片太大了（最大 5MB）");
  return ref;
}

/** 账号水印：连了 X 就用 @账号 */
async function handleOf(userId: string): Promise<string | undefined> {
  const acc = await getAccount(userId);
  return acc?.handle ? `@${acc.handle}` : undefined;
}

function specFromPlan(plan: ImagePlan, o: { layout: CardSpec["layout"]; aspect: Aspect; theme?: Theme; handle?: string }): CardSpec {
  // 没指定风格就随机挑一套（配色 + 要点符号 + 装饰），免得每张都一样
  const style = randomStyle();
  return normalizeSpec({
    layout: o.layout,
    theme: o.theme ?? style.theme,
    bullet: style.bullet,
    decor: style.decor,
    aspect: o.aspect,
    tag: plan.tag,
    title: plan.title,
    points: plan.points,
    source: plan.source || undefined,
    handle: o.handle,
    showTitle: true,
  });
}

async function ownDraft(userId: string, draftId: string | null | undefined): Promise<string | null> {
  if (!draftId) return null;
  const db = await getDb();
  const [d] = await db
    .select({ id: schema.drafts.id })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)))
    .limit(1);
  return d?.id ?? null;
}

async function insertImage(values: typeof schema.images.$inferInsert): Promise<ImageInfo> {
  const db = await getDb();
  const [row] = await db.insert(schema.images).values(values).returning();
  return info(row);
}

export function info(row: ImageRow): ImageInfo {
  const { data: _d, bg: _b, ...rest } = row;
  void _d;
  void _b;
  return rest;
}

/** 先扣钱（价格为 0 时不扣），做成了算数，出错退回 */
async function charged<T>(userId: string, item: PriceKey, fn: () => Promise<T>): Promise<T> {
  const hold = await reserve(userId, { [item]: 1 });
  // 不收费（价格为 0）时也要余额高于停用线，并且每天有次数上限
  if (!hold) await requireActive(userId, "image");
  try {
    return await fn();
  } catch (e) {
    await refund(hold);
    throw e;
  }
}

// ---------- AI 画图（Gemini） ----------

export function isImageAiConfigured(): boolean {
  return process.env.MOCK_IMAGE === "1" || Boolean(process.env.GEMINI_API_KEY);
}

const MODEL_STANDARD = () => process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const MODEL_PRO = () => process.env.GEMINI_IMAGE_PRO_MODEL || "gemini-3-pro-image-preview";

// 测试用的「AI 画图」：一张 1×1 的 PNG
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** 让 Gemini 画一张无字的图；5:2 的长文封面先按 21:9 画，排版时再裁 */
export async function drawScene(scene: string, aspect: Aspect, pro: boolean): Promise<RefImage> {
  if (process.env.MOCK_IMAGE === "1") return { mime: "image/png", base64: TINY_PNG_B64 };
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ImageError("平台还没配置 AI 画图（管理员在「后台」填 Gemini 密钥后就能用）");
  const prompt =
    `${scene}\n\nStrict rules: absolutely no text, letters, numbers, captions, logos, watermarks or UI in the image. ` +
    "Do not depict any real, identifiable person. Leave calm space in the lower third for a title overlay.";
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${pro ? MODEL_PRO() : MODEL_STANDARD()}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect === "5:2" ? "21:9" : "16:9" } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new ImageError("连不上 AI 画图服务，请稍后再试");
  }
  type Part = { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } };
  const body = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    console.error("[images] Gemini 出错", res.status, body?.error?.message);
    if (res.status === 400 && /api key/i.test(body?.error?.message ?? "")) throw new ImageError("AI 画图的密钥不对，请管理员在「后台」重新填");
    if (res.status === 429) throw new ImageError("AI 画图现在太忙了，请过一会儿再试");
    throw new ImageError("AI 画图失败了，请再试一次");
  }
  for (const part of body?.candidates?.[0]?.content?.parts ?? []) {
    const d = part.inlineData ?? (part.inline_data ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data } : undefined);
    if (d?.data) return { mime: d.mimeType || "image/png", base64: d.data };
  }
  throw new ImageError("AI 这次没画出来（可能内容不适合画图），换成信息卡试试");
}

// ---------- 对外 ----------

export interface MakeInput {
  text: string;
  draftId?: string | null;
  ref?: RefImage | null;
  aspect?: Aspect;
  theme?: Theme;
}

/** 信息卡（layout=card）或纯文字封面（layout=cover） */
export async function makeCard(userId: string, input: MakeInput & { layout?: CardSpec["layout"] }): Promise<ImageInfo> {
  const ref = checkRef(input.ref);
  if (!input.text.trim() && !ref) throw new ImageError("先写好内容再配图");
  const draftId = await ownDraft(userId, input.draftId);
  return withAiSlot(userId, () =>
    charged(userId, "image_card", async () => {
      const plan = await planImage(input.text, ref);
      const spec = specFromPlan(plan, {
        layout: input.layout ?? "card",
        aspect: input.aspect ?? (input.layout === "cover" ? "5:2" : "16:9"),
        theme: input.theme,
        handle: await handleOf(userId),
      });
      const png = await renderCard(spec);
      return insertImage({ userId, draftId, kind: "card", spec, mime: "image/png", data: png });
    }),
  );
}

export interface AiResult {
  image: ImageInfo;
  /** 涉及真实人物时改做了信息卡 */
  fellBack?: boolean;
}

/** AI 按内容画一张无字的新图，标题由程序叠上去 */
export async function makeAi(userId: string, input: MakeInput & { pro?: boolean }): Promise<AiResult> {
  const ref = checkRef(input.ref);
  if (!input.text.trim() && !ref) throw new ImageError("先写好内容再配图");
  if (!isImageAiConfigured()) throw new ImageError("平台还没配置 AI 画图（管理员在「后台」填 Gemini 密钥后就能用）");
  const draftId = await ownDraft(userId, input.draftId);
  const aspect = input.aspect ?? "16:9";
  const handle = await handleOf(userId);
  // 先读懂内容（不收费）；涉及真人的不让 AI 画，改做信息卡
  await requireActive(userId, "image");
  const plan = await withAiSlot(userId, () => planImage(input.text, ref));
  if (plan.people) {
    const spec = specFromPlan(plan, { layout: "card", aspect: "16:9", theme: input.theme, handle });
    const image = await charged(userId, "image_card", async () =>
      insertImage({ userId, draftId, kind: "card", spec, mime: "image/png", data: await renderCard(spec) }),
    );
    return { image, fellBack: true };
  }
  const item: PriceKey = input.pro ? "image_ai_pro" : "image_ai";
  const image = await withAiSlot(userId, () =>
    charged(userId, item, async () => {
      const bg = await drawScene(plan.scene, aspect, !!input.pro);
      const spec = { ...specFromPlan(plan, { layout: "cover", aspect, theme: input.theme, handle }), points: [] };
      const png = await renderCard(spec, `data:${bg.mime};base64,${bg.base64}`);
      return insertImage({
        userId,
        draftId,
        kind: "ai",
        spec,
        mime: "image/png",
        data: png,
        bg: Uint8Array.from(Buffer.from(bg.base64, "base64")),
        bgMime: bg.mime,
      });
    }),
  );
  return { image };
}

/** 原图只从这些公开图片地址下载（X 的图片服务器、TG 频道预览页的 CDN） */
const SOURCE_IMAGE_HOSTS = /^(pbs\.twimg\.com|cdn\d*\.(cdn-)?telegram\.org|cdn\d*\.telesco\.pe)$/i;

async function downloadSourceImage(url: string): Promise<RefImage | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !SOURCE_IMAGE_HOSTS.test(u.hostname)) return null;
  // X 的图要大图
  if (u.hostname === "pbs.twimg.com" && !u.searchParams.has("name")) u.searchParams.set("name", "large");
  try {
    const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return { mime, base64: Buffer.from(buf).toString("base64") };
  } catch {
    return null;
  }
}

/**
 * 用原帖的原图配图：先让 AI 看是不是截图、图表、产品图、文档、梗图这类可以用的图，
 * 摄影、手绘插画等原创作品、新闻照片、人物照片、带别人水印的都不用。
 * 能用就存下来（收 image_source）；不能用返回 null 和原因（不收费）
 */
export async function takeSourceImage(userId: string, url: string, text: string): Promise<{ image: ImageInfo | null; reason?: string }> {
  const ref = await downloadSourceImage(url);
  if (!ref) return { image: null, reason: "原图下载不了" };
  await requireActive(userId, "image");
  const verdict = await withAiSlot(userId, () => classifySourceImage(ref, text));
  if (!verdict.usable) return { image: null, reason: `原图不适合转用（${verdict.reason || verdict.kind}）` };
  const image = await charged(userId, "image_source", () =>
    insertImage({ userId, kind: "source", mime: ref.mime, data: Uint8Array.from(Buffer.from(ref.base64, "base64")) }),
  );
  return { image };
}

/** 用户自己的图：直接存下来用（PNG / JPEG 才能发到 X） */
export async function saveUpload(userId: string, input: { ref: RefImage; draftId?: string | null }): Promise<ImageInfo> {
  const ref = checkRef(input.ref)!;
  if (ref.mime !== "image/png" && ref.mime !== "image/jpeg") throw new ImageError("发到 X 的图请用 PNG 或 JPG");
  return insertImage({
    userId,
    draftId: await ownDraft(userId, input.draftId),
    kind: "upload",
    spec: null,
    mime: ref.mime,
    data: Uint8Array.from(Buffer.from(ref.base64, "base64")),
  });
}

async function ownImage(userId: string, id: string): Promise<ImageRow> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.images)
    .where(and(eq(schema.images.id, id), eq(schema.images.userId, userId)))
    .limit(1);
  if (!row) throw new ImageError("找不到这张图（可能已经过期清理了）");
  return row;
}

export async function getImage(userId: string, id: string): Promise<ImageRow> {
  return ownImage(userId, id);
}

export interface Restyle {
  theme?: Theme;
  showTitle?: boolean;
  title?: string;
  points?: string[];
  aspect?: Aspect;
}

/** 换风格、改标题字、去掉标题、换比例：只重新排版，不调 AI、不收费 */
export async function restyle(userId: string, id: string, change: Restyle): Promise<ImageInfo> {
  const row = await ownImage(userId, id);
  if (!row.spec) throw new ImageError("自己发的图不能改样式");
  const spec = normalizeSpec({
    ...row.spec,
    ...(change.theme ? { theme: change.theme } : {}),
    ...(change.showTitle !== undefined ? { showTitle: change.showTitle } : {}),
    ...(change.title?.trim() ? { title: change.title } : {}),
    ...(change.points ? { points: change.points } : {}),
    ...(change.aspect ? { aspect: change.aspect } : {}),
  });
  const bg = row.bg ? `data:${row.bgMime ?? "image/png"};base64,${Buffer.from(row.bg).toString("base64")}` : undefined;
  const png = await renderCard(spec, bg);
  const db = await getDb();
  const [next] = await db
    .update(schema.images)
    .set({ spec, data: png })
    .where(and(eq(schema.images.id, id), eq(schema.images.userId, userId)))
    .returning();
  return info(next);
}

/** 下一个风格（「换风格」按钮轮换用） */
export function nextTheme(t: Theme | undefined): Theme {
  const i = THEMES.indexOf(t ?? "dark");
  return THEMES[(i + 1) % THEMES.length];
}

/** 给草稿选定配图（null = 不要图） */
export async function attachToDraft(userId: string, draftId: string, imageId: string | null) {
  const db = await getDb();
  if (imageId) await ownImage(userId, imageId);
  const [d] = await db
    .select({ meta: schema.drafts.meta })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)))
    .limit(1);
  if (!d) throw new ImageError("找不到这篇草稿");
  const meta = { ...(d.meta ?? {}) };
  if (imageId) meta.imageId = imageId;
  else delete meta.imageId;
  await db
    .update(schema.drafts)
    .set({ meta, updatedAt: new Date() })
    .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)));
}

export async function listImages(userId: string, draftId?: string | null, limit = 12): Promise<ImageInfo[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.images.id,
      userId: schema.images.userId,
      draftId: schema.images.draftId,
      kind: schema.images.kind,
      spec: schema.images.spec,
      mime: schema.images.mime,
      bgMime: schema.images.bgMime,
      createdAt: schema.images.createdAt,
    })
    .from(schema.images)
    .where(draftId ? and(eq(schema.images.userId, userId), eq(schema.images.draftId, draftId)) : eq(schema.images.userId, userId))
    .orderBy(desc(schema.images.createdAt))
    .limit(limit);
  return rows;
}

/** 清理：30 天前的、没被草稿选中、也没挂在待发帖子上的图 */
export async function pruneImages(days = 30): Promise<number> {
  const db = await getDb();
  const rows = await db
    .delete(schema.images)
    .where(
      and(
        lt(schema.images.createdAt, new Date(Date.now() - days * 86400_000)),
        sql`${schema.images.id}::text not in (select meta->>'imageId' from drafts where meta->>'imageId' is not null)`,
        sql`${schema.images.id} not in (select image_id from posts where image_id is not null and status in ('scheduled', 'publishing', 'failed'))`,
      ),
    )
    .returning({ id: schema.images.id });
  return rows.length;
}
