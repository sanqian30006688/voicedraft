/** 把 Mac 上的数据搬到服务器：导出脚本 → 后台上传导入 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getDb, schema } from "@/db";
import * as importRoute from "@/app/api/admin/import/route";
import { createUser, loginAs, type TestUser } from "./helpers";

let OWNER: TestUser;
let A: TestUser;
let exportFile: string;

const upload = (content: string) => {
  const fd = new FormData();
  fd.append("file", new File([content], "voicedraft-export.json", { type: "application/json" }));
  return importRoute.POST(new Request("https://example.com/api/admin/import", { method: "POST", body: fd }));
};

beforeAll(async () => {
  // 模拟 Mac 上的本机数据库：平台方自己的账号 + 一位老顾客
  const dir = mkdtempSync(path.join(tmpdir(), "vd-mac-"));
  const mac = new PGlite(path.join(dir, "pglite"));
  const db = drizzle(mac, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const [me] = await db.insert(schema.users).values({ email: "owner@example.com", passwordHash: "x" }).returning();
  const [old] = await db.insert(schema.users).values({ email: "old-customer@example.com", passwordHash: "y" }).returning();
  await db.insert(schema.sessions).values({ userId: me.id, tokenHash: "t", expiresAt: new Date() });
  await db.insert(schema.drafts).values({ userId: me.id, topic: "平台方的草稿", mode: "quick", sentences: [{ text: "it's 中文", original: "", locked: false }] });
  await db.insert(schema.drafts).values({ userId: old.id, topic: "老顾客的草稿", mode: "quick", sentences: [] });
  await db.insert(schema.tgBindings).values({ userId: me.id, chatId: "555", boundAt: new Date() });
  await mac.close();
  exportFile = path.join(dir, "out.json");
  execFileSync("node", ["scripts/export-local-data.mjs", path.join(dir, "pglite"), exportFile], { stdio: "pipe" });

  // 服务器上：平台方先用同一个邮箱注册，然后再来一位新顾客
  OWNER = await createUser("owner@example.com");
  A = await createUser("a@example.com");
});

describe("导入本机数据", () => {
  it("普通顾客不能导入", async () => {
    loginAs(A);
    expect((await upload(readFileSync(exportFile, "utf8"))).status).toBe(403);
  });

  it("管理员导入后，数据归到服务器上同一个邮箱的账号；登录会话不搬", async () => {
    loginAs(OWNER);
    const res = await upload(readFileSync(exportFile, "utf8"));
    expect(res.status).toBe(200);
    const db = await getDb();
    const mine = await db.select().from(schema.drafts).where(eq(schema.drafts.userId, OWNER.id));
    expect(mine.map((d) => d.topic)).toEqual(["平台方的草稿"]);
    expect(mine[0].sentences[0].text).toBe("it's 中文");
    const [bind] = await db.select().from(schema.tgBindings).where(eq(schema.tgBindings.userId, OWNER.id));
    expect(bind.chatId).toBe("555");
    const [oldUser] = await db.select().from(schema.users).where(eq(schema.users.email, "old-customer@example.com"));
    const theirs = await db.select().from(schema.drafts).where(eq(schema.drafts.userId, oldUser.id));
    expect(theirs.map((d) => d.topic)).toEqual(["老顾客的草稿"]);
    // 新顾客 A 什么都没多出来
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.userId, A.id))).toHaveLength(0);
    expect((await db.select().from(schema.sessions)).every((s) => s.tokenHash !== "t")).toBe(true);
  });

  it("搬过来的老账号不会变成管理员", async () => {
    const { isAdmin } = await import("@/lib/billing");
    const db = await getDb();
    const [oldUser] = await db.select().from(schema.users).where(eq(schema.users.email, "old-customer@example.com"));
    expect(await isAdmin(oldUser)).toBe(false);
    expect(await isAdmin(OWNER)).toBe(true);
  });

  it("重复导入不会多出数据", async () => {
    loginAs(OWNER);
    expect((await upload(readFileSync(exportFile, "utf8"))).status).toBe(200);
    const db = await getDb();
    expect(await db.select().from(schema.drafts)).toHaveLength(2);
  });

  it("文件里不能夹带别的表", async () => {
    loginAs(OWNER);
    const bad = JSON.stringify({ format: "voicedraft-export", tables: [{ name: 'users"; drop table users; --', rows: [] }] });
    expect((await upload(bad)).status).toBe(400);
    expect((await upload("not json")).status).toBe(400);
  });

  it("带上 .env.local 导出时，平台密钥一起搬过去；服务器上已填的不覆盖，别的配置不带", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vd-env-"));
    const envFile = path.join(dir, ".env.local");
    writeFileSync(
      envFile,
      [
        "X_CLIENT_ID=mac-client-id",
        'X_CLIENT_SECRET="mac-secret"',
        "TELEGRAM_BOT_TOKEN=999:MAC_TOKEN",
        "ANTHROPIC_API_KEY=sk-ant-mac-key-0123456789abcdef",
        "TOKEN_ENCRYPTION_KEY=should-not-move",
      ].join("\n"),
    );
    const out = path.join(dir, "out.json");
    const src = path.join(path.dirname(exportFile), "pglite");
    execFileSync("node", ["scripts/export-local-data.mjs", src, out, envFile], { stdio: "pipe" });
    const file = JSON.parse(readFileSync(out, "utf8"));
    expect(Object.keys(file.platformEnv).sort()).toEqual(["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "X_CLIENT_ID", "X_CLIENT_SECRET"]);
    expect(file.platformEnv.X_CLIENT_SECRET).toBe("mac-secret");

    const before = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
    try {
      loginAs(A);
      expect((await upload(readFileSync(out, "utf8"))).status).toBe(403);
      expect(process.env.X_CLIENT_ID).toBeUndefined();

      loginAs(OWNER);
      const res = await upload(readFileSync(out, "utf8"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { platformKeys: string[] };
      expect(body.platformKeys.sort()).toEqual(["ANTHROPIC_API_KEY", "X_CLIENT_ID", "X_CLIENT_SECRET"]);
      expect(process.env.X_CLIENT_ID).toBe("mac-client-id");
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-mac-key-0123456789abcdef");
      // 服务器上已经填过的机器人不被 Mac 上的旧值覆盖
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe(before);
      expect(process.env.TOKEN_ENCRYPTION_KEY).not.toBe("should-not-move");

      // 重启后从数据库读回来
      delete process.env.X_CLIENT_ID;
      const { loadPlatformEnv } = await import("@/lib/platform-config");
      await loadPlatformEnv();
      expect(process.env.X_CLIENT_ID).toBe("mac-client-id");
    } finally {
      delete process.env.X_CLIENT_ID;
      delete process.env.X_CLIENT_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.TELEGRAM_BOT_TOKEN = before;
    }
  });
});
