import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { adminReportText, businessStats, getAdminReportConfig, saveAdminReportConfig, sendAdminReport, validTz } from "@/lib/daily-report";
import { getCosts, saveCosts } from "@/lib/usage";

/** 后台：经营日报（什么时候发、成本单价、昨天的数字预览、立即发一份到 TG） */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const [config, costs] = await Promise.all([getAdminReportConfig(), getCosts()]);
  const [stats, preview] = await Promise.all([businessStats(new Date(), config.tz), adminReportText(new Date(), config.tz)]);
  return Response.json({ config, costs, stats, preview });
}

const price = z.number().min(0).max(1000);
const Body = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  tz: z.string().refine(validTz),
  costs: z.object({ aiInput: price, aiOutput: price, aiCacheWrite: price, aiCacheRead: price, aiLightInput: price, aiLightOutput: price, aiLightCacheWrite: price, aiLightCacheRead: price, xPost: price, xRead: price }),
});

export async function PUT(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "有一项填得不对，请检查" }, { status: 400 });
  const { costs, ...cfg } = parsed.data;
  await saveAdminReportConfig(cfg);
  await saveCosts(costs);
  return Response.json({ ok: true });
}

/** 立即把昨天的经营日报发到管理员的 TG */
export async function POST() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const sent = await sendAdminReport();
  if (!sent) return Response.json({ error: "管理员账号还没绑定 TG，绑定后才能收到" }, { status: 400 });
  return Response.json({ ok: true, sent });
}
