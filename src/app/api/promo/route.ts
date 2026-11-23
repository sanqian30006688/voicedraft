import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { PROMO_MODES } from "@/lib/promo";
import { getPromoLink, PromoLinkFields, getPromoSettings, listPromoLinks, savePromoSettings } from "@/lib/promo-data";

const MAX_LINKS = 30;

/** 推广链接列表 + 偏好设置 */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const [links, settings] = await Promise.all([listPromoLinks(user.id), getPromoSettings(user.id)]);
  return Response.json({ links, settings });
}

/** 新增一条推广链接 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = PromoLinkFields.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "格式不对" }, { status: 400 });
  }
  const existing = await listPromoLinks(user.id);
  if (existing.length >= MAX_LINKS) {
    return Response.json({ error: `最多保存 ${MAX_LINKS} 条` }, { status: 400 });
  }
  const db = await getDb();
  const [row] = await db
    .insert(schema.promoLinks)
    .values({ userId: user.id, ...parsed.data })
    .returning({ id: schema.promoLinks.id });
  // 第一条自动设为默认
  const settings = await getPromoSettings(user.id);
  if (!settings.defaultId) await savePromoSettings(user.id, { defaultId: row.id });
  return Response.json({ id: row.id });
}

const SettingsBody = z.object({
  mode: z.enum(PROMO_MODES).optional(),
  defaultId: z.string().uuid().nullable().optional(),
});

/** 修改偏好：每篇都带 / 每篇自己选 / 不带，默认链接 */
export async function PATCH(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = SettingsBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "格式不对" }, { status: 400 });
  if (parsed.data.defaultId && !(await getPromoLink(user.id, parsed.data.defaultId))) {
    return Response.json({ error: "找不到这条推广链接" }, { status: 404 });
  }
  const settings = await savePromoSettings(user.id, parsed.data);
  return Response.json({ settings });
}
