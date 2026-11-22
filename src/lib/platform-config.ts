import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isLocalRequest, writeEnvLocal } from "./env-file";
import { decrypt, encrypt } from "./secret";

/**
 * 平台共用的密钥（X 应用、TG 机器人、AI）在哪里保存：
 * - 本机运行：写进 .env.local（和以前一样）
 * - 服务器上：服务器的文件每次更新都会清空，所以加密存进数据库，启动时读回来
 * 两种情况都会立即生效，不用重启。
 */
export const PLATFORM_KEYS = ["X_CLIENT_ID", "X_CLIENT_SECRET", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

const SETTING_KEY = "platform_env";

export async function savePlatformEnv(request: Request, values: Partial<Record<PlatformKey, string>>) {
  if (isLocalRequest(request) && !process.env.DATABASE_URL) {
    writeEnvLocal(values as Record<string, string>);
    return;
  }
  const db = await getDb();
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, SETTING_KEY)).limit(1);
  const current = row ? readStored(row.value) : {};
  const next = { ...current, ...values };
  const value = { enc: encrypt(JSON.stringify(next)) };
  await db
    .insert(schema.appSettings)
    .values({ key: SETTING_KEY, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } });
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

function readStored(value: unknown): Record<string, string> {
  const enc = (value as { enc?: string } | null)?.enc;
  if (!enc) return {};
  try {
    return JSON.parse(decrypt(enc)) as Record<string, string>;
  } catch (e) {
    console.error("[platform] 读不出保存的平台密钥（TOKEN_ENCRYPTION_KEY 变了？）", e instanceof Error ? e.message : e);
    return {};
  }
}

/** 启动时把数据库里保存的平台密钥放进环境变量 */
export async function loadPlatformEnv() {
  const db = await getDb();
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, SETTING_KEY)).limit(1);
  if (!row) return;
  const stored = readStored(row.value);
  for (const k of PLATFORM_KEYS) if (stored[k]) process.env[k] = stored[k];
}

/**
 * 搬到服务器以后，Mac 上那份就「退役」：不再发定时帖、不再收机器人消息，
 * 免得两边同时发同一条帖子、抢同一个机器人。在 .data 里放一个 RETIRED 文件即可，随时生效。
 */
export function isRetired(): boolean {
  return existsSync(path.join(process.cwd(), ".data", "RETIRED"));
}

/** 线上地址：优先用配置的 PUBLIC_URL，其次用各托管平台自动提供的地址 */
export function publicUrl(): string | null {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  if (process.env.KOYEB_PUBLIC_DOMAIN) return `https://${process.env.KOYEB_PUBLIC_DOMAIN}`;
  return null;
}
