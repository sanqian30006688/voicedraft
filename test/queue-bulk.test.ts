/**
 * 定时帖一键管理：全部暂停 / 恢复 / 延后 / 删除，只动自己的。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const posted: string[] = [];
vi.mock("@/lib/x", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/x")>();
  return {
    ...real,
    createPost: vi.fn(async (_acc: unknown, text: string) => {
      posted.push(text);
      return String(Date.now() + posted.length);
    }),
  };
});

import { getDb, schema } from "@/db";
import { connectMock } from "@/lib/x";
import { bulkSchedule, createJob, queueSummary, runDuePosts } from "@/lib/publish";
import { addBalance, MICRO } from "@/lib/billing";
import { getSettings, saveSettings } from "@/lib/autopilot";
import { createUser, tgSent, type TestUser } from "./helpers";

let A: TestUser;
let B: TestUser;
const H = 3600_000;

async function rows(userId: string) {
  const db = await getDb();
  return (await db.select().from(schema.posts).where(eq(schema.posts.userId, userId))).sort((x, y) => x.tweets[0].localeCompare(y.tweets[0]));
}

beforeAll(async () => {
  A = await createUser("qa@example.com");
  B = await createUser("qb@example.com");
  await connectMock(A.id, "qalice");
  await connectMock(B.id, "qbob");
  for (const u of [A, B]) await addBalance(u.id, 50 * MICRO, { kind: "adjust", note: "测试" });
  const db = await getDb();
  await db.insert(schema.tgBindings).values([{ userId: A.id, chatId: "7001", boundAt: new Date() }]);
  await createJob(A.id, { tweets: ["A1"], scheduledAt: new Date(Date.now() + H) });
  await createJob(A.id, { tweets: ["A2"], scheduledAt: new Date(Date.now() + 2 * H) });
  await createJob(B.id, { tweets: ["B1"], scheduledAt: new Date(Date.now() + H) });
});

describe("定时帖一键管理", () => {
  it("全部延后：间隔不变，别人的不动", async () => {
    const before = await rows(A.id);
    const b0 = (await rows(B.id))[0].scheduledAt!.getTime();
    expect(await bulkSchedule(A.id, "delay", 60)).toBe(2);
    const after = await rows(A.id);
    for (let i = 0; i < 2; i++) expect(after[i].scheduledAt!.getTime() - before[i].scheduledAt!.getTime()).toBe(H);
    expect((await rows(B.id))[0].scheduledAt!.getTime()).toBe(b0);
  });

  it("全部暂停后到点也不发；恢复后过了点的从 2 分钟后开始，间隔不变", async () => {
    expect(await bulkSchedule(A.id, "pause")).toBe(2);
    expect(await queueSummary(A.id)).toMatchObject({ scheduled: 0, paused: 2 });
    const db = await getDb();
    const now = Date.now();
    // 模拟暂停期间过了点
    await db.update(schema.posts).set({ scheduledAt: new Date(now - 3 * H) }).where(eq(schema.posts.tweets, ["A1"]));
    await db.update(schema.posts).set({ scheduledAt: new Date(now - 2 * H) }).where(eq(schema.posts.tweets, ["A2"]));
    await runDuePosts();
    expect(posted).not.toContain("A1");
    expect(posted).not.toContain("A2");

    expect(await bulkSchedule(A.id, "resume")).toBe(2);
    const [a1, a2] = await rows(A.id);
    expect(a1.status).toBe("scheduled");
    expect(a1.scheduledAt!.getTime()).toBeGreaterThan(Date.now());
    expect(a1.scheduledAt!.getTime()).toBeLessThan(Date.now() + 3 * 60_000);
    expect(a2.scheduledAt!.getTime() - a1.scheduledAt!.getTime()).toBe(H);
    expect((await rows(B.id))[0].status).toBe("scheduled");
  });

  it("机器人里点「全部暂停」，自动发帖也一起停", async () => {
    await saveSettings(A.id, { enabled: true });
    const { handleCallback } = await import("@/lib/tg-bot");
    await handleCallback(A.id, "7001", { data: "qb:p", message: { message_id: 1 } } as never, async () => null);
    expect((await queueSummary(A.id)).paused).toBe(2);
    expect((await getSettings(A.id)).enabled).toBe(false);
    expect(tgSent.some((m) => String(m.params.text).includes("自动发帖也一起暂停了"))).toBe(true);
  });

  it("全部删除：排着的和暂停的都取消，别人的不动", async () => {
    expect(await bulkSchedule(A.id, "cancel")).toBe(2);
    expect((await rows(A.id)).every((r) => r.status === "canceled")).toBe(true);
    expect((await rows(B.id))[0].status).toBe("scheduled");
    expect(await queueSummary(A.id)).toMatchObject({ scheduled: 0, paused: 0 });
  });
});
