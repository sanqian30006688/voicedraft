import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/** 给托管平台检查服务是否正常：能连上数据库就返回 ok */
export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
