/**
 * 推主数据：纯函数部分（行业判断、涨粉和发帖频率、同类对比、名次、周报文字）。
 * 数据库和 X 接口在 benchmark.ts，机器人界面在 tg-bot-bench.ts。
 *
 * 隐私规则：
 * - 同类对比只给中间水平和名次，看不到别人是谁；一组不满 MIN_GROUP 个账号就不显示（免得被猜出是谁）。
 * - 排行榜只列本人主动开启「公开上榜」的账号。
 */

/** 一组至少这么多个账号，才显示这一组的对比数据 */
export const MIN_GROUP = 5;
/** 涨粉、发帖频率按最近几天算 */
export const WINDOW_DAYS = 7;
/** 最新数据超过这么多天没更新的账号不算进对比 */
export const STALE_DAYS = 3;
/** 排行榜最多列几个 */
export const BOARD_SIZE = 20;

export interface Industry {
  code: string;
  label: string;
  keywords: string[];
}

/** 固定的行业列表：自动判断按关键词，本人可以在机器人里改 */
export const INDUSTRIES: Industry[] = [
  {
    code: "web3",
    label: "Web3 / 币圈",
    keywords: ["币", "加密", "crypto", "btc", "比特", "eth", "以太", "web3", "区块链", "defi", "nft", "meme", "空投", "链上", "交易所", "solana", "合约", "撸毛", "山寨"],
  },
  {
    code: "finance",
    label: "财经 / 股票",
    keywords: ["股票", "美股", "a股", "港股", "基金", "理财", "投资", "财经", "经济", "宏观", "期货", "外汇", "黄金", "利率", "美联储", "炒股", "财报"],
  },
  {
    code: "tech",
    label: "AI / 科技",
    keywords: ["ai", "人工智能", "大模型", "gpt", "chatgpt", "claude", "llm", "科技", "编程", "程序", "开发者", "软件", "互联网", "独立开发", "产品经理", "创业", "芯片"],
  },
  {
    code: "ecom",
    label: "跨境 / 出海 / 营销",
    keywords: ["跨境", "电商", "出海", "亚马逊", "shopify", "独立站", "外贸", "tiktok", "带货", "营销", "增长", "流量", "seo", "副业", "赚钱", "私域"],
  },
  { code: "news", label: "新闻 / 时事", keywords: ["新闻", "时事", "政治", "国际", "社会", "时评", "历史", "军事", "地缘", "选举"] },
  { code: "life", label: "生活方式", keywords: ["生活", "美食", "旅行", "旅游", "健身", "运动", "穿搭", "摄影", "宠物", "家居", "育儿", "日常"] },
  { code: "mind", label: "情感 / 成长", keywords: ["情感", "恋爱", "婚姻", "心理", "两性", "成长", "自律", "读书", "认知", "人生"] },
  { code: "game", label: "游戏 / 动漫", keywords: ["游戏", "电竞", "二次元", "动漫", "手游", "steam", "主机", "番剧"] },
  { code: "edu", label: "教育 / 职场", keywords: ["教育", "学习", "留学", "英语", "考试", "职场", "求职", "考研", "面试", "简历"] },
  { code: "ent", label: "娱乐 / 影视", keywords: ["娱乐", "明星", "影视", "电影", "音乐", "综艺", "八卦", "追剧", "演唱会"] },
  { code: "other", label: "其他", keywords: [] },
];

export const industryLabel = (code: string | null | undefined) => INDUSTRIES.find((i) => i.code === code)?.label ?? "未分类";
export const isIndustry = (code: string) => INDUSTRIES.some((i) => i.code === code);

/** 按账号记忆 / 风格卡里的话题猜行业；猜不出来返回 null */
export function guessIndustry(texts: string[]): string | null {
  const hay = texts.join(" ").toLowerCase();
  if (!hay.trim()) return null;
  let best: { code: string; score: number } | null = null;
  for (const ind of INDUSTRIES) {
    let score = 0;
    for (const k of ind.keywords) {
      // 英文关键词要整词匹配（免得 said 里的 ai 也算），中文按包含
      const re = /^[a-z0-9]+$/.test(k) ? new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, "g") : new RegExp(k, "g");
      score += hay.match(re)?.length ?? 0;
    }
    if (score > 0 && (!best || score > best.score)) best = { code: ind.code, score };
  }
  return best?.code ?? null;
}

export interface Snapshot {
  day: string; // YYYY-MM-DD
  xUserId: string;
  followers: number;
  following: number;
  tweets: number;
}

export interface AccountStat {
  followers: number;
  following: number;
  tweets: number;
  day: string;
  /** 按 7 天折算的涨粉；数据不满 1 天时为 null */
  weeklyGrowth: number | null;
  /** 每天发帖（含回复）；数据不满 1 天时为 null */
  postsPerDay: number | null;
  /** 实际用了几天的数据 */
  spanDays: number;
}

const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400_000);

export function dayDiff(a: string, b: string): number {
  return dayNum(b) - dayNum(a);
}

/** 从一个账号的每日快照算出最新数据、周涨粉、日均发帖（只用最新绑定的那个 X 账号的数据） */
export function computeStat(snaps: Snapshot[]): AccountStat | null {
  if (!snaps.length) return null;
  const sorted = [...snaps].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  const last = sorted[sorted.length - 1];
  const same = sorted.filter((s) => s.xUserId === last.xUserId && dayDiff(s.day, last.day) <= WINDOW_DAYS);
  const base = same[0];
  const span = dayDiff(base.day, last.day);
  const stat: AccountStat = {
    followers: last.followers,
    following: last.following,
    tweets: last.tweets,
    day: last.day,
    weeklyGrowth: null,
    postsPerDay: null,
    spanDays: span,
  };
  if (span >= 1) {
    stat.weeklyGrowth = Math.round(((last.followers - base.followers) * WINDOW_DAYS) / span);
    stat.postsPerDay = Math.max(0, Math.round(((last.tweets - base.tweets) / span) * 10) / 10);
  }
  return stat;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface GroupMember {
  userId: string;
  stat: AccountStat;
}

export interface Comparison {
  /** 对比的是哪一组：本行业，还是全站（本行业不满 MIN_GROUP 个） */
  scope: "industry" | "all";
  size: number;
  medianPostsPerDay: number;
  medianWeeklyGrowth: number;
  medianFollowers: number;
  /** 本周涨粉第几名（1 起）；自己没有涨粉数据时为 null */
  rank: number | null;
  /** 超过了百分之多少的同组账号 */
  beatPct: number | null;
}

/** 只算有涨粉数据的账号 */
const usable = (ms: GroupMember[]) => ms.filter((m) => m.stat.weeklyGrowth !== null && m.stat.postsPerDay !== null);

function compareIn(userId: string, members: GroupMember[], scope: Comparison["scope"]): Comparison | null {
  const ms = usable(members);
  if (ms.length < MIN_GROUP) return null;
  const me = ms.find((m) => m.userId === userId);
  let rank: number | null = null;
  let beatPct: number | null = null;
  if (me) {
    const g = me.stat.weeklyGrowth!;
    rank = ms.filter((m) => m.stat.weeklyGrowth! > g).length + 1;
    const below = ms.filter((m) => m.stat.weeklyGrowth! < g).length;
    beatPct = Math.round((below / (ms.length - 1)) * 100);
  }
  return {
    scope,
    size: ms.length,
    medianPostsPerDay: Math.round(median(ms.map((m) => m.stat.postsPerDay!)) * 10) / 10,
    medianWeeklyGrowth: Math.round(median(ms.map((m) => m.stat.weeklyGrowth!))),
    medianFollowers: Math.round(median(ms.map((m) => m.stat.followers))),
    rank,
    beatPct,
  };
}

/** 先和同行业比；同行业不满 MIN_GROUP 个账号就和全站比；全站也不够就不给对比 */
export function compare(userId: string, industry: string | null, all: (GroupMember & { industry: string | null })[]): Comparison | null {
  if (industry) {
    const same = compareIn(
      userId,
      all.filter((m) => m.industry === industry),
      "industry",
    );
    if (same) return same;
  }
  return compareIn(userId, all, "all");
}

export interface BoardEntry {
  handle: string;
  industry: string | null;
  stat: AccountStat;
  mine?: boolean;
}

export type BoardSort = "growth" | "followers";

export function sortBoard(entries: BoardEntry[], sort: BoardSort): BoardEntry[] {
  const key = (e: BoardEntry) => (sort === "growth" ? (e.stat.weeklyGrowth ?? Number.NEGATIVE_INFINITY) : e.stat.followers);
  return [...entries].sort((a, b) => key(b) - key(a) || b.stat.followers - a.stat.followers || a.handle.localeCompare(b.handle));
}

// ---------- 文字 ----------

/** 12345 → 1.2 万 */
export function fmtNum(n: number): string {
  if (Math.abs(n) >= 10000) return `${(Math.round(n / 1000) / 10).toString()} 万`;
  return n.toLocaleString("en-US");
}

export const fmtGrowth = (n: number | null) => (n === null ? "—" : n >= 0 ? `+${fmtNum(n)}` : `-${fmtNum(-n)}`);

export interface ReportInput {
  handle: string;
  industry: string | null;
  stat: AccountStat;
  cmp: Comparison | null;
  /** 最近 7 天通过 VoiceDraft 发出的帖子数 */
  viaApp: number;
  publicRank: boolean;
}

/** 「我的数据」卡片和每周周报共用的正文 */
export function statLines(r: ReportInput): string[] {
  const s = r.stat;
  const lines = [
    `@${r.handle}`,
    `粉丝 ${fmtNum(s.followers)}${s.weeklyGrowth !== null ? `（本周 ${fmtGrowth(s.weeklyGrowth)}）` : ""}`,
    `关注 ${fmtNum(s.following)} · 发帖总数 ${fmtNum(s.tweets)}`,
  ];
  if (s.postsPerDay !== null) lines.push(`最近每天发 ${s.postsPerDay} 条（含回复）`);
  if (r.viaApp > 0) lines.push(`这 7 天通过我发了 ${r.viaApp} 条`);
  if (s.weeklyGrowth === null) lines.push("", "⏳ 数据从今天开始记录，明天起就能看到涨粉和发帖频率。");
  lines.push("", `🏷 行业：${industryLabel(r.industry)}`);
  const c = r.cmp;
  if (!c) {
    lines.push(`同类账号满 ${MIN_GROUP} 个后，这里会显示同类对比和你的名次。`);
    return lines;
  }
  const who = c.scope === "industry" ? `同类 ${c.size} 个账号` : `全站 ${c.size} 个账号（同类还不满 ${MIN_GROUP} 个，先和全站比）`;
  lines.push(`${who}的中间水平：每天发 ${c.medianPostsPerDay} 条，周涨粉 ${fmtGrowth(c.medianWeeklyGrowth)}，粉丝 ${fmtNum(c.medianFollowers)}`);
  if (c.rank !== null) {
    lines.push(`你的本周涨粉排第 ${c.rank} / ${c.size}${c.beatPct !== null && c.beatPct > 0 ? `，超过 ${c.beatPct}% 的账号` : ""}`);
  }
  const tip = tipFor(s, c);
  if (tip) lines.push("", `💡 ${tip}`);
  return lines;
}

function tipFor(s: AccountStat, c: Comparison): string | null {
  if (s.postsPerDay === null) return null;
  const gap = Math.round((c.medianPostsPerDay - s.postsPerDay) * 10) / 10;
  if (gap >= 0.5) return `${c.scope === "industry" ? "同类" : "全站"}大多数账号每天比你多发 ${gap} 条。发个主题给我，我按你的口吻写。`;
  if (s.weeklyGrowth !== null && s.weeklyGrowth < c.medianWeeklyGrowth) return "发得不少，涨粉慢一点。可以试试多回复同行的帖子，或者写一条长推讲透一个观点。";
  if (c.rank === 1) return "本周涨粉第一，保持住！";
  return null;
}

export function weeklyReportText(r: ReportInput): string {
  const lines = ["📊 本周数据周报", "", ...statLines(r)];
  if (!r.publicRank) lines.push("", "想让别人看到你？在排行榜里点「公开上榜」。");
  return lines.join("\n");
}

export function boardLines(entries: BoardEntry[], sort: BoardSort, scopeLabel: string): string[] {
  const head = `🏆 排行榜 · ${scopeLabel} · ${sort === "growth" ? "按本周涨粉" : "按粉丝数"}`;
  if (!entries.length) return [head, "", "还没有人公开上榜。点「公开上榜」，你就是第一个。"];
  const rows = sortBoard(entries, sort)
    .slice(0, BOARD_SIZE)
    .map((e, i) => {
      const main = sort === "growth" ? `本周 ${fmtGrowth(e.stat.weeklyGrowth)} · 粉丝 ${fmtNum(e.stat.followers)}` : `粉丝 ${fmtNum(e.stat.followers)} · 本周 ${fmtGrowth(e.stat.weeklyGrowth)}`;
      return `${i + 1}. @${e.handle}${e.mine ? "（你）" : ""} · ${industryLabel(e.industry)} · ${main}`;
    });
  return [head, "", ...rows, "", "只列出本人开启了「公开上榜」的账号。"];
}

/** 每周发到 TG 频道的涨粉榜（只含公开上榜的账号） */
export function channelBoardText(entries: BoardEntry[], botUsername: string | null, top = 10): string {
  const rows = sortBoard(entries, "growth")
    .slice(0, top)
    .map((e, i) => `${["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`} @${e.handle} · ${industryLabel(e.industry)} · 本周 ${fmtGrowth(e.stat.weeklyGrowth)} · 粉丝 ${fmtNum(e.stat.followers)}`);
  const join = botUsername
    ? `想上榜？打开 @${botUsername} → ☰ 更多 → 📊 数据和排行 → 公开上榜`
    : "想上榜？在机器人里点 ☰ 更多 → 📊 数据和排行 → 公开上榜";
  return ["🏆 本周推主涨粉榜", "", ...rows, "", "只列出本人自愿公开的账号。", join].join("\n");
}

// ---------- 周报时间 ----------

/** 每周一北京时间 10 点发周报：返回不晚于 now 的最近一个发送时刻 */
export function reportSlot(now = new Date()): Date {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const dow = (bj.getUTCDay() + 6) % 7; // 周一 = 0
  const slot = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - dow, 10) - 8 * 3600_000;
  return new Date(slot > now.getTime() ? slot - 7 * 86400_000 : slot);
}
