import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSetting, setSetting } from "./billing";
import { publicUrl } from "./platform-config";

/**
 * 机器人里自动开的账号没有密码：在机器人里发 /web 拿一个一次性登录链接（10 分钟有效），点开就登录网页版。
 * 只存链接的哈希；用过一次就作废。
 */
const TTL_MS = 10 * 60_000;
const key = (token: string) => `weblogin:${createHash("sha256").update(token).digest("hex")}`;

export async function createWebLoginLink(userId: string): Promise<string | null> {
  const base = publicUrl();
  if (!base) return null;
  const token = randomBytes(24).toString("base64url");
  await setSetting(key(token), { userId, exp: Date.now() + TTL_MS });
  return `${base}/auth/tg?t=${token}`;
}

/** 用掉一个登录链接：有效就返回用户 ID */
export async function consumeWebLogin(token: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const k = key(token);
  const v = await getSetting<{ userId: string; exp: number }>(k);
  if (!v) return null;
  const db = await getDb();
  const gone = await db.delete(schema.appSettings).where(eq(schema.appSettings.key, k)).returning();
  if (!gone.length || v.exp < Date.now()) return null;
  return v.userId;
}
