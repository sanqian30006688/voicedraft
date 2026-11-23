/**
 * 把本机（PGlite）的数据导出成一个 JSON 文件，用来搬到服务器的 Postgres（例如 Neon）。
 *
 *   node scripts/export-local-data.mjs <PGlite 数据文件夹> <输出的 .json 文件> [.env.local]
 *
 * 带上 .env.local 时，平台密钥（X 应用、TG 机器人、AI）也一起放进文件，服务器导入时自动填好，
 * 不用在后台重新输入。这个文件因此要当密码一样保管，导入后删掉。
 *
 * 请先把 .data/pglite 复制一份再导出（应用开着时原文件夹被占用）。
 * 不导出：登录会话（搬过去后重新登录一次）、X 授权（服务器换了回调地址和密钥，重新连接一次 X）。
 * 导入：管理员在服务器上的「后台」页上传这个文件（已存在的行会跳过，可以重复导入）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const [src, out, envFile] = process.argv.slice(2);
if (!src || !out) {
  console.error("用法：node scripts/export-local-data.mjs <PGlite 文件夹> <输出.json>");
  process.exit(1);
}

const SKIP = new Set(["sessions", "x_oauth_states", "x_accounts"]);
const db = new PGlite(src);

const tables = (
  await db.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)
).rows.map((r) => r.table_name).filter((t) => !SKIP.has(t));

// 按外键排序：被引用的表先导入
const deps = new Map(tables.map((t) => [t, new Set()]));
for (const r of (
  await db.query(`
    select tc.relname as child, tp.relname as parent
    from pg_constraint c
    join pg_class tc on tc.oid = c.conrelid
    join pg_class tp on tp.oid = c.confrelid
    join pg_namespace n on n.oid = tc.relnamespace
    where c.contype = 'f' and n.nspname = 'public'`)
).rows) {
  if (r.child !== r.parent && deps.has(r.child) && deps.has(r.parent)) deps.get(r.child).add(r.parent);
}
const ordered = [];
const seen = new Set();
const visit = (t) => {
  if (seen.has(t)) return;
  seen.add(t);
  for (const p of deps.get(t)) visit(p);
  ordered.push(t);
};
tables.forEach(visit);

const data = { format: "voicedraft-export", version: 1, exportedAt: new Date().toISOString(), tables: [] };

// 和 src/lib/platform-config.ts 的 PLATFORM_KEYS 一致
const PLATFORM_KEYS = ["X_CLIENT_ID", "X_CLIENT_SECRET", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY"];
if (envFile) {
  const env = {};
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || !PLATFORM_KEYS.includes(m[1])) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (v) env[m[1]] = v;
  }
  data.platformEnv = env;
  console.log(`平台密钥：${Object.keys(env).join("、") || "（没有）"}`);
}
let total = 0;
for (const t of ordered) {
  const rows = (await db.query(`select row_to_json(x) as j from "${t}" x`)).rows.map((r) => r.j);
  total += rows.length;
  console.log(`${t}: ${rows.length}`);
  data.tables.push({ name: t, rows });
}
writeFileSync(out, JSON.stringify(data));
console.log(`共 ${total} 行，已写入 ${out}`);
await db.close();
