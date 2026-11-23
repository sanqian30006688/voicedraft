/**
 * 后台定时任务（定时发布、自动拉取提及）一次处理所有顾客，
 * 每一条都必须用「这条所属顾客」自己的 X 账号，结果也只通知他自己。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const calls: { kind: string; xUserId: string; userId: string; text?: string }[] = [];
vi.mock("@/lib/x", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/x")>();
  return {
    ...real,
    createPost: vi.fn(async (acc: { xUserId: string; userId: string }, text: string) => {
      calls.push({ kind: "post", xUserId: acc.xUserId, userId: acc.userId, text });
      return String(Date.now() + calls.length);
    }),
    fetchMentions: vi.fn(async (acc: { xUserId: string; userId: string; handle: string }) => {
      calls.push({ kind: "mentions", xUserId: acc.xUserId, userId: acc.userId });
      return {
        items: [
          {
            id: `m-${acc.handle}`,
            text: `@${acc.handle} 给 ${acc.handle} 的提及`,
            conversationId: `c-${acc.handle}`,
            authorId: "42",
            authorHandle: "fan",
            authorName: "粉丝",
            createdAt: new Date(),
            inReplyToText: null,
          },
        ],
        newestId: `m-${acc.handle}`,
      };
    }),
  };
});

import { getDb, schema } from "@/db";
import { connectMock, getAccount } from "@/lib/x";
import { tick } from "@/lib/scheduler";
import { createJob } from "@/lib/publish";
import { addBalance, MICRO } from "@/lib/billing";
import { createUser, tgSent, type TestUser } from "./helpers";

let A: TestUser;
let B: TestUser;

beforeAll(async () => {
  A = await createUser("a@example.com");
  B = await createUser("b@example.com");
  await connectMock(A.id, "alice");
  await connectMock(B.id, "bob");
  for (const u of [A, B]) await addBalance(u.id, 50 * MICRO, { kind: "adjust", note: "测试" });
  const db = await getDb();
  await db.insert(schema.tgBindings).values([
    { userId: A.id, chatId: "1001", boundAt: new Date() },
    { userId: B.id, chatId: "2002", boundAt: new Date() },
  ]);
  const traits = { catchphrases: [], bannedWords: [], openings: "", stance: "", humor: "", topics: [], notes: "" };
  await db.insert(schema.styleCards).values([
    { userId: A.id, lang: "zh", version: 1, traits, source: "generated" },
    { userId: B.id, lang: "zh", version: 1, traits, source: "generated" },
  ]);
});

describe("定时发布", () => {
  it("到点的帖子各用各的 X 账号发出，结果只通知本人", async () => {
    const soon = new Date(Date.now() + 1000);
    await createJob(A.id, { tweets: ["A 的定时帖"], scheduledAt: soon });
    await createJob(B.id, { tweets: ["B 的定时帖"], scheduledAt: soon });
    const db = await getDb();
    await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() - 1000) });
    await tick();

    const a = calls.find((c) => c.text === "A 的定时帖")!;
    const b = calls.find((c) => c.text === "B 的定时帖")!;
    expect(a.userId).toBe(A.id);
    expect(a.xUserId).toBe("mock-alice");
    expect(b.userId).toBe(B.id);
    expect(b.xUserId).toBe("mock-bob");

    const toA = tgSent.filter((m) => m.params.chat_id === "1001").map((m) => String(m.params.text)).join("\n");
    const toB = tgSent.filter((m) => m.params.chat_id === "2002").map((m) => String(m.params.text)).join("\n");
    expect(toA).toContain("A 的定时帖");
    expect(toA).not.toContain("B 的定时帖");
    expect(toB).toContain("B 的定时帖");
    expect(toB).not.toContain("A 的定时帖");
  });

  it("排期后换了 X 账号，到点不会发到新账号上", async () => {
    await createJob(A.id, { tweets: ["A 排给旧账号的帖"], scheduledAt: new Date(Date.now() + 1000) });
    await connectMock(A.id, "alice_new");
    const db = await getDb();
    await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(schema.posts.status, "scheduled"));
    await tick();
    expect(calls.find((c) => c.text === "A 排给旧账号的帖")).toBeUndefined();
    const [row] = (await db.select().from(schema.posts).where(eq(schema.posts.userId, A.id))).filter((p) => p.tweets[0] === "A 排给旧账号的帖");
    expect(row.status).toBe("failed");
    await connectMock(A.id, "alice");
  });
});

describe("自动拉取提及", () => {
  it("每个人的提及用他自己的账号拉、进他自己的回复队列、推到他自己的 TG", async () => {
    const db = await getDb();
    await db.update(schema.xAccounts).set({ autoReplyEnabled: true, lastCheckedAt: null });
    calls.length = 0;
    tgSent.length = 0;
    await tick();

    const pulls = calls.filter((c) => c.kind === "mentions");
    expect(pulls.map((c) => `${c.userId}:${c.xUserId}`).sort()).toEqual([`${A.id}:mock-alice`, `${B.id}:mock-bob`].sort());

    const items = await db.select().from(schema.replyItems);
    expect(items.find((i) => i.tweetId === "m-demo_alice")?.userId).toBe(A.id);
    expect(items.find((i) => i.tweetId === "m-demo_bob")?.userId).toBe(B.id);

    const toA = tgSent.filter((m) => m.params.chat_id === "1001").map((m) => JSON.stringify(m.params)).join("\n");
    const toB = tgSent.filter((m) => m.params.chat_id === "2002").map((m) => JSON.stringify(m.params)).join("\n");
    expect(toA).not.toContain("demo_bob");
    expect(toB).not.toContain("demo_alice");
    expect((await getAccount(A.id))?.mentionsSinceId).toBe("m-demo_alice");
    expect((await getAccount(B.id))?.mentionsSinceId).toBe("m-demo_bob");
  });
});
