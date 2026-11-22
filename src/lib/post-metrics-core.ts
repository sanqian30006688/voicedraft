/**
 * 发帖效果：纯函数部分（哪类内容效果好、什么时间发效果好、给顾客看的文字）。
 * 数据库和 X 接口在 post-metrics.ts，机器人界面在 tg-bot-perf.ts。
 */
import type { TweetMetrics } from "@/db/schema";

export type PostKind = "short" | "long" | "thread" | "link" | "quote" | "auto";

export const KIND_LABEL: Record<PostKind, string> = {
  short: "短推",
  long: "单条长推",
  thread: "串推",
  link: "带链接的",
  quote: "引用推文",
  auto: "自动发帖",
};

/** 发出后多久读第一次、第二次 */
export const D1_MS = 24 * 3600_000;
export const D7_MS = 7 * 24 * 3600_000;
/** 看最近多少天发的帖子 */
export const INSIGHT_DAYS = 30;
/** 推荐发帖时间至少要有这么多条数据，每个时段至少几条 */
export const MIN_FOR_HOURS = 6;
export const MIN_PER_SLOT = 2;
/** 比较类型时，每类至少几条 */
export const MIN_PER_KIND = 2;
/** 时段宽度（小时）：0–3、3–6 … 21–24 */
export const SLOT_HOURS = 3;

/** 互动分：点赞 1 分，转发、引用、回复各 2 分，收藏 1 分 */
export function engagement(m: TweetMetrics): number {
  return m.likes + 2 * (m.retweets + m.quotes + m.replies) + m.bookmarks;
}

export interface PerfRow {
  postId: string;
  tweetId: string;
  kind: PostKind;
  text: string;
  publishedAt: Date;
  /** 最新一次读到的数据（7 天的优先），null = 还没读到或已删 */
  metrics: TweetMetrics | null;
}

export interface Insights {
  /** 有数据的帖子数 */
  count: number;
  avgImpressions: number;
  avgEngagement: number;
  top: PerfRow[];
  /** 各类内容的平均互动（够条数的类型才算），按高到低 */
  kinds: { kind: PostKind; count: number; avg: number }[];
  /** 最好的时段（本地时间），不够数据时 null */
  bestSlot: { start: number; end: number; avg: number; ratio: number; count: number } | null;
}

/** 这个时刻在某时区是几点（0–23） */
export function hourIn(d: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d);
  return Number(h) % 24;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function insights(rows: PerfRow[], tz: string): Insights {
  const has = rows.filter((r): r is PerfRow & { metrics: TweetMetrics } => !!r.metrics);
  const score = (r: { metrics: TweetMetrics }) => engagement(r.metrics);
  const overall = avg(has.map(score));
  const top = [...has].sort((a, b) => score(b) - score(a) || b.metrics.impressions - a.metrics.impressions).slice(0, 3);

  const byKind = new Map<PostKind, number[]>();
  for (const r of has) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), score(r)]);
  const kinds = [...byKind.entries()]
    .filter(([, xs]) => xs.length >= MIN_PER_KIND)
    .map(([kind, xs]) => ({ kind, count: xs.length, avg: avg(xs) }))
    .sort((a, b) => b.avg - a.avg);

  let bestSlot: Insights["bestSlot"] = null;
  if (has.length >= MIN_FOR_HOURS && overall > 0) {
    const slots = new Map<number, number[]>();
    for (const r of has) {
      const s = Math.floor(hourIn(r.publishedAt, tz) / SLOT_HOURS) * SLOT_HOURS;
      slots.set(s, [...(slots.get(s) ?? []), score(r)]);
    }
    const ranked = [...slots.entries()]
      .filter(([, xs]) => xs.length >= MIN_PER_SLOT)
      .map(([start, xs]) => ({ start, end: start + SLOT_HOURS, avg: avg(xs), count: xs.length, ratio: avg(xs) / overall }))
      .sort((a, b) => b.avg - a.avg);
    // 至少要有两个时段可比，并且最好的明显好于平均，才推荐
    if (ranked.length >= 2 && ranked[0].ratio >= 1.15) bestSlot = ranked[0];
  }

  return {
    count: has.length,
    avgImpressions: avg(has.map((r) => r.metrics.impressions)),
    avgEngagement: overall,
    top,
    kinds,
    bestSlot,
  };
}

/** 推荐时段里的「最佳时刻」：时段中间那个整点 */
export const bestHour = (slot: { start: number }) => slot.start + Math.floor(SLOT_HOURS / 2);

const n0 = (x: number) => (x >= 10000 ? `${(x / 10000).toFixed(1)} 万` : String(Math.round(x)));
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function metricsLine(m: TweetMetrics): string {
  return `👁 ${n0(m.impressions)} · ❤️ ${n0(m.likes)} · 🔁 ${n0(m.retweets + m.quotes)} · 💬 ${n0(m.replies)}`;
}

const pad = (h: number) => String(h).padStart(2, "0");

/** 给顾客看的「📈 发帖效果」 */
export function insightLines(i: Insights, tzLabel: string): string[] {
  if (!i.count) {
    return ["📈 发帖效果", "", "还没有数据。帖子发出 1 天后我会去 X 上读一次浏览和互动，7 天后再读一次，到时候这里会告诉你哪类内容、什么时间发效果最好。"];
  }
  const lines = ["📈 发帖效果（最近 30 天）", "", `有数据的帖子 ${i.count} 条，平均浏览 ${n0(i.avgImpressions)}、互动 ${n0(i.avgEngagement)}`];
  if (i.top.length) {
    lines.push("", "🏅 效果最好的：");
    i.top.forEach((r, k) => lines.push(`${k + 1}. ${clip(r.text, 40)}`, `   ${metricsLine(r.metrics!)}`));
  }
  if (i.kinds.length >= 2) {
    const best = i.kinds[0];
    const worst = i.kinds[i.kinds.length - 1];
    lines.push("", `📝 ${KIND_LABEL[best.kind]}效果最好（平均互动 ${n0(best.avg)}），${KIND_LABEL[worst.kind]}最弱（${n0(worst.avg)}）`);
  }
  if (i.bestSlot) {
    lines.push(
      "",
      `⏰ ${pad(i.bestSlot.start)}:00–${pad(i.bestSlot.end % 24)}:00（${tzLabel}）发的互动最高，是平均的 ${i.bestSlot.ratio.toFixed(1)} 倍。定时发布时可以选「⭐ 最佳时间」。`,
    );
  } else if (i.count < MIN_FOR_HOURS) {
    lines.push("", `⏰ 再多发几条（至少 ${MIN_FOR_HOURS} 条有数据），我就能告诉你什么时间发最好。`);
  }
  return lines;
}
