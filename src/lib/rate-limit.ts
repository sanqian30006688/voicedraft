/**
 * 防刷：限流、冷却、临时封禁。
 *
 * 全部放在内存里（应用是单进程运行的），不碰数据库，所以挡掉一条刷屏消息几乎不花成本。
 * 重启后计数清零，这没关系：攻击者也得从头再来。
 */

const g = globalThis as unknown as {
  __vdRate?: {
    hits: Map<string, number[]>;
    bans: Map<string, { until: number; level: number; at: number }>;
    running: Map<string, number>;
  };
};
const store = (g.__vdRate ??= { hits: new Map(), bans: new Map(), running: new Map() });

const DAY = 24 * 3600_000;

function prune(now: number) {
  if (store.hits.size > 50_000) {
    for (const [k, ts] of store.hits) if (!ts.length || now - ts[ts.length - 1] > DAY) store.hits.delete(k);
  }
  if (store.bans.size > 10_000) {
    for (const [k, b] of store.bans) if (now - b.at > DAY && b.until < now) store.bans.delete(k);
  }
}

/** 只看不记：这个 key 在窗口里已经有几次 */
export function count(key: string, windowMs: number, now = Date.now()): number {
  const ts = store.hits.get(key);
  if (!ts) return 0;
  let n = 0;
  for (let i = ts.length - 1; i >= 0 && now - ts[i] < windowMs; i--) n++;
  return n;
}

/**
 * 记一次，并判断有没有超限（滑动窗口：windowMs 内最多 limit 次）。
 * 超限时这次不计入，返回还要等多久。
 */
export function hit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterMs: number } {
  prune(now);
  const ts = (store.hits.get(key) ?? ([] as number[])).filter((t: number) => now - t < Math.max(windowMs, 1));
  if (ts.length >= limit) {
    store.hits.set(key, ts);
    return { ok: false, retryAfterMs: Math.max(1000, windowMs - (now - ts[ts.length - limit])) };
  }
  ts.push(now);
  // 只留够判断用的条数，防止一个 key 占太多内存
  store.hits.set(key, ts.length > limit ? ts.slice(-limit) : ts);
  return { ok: true, retryAfterMs: 0 };
}

/** 多条规则一起检查：全部没超才计一次 */
export function hitAll(rules: { key: string; limit: number; windowMs: number }[], now = Date.now()) {
  for (const r of rules) {
    if (count(r.key, r.windowMs, now) >= r.limit) {
      return hit(r.key, r.limit, r.windowMs, now); // 超了：拿到等待时间（不会计入）
    }
  }
  for (const r of rules) hit(r.key, r.limit, r.windowMs, now);
  return { ok: true, retryAfterMs: 0 };
}

// ---------- 临时封禁 ----------

/** 封禁时长逐级加长：10 分钟 → 1 小时 → 6 小时 → 24 小时 */
export const BAN_STEPS_MS = [10 * 60_000, 3600_000, 6 * 3600_000, DAY];

export function bannedFor(key: string, now = Date.now()): number {
  const b = store.bans.get(key);
  return b && b.until > now ? b.until - now : 0;
}

/** 封一次；距离上次封禁不到一天的话，这次更久 */
export function ban(key: string, now = Date.now()): number {
  const prev = store.bans.get(key);
  const level = prev && now - prev.at < DAY ? Math.min(prev.level + 1, BAN_STEPS_MS.length - 1) : 0;
  const ms = BAN_STEPS_MS[level];
  store.bans.set(key, { until: now + ms, level, at: now });
  return ms;
}

export function unban(key: string) {
  store.bans.delete(key);
}

// ---------- 同时进行中的任务 ----------

/** 占一个名额；满了返回 false。用完一定要 release */
export function acquire(key: string, max: number): boolean {
  const n = store.running.get(key) ?? 0;
  if (n >= max) return false;
  store.running.set(key, n + 1);
  return true;
}

export function release(key: string) {
  const n = (store.running.get(key) ?? 1) - 1;
  if (n <= 0) store.running.delete(key);
  else store.running.set(key, n);
}

/** 测试用：清空所有计数 */
export function resetRateLimits() {
  store.hits.clear();
  store.bans.clear();
  store.running.clear();
}

export function fmtWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.ceil(m / 60)} 小时`;
}

/**
 * 请求方 IP。x-forwarded-for 最左边的值是客户端自己填的，可以伪造，不能拿来限流；
 * 每一层可信代理都会把它看到的来源 IP 追加到最右边，所以从右往左数：
 * 默认只有 1 层代理（TRUSTED_PROXY_HOPS=1，取最右一个）；前面再套了 Cloudflare 等就设成 2。
 * 不信任 cf-connecting-ip / x-real-ip（没有代理改写时同样能被伪造）。
 * 本机直接打开时没有这个头，统一算作一个来源。
 */
export function clientIp(request: Request): string {
  const parts = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return "direct";
  const hops = Math.max(1, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS) || 1));
  return parts[Math.max(0, parts.length - hops)].slice(0, 64);
}

export function tooMany(message: string, retryAfterMs: number) {
  return Response.json(
    { error: message },
    { status: 429, headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } },
  );
}
