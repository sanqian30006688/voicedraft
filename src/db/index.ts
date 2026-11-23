import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * 有 DATABASE_URL（例如 Neon）时连 Postgres；
 * 没有时用 PGlite 把数据存在本地 .data 文件夹，本地运行不需要装数据库。
 * 首次访问时自动执行迁移。
 */
export type DB = PgliteDatabase<typeof schema>;

const migrationsFolder = path.join(process.cwd(), "drizzle");

const g = globalThis as unknown as { __vdDb?: Promise<DB> };

async function create(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const migrationClient = postgres(url, { max: 1 });
    await migratePg(drizzlePg(migrationClient), { migrationsFolder });
    await migrationClient.end();
    const client = postgres(url, { max: 5 });
    // postgres-js 与 PGlite 的查询接口一致，这里统一按同一类型使用
    return drizzlePg(client, { schema }) as unknown as DB;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  // 自动化测试用：数据只放在内存里，每次运行都是空库
  if (process.env.VD_DB === "memory") {
    const db = drizzlePglite(new PGlite(), { schema });
    await migratePglite(db, { migrationsFolder });
    return db;
  }
  const dir = path.join(process.cwd(), ".data");
  mkdirSync(dir, { recursive: true });
  const client = new PGlite(path.join(dir, "pglite"));
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return db;
}

export function getDb(): Promise<DB> {
  g.__vdDb ??= create().catch((e) => {
    g.__vdDb = undefined;
    throw e;
  });
  return g.__vdDb;
}

export { schema };
