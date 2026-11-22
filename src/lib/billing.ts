import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { keccak256 } from "js-sha3";
import twitterText from "twitter-text";
import { getDb, schema } from "@/db";
import { acquire, fmtWait, hitAll, release } from "./rate-limit";

/**
 * 开源自托管版：没有计费。这一模块保留了原来的导出接口，让其他代码不用改就能编译和运行，
 * 但所有扣费动作都是空操作：不扣钱、不拦人，余额视为无限。
 * 还保留的真实逻辑都是通用基础设施：app_settings 的读写（getSetting / setSetting）、
 * 管理员判断（ADMIN_EMAILS）、团队成员关系查询、流水显示用的文案函数、AI 防刷限流。
 */

export const MICRO = 1_000_000;

/** 价目表条目（只用于显示历史流水的文案；开源版不按这个收费） */
export const PRICE_ITEMS = [
  { key: "generate", label: "写：生成短推、改写或引用推文", short: "生成短推 / 改写 / 引用", unit: "次", default: 0.06 },
  { key: "reply", label: "写：为一条 @我 或关注的人的帖子写回复候选", short: "写回复候选", unit: "条", default: 0.05 },
  { key: "long_single", label: "写：单条长推", short: "写单条长推", unit: "篇", default: 0.2 },
  { key: "long_thread", label: "写：串推", short: "写串推", unit: "篇", default: 0.4 },
  { key: "long_article", label: "写：X 长文（复制到 X 自己发，不收发帖费）", short: "写 X 长文", unit: "篇", default: 0.7 },
  { key: "post", label: "发：普通帖子或回复", short: "发帖 / 回复", unit: "条", default: 0.03 },
  { key: "thread", label: "发：串推整串（{n} 条以内）", short: "发串推", unit: "串", default: 0.15 },
  { key: "thread_extra", label: "发：串推超过 {n} 条，每多一条", short: "串推超出的条数", unit: "条", default: 0.02 },
  { key: "post_link", label: "发：带链接的那一条（代替普通价，不叠加）", short: "发带链接的帖子", unit: "条", default: 0.3 },
  { key: "mention_read", label: "读取一条 @我", short: "读取 @我", unit: "条", default: 0.02 },
  { key: "timeline_read", label: "读取一条关注的人的帖子", short: "读取关注的人", unit: "条", default: 0.02 },
  { key: "auto_draft", label: "写：自动发帖，采集后按文风写一条", short: "自动发帖写一条", unit: "条", default: 0.06 },
  { key: "source_read", label: "读取一条 X 主页推文（自动发帖信息源）", short: "读取 X 主页", unit: "条", default: 0.02 },
  { key: "image_card", label: "配图：信息卡 / 封面（程序排版，换风格、改标题字不另收）", short: "配图：信息卡", unit: "张", default: 0.05 },
  { key: "image_source", label: "配图：用原帖的原图（AI 先判断能不能用，用上了才收）", short: "配图：原图", unit: "张", default: 0.05 },
  { key: "image_ai", label: "配图：AI 画一张（标准）", short: "配图：AI 画图", unit: "张", default: 0.15 },
  { key: "follow_read", label: "互关检测：读取一位关注或粉丝", short: "互关检测", unit: "人", default: 0.015 },
  { key: "unfollow", label: "互关检测：取关一个账号", short: "取关", unit: "次", default: 0.02 },
  { key: "image_ai_pro", label: "配图：AI 画一张（精品）", short: "配图：AI 精品图", unit: "张", default: 0.4 },
] as const;

/** 旧版价目表里的项目，只用于显示以前的明细 */
const LEGACY_SHORT: Record<string, string> = { longform: "写长文" };

export type PriceKey = (typeof PRICE_ITEMS)[number]["key"];

export type ChainKey = "plasma" | "bsc" | "polygon" | "arbitrum";
export const CHAIN_KEYS: readonly ChainKey[] = ["plasma", "bsc", "polygon", "arbitrum"];
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface BillingConfig {
  /** 开源版恒为 false：所有功能都不扣费 */
  enabled: boolean;
  /** 单价，单位 USDT（只用于历史流水文案，开源版不收费） */
  prices: Record<PriceKey, number>;
  /** 单次最低充值（开源版无充值，保留字段兼容旧设置） */
  minTopup: number;
  /** 余额停用线（开源版不用，保留字段兼容旧设置） */
  reserve: number;
  /** 新注册用户送的余额 */
  signupBonus: number;
  /** 收款地址（开源版无收款，恒为空） */
  addresses: Partial<Record<ChainKey, string>>;
  /** 管理员自己用也扣费（开源版不扣费，保留字段兼容旧设置） */
  chargeAdmin: boolean;
  /** 串推整串价包含几条（不算带链接的） */
  threadIncluded: number;
  /** 团队功能要求所有者余额不低于这个数（开源版不用，保留字段兼容旧设置） */
  teamMinBalance: number;
  /** 充值金额随机尾数位数（开源版无充值，保留字段兼容旧设置） */
  tailDigits: number;
}

export const DEFAULT_CONFIG: BillingConfig = {
  enabled: false,
  prices: Object.fromEntries(PRICE_ITEMS.map((p) => [p.key, p.default])) as Record<PriceKey, number>,
  minTopup: 10,
  reserve: 1,
  signupBonus: 0,
  addresses: {},
  chargeAdmin: false,
  threadIncluded: 10,
  teamMinBalance: 20,
  tailDigits: 4,
};

const CONFIG_KEY = "billing";

export async function getSetting<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1);
  return (row?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown) {
  const db = await getDb();
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteSetting(key: string) {
  const db = await getDb();
  await db.delete(schema.appSettings).where(eq(schema.appSettings.key, key));
}

export async function getConfig(): Promise<BillingConfig> {
  const saved = (await getSetting<Partial<BillingConfig>>(CONFIG_KEY)) ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    // 开源版恒定：计费关闭、无收款地址（即使旧数据库里存过也忽略）
    enabled: false,
    addresses: {},
    prices: { ...DEFAULT_CONFIG.prices, ...(saved.prices ?? {}) },
  };
}

export async function saveConfig(next: BillingConfig) {
  const addresses: Partial<Record<ChainKey, string>> = {};
  for (const k of CHAIN_KEYS) {
    const a = next.addresses[k]?.trim();
    if (a) {
      if (!isValidAddress(a)) throw new Error(`${k} 地址格式不对，或者大小写校验没通过（可能抄错了一位）`);
      addresses[k] = a.toLowerCase();
    }
  }
  await setSetting(CONFIG_KEY, { ...next, addresses });
}

/**
 * EVM 地址是否有效：0x + 40 位十六进制；大小写混写时还要通过 EIP-55 校验。
 * （通用校验工具，保留原实现。）
 */
export function isValidAddress(a: string): boolean {
  if (!EVM_ADDRESS_RE.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = keccak256(body.toLowerCase());
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (/[a-f]/i.test(c) && (parseInt(hash[i], 16) >= 8 ? c !== c.toUpperCase() : c !== c.toLowerCase())) return false;
  }
  return true;
}

/** 开着的收款链（开源版恒为空） */
export function openChains(cfg: BillingConfig): ChainKey[] {
  return CHAIN_KEYS.filter((k) => cfg.addresses[k]);
}

// ---------- 金额 ----------

export const toMicro = (usdt: number) => Math.round(usdt * MICRO);

/** 「12.34」：至少两位小数，最多六位，不带浮点噪音 */
export function fmtUsdt(m: number): string {
  const neg = m < 0;
  const v = Math.abs(Math.round(m));
  let f = String(v % MICRO).padStart(6, "0").replace(/0+$/, "");
  if (f.length < 2) f = f.padEnd(2, "0");
  return `${neg ? "-" : ""}${Math.floor(v / MICRO)}.${f}`;
}

/** 「12.345」→ 12345000；不是普通小数时返回 NaN */
export function parseUsdt(s: string | number): number {
  const t = String(s ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  const [i, f = ""] = t.split(".");
  return Number(i) * MICRO + Number((f + "000000").slice(0, 6));
}

// ---------- 管理员 ----------

/** 管理员账号的 id */
export async function adminUserIds(): Promise<string[]> {
  const db = await getDb();
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length) {
    const rows = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users);
    return rows.filter((r) => list.includes(r.email.toLowerCase())).map((r) => r.id);
  }
  const [first] = await db.select({ id: schema.users.id }).from(schema.users).orderBy(asc(schema.users.createdAt)).limit(1);
  return first ? [first.id] : [];
}

/** 管理员：ADMIN_EMAILS 里的邮箱（逗号分隔）；没配置时是最早注册的那个账号 */
export async function isAdmin(user: { id: string; email: string }): Promise<boolean> {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length) return list.includes(user.email.toLowerCase());
  const db = await getDb();
  const [first] = await db.select({ id: schema.users.id }).from(schema.users).orderBy(asc(schema.users.createdAt)).limit(1);
  return first?.id === user.id;
}

// ---------- 余额（开源版：无限，不扣费） ----------

export class InsufficientBalanceError extends Error {
  constructor(
    public needMicro: number,
    public balanceMicro: number,
    reserveMicro = 0,
  ) {
    super(`余额不足（需要 ${fmtUsdt(needMicro)}，当前 ${fmtUsdt(balanceMicro)}）。`);
    void reserveMicro;
  }
}

/** 团队成员：团队给的额度用完了（开源版不会真的抛出，保留类型兼容） */
export class TeamBalanceError extends InsufficientBalanceError {
  constructor(needMicro: number, balanceMicro: number, reason: string, fallback: boolean) {
    super(needMicro, balanceMicro);
    this.message = fallback
      ? `${reason}，你自己的额度也不够这次用。请找团队所有者加额度。`
      : `${reason}，团队设置为用完就停。请找团队所有者加额度。`;
  }
}

// ---------- 团队 ----------

/**
 * 团队成员关系（谁在哪个团队、是什么角色、每天 / 每月上限）。
 * 这是团队功能本身的数据，和计费无关，保留真实查询。
 */
export interface TeamLink {
  teamId: string;
  /** 就是查的这位用户 */
  actorId: string;
  ownerId: string;
  role: "owner" | "admin" | "member";
  dailyMicro: number | null;
  monthlyMicro: number | null;
  fallback: boolean;
}

export async function teamLink(userId: string): Promise<TeamLink | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      teamId: schema.teams.id,
      ownerId: schema.teams.ownerUserId,
      role: schema.teamMembers.role,
      dailyMicro: schema.teamMembers.dailyMicro,
      monthlyMicro: schema.teamMembers.monthlyMicro,
      fallback: schema.teams.fallbackPersonal,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teamMembers.userId, userId))
    .limit(1);
  return row ? { ...row, actorId: userId, role: row.role as TeamLink["role"] } : null;
}

/** 北京时间的今天 0 点、本月 1 号 0 点 */
export function periodStarts(now = new Date()) {
  const off = 8 * 3600_000;
  const b = new Date(now.getTime() + off);
  return {
    day: new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - off),
    month: new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1) - off),
  };
}

export type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];
export type DbOrTx = Awaited<ReturnType<typeof getDb>> | Tx;

/** 这位成员今天、本月在团队流水里用了多少（扣费减退回；开源版流水一般为空） */
export async function teamSpent(q: DbOrTx, ownerId: string, actorId: string): Promise<{ day: number; month: number }> {
  const { day, month } = periodStarts();
  const [r] = await q
    .select({
      day: sql<string>`coalesce(sum(case when ${schema.ledger.createdAt} >= ${day.toISOString()} then -${schema.ledger.amountMicro} else 0 end), 0)`,
      month: sql<string>`coalesce(sum(-${schema.ledger.amountMicro}), 0)`,
    })
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.userId, ownerId),
        eq(schema.ledger.actorUserId, actorId),
        sql`${schema.ledger.kind} in ('charge', 'refund')`,
        sql`${schema.ledger.createdAt} >= ${month.toISOString()}`,
      ),
    );
  return { day: Number(r?.day ?? 0), month: Number(r?.month ?? 0) };
}

/** 还能从团队额度用多少（null = 不限） */
export function teamLeft(l: Pick<TeamLink, "dailyMicro" | "monthlyMicro">, spent: { day: number; month: number }): number | null {
  const parts: number[] = [];
  if (l.dailyMicro != null) parts.push(l.dailyMicro - spent.day);
  if (l.monthlyMicro != null) parts.push(l.monthlyMicro - spent.month);
  return parts.length ? Math.max(0, Math.min(...parts)) : null;
}

/** 团队余额低于门槛时的说明（半句话；开源版不会用到） */
export const teamPausedText = (cfg: BillingConfig) => `团队余额低于 ${cfg.teamMinBalance} USDT，共用已暂停`;

/** 开源版不计费：团队共用永远可用 */
export async function teamFundsOk(ownerId: string, cfg?: BillingConfig): Promise<boolean> {
  void ownerId;
  void cfg;
  return true;
}

/**
 * 钱包余额（真实读库）。开源版没有任何地方会扣费，余额只会因为赠送 / 奖励记账而增加，
 * 所以「够不够用」永远不是问题；保留真实读数是为了让签到、邀请奖励这类记账还能对上。
 */
export async function getBalance(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ b: schema.wallets.balanceMicro })
    .from(schema.wallets)
    .where(eq(schema.wallets.userId, userId))
    .limit(1);
  return row?.b ?? 0;
}

export interface LedgerEntry {
  kind: "topup" | "charge" | "refund" | "adjust" | "bonus";
  item?: PriceKey;
  quantity?: number;
  note?: string;
  refId?: string;
  /** 团队：是哪位成员用的 */
  actorUserId?: string | null;
}

/** 改余额并记一笔流水（同一个事务里）。签到 / 邀请奖励等赠送额度还走这里记账。 */
export async function addBalance(
  userId: string,
  amountMicro: number,
  entry: LedgerEntry,
): Promise<number> {
  const db = await getDb();
  return db.transaction((tx) => addBalanceTx(tx, userId, amountMicro, entry));
}

/** 在调用方的事务里改余额并记流水 */
export async function addBalanceTx(
  tx: Tx,
  userId: string,
  amountMicro: number,
  entry: LedgerEntry,
): Promise<number> {
  {
    const [w] = await tx
      .insert(schema.wallets)
      .values({ userId, balanceMicro: amountMicro })
      .onConflictDoUpdate({
        target: schema.wallets.userId,
        set: {
          balanceMicro: sql`${schema.wallets.balanceMicro} + ${amountMicro}`,
          ...(entry.kind === "charge" && amountMicro < 0 ? { bonusMicro: sql`greatest(0, ${schema.wallets.bonusMicro} + ${amountMicro})` } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ b: schema.wallets.balanceMicro });
    await tx.insert(schema.ledger).values({
      userId,
      kind: entry.kind,
      item: entry.item ?? null,
      quantity: entry.quantity ?? 1,
      amountMicro,
      balanceAfterMicro: w.b,
      note: entry.note ?? null,
      refId: entry.refId ?? null,
      actorUserId: entry.actorUserId ?? null,
    });
    return w.b;
  }
}

/** 这位用户用功能时扣不扣费：开源版恒为 false */
export async function isBillable(userId: string): Promise<boolean> {
  void userId;
  return false;
}

/** 用户自己余额的停用线：开源版恒为 0 */
export async function userFloor(userId: string, cfg: BillingConfig): Promise<number> {
  void userId;
  void cfg;
  return 0;
}

export type Cost = Partial<Record<PriceKey, number>>;

/** 开源版不查余额：永远放行 */
export async function requireBalance(userId: string, cost: Cost): Promise<void> {
  void userId;
  void cost;
}

/** 先扣下来的一笔钱（开源版没有这个概念，reserve 恒返回 null） */
export interface Hold {
  /** 钱从谁的余额扣的 */
  userId: string;
  /** 团队：实际是哪位成员用的 */
  actorId?: string;
  /** 每个项目扣了几次、单价多少（微 USDT） */
  lines: { item: PriceKey; quantity: number; unitMicro: number }[];
  refId?: string;
  /** 这笔里有多少是从赠送额度扣的 */
  bonusMicro?: number;
}

/** 开源版不扣费：恒返回 null */
export async function reserve(userId: string, cost: Cost, refId?: string, note?: string): Promise<Hold | null> {
  void userId;
  void cost;
  void refId;
  void note;
  return null;
}

/** 开源版没有扣费，退回是空操作 */
export async function refund(hold: Hold | null, cost?: Cost): Promise<void> {
  void hold;
  void cost;
}

/** 开源版不扣费：空操作 */
export async function charge(userId: string, item: PriceKey, quantity = 1, refId?: string, note?: string): Promise<void> {
  void userId;
  void item;
  void quantity;
  void refId;
  void note;
}

/** 余额最多够做几次：开源版恒为 Infinity */
export async function affordable(userId: string, item: PriceKey): Promise<number> {
  void userId;
  void item;
  return Infinity;
}

/** 先扣钱、做成了算数、出错退回：开源版只保留 AI 防刷限流，直接执行 */
export async function withCharge<T>(userId: string, item: PriceKey, fn: () => Promise<T>, refId?: string): Promise<T> {
  void item;
  void refId;
  return withAiSlot(userId, fn);
}

/** 用得太频繁（防止有人用脚本反复调 AI 功能） */
export class UsageLimitError extends Error {}

/**
 * 所有要调 AI 的功能共用的防刷线，管理员也一样：
 * 每人每分钟、每小时最多发起几次；每人同时最多几个在生成；整个实例同时最多几个在生成。
 */
export const AI_LIMITS = { perMinute: 20, perHour: 300, runningPerUser: 2, runningAll: 12 } as const;

function aiRate(userId: string) {
  const r = hitAll([
    { key: `ai:m:${userId}`, limit: AI_LIMITS.perMinute, windowMs: 60_000 },
    { key: `ai:h:${userId}`, limit: AI_LIMITS.perHour, windowMs: 3600_000 },
  ]);
  if (!r.ok) throw new UsageLimitError(`AI 功能点得太频繁了，请 ${fmtWait(r.retryAfterMs)}后再试。`);
}

/** 占一个「正在生成」的名额再调 AI；名额满了直接拒绝，不排队 */
export async function withAiSlot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  aiRate(userId);
  const mine = `ai:run:${userId}`;
  if (!acquire(mine, AI_LIMITS.runningPerUser)) throw new UsageLimitError("你还有内容正在生成，等它好了再点。");
  if (!acquire("ai:run:all", AI_LIMITS.runningAll)) {
    release(mine);
    throw new UsageLimitError("现在用的人比较多，请过半分钟再试。");
  }
  try {
    return await fn();
  } finally {
    release(mine);
    release("ai:run:all");
  }
}

/** 这位用户现在还能不能用：开源版恒为 true */
export async function canUse(userId: string): Promise<boolean> {
  void userId;
  return true;
}

/** 不单独收费的 AI 功能，每人每天最多用几次（只在计费版生效；开源版不限，保留常量兼容） */
export const FREE_AI_DAILY = { style: 10, learn: 20, blind: 10, points: 200, outline: 100, memory: 10, image: 100 } as const;
export type FreeAiKind = keyof typeof FREE_AI_DAILY;

/**
 * 不单独收费的 AI 功能入口检查：开源版只过一遍 AI 防刷限流，不查余额、不限每天次数
 * （和原版「不扣费的用户」的行为一致）。
 */
export async function requireActive(userId: string, kind: FreeAiKind): Promise<void> {
  void kind;
  aiRate(userId);
}

/**
 * 长文各步骤对应的计费项目（开源版只用于流水文案分类）：
 * 写成一篇按形式分三档，改写一段按「生成」，列提纲不计
 */
export function longformItem(task: {
  kind: "outline" | "candidates" | "write" | "rewrite";
  format: "single" | "thread" | "article";
}): PriceKey | null {
  if (task.kind === "outline") return null;
  if (task.kind === "rewrite") return "generate";
  return task.format === "thread" ? "long_thread" : task.format === "article" ? "long_article" : "long_single";
}

/** 推文里有链接吗 */
export function hasLink(text: string): boolean {
  return twitterText.extractUrls(text).length > 0;
}

export const postItem = (text: string): PriceKey => (hasLink(text) ? "post_link" : "post");

/** 一组推文按原计费规则折算的 Cost（开源版只用于兼容签名，不再真的扣费） */
export function postsCost(tweets: string[], sent = tweets.length, threadIncluded = DEFAULT_CONFIG.threadIncluded): Cost {
  const part = tweets.slice(0, sent);
  const links = part.filter(hasLink).length;
  const plain = part.length - links;
  if (tweets.length <= 1 || tweets.filter((t) => !hasLink(t)).length <= 1) return { post_link: links, post: plain };
  return {
    post_link: links,
    thread: plain > 0 ? 1 : 0,
    thread_extra: Math.max(0, plain - threadIncluded),
  };
}

/** a 比 b 多出来的部分（每项不小于 0） */
export function costMinus(a: Cost, b: Cost): Cost {
  const out: Cost = {};
  for (const [k, n] of Object.entries(a) as [PriceKey, number][]) out[k] = Math.max(0, n - (b[k] ?? 0));
  return out;
}

/** 价目表的说明（把 {n} 换成设定的条数） */
export function priceLabel(p: { label: string }, cfg: BillingConfig): string {
  return p.label.replaceAll("{n}", String(cfg.threadIncluded));
}

/** 一条普通推文（写 + 发）的折算价（微 USDT），只用于估算显示 */
export function postUnitMicro(cfg: BillingConfig): number {
  return toMicro(cfg.prices.generate ?? 0) + toMicro(cfg.prices.post ?? 0);
}

/** 这么多钱大约能发几条普通推文；不计费时返回 null */
export function estimatePosts(cfg: BillingConfig, availableMicro: number): number | null {
  const unit = postUnitMicro(cfg);
  if (!cfg.enabled || unit <= 0) return null;
  return Math.max(0, Math.floor(availableMicro / unit));
}

/** 这位用户预计还能发几条：开源版不计费，恒返回 null（不显示这个估算） */
export async function postsLeft(userId: string): Promise<number | null> {
  void userId;
  return null;
}

export function priceList(cfg: BillingConfig) {
  return PRICE_ITEMS.map((p) => ({ key: p.key, label: priceLabel(p, cfg), unit: p.unit, price: cfg.prices[p.key] }));
}

export async function recentLedger(userId: string, limit = 30) {
  const db = await getDb();
  const rows = await db
    .select({ row: schema.ledger, actorName: schema.users.name, actorEmail: schema.users.email })
    .from(schema.ledger)
    .leftJoin(schema.users, eq(schema.users.id, schema.ledger.actorUserId))
    .where(eq(schema.ledger.userId, userId))
    .orderBy(desc(schema.ledger.createdAt))
    .limit(limit);
  return rows.map(({ row, actorName, actorEmail }) => ({
    ...row,
    actorName: row.actorUserId ? actorName || actorEmail?.split("@")[0] || "成员" : null,
  }));
}

export function itemLabel(item: string | null): string {
  return PRICE_ITEMS.find((p) => p.key === item)?.short ?? (item ? (LEGACY_SHORT[item] ?? "") : "");
}

/** 流水的说明（不含金额） */
export function ledgerLabel(r: { kind: string; item: string | null; quantity: number; note: string | null; actorName?: string | null }): string {
  const base = ledgerBase(r);
  return r.actorName ? `${base}（团队成员 ${r.actorName}）` : base;
}

function ledgerBase(r: { kind: string; item: string | null; quantity: number; note: string | null }): string {
  if (r.kind === "charge") return `${itemLabel(r.item)}${r.quantity > 1 ? ` ×${r.quantity}` : ""}`;
  if (r.kind === "refund") return `退回：${itemLabel(r.item)}${r.quantity > 1 ? ` ×${r.quantity}` : ""}（没做成）`;
  if (r.kind === "topup") return `充值${r.note ? `（${r.note}）` : ""}`;
  if (r.kind === "bonus") return r.note || "赠送";
  return `调整${r.note ? `：${r.note}` : ""}`;
}

/** 扣费、退回不显示金额，赠送、调整照常显示 */
export const showsAmount = (kind: string) => kind !== "charge" && kind !== "refund";

/** 给用户看的一行流水 */
export function ledgerLine(r: { kind: string; item: string | null; quantity: number; amountMicro: number; note: string | null; actorName?: string | null }): string {
  if (!showsAmount(r.kind)) return ledgerLabel(r);
  return `${ledgerLabel(r)}  ${r.amountMicro >= 0 ? "+" : ""}${fmtUsdt(r.amountMicro)}`;
}
