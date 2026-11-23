import { requireUser } from "@/lib/auth";
import { tzLabel } from "@/lib/daily-report";
import { KIND_LABEL, insightLines } from "@/lib/post-metrics-core";
import { myInsights } from "@/lib/post-metrics";

/** 发帖效果：最近 30 天帖子的浏览和互动、哪类内容好、什么时间发好（只看自己的） */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { insights: i, tz } = await myInsights(user.id);
  return Response.json({
    count: i.count,
    lines: insightLines(i, tzLabel(tz)).slice(1),
    top: i.top.map((r) => ({ text: r.text, kind: KIND_LABEL[r.kind], tweetId: r.tweetId, metrics: r.metrics })),
    bestSlot: i.bestSlot,
  });
}
