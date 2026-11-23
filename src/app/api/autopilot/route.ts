import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { CAP_MAX, getSettings, limitsFor, listAuto, saveSettings, X_MAX_OVERLAP, WEB_MAX_OVERLAP } from "@/lib/autopilot";
import { getAccount } from "@/lib/x";

/** 自动发帖页：设置、信息源、最近的自动帖 */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const db = await getDb();
  const [settings, items, sources, acc, lim] = await Promise.all([
    getSettings(user.id),
    listAuto(user.id, 40),
    db.select().from(schema.sources).where(eq(schema.sources.userId, user.id)).orderBy(desc(schema.sources.createdAt)),
    getAccount(user.id),
    limitsFor(user.id),
  ]);
  return Response.json({
    settings,
    items,
    sources: sources.map(({ seen: _s, ...s }) => (void _s, s)),
    x: acc ? { handle: acc.handle, ok: !acc.authError } : null,
    limits: { xOverlap: Math.round(X_MAX_OVERLAP * 100), webOverlap: Math.round(WEB_MAX_OVERLAP * 100), capMax: lim.capMax, gapMin: lim.gapMin, owner: lim.owner },
  });
}

const Patch = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["review", "auto"]).optional(),
  dailyCap: z.number().int().min(1).max(CAP_MAX).optional(),
  minGapMin: z.number().int().min(1).max(1440).optional(),
  maxGapMin: z.number().int().min(0).max(1440).optional(),
  startHour: z.number().int().min(0).max(23).optional(),
  endHour: z.number().int().min(1).max(24).optional(),
  tz: z.string().max(60).optional(),
  attachLink: z.boolean().optional(),
  withPromo: z.boolean().optional(),
  withImage: z.boolean().optional(),
  linkReply: z.boolean().optional(),
  longForm: z.boolean().optional(),
  instruction: z.string().max(500).optional(),
  maxAgeHours: z.number().int().min(1).max(336).optional(),
  perSourceDaily: z.number().int().min(1).max(CAP_MAX).optional(),
});

export async function PATCH(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "设置格式不对" }, { status: 400 });
  if (parsed.data.enabled) {
    const acc = await getAccount(user.id);
    if (!acc || acc.authError) return Response.json({ error: "请先到「发布」页连接 X 账号" }, { status: 400 });
  }
  return Response.json({ settings: await saveSettings(user.id, parsed.data) });
}
