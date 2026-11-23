import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { BenchChannelError, getBenchChannel, MIN_ENTRIES, postBoardToChannel, saveBenchChannel, targetChat } from "@/lib/bench-channel";
import { leaderboard } from "@/lib/benchmark";

/** 后台：每周把涨粉榜发到 TG 频道 */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const cfg = await getBenchChannel();
  return Response.json({ ...cfg, target: await targetChat(cfg), publicCount: (await leaderboard("")).length, minEntries: MIN_ENTRIES });
}

const Body = z.object({ enabled: z.boolean(), chat: z.string().trim().max(200) });

export async function PUT(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "填得不对，请检查" }, { status: 400 });
  try {
    await saveBenchChannel(parsed.data);
  } catch (e) {
    if (e instanceof BenchChannelError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  return GET();
}

/** 现在发一次（不管时间） */
export async function POST() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const r = await postBoardToChannel(new Date(), true);
  return Response.json(r, { status: r.ok ? 200 : 400 });
}
