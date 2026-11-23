/**
 * 给关注的人推送回复候选：只写候选、绝不自动发；按规则挑帖；每天上限；按条扣费；顾客之间互不影响。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const posted: { userId: string; text: string; replyTo?: string }[] = [];
vi.mock("@/lib/x", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/x")>();
  return {
    ...real,
    createPost: vi.fn(async (acc: { userId: string }, text: string, replyTo?: string) => {
      posted.push({ userId: acc.userId, text, replyTo });
      return String(9_000_000 + posted.length);
    }),
  };
});

import { getDb, schema } from "@/db";
import { addBalance, getBalance, MICRO } from "@/lib/billing";
import { checkTimeline, pickPosts, saveFollowSettings, type PickRules } from "@/lib/follow-replies";
import { resetRateLimits } from "@/lib/rate-limit";
import { tick } from "@/lib/scheduler";
import { handleCallback, handleText } from "@/lib/tg-bot";
import { connectMock, type XTweet } from "@/lib/x";
import * as checkRoute from "@/app/api/replies/follow-check/route";
import * as repliesRoute from "@/app/api/replies/route";
import * as accountRoute from "@/app/api/x/account/route";
import { body, createUser, get, json, loginAs, tgSent, type TestUser } from "./helpers";

let A: TestUser;
let B: TestUser;

beforeAll(async () => {
  A = await createUser("follow-a@example.com");
  B = await createUser("follow-b@example.com");
  // 第一个注册的是管理员（不扣费），扣费用后面新建的顾客测
  await connectMock(A.id, "alice");
  await connectMock(B.id, "bob");
  for (const u of [A, B]) await addBalance(u.id, 50 * MICRO, { kind: "adjust", note: "测试" });
  const db = await getDb();
  await db.insert(schema.tgBindings).values([
    { userId: A.id, chatId: "3001", boundAt: new Date() },
    { userId: B.id, chatId: "3002", boundAt: new Date() },
  ]);
  const traits = { catchphrases: [], bannedWords: [], openings: "", stance: "", humor: "", topics: [], notes: "" };
  await db.insert(schema.styleCards).values([
    { userId: A.id, lang: "zh", version: 1, traits, source: "generated" },
    { userId: B.id, lang: "zh", version: 1, traits, source: "generated" },
  ]);
});

const tw = (id: number, handle: string, text: string, authorId = `a-${handle}`): XTweet => ({
  id: String(id),
  text,
  authorId,
  authorHandle: handle,
  authorName: handle,
  createdAt: new Date(),
});

const rules = (p: Partial<PickRules> = {}): PickRules => ({
  ownXUserId: "me",
  keywords: [],
  handles: [],
  skipKeywords: [],
  skipHandles: [],
  ...p,
});

describe("挑帖规则", () => {
  const tweets = [
    tw(1, "pm", "做 AI 产品最容易犯的错是先有模型再找场景"),
    tw(2, "writer", "今天写了两千字删了一千五，剩下的最满意"),
    tw(3, "me_handle", "这是我自己发的一条比较长的推文", "me"),
    tw(4, "short", "好"),
    tw(5, "spam", "限时福利点击链接领取免费课程啊"),
    tw(6, "pm", "第二条：AI 写的东西最大的问题是没有立场"),
  ];

  it("没设账号和关键词：关注的人都可以，但不回自己的、太短的；同一个人只挑一条，新的在前", () => {
    const out = pickPosts(tweets, rules(), new Set(), 10);
    expect(out.map((p) => p.tweet.id)).toEqual(["6", "5", "2"]);
  });

  it("「不回复」名单和关键词照样生效", () => {
    const out = pickPosts(tweets, rules({ skipHandles: ["@spam"], skipKeywords: ["两千字"] }), new Set(), 10);
    expect(out.map((p) => p.tweet.authorHandle)).toEqual(["pm"]);
  });

  it("设了账号或关键词时只挑命中的，账号优先", () => {
    const out = pickPosts(tweets, rules({ handles: ["Writer"], keywords: ["ai"] }), new Set(), 10);
    expect(out.map((p) => [p.tweet.id, p.reason])).toEqual([
      ["2", "你指定的账号 @writer"],
      ["6", "含关键词「ai」"],
    ]);
  });

  it("今天已经挑过的人不再挑；不超过上限", () => {
    expect(pickPosts(tweets, rules(), new Set(["a-pm"]), 10).map((p) => p.tweet.id)).toEqual(["5", "2"]);
    expect(pickPosts(tweets, rules(), new Set(), 1)).toHaveLength(1);
    expect(pickPosts(tweets, rules(), new Set(), 0)).toHaveLength(0);
  });
});

describe("定时检查关注的人", () => {
  it("没打开的人不读", async () => {
    tgSent.length = 0;
    await tick();
    const db = await getDb();
    const rows = await db.select().from(schema.replyItems).where(eq(schema.replyItems.source, "timeline"));
    expect(rows).toHaveLength(0);
  });

  it("各读各的，写好候选推到自己的 TG，绝不自动发出", async () => {
    await saveFollowSettings(A.id, { timelineEnabled: true });
    await saveFollowSettings(B.id, { timelineEnabled: true, timelineDailyCap: 1 });
    posted.length = 0;
    tgSent.length = 0;
    await tick();

    expect(posted).toHaveLength(0); // 一条都没发

    const db = await getDb();
    const rows = await db.select().from(schema.replyItems).where(eq(schema.replyItems.source, "timeline"));
    const ofA = rows.filter((r) => r.userId === A.id);
    const ofB = rows.filter((r) => r.userId === B.id);
    // 演示时间线：pm_notes、writer_daily、自己、福利号、tech_watch。自己的不挑；福利号由 AI 判断不回
    expect(ofA.filter((r) => r.status === "pending").map((r) => r.authorHandle).sort()).toEqual(["pm_notes", "tech_watch", "writer_daily"]);
    expect(ofA.find((r) => r.authorHandle === "promo_shop")?.status).toBe("skipped");
    expect(ofA.every((r) => r.status !== "pending" || r.candidates.length === 3)).toBe(true);
    // B 每天只要 1 条
    expect(ofB.filter((r) => r.status === "pending")).toHaveLength(1);

    const toA = tgSent.filter((m) => m.params.chat_id === "3001").map((m) => String(m.params.text));
    const toB = tgSent.filter((m) => m.params.chat_id === "3002").map((m) => String(m.params.text));
    expect(toA.filter((t) => t.includes("你关注的"))).toHaveLength(3);
    expect(toB.filter((t) => t.includes("你关注的"))).toHaveLength(1);
    // 不会把自己的帖子推给别人
    expect(toA.join("\n")).not.toContain("demo_bob");
    expect(toB.join("\n")).not.toContain("demo_alice");
  });

  it("没到间隔不再读；到了间隔只读新的", async () => {
    const db = await getDb();
    const before = (await db.select().from(schema.replyItems)).length;
    await tick();
    expect((await db.select().from(schema.replyItems)).length).toBe(before);
    await db.update(schema.xAccounts).set({ timelineCheckedAt: new Date(Date.now() - 2 * 3600_000) });
    await tick(); // 演示接口带 sinceId 时没有新帖子
    expect((await db.select().from(schema.replyItems)).length).toBe(before);
  });

  it("在 TG 里点「发送」才会作为回复发出，回复的是对方那条帖子", async () => {
    const db = await getDb();
    const [item] = await db
      .select()
      .from(schema.replyItems)
      .where(and(eq(schema.replyItems.userId, A.id), eq(schema.replyItems.source, "timeline"), eq(schema.replyItems.status, "pending")))
      .limit(1);
    posted.length = 0;
    await handleCallback(A.id, "3001", { id: "q", data: `rs:${item.id}:0`, message: { message_id: 1, chat: { id: 3001 } } }, async () => null);
    expect(posted).toEqual([{ userId: A.id, text: item.candidates[0], replyTo: item.tweetId }]);
    // B 点不了 A 的
    const [other] = await db
      .select()
      .from(schema.replyItems)
      .where(and(eq(schema.replyItems.userId, A.id), eq(schema.replyItems.status, "pending")))
      .limit(1);
    posted.length = 0;
    await handleCallback(B.id, "3002", { id: "q", data: `rs:${other.id}:0`, message: { message_id: 1, chat: { id: 3002 } } }, async () => null);
    expect(posted).toHaveLength(0);
  });
});

describe("扣费和上限", () => {
  it("读关注的人的帖子、写候选；每天上限到了就不再读（开源版不扣费）", async () => {
    const C = await createUser("follow-c@example.com");
    await connectMock(C.id, "carol");
    await addBalance(C.id, 10 * MICRO, { kind: "adjust", note: "测试" });
    const db = await getDb();
    const traits = { catchphrases: [], bannedWords: [], openings: "", stance: "", humor: "", topics: [], notes: "" };
    await db.insert(schema.styleCards).values({ userId: C.id, lang: "zh", version: 1, traits, source: "generated" });
    await saveFollowSettings(C.id, { timelineDailyCap: 2, timelineKeywords: [] });

    const r = await checkTimeline(C.id);
    expect(r).toMatchObject({ read: 5, added: 2 });
    // 5 × 0.02 + 2 × 0.05
    expect(await getBalance(C.id)).toBe(10 * MICRO); // 开源版不扣费

    // 上限到了：不读、不扣
    await db.update(schema.xAccounts).set({ timelineSinceId: null }).where(eq(schema.xAccounts.userId, C.id));
    const again = await checkTimeline(C.id);
    expect(again.read).toBe(0);
    expect(again.message).toContain("上限");
    expect(await getBalance(C.id)).toBe(10 * MICRO); // 开源版不扣费
  });

});

describe("网页", () => {
  it("设置只改自己的；手动检查有最短间隔；队列只看得到自己的", async () => {
    resetRateLimits();
    loginAs(B);
    const res = await accountRoute.PATCH(json({ timelineHandles: ["@Paulg", "paulg", "naval"], timelineKeywords: ["AI"], timelineDailyCap: 5 }, undefined, "PATCH"));
    expect(res.status).toBe(200);
    const acc = (await body(await accountRoute.GET())).account as Record<string, unknown>;
    expect(acc.timelineHandles).toEqual(["Paulg", "naval"]);
    expect(acc.timelineDailyCap).toBe(5);
    loginAs(A);
    const accA = (await body(await accountRoute.GET())).account as Record<string, unknown>;
    expect(accA.timelineHandles).toEqual([]);

    loginAs(B);
    expect((await checkRoute.POST()).status).toBe(200);
    expect((await checkRoute.POST()).status).toBe(429);

    const items = (await body(await repliesRoute.GET(get("http://localhost/api/replies?view=todo")))).items as { userId: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.userId === B.id)).toBe(true);
  });

  it("TG 里能设置账号和关键词", async () => {
    await handleCallback(A.id, "3001", { id: "q", data: "fh", message: { message_id: 1, chat: { id: 3001 } } }, async () => null);
    await handleText(A.id, "3001", "@paulg, naval 不合法的账号名字");
    const db = await getDb();
    const [acc] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, A.id));
    expect(acc.timelineHandles).toEqual(["paulg", "naval"]);
    await handleCallback(A.id, "3001", { id: "q", data: "fk", message: { message_id: 1, chat: { id: 3001 } } }, async () => null);
    await handleText(A.id, "3001", "清空");
    const [acc2] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, A.id));
    expect(acc2.timelineKeywords).toEqual([]);
  });
});
