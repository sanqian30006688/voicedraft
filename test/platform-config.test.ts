/** 服务器上在页面里保存的平台密钥：只有管理员能存，存进数据库（加密），重启后能读回来 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { loadPlatformEnv } from "@/lib/platform-config";
import * as xSetupRoute from "@/app/api/x/setup/route";
import { createUser, json, loginAs, type TestUser } from "./helpers";

let ADMIN: TestUser;
let A: TestUser;
const onServer = (b: unknown) => json(b, "https://voicedraft.example.com/api/x/setup");

beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = "test-key";
  ADMIN = await createUser("owner@example.com");
  A = await createUser("a@example.com");
});

describe("平台密钥", () => {
  it("普通顾客存不了", async () => {
    loginAs(A);
    expect((await xSetupRoute.POST(onServer({ clientId: "client-id-123", clientSecret: "client-secret-123" }))).status).toBe(403);
  });

  it("管理员在服务器上保存：立即生效、数据库里是加密的、重启后读得回来", async () => {
    loginAs(ADMIN);
    const res = await xSetupRoute.POST(onServer({ clientId: "client-id-123", clientSecret: "client-secret-123" }));
    expect(res.status).toBe(200);
    expect(process.env.X_CLIENT_ID).toBe("client-id-123");
    const db = await getDb();
    const rows = await db.select().from(schema.appSettings);
    expect(JSON.stringify(rows)).not.toContain("client-secret-123");
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
    await loadPlatformEnv();
    expect(process.env.X_CLIENT_SECRET).toBe("client-secret-123");
  });
});

describe("AI 密钥", () => {
  it("只有管理员能填，填完立即生效", async () => {
    const route = await import("@/app/api/admin/ai-key/route");
    const { isMock } = await import("@/lib/llm");
    const key = "sk-ant-" + "x".repeat(40);
    loginAs(A);
    expect((await route.POST(json({ key }))).status).toBe(403);
    loginAs(ADMIN);
    expect((await route.POST(json({ key: "wrong" }))).status).toBe(400);
    expect((await route.POST(json({ key }, "https://voicedraft.example.com/api/admin/ai-key"))).status).toBe(200);
    expect(process.env.ANTHROPIC_API_KEY).toBe(key);
    process.env.MOCK_LLM = "1";
    expect(isMock()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
  });
});
