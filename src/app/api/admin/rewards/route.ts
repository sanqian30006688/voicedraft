import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { adminUserIds, getConfig, postUnitMicro } from "@/lib/billing";
import { adminReferrals, funnel, getRewardsConfig, saveRewardsConfig } from "@/lib/rewards";

/** 后台：签到 / 邀请奖励设置、邀请记录、转化漏斗 */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const admins = await adminUserIds();
  const [config, cfg, referrals, f7, f30, fAll] = await Promise.all([
    getRewardsConfig(),
    getConfig(),
    adminReferrals(),
    funnel(7, admins),
    funnel(30, admins),
    funnel(null, admins),
  ]);
  return Response.json({ config, postUnitMicro: postUnitMicro(cfg), referrals, funnel: [f7, f30, fAll] });
}

const money = z.number().min(0).max(1000);
const Body = z.object({
  enabled: z.boolean(),
  checkin: money,
  streakDays: z.number().int().min(0).max(365),
  streakBonus: money,
  piggyCap: money,
  expireDays: z.number().int().min(1).max(3650),
  invitePct: z.number().min(0).max(100),
  inviteMax: money,
  inviteeBonus: money,
  inviteMonthly: z.number().int().min(0).max(10_000),
});

export async function PUT(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "有一项填得不对，请检查数字" }, { status: 400 });
  await saveRewardsConfig(parsed.data);
  return Response.json({ ok: true });
}
