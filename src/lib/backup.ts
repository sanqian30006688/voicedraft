import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getSetting, setSetting } from "./billing";
import { decrypt, encrypt } from "./secret";
import {
  BACKUP_SKIP_SETTINGS,
  BACKUP_SKIP_TABLES,
  backupObjectKey,
  encryptBackup,
  signPutObject,
  type S3Target,
} from "./backup-core";

/**
 * 每日数据库异地备份：每天加密备份一份到 S3。
 *
 * - 导出格式和「导入本机数据」一样（voicedraft-export），恢复时在后台上传备份文件 + 备份密码即可
 * - 不带：登录会话、OAuth 中间状态、平台密钥（X / TG / AI）、备份设置本身
 * - 先 gzip 再用备份密码加密，再传到 S3；S3 密钥只需要「写」权限，旧文件由桶的生命周期规则删除
 * - 每天一次；失败的话一小时后再试
 */

const CONFIG_KEY = "backup_config";
const STATE_KEY = "backup_state";

export interface BackupConfig extends S3Target {
  enabled: boolean;
  prefix: string;
  passphrase: string;
}

export interface BackupState {
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastKey?: string;
  lastBytes?: number;
  lastError?: string | null;
}

// PGlite 返回 { rows }，postgres-js 直接返回数组
const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Record<string, unknown>[];

export async function getBackupConfig(): Promise<BackupConfig | null> {
  const stored = await getSetting<{ enc?: string }>(CONFIG_KEY);
  if (!stored?.enc) return null;
  try {
    return JSON.parse(decrypt(stored.enc)) as BackupConfig;
  } catch (e) {
    console.error("[backup] 读不出备份设置", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 保存设置；没填的密钥项沿用上次的（后台不会把密钥回显给浏览器） */
export async function saveBackupConfig(input: Partial<BackupConfig>): Promise<BackupConfig> {
  const current = await getBackupConfig();
  const next: BackupConfig = {
    enabled: input.enabled ?? current?.enabled ?? true,
    bucket: input.bucket ?? current?.bucket ?? "",
    region: input.region ?? current?.region ?? "",
    prefix: input.prefix ?? current?.prefix ?? "tuiter-backup/",
    endpoint: input.endpoint !== undefined ? input.endpoint || undefined : current?.endpoint,
    accessKeyId: input.accessKeyId || current?.accessKeyId || "",
    secretAccessKey: input.secretAccessKey || current?.secretAccessKey || "",
    passphrase: input.passphrase || current?.passphrase || "",
  };
  await setSetting(CONFIG_KEY, { enc: encrypt(JSON.stringify(next)) });
  return next;
}

export async function getBackupState(): Promise<BackupState> {
  return (await getSetting<BackupState>(STATE_KEY)) ?? {};
}

export function configComplete(c: BackupConfig | null): c is BackupConfig {
  return !!c && !!c.bucket && !!c.region && !!c.accessKeyId && !!c.secretAccessKey && c.passphrase.length >= 12;
}

/** 给后台看的样子：密钥只说填没填 */
export async function backupStatus() {
  const c = await getBackupConfig();
  return {
    config: c
      ? {
          enabled: c.enabled,
          bucket: c.bucket,
          region: c.region,
          prefix: c.prefix,
          endpoint: c.endpoint ?? "",
          hasAccessKey: !!c.accessKeyId && !!c.secretAccessKey,
          hasPassphrase: c.passphrase.length >= 12,
        }
      : null,
    complete: configComplete(c),
    state: await getBackupState(),
  };
}

/** 把整个数据库导出成和「导入本机数据」相同格式的 JSON */
export async function buildExport(now = new Date()): Promise<string> {
  const db = await getDb();
  const tables = rowsOf(
    await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`),
  )
    .map((r) => String(r.table_name))
    .filter((t) => !BACKUP_SKIP_TABLES.has(t) && !t.startsWith("__drizzle") && /^[a-z_][a-z0-9_]*$/.test(t));

  // 按外键排序：被引用的表在前，导入时才不会撞外键
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const r of rowsOf(
    await db.execute(sql`
      select tc.relname as child, tp.relname as parent
      from pg_constraint c
      join pg_class tc on tc.oid = c.conrelid
      join pg_class tp on tp.oid = c.confrelid
      join pg_namespace n on n.oid = tc.relnamespace
      where c.contype = 'f' and n.nspname = 'public'`),
  )) {
    const child = String(r.child);
    const parent = String(r.parent);
    if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of deps.get(t) ?? []) visit(p);
    ordered.push(t);
  };
  [...tables].sort().forEach(visit);

  const out: { name: string; rows: Record<string, unknown>[] }[] = [];
  for (const name of ordered) {
    // 用户按编号排，恢复到空库时编号不变
    const order = name === "users" ? sql.raw(" order by user_no") : sql.raw("");
    let rows = rowsOf(await db.execute(sql`select * from ${sql.raw(`"${name}"`)}${order}`));
    if (name === "app_settings") rows = rows.filter((r) => !BACKUP_SKIP_SETTINGS.has(String(r.key)));
    out.push({ name, rows });
  }
  return JSON.stringify({ format: "voicedraft-export", version: 1, exportedAt: now.toISOString(), source: "daily-backup", tables: out });
}

type Fetch = typeof fetch;

/** 立刻做一次备份并上传，返回文件名和大小；出错抛异常 */
export async function runBackupNow(now = new Date(), fetchImpl: Fetch = fetch): Promise<{ key: string; bytes: number }> {
  const c = await getBackupConfig();
  if (!configComplete(c)) throw new Error("备份还没设置完整（桶、区域、密钥、备份密码）");
  const state = await getBackupState();
  await setSetting(STATE_KEY, { ...state, lastAttemptAt: now.toISOString() });
  try {
    const body = encryptBackup(await buildExport(now), c.passphrase);
    const key = backupObjectKey(c.prefix, now);
    const req = signPutObject(c, key, body, now);
    const res = await fetchImpl(req.url, { method: "PUT", headers: req.headers, body: new Uint8Array(body) });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
      throw new Error(`S3 返回 ${res.status}${code ? ` ${code}` : ""}`);
    }
    await setSetting(STATE_KEY, { lastAttemptAt: now.toISOString(), lastOkAt: now.toISOString(), lastKey: key, lastBytes: body.length, lastError: null });
    return { key, bytes: body.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setSetting(STATE_KEY, { ...state, lastAttemptAt: now.toISOString(), lastError: msg });
    throw e;
  }
}

const DAY_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const g = globalThis as unknown as { __vdBackupCheck?: number };

/** 调度器每轮调一次：最多每 5 分钟看一眼；离上次成功满一天就备份，失败一小时后再试 */
export async function runDailyBackup(now = new Date(), fetchImpl: Fetch = fetch): Promise<boolean> {
  if (g.__vdBackupCheck && now.getTime() - g.__vdBackupCheck < 5 * 60_000) return false;
  g.__vdBackupCheck = now.getTime();
  const c = await getBackupConfig();
  if (!c?.enabled || !configComplete(c)) return false;
  const s = await getBackupState();
  const t = now.getTime();
  if (s.lastOkAt && t - Date.parse(s.lastOkAt) < DAY_MS - 10 * 60_000) return false;
  if (s.lastAttemptAt && s.lastError && t - Date.parse(s.lastAttemptAt) < RETRY_MS) return false;
  try {
    await runBackupNow(now, fetchImpl);
    return true;
  } catch (e) {
    console.error("[backup] 备份失败", e instanceof Error ? e.message : e);
    return false;
  }
}

/** 经营日报里的一行 */
export async function backupReportLine(now = new Date()): Promise<string> {
  const c = await getBackupConfig();
  if (!configComplete(c)) return "🗄 数据库备份：还没设置（后台「数据库备份」）";
  if (!c.enabled) return "🗄 数据库备份：已暂停";
  const s = await getBackupState();
  if (!s.lastOkAt) return `🗄 数据库备份：还没成功过${s.lastError ? `（${s.lastError}）` : ""}`;
  const hours = Math.floor((now.getTime() - Date.parse(s.lastOkAt)) / 3600_000);
  const size = `${Math.max(1, Math.round((s.lastBytes ?? 0) / 1024))} KB`;
  if (hours > 36) return `⚠️ 数据库备份：已经 ${hours} 小时没成功了${s.lastError ? `（${s.lastError}）` : ""}`;
  return `🗄 数据库备份：正常，最近一份 ${hours} 小时前（${size}）`;
}
