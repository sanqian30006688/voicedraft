import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TweetMetrics } from "@/db/schema";
import { publicUrl } from "./platform-config";
import { decrypt, encrypt } from "./secret";
import { recordXCall } from "./usage";

/**
 * X 官方 API（v2）+ OAuth 2.0 用户授权（PKCE）。
 * 只用官方接口：发推、删推、读取提及、读取本人书签、读取本人首页时间线（关注的人）、按 id 读取单条推文、
 * 读取本人的关注 / 粉丝列表、用户自己点了才取关一个人（互关检测）。不抓取、不模拟浏览器。
 */

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const API = "https://api.x.com/2";

/**
 * 一次把以后可能用到的权限都申请好，免得每加一个新功能用户都要重新连接一次 X：
 * 读写推文、隐藏回复、上传配图、读取资料、关注 / 粉丝、点赞、书签、列表、静音、屏蔽、Spaces、长期授权（刷新令牌）。
 * 不申请私信（dm.*，项目规定不做自动私信）和邮箱（users.email）。
 * 申请到权限不等于会用：点赞、关注这类互动仍然只在用户自己点了才做，不会自动做。
 */
export const SCOPES = [
  "tweet.read",
  "tweet.write",
  "tweet.moderate.write",
  "media.write",
  "users.read",
  "follows.read",
  "follows.write",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
  "list.read",
  "list.write",
  "mute.read",
  "mute.write",
  "block.read",
  "block.write",
  "space.read",
  "offline.access",
];

/** 账号授权里有没有某项权限（早先连接的账号没有书签权限，需要重新连接一次） */
export function hasScope(acc: { scopes: string }, scope: string): boolean {
  return isXMock() || acc.scopes.split(/[\s,]+/).includes(scope);
}

/** X_MOCK=1 时不连真实 X：连接、发布、提及都是模拟的，方便先看流程 */
export function isXMock(): boolean {
  return process.env.X_MOCK === "1";
}

export function isXConfigured(): boolean {
  return isXMock() || Boolean(process.env.X_CLIENT_ID);
}

export function redirectUri(): string {
  const base = publicUrl();
  return process.env.X_REDIRECT_URI || (base ? `${base}/api/x/callback` : "http://127.0.0.1:3000/api/x/callback");
}

export type XErrorKind = "auth" | "rate_limit" | "duplicate" | "credits" | "forbidden" | "not_found" | "other";

export class XApiError extends Error {
  constructor(
    message: string,
    public kind: XErrorKind,
    public status: number,
    /** 限流时 X 告知的恢复时间 */
    public resetAt?: Date,
  ) {
    super(message);
  }
}

// ---------- OAuth ----------

export function createPkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  return { verifier, challenge, state };
}

export function authorizeUrl(state: string, challenge: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.X_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

/** 机密客户端（有 X_CLIENT_SECRET）用 Basic 认证；公开客户端把 client_id 放在表单里 */
async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const id = process.env.X_CLIENT_ID ?? "";
  const secret = process.env.X_CLIENT_SECRET;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams(params);
  if (secret) headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  else body.set("client_id", id);
  const res = await fetch(`${API}/oauth2/token`, { method: "POST", headers, body });
  const data = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error_description?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new XApiError(
      `X 授权失败：${data.error_description || data.error || res.status}`,
      "auth",
      res.status,
    );
  }
  return data as TokenResponse;
}

export async function exchangeCode(code: string, verifier: string) {
  if (isXMock()) {
    return { access_token: "mock", refresh_token: "mock", expires_in: 7200, scope: SCOPES.join(" ") };
  }
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
}

export async function revokeToken(token: string) {
  if (isXMock()) return;
  const id = process.env.X_CLIENT_ID ?? "";
  const secret = process.env.X_CLIENT_SECRET;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ token, token_type_hint: "access_token" });
  if (secret) headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  else body.set("client_id", id);
  await fetch(`${API}/oauth2/revoke`, { method: "POST", headers, body }).catch(() => undefined);
}

/** 演示模式（X_MOCK=1）下直接连上一个属于这位用户的演示账号 */
export async function connectMock(userId: string, tag: string = userId) {
  return saveAccount(userId, { access_token: `mock:${tag}`, refresh_token: "mock", expires_in: 7200, scope: SCOPES.join(" ") });
}

/** 一个 X 账号只能绑定一个 VoiceDraft 账号 */
export const X_TAKEN_MESSAGE =
  "这个 X 账号已经绑定在另一个 VoiceDraft 账号上了。一个 X 账号只能绑定一个账号；如果要换绑，请先在原来的账号里断开 X。";

/** 保存（或更新）用户绑定的 X 账号 */
export async function saveAccount(userId: string, token: TokenResponse) {
  const me = await getMe(token.access_token);
  const db = await getDb();
  const [owner] = await db
    .select({ userId: schema.xAccounts.userId })
    .from(schema.xAccounts)
    .where(eq(schema.xAccounts.xUserId, me.id))
    .limit(1);
  if (owner && owner.userId !== userId) throw new XApiError(X_TAKEN_MESSAGE, "forbidden", 409);
  const values = {
    userId,
    xUserId: me.id,
    handle: me.username,
    name: me.name,
    scopes: token.scope,
    accessTokenEnc: encrypt(token.access_token),
    refreshTokenEnc: token.refresh_token ? encrypt(token.refresh_token) : null,
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
    authError: null,
    premium: me.premium,
    premiumCheckedAt: new Date(),
    updatedAt: new Date(),
  };
  const [existing] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, userId)).limit(1);
  if (existing) {
    // 换了另一个 X 账号时，提及的拉取进度要重来
    const switched = existing.xUserId !== me.id;
    await db
      .update(schema.xAccounts)
      .set({ ...values, ...(switched ? { mentionsSinceId: null, lastCheckedAt: null, timelineSinceId: null, timelineCheckedAt: null } : {}) })
      .where(eq(schema.xAccounts.id, existing.id));
    if (switched) {
      // 旧账号收到的提及不能用新账号去回复
      await db
        .update(schema.replyItems)
        .set({ status: "skipped", skipReason: "已更换 X 账号", updatedAt: new Date() })
        .where(and(eq(schema.replyItems.userId, userId), inArray(schema.replyItems.status, ["pending", "failed"])));
    }
  } else {
    await db.insert(schema.xAccounts).values(values);
  }
  // TG 也绑好了的新用户：这时候发新人赠送（动态引入，避免和机器人那边互相引用）
  await import("./tg-gate")
    .then((m) => m.grantNewUserBonus(userId))
    .catch((e) => console.error("[x] 新人赠送失败", e));
  return me;
}

export type XAccount = typeof schema.xAccounts.$inferSelect;

export async function getAccount(userId: string): Promise<XAccount | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, userId)).limit(1);
  return row ?? null;
}

// 同一账号同时刷新令牌时只刷新一次（刷新令牌是一次性的）
const refreshing = new Map<string, Promise<string>>();

/** 取可用的访问令牌，快过期时自动刷新 */
async function accessToken(acc: XAccount): Promise<string> {
  if (isXMock()) return "mock";
  if (acc.authError) throw new XApiError(`X 授权已失效，请重新连接：${acc.authError}`, "auth", 401);
  if (acc.expiresAt.getTime() - Date.now() > 60_000) return decrypt(acc.accessTokenEnc);
  return refreshAccessToken(acc);
}

function refreshAccessToken(acc: XAccount): Promise<string> {
  const running = refreshing.get(acc.id);
  if (running) return running;
  const p = (async () => {
    const db = await getDb();
    // 读最新的一行：另一个请求可能刚刷新过
    const [fresh] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.id, acc.id)).limit(1);
    if (!fresh) throw new XApiError("X 账号已断开", "auth", 401);
    if (fresh.expiresAt.getTime() - Date.now() > 60_000) return decrypt(fresh.accessTokenEnc);
    if (!fresh.refreshTokenEnc) {
      await markAuthError(acc.id, "授权已过期");
      throw new XApiError("X 授权已过期，请重新连接", "auth", 401);
    }
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(fresh.refreshTokenEnc) });
      await db
        .update(schema.xAccounts)
        .set({
          accessTokenEnc: encrypt(t.access_token),
          refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : fresh.refreshTokenEnc,
          expiresAt: new Date(Date.now() + t.expires_in * 1000),
          scopes: t.scope || fresh.scopes,
          updatedAt: new Date(),
        })
        .where(eq(schema.xAccounts.id, acc.id));
      return t.access_token;
    } catch (e) {
      if (e instanceof XApiError && e.status >= 400 && e.status < 500) {
        await markAuthError(acc.id, "授权已被撤销或过期");
      }
      throw e;
    }
  })().finally(() => refreshing.delete(acc.id));
  refreshing.set(acc.id, p);
  return p;
}

async function markAuthError(accountId: string, reason: string) {
  const db = await getDb();
  await db.update(schema.xAccounts).set({ authError: reason, updatedAt: new Date() }).where(eq(schema.xAccounts.id, accountId));
}

// ---------- 接口调用 ----------

interface XErrorBody {
  title?: string;
  detail?: string;
  type?: string;
  errors?: { message?: string; title?: string; detail?: string }[];
}

function toError(res: Response, body: XErrorBody): XApiError {
  const detail = body.detail || body.errors?.[0]?.message || body.errors?.[0]?.detail || body.title || "";
  const text = `${body.title ?? ""} ${detail} ${body.type ?? ""}`.toLowerCase();
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    const resetAt = reset ? new Date(reset * 1000) : new Date(Date.now() + 15 * 60_000);
    return new XApiError(
      `触发了 X 的频率限制，${resetAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 后恢复`,
      "rate_limit",
      429,
      resetAt,
    );
  }
  if (res.status === 401) return new XApiError("X 授权已失效，请重新连接", "auth", 401);
  if (res.status === 402 || text.includes("credit")) {
    return new XApiError("X API 额度不足，请到 X 开发者后台充值或升级", "credits", res.status);
  }
  if (text.includes("duplicate")) return new XApiError("X 不允许发和之前完全相同的内容", "duplicate", res.status);
  if (res.status === 404) return new XApiError("X 上找不到这条推文（可能已被删除）", "not_found", 404);
  if (res.status === 403) return new XApiError(`X 拒绝了这次请求：${detail || "没有权限"}`, "forbidden", 403);
  return new XApiError(`X 返回错误（${res.status}）：${detail || "未知原因"}`, "other", res.status);
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new XApiError("连不上 X，请检查网络后重试", "other", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & XErrorBody;
  if (!res.ok) throw toError(res, data);
  // 平台方的 X 成本：发了几条、读了几条（只记成功的）
  void recordXCall(method, path.split("?")[0], data);
  return data;
}

/** 带令牌调用；令牌被 X 拒绝时刷新一次再试 */
async function callAs<T>(acc: XAccount, method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken(acc);
  try {
    return await call<T>(token, method, path, body);
  } catch (e) {
    if (e instanceof XApiError && e.kind === "auth" && acc.refreshTokenEnc) {
      const db = await getDb();
      // 让本地记录视为过期，强制刷新
      await db.update(schema.xAccounts).set({ expiresAt: new Date(0) }).where(eq(schema.xAccounts.id, acc.id));
      const again = await refreshAccessToken({ ...acc, expiresAt: new Date(0) });
      return call<T>(again, method, path, body);
    }
    throw e;
  }
}

/** X 会员字段 → 能不能发长推：Basic / Premium / Premium+ 都能；没有 subscription_type 时看是不是蓝标 */
export function parsePremium(d: { subscription_type?: string; verified_type?: string }): boolean {
  if (d.subscription_type) return /^(basic|premium|premiumplus)$/i.test(d.subscription_type);
  return d.verified_type === "blue";
}

const ME_FIELDS = "subscription_type,verified_type";

export async function getMe(token: string): Promise<{ id: string; username: string; name: string; premium: boolean }> {
  if (isXMock()) {
    // 演示模式：每位用户各有一个自己的演示账号（令牌形如 mock:<标识>）
    const tag = token.startsWith("mock:") ? token.slice(5) : "";
    return tag
      ? { id: `mock-${tag}`, username: `demo_${tag.slice(0, 8)}`, name: "演示账号", premium: false }
      : { id: "1000", username: "demo_user", name: "演示账号", premium: false };
  }
  const r = await call<{ data: { id: string; username: string; name: string; subscription_type?: string; verified_type?: string } }>(
    token,
    "GET",
    `/users/me?user.fields=${ME_FIELDS}`,
  );
  return { id: r.data.id, username: r.data.username, name: r.data.name, premium: parsePremium(r.data) };
}

async function savePremium(acc: XAccount, premium: boolean) {
  const db = await getDb();
  await db.update(schema.xAccounts).set({ premium, premiumCheckedAt: new Date() }).where(eq(schema.xAccounts.id, acc.id));
}

/**
 * 是不是 X 会员（能不能一条发长推）。连接时读一次，每天读账号数据时顺便更新；
 * 超过 7 天没查过才再去 X 读一次
 */
export async function isPremium(acc: XAccount): Promise<boolean> {
  if (acc.premium != null && acc.premiumCheckedAt && Date.now() - acc.premiumCheckedAt.getTime() < 7 * 86400_000) return acc.premium;
  if (isXMock()) return acc.premium ?? false;
  try {
    const r = await callAs<{ data: { subscription_type?: string; verified_type?: string } }>(acc, "GET", `/users/me?user.fields=${ME_FIELDS}`);
    const premium = parsePremium(r.data);
    await savePremium(acc, premium);
    return premium;
  } catch {
    return acc.premium ?? false;
  }
}

export interface PublicMetrics {
  followers: number;
  following: number;
  tweets: number;
  listed: number;
  likes: number;
}

/** 本人账号的公开数据（粉丝、关注、发帖总数等）：GET /users/me，每个账号每天只读一次 */
export async function getPublicMetrics(acc: XAccount): Promise<PublicMetrics> {
  if (isXMock()) {
    // 演示模式：按账号和日期给一组固定的数字，每天慢慢涨
    let h = 0;
    for (const c of acc.xUserId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const day = Math.floor(Date.now() / 86400_000);
    return { followers: 500 + (h % 5000) + (day % 100) * 3, following: 100 + (h % 300), tweets: 1000 + (h % 2000) + (day % 100) * 2, listed: h % 20, likes: 3000 + (h % 9000) };
  }
  const r = await callAs<{
    data: {
      public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number; listed_count?: number; like_count?: number };
      subscription_type?: string;
      verified_type?: string;
    };
  }>(acc, "GET", `/users/me?user.fields=public_metrics,${ME_FIELDS}`);
  // 顺便记下是不是会员（不多花一次读取）
  await savePremium(acc, parsePremium(r.data)).catch(() => {});
  const m = r.data.public_metrics ?? {};
  return {
    followers: m.followers_count ?? 0,
    following: m.following_count ?? 0,
    tweets: m.tweet_count ?? 0,
    listed: m.listed_count ?? 0,
    likes: m.like_count ?? 0,
  };
}


/**
 * 读自己发出的推文的数据（浏览、点赞、转发、回复、引用、收藏）：GET /tweets?ids=，一次最多 100 条。
 * 返回 id → 数据；X 上找不到的（删了）不在结果里。
 */
/** 按 id 读推文里的图片地址（给之前收进来、没记图的推文补图用），一次最多 100 条 */
export async function fetchTweetPhotos(acc: XAccount, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  if (isXMock()) {
    for (const id of ids) out.set(id, [`https://pbs.twimg.com/media/mock-${id}.jpg`]);
    return out;
  }
  for (let i = 0; i < ids.length; i += 100) {
    const q = new URLSearchParams({ ids: ids.slice(i, i + 100).join(","), expansions: "attachments.media_keys", "media.fields": "type,url" });
    const r = await callAs<TweetsResponse>(acc, "GET", `/tweets?${q}`);
    const photos = new Map((r.includes?.media ?? []).filter((m) => m.type === "photo" && m.url).map((m) => [m.media_key, m.url!]));
    for (const t of Array.isArray(r.data) ? r.data : r.data ? [r.data] : []) {
      out.set(t.id, (t.attachments?.media_keys ?? []).map((k) => photos.get(k)).filter((u): u is string => !!u));
    }
  }
  return out;
}

export async function getTweetMetrics(acc: XAccount, ids: string[]): Promise<Map<string, TweetMetrics>> {
  const out = new Map<string, TweetMetrics>();
  if (!ids.length) return out;
  if (isXMock()) {
    // 演示模式：按 id 给一组固定的数字；含「[已删除]」标记的 id 当作删了
    for (const id of ids) {
      if (id.includes("deleted")) continue;
      let h = 0;
      for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      out.set(id, { impressions: 200 + (h % 5000), likes: h % 80, retweets: h % 9, replies: h % 13, quotes: h % 4, bookmarks: h % 7 });
    }
    return out;
  }
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const q = new URLSearchParams({ ids: part.join(","), "tweet.fields": "public_metrics" });
    const r = await callAs<{
      data?: {
        id: string;
        public_metrics?: { impression_count?: number; like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number; bookmark_count?: number };
      }[];
    }>(acc, "GET", `/tweets?${q}`);
    for (const t of r.data ?? []) {
      const m = t.public_metrics ?? {};
      out.set(t.id, {
        impressions: m.impression_count ?? 0,
        likes: m.like_count ?? 0,
        retweets: m.retweet_count ?? 0,
        replies: m.reply_count ?? 0,
        quotes: m.quote_count ?? 0,
        bookmarks: m.bookmark_count ?? 0,
      });
    }
  }
  return out;
}

let mockSeq = Date.now();

/** 测试用：记录模拟发出的帖子带了哪些图 */
export const mockMediaLog: { text: string; mediaIds: string[] }[] = [];

/** 发一条推文；replyTo 有值时作为回复发出，quoteOf 有值时作为引用推文发出，mediaIds 是先上传好的配图 */
export async function createPost(acc: XAccount, text: string, replyTo?: string, quoteOf?: string, mediaIds?: string[]): Promise<string> {
  if (isXMock()) {
    if (text.includes("[模拟失败]")) throw new XApiError("（演示）模拟的发布失败", "other", 500);
    if (mediaIds?.length) mockMediaLog.push({ text, mediaIds });
    return String(mockSeq++);
  }
  const r = await callAs<{ data: { id: string } }>(acc, "POST", "/tweets", {
    text,
    ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}),
    ...(quoteOf ? { quote_tweet_id: quoteOf } : {}),
    ...(mediaIds?.length ? { media: { media_ids: mediaIds } } : {}),
  });
  return r.data.id;
}

/** 上传一张配图（PNG / JPEG），返回 media id，发帖时带上。需要 media.write 权限 */
export async function uploadMedia(acc: XAccount, data: Uint8Array, mime: string): Promise<string> {
  if (isXMock()) return `m${mockSeq++}`;
  const send = async (token: string) => {
    const form = new FormData();
    form.set("media", new Blob([new Uint8Array(data)], { type: mime }), mime === "image/jpeg" ? "image.jpg" : "image.png");
    form.set("media_category", "tweet_image");
    let res: Response;
    try {
      res = await fetch(`${API}/media/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new XApiError("连不上 X，配图没传上去，请稍后重试", "other", 0);
    }
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string } } & XErrorBody;
    if (!res.ok || !body.data?.id) throw toError(res, body);
    return body.data.id;
  };
  try {
    return await send(await accessToken(acc));
  } catch (e) {
    if (e instanceof XApiError && e.kind === "auth" && acc.refreshTokenEnc) {
      const db = await getDb();
      await db.update(schema.xAccounts).set({ expiresAt: new Date(0) }).where(eq(schema.xAccounts.id, acc.id));
      return send(await refreshAccessToken({ ...acc, expiresAt: new Date(0) }));
    }
    throw e;
  }
}

export async function deletePost(acc: XAccount, id: string): Promise<void> {
  if (isXMock()) return;
  try {
    await callAs(acc, "DELETE", `/tweets/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof XApiError && e.kind === "not_found") return;
    throw e;
  }
}

export interface Mention {
  id: string;
  text: string;
  conversationId: string | null;
  authorId: string;
  authorHandle: string;
  authorName: string | null;
  createdAt: Date | null;
  inReplyToText: string | null;
}

interface MentionsResponse {
  data?: {
    id: string;
    text: string;
    author_id: string;
    conversation_id?: string;
    created_at?: string;
    referenced_tweets?: { type: string; id: string }[];
  }[];
  includes?: {
    users?: { id: string; username: string; name: string }[];
    tweets?: { id: string; text: string }[];
  };
  meta?: { newest_id?: string; next_token?: string };
}

/**
 * 增量拉取 @本人 的推文（别人在本人推文下的评论默认也会 @本人，一并包含）。
 * 首次拉取（没有 sinceId）只取最近 20 条。返回结果按时间正序。
 */
/** limit：最多读几条（按余额算，读多少扣多少，不让余额扣成负数） */
export async function fetchMentions(
  acc: XAccount,
  sinceId: string | null,
  limit = Infinity,
): Promise<{ items: Mention[]; newestId: string | null }> {
  if (isXMock()) return mockMentions(sinceId);
  const items: Mention[] = [];
  let newestId: string | null = null;
  let next: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({
      // X 规定每页 5–100 条
      max_results: String(Math.max(5, Math.min(sinceId ? 100 : 20, limit - items.length))),
      "tweet.fields": "created_at,conversation_id,author_id,referenced_tweets",
      expansions: "author_id,referenced_tweets.id",
      "user.fields": "username,name",
    });
    if (sinceId) q.set("since_id", sinceId);
    if (next) q.set("pagination_token", next);
    const r = await callAs<MentionsResponse>(acc, "GET", `/users/${acc.xUserId}/mentions?${q}`);
    newestId ??= r.meta?.newest_id ?? null;
    const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u]));
    const tweets = new Map((r.includes?.tweets ?? []).map((t) => [t.id, t.text]));
    for (const t of r.data ?? []) {
      const parent = t.referenced_tweets?.find((x) => x.type === "replied_to");
      const u = users.get(t.author_id);
      items.push({
        id: t.id,
        text: t.text,
        conversationId: t.conversation_id ?? null,
        authorId: t.author_id,
        authorHandle: u?.username ?? t.author_id,
        authorName: u?.name ?? null,
        createdAt: t.created_at ? new Date(t.created_at) : null,
        inReplyToText: parent ? (tweets.get(parent.id) ?? null) : null,
      });
    }
    next = r.meta?.next_token;
    // 首次拉取只要最近一页
    if (!sinceId || !next || items.length >= limit) break;
  }
  items.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return { items, newestId };
}

function mockMentions(sinceId: string | null): { items: Mention[]; newestId: string | null } {
  if (sinceId) return { items: [], newestId: null };
  const base = Date.now();
  const items: Mention[] = [
    {
      id: String(base),
      text: "@demo_user 这条说得太对了，能展开讲讲你是怎么坚持下来的吗？",
      conversationId: "c1",
      authorId: "2001",
      authorHandle: "reader_a",
      authorName: "读者 A",
      createdAt: new Date(base - 600_000),
      inReplyToText: "说白了，难的从来不是开始。是第三个月还愿意做。",
    },
    {
      id: String(base + 1),
      text: "@demo_user 不同意，我觉得方法论比坚持更重要。",
      conversationId: "c2",
      authorId: "2002",
      authorHandle: "reader_b",
      authorName: "读者 B",
      createdAt: new Date(base - 300_000),
      inReplyToText: "其实我的看法很简单：先做出来，再谈方法论。",
    },
    {
      id: String(base + 2),
      text: "@demo_user 限时福利！点击链接领取免费课程",
      conversationId: "c3",
      authorId: "2003",
      authorHandle: "spam_bot",
      authorName: "福利号",
      createdAt: new Date(base - 100_000),
      inReplyToText: null,
    },
  ];
  return { items, newestId: String(base + 2) };
}

// ---------- 书签 / 单条推文 ----------

export interface XTweet {
  id: string;
  text: string;
  /** 推文里的图片地址（只要图片，不要视频） */
  media?: string[];
  authorId: string;
  authorHandle: string;
  authorName: string | null;
  createdAt: Date | null;
}

interface TweetsResponse {
  data?: TweetData | TweetData[];
  includes?: { users?: { id: string; username: string; name: string }[]; media?: { media_key: string; type: string; url?: string }[] };
  meta?: { next_token?: string; result_count?: number };
}

interface TweetData {
  id: string;
  text: string;
  author_id: string;
  created_at?: string;
  /** 超过 280 字的长推文，完整正文在这里 */
  note_tweet?: { text?: string };
  attachments?: { media_keys?: string[] };
}

const TWEET_QUERY = {
  "tweet.fields": "created_at,author_id,note_tweet,attachments",
  expansions: "author_id,attachments.media_keys",
  "user.fields": "username,name",
  "media.fields": "type,url",
};

function toTweets(r: TweetsResponse): XTweet[] {
  const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u]));
  const photos = new Map((r.includes?.media ?? []).filter((m) => m.type === "photo" && m.url).map((m) => [m.media_key, m.url!]));
  const list = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  return list.map((t) => {
    const u = users.get(t.author_id);
    return {
      id: t.id,
      text: t.note_tweet?.text || t.text,
      media: (t.attachments?.media_keys ?? []).map((k) => photos.get(k)).filter((u): u is string => !!u),
      authorId: t.author_id,
      authorHandle: u?.username ?? t.author_id,
      authorName: u?.name ?? null,
      createdAt: t.created_at ? new Date(t.created_at) : null,
    };
  });
}

/**
 * 读取本人的书签（最新的在前）。X 不支持 since_id，所以碰到已经收过的推文就停，
 * 首次同步最多读 maxPages 页（每页 100 条），控制按量计费的读取次数。
 */
export async function fetchBookmarks(acc: XAccount, known: Set<string>, maxPages = 2): Promise<XTweet[]> {
  if (isXMock()) return mockBookmarks().filter((t) => !known.has(t.id));
  const out: XTweet[] = [];
  let next: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ ...TWEET_QUERY, max_results: "100" });
    if (next) q.set("pagination_token", next);
    const r = await callAs<TweetsResponse>(acc, "GET", `/users/${acc.xUserId}/bookmarks?${q}`);
    let reachedKnown = false;
    for (const t of toTweets(r)) {
      if (known.has(t.id)) {
        reachedKnown = true;
        continue;
      }
      out.push(t);
    }
    next = r.meta?.next_token;
    if (reachedKnown || !next) break;
  }
  return out;
}

/** 按 id 读取一条推文（用户贴链接时） */
export async function lookupTweet(acc: XAccount, id: string): Promise<XTweet> {
  if (isXMock()) {
    return {
      id,
      text: "（演示）很多人以为做内容靠灵感，其实靠的是每天固定时间坐下来。",
      authorId: "3001",
      authorHandle: "someone",
      authorName: "某位作者",
      createdAt: new Date(),
    };
  }
  const q = new URLSearchParams(TWEET_QUERY);
  const r = await callAs<TweetsResponse>(acc, "GET", `/tweets/${encodeURIComponent(id)}?${q}`);
  const [t] = toTweets(r);
  if (!t) throw new XApiError("X 上找不到这条推文（可能已被删除或设为私密）", "not_found", 404);
  return t;
}

// ---------- X 用户主页（自动发帖的信息源） ----------

/** 从 @name、x.com/name、twitter.com/name 里取出用户名；推文链接、功能页不算 */
export function parseXHandle(input: string): string | null {
  const s = input.trim();
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i) ??
    s.match(/^@([A-Za-z0-9_]{1,15})$/);
  const name = m?.[1];
  if (!name) return null;
  if (/^(home|explore|search|i|settings|messages|notifications|compose|login|signup|tos|privacy|share|intent)$/i.test(name)) return null;
  return name;
}

/** 按用户名查用户 */
export async function lookupUser(acc: XAccount, handle: string): Promise<{ id: string; username: string; name: string }> {
  if (isXMock()) return { id: `mock-u-${handle.toLowerCase()}`, username: handle, name: `${handle}（演示）` };
  const r = await callAs<{ data?: { id: string; username: string; name: string } }>(
    acc,
    "GET",
    `/users/by/username/${encodeURIComponent(handle)}?user.fields=name`,
  );
  if (!r.data) throw new XApiError(`X 上找不到 @${handle}（可能改名、被封或设为私密）`, "not_found", 404);
  return r.data;
}

/**
 * 读某个用户最近的原创推文（不含转推和回复），只读 sinceId 之后的。
 * 首次只读最近 5 条。limit：最多读几条（按余额算）。最新的在前。
 */
export async function fetchUserTweets(acc: XAccount, xUserId: string, sinceId: string | null, limit = 20): Promise<XTweet[]> {
  if (limit <= 0) return [];
  if (isXMock()) {
    if (sinceId) return [];
    return [
      {
        id: String(Date.now()),
        text: "（演示）AI 工具越来越多，真正拉开差距的是谁能把它接进自己每天的工作流。",
        authorId: xUserId,
        authorHandle: "someone",
        authorName: "某位作者",
        createdAt: new Date(),
      },
    ];
  }
  const q = new URLSearchParams({ ...TWEET_QUERY, exclude: "retweets,replies", max_results: String(Math.max(5, Math.min(sinceId ? 20 : 5, limit))) });
  if (sinceId) q.set("since_id", sinceId);
  const r = await callAs<TweetsResponse>(acc, "GET", `/users/${encodeURIComponent(xUserId)}/tweets?${q}`);
  return toTweets(r).slice(0, limit);
}

/** 从 x.com / twitter.com 链接或纯数字里取出推文 id */
export function parseTweetId(input: string): string | null {
  const s = input.trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:x|twitter)\.com\/(?:[A-Za-z0-9_]+|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1] : null;
}

function mockBookmarks(): XTweet[] {
  return [
    {
      id: "1900000000000000003",
      text: "做产品最难的不是想功能，是决定不做什么。每加一个按钮，就多一份维护和解释的成本。",
      authorId: "3001",
      authorHandle: "pm_notes",
      authorName: "产品笔记",
      createdAt: new Date(Date.now() - 3_600_000),
    },
    {
      id: "1900000000000000002",
      text: "写作没有捷径。我见过的高产作者，都是把写作当成上班：固定时间、固定字数，不等灵感。",
      authorId: "3002",
      authorHandle: "writer_daily",
      authorName: "每日写作",
      createdAt: new Date(Date.now() - 86_400_000),
    },
    {
      id: "1900000000000000001",
      text: "AI 不会让平庸的内容变好，只会让平庸的内容变多。",
      authorId: "3003",
      authorHandle: "tech_watch",
      authorName: "科技观察",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    },
  ];
}

// ---------- 关注的人（首页时间线，按时间排序） ----------

/**
 * 读取本人首页时间线（「正在关注」那一栏，按时间倒序），不含回复和转推。
 * 只读一页，最多 limit 条（X 规定每页 1–100 条）；没有 sinceId 时就是最新的 limit 条。
 * 返回的 newestId 用作下次的 sinceId。X 的「为你推荐」没有开放接口，读不到。
 */
export async function fetchHomeTimeline(
  acc: XAccount,
  sinceId: string | null,
  limit: number,
): Promise<{ items: XTweet[]; newestId: string | null }> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  if (isXMock()) {
    if (sinceId) return { items: [], newestId: null };
    const items = mockTimeline(acc).slice(0, n);
    return { items, newestId: items[0]?.id ?? null };
  }
  const q = new URLSearchParams({ ...TWEET_QUERY, max_results: String(n), exclude: "replies,retweets" });
  if (sinceId) q.set("since_id", sinceId);
  const r = await callAs<TweetsResponse>(acc, "GET", `/users/${acc.xUserId}/timelines/reverse_chronological?${q}`);
  // X 偶尔会多给几条，按读到的条数收费前先截断
  const items = toTweets(r).slice(0, n);
  return { items, newestId: items[0]?.id ?? null };
}

function mockTimeline(acc: XAccount): XTweet[] {
  const base = BigInt("1950000000000000000") + BigInt(Date.now());
  const t = (i: number, handle: string, name: string, text: string, authorId = `40${i}`): XTweet => ({
    id: String(base - BigInt(i)),
    text,
    authorId,
    authorHandle: handle,
    authorName: name,
    createdAt: new Date(Date.now() - i * 600_000),
  });
  return [
    t(0, "pm_notes", "产品笔记", "做 AI 产品最容易犯的错：先有模型，再找场景。顺序反了，后面全是补丁。"),
    t(1, "writer_daily", "每日写作", "今天写了 2000 字，删了 1500。剩下的 500 字是这周最满意的。"),
    t(2, acc.handle, acc.name ?? acc.handle, "（这是我自己发的）", acc.xUserId),
    t(3, "promo_shop", "福利号", "限时福利！点击链接领取免费课程 https://example.com"),
    t(4, "tech_watch", "科技观察", "AI 写的东西最大的问题不是错，是没有立场。"),
  ];
}

// ---------- 互关检测：关注 / 粉丝列表、取关 ----------

export interface XPerson {
  id: string;
  handle: string;
  name: string | null;
  /** blue | business | government；没认证为 null */
  verifiedType: string | null;
  followers: number;
  following: number;
}

interface UsersPage {
  data?: {
    id: string;
    username: string;
    name?: string;
    verified?: boolean;
    verified_type?: string;
    public_metrics?: { followers_count?: number; following_count?: number };
  }[];
  meta?: { next_token?: string; result_count?: number };
}

/** 演示模式下被取关的人（按 X 账号记），重新扫描时不再出现在「我关注的」里 */
const mockUnfollowed = ((globalThis as { __vdMockUnfollowed?: Map<string, Set<string>> }).__vdMockUnfollowed ??= new Map());
/** 演示模式：每扫一次粉丝少掉一两个，方便看「取关了我」 */
const mockScans = ((globalThis as { __vdMockScans?: Map<string, number> }).__vdMockScans ??= new Map());

function mockPeople(acc: XAccount, kind: "following" | "followers"): XPerson[] {
  const p = (i: number): XPerson => ({
    id: `mp${i}`,
    handle: `demo_${i}`,
    name: `演示用户 ${i}`,
    verifiedType: i % 4 === 0 ? "blue" : null,
    followers: (i * 137) % 9000,
    following: (i * 59) % 2000,
  });
  if (kind === "following") {
    const gone = mockUnfollowed.get(acc.xUserId) ?? new Set();
    return Array.from({ length: 40 }, (_, i) => p(i)).filter((x) => !gone.has(x.id));
  }
  const n = mockScans.get(acc.xUserId) ?? 0;
  mockScans.set(acc.xUserId, n + 1);
  // 粉丝：编号 20–59（和关注的 0–39 有一半重叠），第 n 次扫描时前 n 个取关了
  return Array.from({ length: 40 }, (_, i) => p(20 + i)).slice(Math.min(n, 10));
}

/**
 * 读本人的关注列表或粉丝列表（GET /users/:id/following | followers），每页最多 1000 人。
 * X 按读到的人数收费，所以最多读 limit 人（按用户先扣下的钱算）。
 */
export async function fetchFollowList(acc: XAccount, kind: "following" | "followers", limit: number): Promise<XPerson[]> {
  if (limit <= 0) return [];
  if (isXMock()) return mockPeople(acc, kind).slice(0, limit);
  const out: XPerson[] = [];
  let next: string | undefined;
  do {
    const q = new URLSearchParams({
      max_results: String(Math.max(1, Math.min(1000, limit - out.length))),
      "user.fields": "verified,verified_type,public_metrics",
    });
    if (next) q.set("pagination_token", next);
    const r = await callAs<UsersPage>(acc, "GET", `/users/${acc.xUserId}/${kind}?${q}`);
    for (const u of r.data ?? []) {
      const vt = u.verified_type && u.verified_type !== "none" ? u.verified_type : u.verified ? "blue" : null;
      out.push({
        id: u.id,
        handle: u.username,
        name: u.name ?? null,
        verifiedType: vt,
        followers: u.public_metrics?.followers_count ?? 0,
        following: u.public_metrics?.following_count ?? 0,
      });
    }
    next = r.meta?.next_token;
  } while (next && out.length < limit);
  return out.slice(0, limit);
}

/** 取关一个人（DELETE /users/:id/following/:target）。只在用户自己点了「取关」时调用，一次一个 */
export async function unfollowUser(acc: XAccount, targetId: string): Promise<void> {
  if (isXMock()) {
    const set = mockUnfollowed.get(acc.xUserId) ?? new Set<string>();
    set.add(targetId);
    mockUnfollowed.set(acc.xUserId, set);
    return;
  }
  await callAs(acc, "DELETE", `/users/${acc.xUserId}/following/${encodeURIComponent(targetId)}`);
}
