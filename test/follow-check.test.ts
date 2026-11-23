/**
 * 互关检测：先扣钱再读 X（多退少补、失败全退）、算未回关 / 取关了我、一个一个取关（每天上限）、顾客之间互不影响。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const xCalls = { list: 0, unfollow: 0 };
let failList = false;
vi.mock("@/lib/x", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/x")>();
  return {
    ...real,
    fetchFollowList: vi.fn(async (...args: Parameters<typeof real.fetchFollowList>) => {
      xCalls.list++;
      if (failList) throw new real.XApiError("X 返回错误（500）：测试", "other", 500);
      return real.fetchFollowList(...args);
    }),
    unfollowUser: vi.fn(async (...args: Parameters<typeof real.unfollowUser>) => {
      xCalls.unfollow++;
      return real.unfollowUser(...args);
    }),
  };
});

import { getDb, schema } from "@/db";
import { addBalance, getBalance, InsufficientBalanceError, MICRO, UsageLimitError } from "@/lib/billing";
import { estimateScan, exportCsv, listPeople, runScan, summary, unfollowOne, UNFOLLOW_DAILY_CAP } from "@/lib/follow-check";
import { diffScan, toCsv, type PersonInfo } from "@/lib/follow-check-core";
import { resetRateLimits } from "@/lib/rate-limit";
import { handleCallback } from "@/lib/tg-bot";
import { connectMock } from "@/lib/x";
import * as listRoute from "@/app/api/follow-check/route";
import * as personRoute from "@/app/api/follow-check/[id]/route";
import { body, createUser, ctx, get, json, loginAs, tgSent, type TestUser } from "./helpers";

let A: TestUser;
let B: TestUser;
let C: TestUser;

const p = (id: string): PersonInfo => ({ id, handle: id, name: null, verifiedType: null, followers: 0, following: 0 });

/** 让「刚扫描过」的限制过去 */
async function ageScan(userId: string) {
  const db = await getDb();
  await db.update(schema.followScans).set({ scannedAt: new Date(Date.now() - 3600_000) }).where(eq(schema.followScans.userId, userId));
}

beforeAll(async () => {
  // 第一个注册的是管理员（不扣费）
  await createUser("fc-admin@example.com");
  A = await createUser("fc-a@example.com");
  B = await createUser("fc-b@example.com");
  C = await createUser("fc-c@example.com");
  await connectMock(A.id, "fca");
  await connectMock(B.id, "fcb");
  await connectMock(C.id, "fcc");
  await addBalance(A.id, 50 * MICRO, { kind: "adjust", note: "测试" });
  await addBalance(B.id, 50 * MICRO, { kind: "adjust", note: "测试" });
  // C 充过值但只剩 1.1：高于停用线（1），但不够扫一次
  await addBalance(C.id, 1.1 * MICRO, { kind: "adjust", note: "测试" });
  const db = await getDb();
  await db.insert(schema.tgBindings).values([{ userId: A.id, chatId: "7001", boundAt: new Date() }]);
});

beforeEach(() => {
  resetRateLimits();
  failList = false;
});

describe("和上次比（纯计算）", () => {
  it("第一次扫描不算谁取关了我；之后粉丝少了才算；回关了就清掉", () => {
    const now = new Date();
    const first = diffScan([p("a"), p("b")], [p("b"), p("c")], [], now);
    expect(first.newlyLost).toBe(0);
    expect(first.upsert.find((r) => r.id === "a")).toMatchObject({ iFollow: true, followsMe: false, lostAt: null });
    expect(first.upsert.find((r) => r.id === "b")).toMatchObject({ iFollow: true, followsMe: true });

    const prev = first.upsert.map((r) => ({ targetId: r.id, followsMe: r.followsMe, lostAt: r.lostAt, ignored: false, unfollowedAt: null }));
    // b 取关了我（我还关注着），c 两边都没了（取关了我），a 没变
    const second = diffScan([p("a"), p("b")], [], prev, now);
    expect(second.newlyLost).toBe(2);
    expect(second.upsert.find((r) => r.id === "b")).toMatchObject({ iFollow: true, followsMe: false, lostAt: now });
    expect(second.upsert.find((r) => r.id === "c")).toMatchObject({ iFollow: false, followsMe: false, lostAt: now });

    const prev2 = second.upsert.map((r) => ({ targetId: r.id, followsMe: r.followsMe, lostAt: r.lostAt, ignored: false, unfollowedAt: null }));
    // b 又关注回来了；a 我不关注了、他也没关注我 → 删掉
    const third = diffScan([], [p("b")], prev2, new Date());
    expect(third.upsert.find((r) => r.id === "b")).toMatchObject({ followsMe: true, lostAt: null });
    expect(third.remove).toEqual(["a"]);
    expect(third.upsert.find((r) => r.id === "c")?.lostAt).toEqual(now);
  });

  it("导出的表格带 BOM，公式开头的内容会被转义", () => {
    const csv = toCsv([{ handle: "x", name: "=HYPERLINK(1)", followers: 1, following: 2, verifiedType: "blue", status: "未回关" }]);
    expect(csv.startsWith("﻿用户名,")).toBe(true);
    expect(csv).toContain("'=HYPERLINK(1)");
  });
});

describe("扫描和扣费", () => {

  it("读 X 失败：先扣的钱全部退回", async () => {
    const before = await getBalance(B.id);
    await estimateScan(B.id);
    failList = true;
    await expect(runScan(B.id)).rejects.toThrow();
    expect(await getBalance(B.id)).toBe(before);
  });

  it("按实际读到的人数出结果（开源版不扣费）", async () => {
    const before = await getBalance(A.id);
    const e = await estimateScan(A.id);
    expect(e.people).toBeGreaterThan(80);
    const r = await runScan(A.id);
    // 演示数据：关注 40 人（0–39），粉丝 40 人（20–59）
    expect(r).toMatchObject({ following: 40, followers: 40, noFollowBack: 20, lost: 0, first: true });
    expect(before - (await getBalance(A.id))).toBe(0); // 开源版不扣费
  });

  it("刚扫过不能马上再扫", async () => {
    await expect(runScan(A.id)).rejects.toBeInstanceOf(UsageLimitError);
  });

  it("第二次扫描：少了的粉丝进「取关了我」", async () => {
    await ageScan(A.id);
    const r = await runScan(A.id);
    expect(r.newlyLost).toBe(1);
    const lost = await listPeople(A.id, { tab: "lost" });
    expect(lost.rows.map((x) => x.targetId)).toEqual(["mp20"]);
    expect(lost.rows[0].iFollow).toBe(true);
    const csv = await exportCsv(A.id);
    expect(csv).toContain("取关了我");
    expect(csv).toContain("demo_20");
  });
});

describe("取关", () => {
  it("一次取关一个；不能取关别人名单里的人", async () => {
    const before = await getBalance(A.id);
    const row = await unfollowOne(A.id, "mp0");
    expect(row.iFollow).toBe(false);
    expect(before - (await getBalance(A.id))).toBe(0); // 开源版不扣费
    // 已经取关过的再点没有用，也不扣钱
    resetRateLimits();
    await expect(unfollowOne(A.id, "mp0")).rejects.toThrow(/已经没有关注/);
    // B 的名单里没有这个人
    await expect(unfollowOne(B.id, "mp1")).rejects.toThrow(/名单里没有/);
    loginAs(B);
    const res = await personRoute.POST(json({ action: "unfollow" }), ctx("mp1"));
    expect(res.status).toBe(422);
  });

  it("点太快要等几秒；每天有上限", async () => {
    await expect(unfollowOne(A.id, "mp1")).resolves.toBeTruthy();
    await expect(unfollowOne(A.id, "mp2")).rejects.toBeInstanceOf(UsageLimitError);
    const db = await getDb();
    // 把今天已取关的数量凑到上限
    const extra = UNFOLLOW_DAILY_CAP - (await summary(A.id)).unfollowedToday;
    await db.insert(schema.followPeople).values(
      Array.from({ length: extra }, (_, i) => ({ userId: A.id, ownXUserId: "mock-fca", targetId: `cap${i}`, handle: `cap${i}`, unfollowedAt: new Date() })),
    );
    expect((await summary(A.id)).unfollowLeft).toBe(0);
    resetRateLimits();
    const calls = xCalls.unfollow;
    await expect(unfollowOne(A.id, "mp5")).rejects.toThrow(/今天已经取关/);
    // 没取关成，这个人还在名单里
    expect((await listPeople(A.id, { tab: "nofollow", size: 50 })).rows.some((r) => r.targetId === "mp5")).toBe(true);
    expect(xCalls.unfollow).toBe(calls);
  });
});

describe("机器人和网页", () => {
  it("TG：互关检测首页和名单", async () => {
    tgSent.length = 0;
    await handleCallback(A.id, "7001", { id: "1", data: "mu:h", message: { message_id: 5, chat: { id: 7001 } } }, async () => null);
    const home = tgSent.find((m) => m.method === "editMessageText");
    expect(String(home?.params.text)).toContain("互关检测");
    tgSent.length = 0;
    await handleCallback(A.id, "7001", { id: "2", data: "mu:l:l:0:0", message: { message_id: 5, chat: { id: 7001 } } }, async () => null);
    const list = tgSent.find((m) => m.method === "editMessageText");
    expect(String(list?.params.text)).toContain("@demo_20");
  });

  it("网页：只能看到自己的名单", async () => {
    loginAs(B);
    const res = await listRoute.GET(get("http://localhost:3000/api/follow-check?tab=lost"));
    const d = await body(res);
    expect(d.total).toBe(0);
    loginAs(A);
    const mine = await body(await listRoute.GET(get("http://localhost:3000/api/follow-check?tab=lost")));
    expect(mine.total).toBe(1);
  });
});
