import { and, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * 平台方的接口成本：AI 用了多少 token、X 发了多少条 / 读了多少条，按小时累加进 api_usage。
 * 只在真的调用接口时记（演示模式不记）。记失败不影响正常使用。
 *
 * 单价存在 app_settings 的 api_costs 里（后台「日报」可改），算日报时再乘，改了单价对以前的用量也按新价算。
 */

export type UsageProvider = "ai" | "ai_light" | "x";

export interface ApiCosts {
  /** AI 每百万 token 的价格（美元，按 1 USDT ≈ 1 美元算） */
  aiInput: number;
  aiOutput: number;
  aiCacheWrite: number;
  aiCacheRead: number;
  /** 轻量模型（Haiku）的单价，每百万 token */
  aiLightInput: number;
  aiLightOutput: number;
  aiLightCacheWrite: number;
  aiLightCacheRead: number;
  /** X 每发出一条帖子 / 回复 */
  xPost: number;
  /** X 每读到一条推文或一个用户 */
  xRead: number;
}

/**
 * 默认单价：AI 按 Claude Sonnet 5.5 的官方价（输入 2、输出 10、缓存写入 2.5、缓存读取 0.1，每百万 token）；
 * 轻量任务用的 Haiku 5.5 另算（输入 0.1、输出 0.5、缓存写入 0.125、缓存读取 0.01）；
 * X 按次付费的单价是估算，以 X 开发者后台账单为准，在后台改。
 */
export const DEFAULT_COSTS: ApiCosts = {
  aiInput: 2,
  aiOutput: 10,
  aiCacheWrite: 2.5,
  aiCacheRead: 0.1,
  aiLightInput: 0.1,
  aiLightOutput: 0.5,
  aiLightCacheWrite: 0.125,
  aiLightCacheRead: 0.01,
  xPost: 0.01, xRead: 0.005,
};

const COSTS_KEY = "api_costs";

export async function getCosts(): Promise<ApiCosts> {
  const db = await getDb();
  const [row] = await db.select().from(schema.appSettings).where(sql`${schema.appSettings.key} = ${COSTS_KEY}`).limit(1);
  return { ...DEFAULT_COSTS, ...((row?.value as Partial<ApiCosts> | undefined) ?? {}) };
}

export async function saveCosts(next: ApiCosts) {
  const db = await getDb();
  await db
    .insert(schema.appSettings)
    .values({ key: COSTS_KEY, value: next })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next, updatedAt: new Date() } });
}

const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / 3600_000) * 3600_000);

/** 记一笔用量：units 是 token 数或条数 */
export async function recordUsage(provider: UsageProvider, kinds: Record<string, number>, at = new Date()): Promise<void> {
  const rows = Object.entries(kinds)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .map(([kind, units]) => ({ hour: hourOf(at), provider, kind, units: Math.round(units), calls: 1 }));
  if (!rows.length) return;
  try {
    const db = await getDb();
    await db
      .insert(schema.apiUsage)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.apiUsage.hour, schema.apiUsage.provider, schema.apiUsage.kind],
        set: { units: sql`${schema.apiUsage.units} + excluded.units`, calls: sql`${schema.apiUsage.calls} + 1` },
      });
  } catch (e) {
    console.error("[usage] 记录接口用量失败", e instanceof Error ? e.message : e);
  }
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** 从 AI 接口的返回里取出 token 用量记下 */
export function recordAiUsage(usage: AnthropicUsage | null | undefined, model?: string) {
  if (!usage) return Promise.resolve();
  // Haiku 单价差很多，单独记一个 provider，成本才算得准
  return recordUsage(/haiku/i.test(model ?? "") ? "ai_light" : "ai", {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cache_write: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
  });
}

/**
 * 给 AI 客户端用的 fetch：照常请求，成功的 /v1/messages 返回里带着 usage，顺手记下来。
 * 不改返回内容，记录失败也不影响。
 */
export const usageFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  try {
    const url = String(input instanceof Request ? input.url : input);
    if (res.ok && /\/v1\/messages(\?|$)/.test(url) && (res.headers.get("content-type") ?? "").includes("json")) {
      res
        .clone()
        .json()
        .then((d: { usage?: AnthropicUsage; model?: string }) => recordAiUsage(d?.usage, d?.model))
        .catch(() => {});
    }
  } catch {
    // 只是记账，出错不管
  }
  return res;
};

/** X 接口：发出一条记 post；读到的推文 / 用户按条记 read */
export function recordXCall(method: string, path: string, data: unknown) {
  if (method === "POST" && /^\/tweets\/?$/.test(path)) return recordUsage("x", { post: 1 });
  // 取关一次：X 按次收费，单价和发一条帖子差不多，记在 post 里
  if (method === "DELETE" && /^\/users\/[^/]+\/following\//.test(path)) return recordUsage("x", { post: 1 });
  if (method !== "GET" || path.startsWith("/oauth2")) return Promise.resolve();
  const d = (data as { data?: unknown; includes?: { users?: unknown[] } } | null)?.data;
  const n = Array.isArray(d) ? d.length : d ? 1 : 0;
  return recordUsage("x", { read: n });
}

export interface UsageTotals {
  ai: { input: number; output: number; cache_write: number; cache_read: number; calls: number; costMicro: number };
  x: { post: number; read: number; costMicro: number };
  costMicro: number;
}

/** 一段时间里的用量和成本（微 USDT） */
export async function usageBetween(from: Date, to: Date, costs?: ApiCosts): Promise<UsageTotals> {
  const c = costs ?? (await getCosts());
  const db = await getDb();
  const rows = await db
    .select({
      provider: schema.apiUsage.provider,
      kind: schema.apiUsage.kind,
      units: sql<string>`sum(${schema.apiUsage.units})`,
      calls: sql<string>`sum(${schema.apiUsage.calls})`,
    })
    .from(schema.apiUsage)
    .where(and(gte(schema.apiUsage.hour, from), lt(schema.apiUsage.hour, to)))
    .groupBy(schema.apiUsage.provider, schema.apiUsage.kind);
  const get = (p: string, k: string) => Number(rows.find((r) => r.provider === p && r.kind === k)?.units ?? 0);
  const ai = {
    input: get("ai", "input"),
    output: get("ai", "output"),
    cache_write: get("ai", "cache_write"),
    cache_read: get("ai", "cache_read"),
    // 每次调用都有输出，用 output 那一行的次数当调用次数
    calls: Number(rows.find((r) => r.provider === "ai" && r.kind === "output")?.calls ?? 0),
    costMicro: 0,
  };
  // 每百万 token 的价格 × token 数 / 1e6 × 1e6（微 USDT）= 价格 × token 数
  const light = {
    input: get("ai_light", "input"),
    output: get("ai_light", "output"),
    cache_write: get("ai_light", "cache_write"),
    cache_read: get("ai_light", "cache_read"),
  };
  // 轻量模型的 token 并入 AI 总量展示，成本按自己的单价算
  const lightCost = light.input * c.aiLightInput + light.output * c.aiLightOutput + light.cache_write * c.aiLightCacheWrite + light.cache_read * c.aiLightCacheRead;
  ai.calls += Number(rows.find((r) => r.provider === "ai_light" && r.kind === "output")?.calls ?? 0);
  ai.input += light.input;
  ai.output += light.output;
  ai.cache_write += light.cache_write;
  ai.cache_read += light.cache_read;
  ai.costMicro = Math.round(get("ai", "input") * c.aiInput + get("ai", "output") * c.aiOutput + get("ai", "cache_write") * c.aiCacheWrite + get("ai", "cache_read") * c.aiCacheRead + lightCost);
  const x = { post: get("x", "post"), read: get("x", "read"), costMicro: 0 };
  x.costMicro = Math.round((x.post * c.xPost + x.read * c.xRead) * 1_000_000);
  return { ai, x, costMicro: ai.costMicro + x.costMicro };
}
