import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { INDUSTRIES, isIndustry } from "@/lib/benchmark-core";
import { getProfile, leaderboard, myBenchmark, updateProfile } from "@/lib/benchmark";

/** 推主数据：我的数据、同类对比、排行榜（只含公开上榜的）。别人的数据只给中间水平，不给是谁 */
async function view(userId: string, mine: boolean) {
  const [me, profile] = await Promise.all([myBenchmark(userId), getProfile(userId)]);
  const board = await leaderboard(userId, mine ? profile.industry : null);
  return {
    connected: !!me,
    handle: me?.handle ?? null,
    stat: me?.stat ?? null,
    cmp: me?.cmp ?? null,
    viaApp: me?.viaApp ?? 0,
    profile: {
      industry: profile.industry,
      industrySource: profile.industrySource,
      publicRank: profile.publicRank,
      weeklyReport: profile.weeklyReport,
    },
    industries: INDUSTRIES.map((i) => ({ code: i.code, label: i.label })),
    board: board.map((e) => ({ handle: e.handle, industry: e.industry, followers: e.stat.followers, weeklyGrowth: e.stat.weeklyGrowth, postsPerDay: e.stat.postsPerDay, mine: !!e.mine })),
  };
}

export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const mine = new URL(request.url).searchParams.get("scope") === "mine";
  return Response.json(await view(user.id, mine));
}

const Body = z.object({
  industry: z.string().refine(isIndustry).optional(),
  publicRank: z.boolean().optional(),
  weeklyReport: z.boolean().optional(),
});

export async function PUT(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "填得不对，请检查" }, { status: 400 });
  await updateProfile(user.id, parsed.data);
  return Response.json(await view(user.id, false));
}
