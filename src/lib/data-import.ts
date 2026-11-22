import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { PLATFORM_KEYS, type PlatformKey } from "./platform-config";

/**
 * 导入 scripts/export-local-data.mjs 从本机导出的数据（搬到服务器用）。
 * - 只认这份数据库里真实存在的表，表名不能随便填
 * - 已存在的行跳过，可以重复导入
 * - 本机账号的邮箱在服务器上已经注册过时，数据归到服务器上的这个账号
 */
const SKIP = new Set(["sessions", "x_oauth_states", "x_accounts"]);

export class ImportError extends Error {}

// PGlite 返回 { rows }，postgres-js 直接返回数组
const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Record<string, unknown>[];

interface ExportFile {
  format: string;
  tables: { name: string; rows: Record<string, unknown>[] }[];
  platformEnv?: Record<string, unknown>;
}

/**
 * 文件里带的平台密钥（Mac 上 .env.local 里的）：只取认识的几项，
 * 服务器上已经填过的不覆盖。
 */
export function platformEnvToImport(input: unknown): Partial<Record<PlatformKey, string>> {
  const env = (input as ExportFile | null)?.platformEnv;
  const out: Partial<Record<PlatformKey, string>> = {};
  if (!env || typeof env !== "object") return out;
  for (const k of PLATFORM_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.trim() && v.length < 1000 && !process.env[k]) out[k] = v.trim();
  }
  return out;
}

export async function importExport(input: unknown): Promise<{ table: string; added: number; total: number }[]> {
  const data = input as ExportFile;
  if (!data || data.format !== "voicedraft-export" || !Array.isArray(data.tables)) throw new ImportError("不是 VoiceDraft 导出的数据文件");
  const db = await getDb();
  const existing = new Set(
    rowsOf(await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).map((r) =>
      String(r.table_name),
    ),
  );
  return db.transaction(async (tx) => {
    // 同一个邮箱在两边是不同的账号编号：换成服务器上的
    const remap = new Map<string, string>();
    const users = data.tables.find((t) => t.name === "users")?.rows ?? [];
    for (const u of users) {
      const found = rowsOf(await tx.execute(sql`select id from users where lower(email) = lower(${String(u.email)})`))[0];
      if (found && found.id !== u.id) remap.set(String(u.id), String(found.id));
    }
    const out: { table: string; added: number; total: number }[] = [];
    for (const t of data.tables) {
      if (SKIP.has(t.name)) continue;
      if (!existing.has(t.name) || !/^[a-z_][a-z0-9_]*$/.test(t.name)) throw new ImportError(`文件里有不认识的表：${t.name}`);
      const now = new Date().toISOString();
      let rows = (t.rows ?? []).map((r) => {
        // 管理员在没设 ADMIN_EMAILS 时是「最早注册的账号」：搬过来的账号按导入时间算，不能顶替现在的管理员
        if (t.name === "users") return { ...r, created_at: now };
        return typeof r.user_id === "string" && remap.has(r.user_id) ? { ...r, user_id: remap.get(r.user_id) } : r;
      });
      // 用户编号按服务器上的顺序重新发（本机的编号可能和服务器上的重复）；服务器上已有的邮箱不导入，不占编号
      if (t.name === "users") {
        const fresh: Record<string, unknown>[] = [];
        for (const r of rows) {
          const dup = rowsOf(await tx.execute(sql`select 1 as x from users where lower(email) = lower(${String(r.email)}) or id::text = ${String(r.id)}`))[0];
          if (dup) continue;
          fresh.push({ ...r, user_no: Number(rowsOf(await tx.execute(sql`select nextval('users_user_no_seq')::int as n`))[0].n) });
        }
        rows = fresh;
      }
      let added = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = JSON.stringify(rows.slice(i, i + 500));
        const table = sql.raw(`"${t.name}"`);
        const res = rowsOf(
          await tx.execute(
            sql`with ins as (insert into ${table} select * from json_populate_recordset(null::${table}, ${chunk}::json) on conflict do nothing returning 1) select count(*)::int as n from ins`,
          ),
        );
        added += Number(res[0]?.n ?? 0);
      }
      out.push({ table: t.name, added, total: rows.length });
    }
    return out;
  });
}
