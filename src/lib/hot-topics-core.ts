/**
 * 热点提醒：纯函数部分（把最近收进来的内容按「说的是不是同一件事」分组，数有几个信息源在说）。
 * 数据库和推送在 hot-topics.ts。不调 AI、不收费。
 */
import { trigramSimilarity } from "./text";

/** 看最近多少小时收进来的 */
export const HOT_WINDOW_HOURS = 12;
/** 两条内容开头这么多字的重合度达到这个比例，算在说同一件事（比去重的 60% 宽松：不同媒体的说法不一样） */
export const HOT_SIMILARITY = 0.35;
const HOT_CHARS = 400;
/** 去掉标点后不到这么多字的不比（太短容易误判） */
const MIN_CHARS = 20;

export interface HotItem {
  id: string;
  sourceId: string | null;
  text: string;
  createdAt: Date;
  /** 跨来源去重时没收进来的、别的信息源发的同一件事 */
  alsoSeen: { sourceId: string | null }[];
  /** 这件事已经推过热点提醒了 */
  hotAt: Date | null;
}

export interface HotCluster {
  /** 推送时用的那一条（来源最多、其次最长） */
  lead: HotItem;
  members: HotItem[];
  /** 有几个不同的信息源在说 */
  sources: number;
  sourceIds: string[];
}

const key = (s: string) => s.replace(/https?:\/\/\S+/g, "").slice(0, HOT_CHARS);
const bare = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");

function sourcesOf(it: HotItem): string[] {
  return [it.sourceId, ...it.alsoSeen.map((a) => a.sourceId)].filter((x): x is string => !!x);
}

/** 分组：同一个信息源里的两条不连在一起（同一个网站常用同一套模板，容易误判） */
export function clusterItems(items: HotItem[]): HotCluster[] {
  const ok = items.filter((it) => it.sourceId && bare(key(it.text)).length >= MIN_CHARS);
  const parent = ok.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const keys = ok.map((it) => key(it.text));
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      if (ok[i].sourceId === ok[j].sourceId) continue;
      if (find(i) === find(j)) continue;
      if (trigramSimilarity(keys[i], keys[j]) >= HOT_SIMILARITY) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, HotItem[]>();
  ok.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));
  return [...groups.values()].map((members) => {
    const ids = [...new Set(members.flatMap(sourcesOf))];
    const lead = [...members].sort((a, b) => sourcesOf(b).length - sourcesOf(a).length || b.text.length - a.text.length)[0];
    return { lead, members, sources: ids.length, sourceIds: ids };
  });
}

/** 够热、还没推过的话题，按信息源多少排 */
export function hotClusters(items: HotItem[], minSources: number): HotCluster[] {
  return clusterItems(items)
    .filter((c) => c.sources >= minSources && c.members.every((m) => !m.hotAt))
    .sort((a, b) => b.sources - a.sources || b.lead.createdAt.getTime() - a.lead.createdAt.getTime());
}
