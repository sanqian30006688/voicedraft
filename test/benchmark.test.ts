/**
 * 推主数据：每日快照、同类对比（不满 5 个不显示）、自愿排行榜、周报。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import { connectMock } from "@/lib/x";
import { beijingDay } from "@/lib/rewards";
import { computeStat, compare, guessIndustry, reportSlot, MIN_GROUP } from "@/lib/benchmark-core";
import { leaderboard, myBenchmark, snapshotDue, takeSnapshot, updateProfile } from "@/lib/benchmark";
import { sendWeeklyReports } from "@/lib/tg-bot-bench";
import * as bindRoute from "@/app/api/telegram/bind/route";
import { body, createUser, json, loginAs, tgSent, type TestUser } from "./helpers";

describe("纯函数", () => {
  it("按话题猜行业；英文关键词整词匹配", () => {
    expect(guessIndustry(["比特币行情", "链上数据", "空投"])).toBe("web3");
    expect(guessIndustry(["美股财报", "美联储加息"])).toBe("finance");
    expect(guessIndustry(["AI 工具", "大模型"])).toBe("tech");
    expect(guessIndustry(["he said hello"])).toBeNull();
    expect(guessIndustry([])).toBeNull();
  });

  it("周涨粉按天数折算；只用同一个 X 账号的数据", () => {
    const s = computeStat([
      { day: "2026-11-01", xUserId: "old", followers: 9999, following: 1, tweets: 1 },
      { day: "2026-11-05", xUserId: "a", followers: 100, following: 10, tweets: 50 },
      { day: "2026-11-07", xUserId: "a", followers: 120, following: 11, tweets: 56 },
    ])!;
    expect(s.spanDays).toBe(2);
    expect(s.weeklyGrowth).toBe(70);
    expect(s.postsPerDay).toBe(3);
    expect(computeStat([{ day: "2026-11-07", xUserId: "a", followers: 1, following: 1, tweets: 1 }])!.weeklyGrowth).toBeNull();
  });

  it("同类不满 5 个用全站；全站也不满就不给对比", () => {
    const mk = (i: number, industry: string | null) => ({
      userId: `u${i}`,
      industry,
      stat: { followers: 1000 + i, following: 1, tweets: 1, day: "2026-11-07", weeklyGrowth: i * 10, postsPerDay: i, spanDays: 7 },
    });
    const few = [mk(1, "web3"), mk(2, "web3"), mk(3, "tech")];
    expect(compare("u1", "web3", few)).toBeNull();
    const site = [...few, mk(4, "tech"), mk(5, "tech")];
    const c = compare("u1", "web3", site)!;
    expect(c.scope).toBe("all");
    expect(c.size).toBe(MIN_GROUP);
    expect(c.rank).toBe(5);
    const many = [...site, mk(6, "web3"), mk(7, "web3"), mk(8, "web3")];
    const c2 = compare("u8", "web3", many)!;
    expect(c2.scope).toBe("industry");
    expect(c2.size).toBe(5);
    expect(c2.rank).toBe(1);
    expect(c2.beatPct).toBe(100);
  });

  it("周报时刻：每周一北京时间 10 点", () => {
    // 2026-11-13 是周五
    expect(reportSlot(new Date("2026-11-13T00:00:00Z")).toISOString()).toBe("2026-11-09T02:00:00.000Z");
    // 周一 9 点（北京）还没到，算上周一
    expect(reportSlot(new Date("2026-11-16T01:00:00Z")).toISOString()).toBe("2026-11-09T02:00:00.000Z");
    expect(reportSlot(new Date("2026-11-16T02:30:00Z")).toISOString()).toBe("2026-11-16T02:00:00.000Z");
  });
});

let seq = 1;
function message(chat: number, text: string): TgUpdate {
  return {
    update_id: seq++,
    message: { message_id: seq, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, from: { id: chat }, text },
  } as TgUpdate;
}
function press(chat: number, data: string): TgUpdate {
  return {
    update_id: seq++,
    callback_query: { id: String(seq), data, message: { message_id: 1, chat: { id: chat, type: "private" } } },
  } as unknown as TgUpdate;
}
const textsTo = (chat: number) =>
  tgSent.filter((x) => String(x.params.chat_id) === String(chat) && /^(sendMessage|editMessageText)$/.test(x.method)).map((x) => String(x.params.text));

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

/** 直接写一周的快照：followers 每天涨 growthPerDay */
async function seedWeek(u: TestUser, base: number, growthPerDay: number, now = new Date()) {
  const db = await getDb();
  const [acc] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, u.id));
  for (let d = 7; d >= 1; d--) {
    await db
      .insert(schema.xStatSnapshots)
      .values({ userId: u.id, xUserId: acc.xUserId, day: beijingDay(now, -d), followers: base + (7 - d) * growthPerDay, following: 50, tweets: 100 + (7 - d) * 2 })
      .onConflictDoNothing();
  }
}

const users: TestUser[] = [];
let NOX: TestUser;

beforeAll(async () => {
  await createUser("bench-admin@example.com");
  await saveGate({ enabled: false, chats: [] });
  for (let i = 0; i < 6; i++) {
    const u = await createUser(`bench-u${i}@example.com`);
    await connectMock(u.id, `bench${i}`);
    users.push(u);
  }
  NOX = await createUser("bench-nox@example.com");
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
});

describe("每日快照", () => {
  it("每个账号每天只读一次；没连 X 的不读", async () => {
    const n = await snapshotDue(50);
    expect(n).toBe(6);
    expect(await snapshotDue(50)).toBe(0);
    expect(await takeSnapshot(users[0].id)).toBe(true); // 今天已有
    expect(await takeSnapshot(NOX.id)).toBe(false);
    const db = await getDb();
    const rows = await db.select().from(schema.xStatSnapshots).where(eq(schema.xStatSnapshots.day, beijingDay()));
    expect(rows.length).toBe(6);
    expect(rows.every((r) => r.followers > 0)).toBe(true);
  });
});

describe("同类对比和排行榜", () => {
  beforeAll(async () => {
    for (let i = 0; i < 6; i++) await seedWeek(users[i], 1000 * (i + 1), (i + 1) * 5);
    for (let i = 0; i < 6; i++) await updateProfile(users[i].id, { industry: i < 3 ? "web3" : "tech" });
  });

  it("同行业只有 3 个：和全站 6 个比；看不到别人是谁", async () => {
    const b = (await myBenchmark(users[0].id))!;
    expect(b.stat!.weeklyGrowth).not.toBeNull();
    expect(b.cmp!.scope).toBe("all");
    expect(b.cmp!.size).toBe(6);
    expect(JSON.stringify(b)).not.toContain("bench1");
  });

  it("排行榜只列公开上榜的人", async () => {
    expect(await leaderboard(users[0].id)).toEqual([]);
    await updateProfile(users[2].id, { publicRank: true });
    const board = await leaderboard(users[0].id);
    expect(board.map((e) => e.handle)).toEqual(["demo_bench2"]);
    expect(board[0].mine).toBe(false);
    expect(await leaderboard(users[0].id, "tech")).toEqual([]);
    await updateProfile(users[2].id, { publicRank: false });
    expect(await leaderboard(users[0].id)).toEqual([]);
  });

  it("机器人：更多 → 数据和排行 → 公开上榜要确认一次", async () => {
    await bind(users[1], 9201);
    tgSent.length = 0;
    await handleUpdate(press(9201, "bm"));
    const card = textsTo(9201).at(-1)!;
    expect(card).toContain("📊 我的数据");
    expect(card).toContain("@demo_bench1");
    expect(card).toContain("Web3");
    expect(card).toContain("排第");
    await handleUpdate(press(9201, "bm:pubask"));
    expect(textsTo(9201).at(-1)).toContain("所有用机器人的人都能看到");
    expect((await leaderboard(users[1].id)).length).toBe(0);
    await handleUpdate(press(9201, "bm:pub:1"));
    await handleUpdate(press(9201, "bm:lb:g"));
    expect(textsTo(9201).at(-1)).toContain("@demo_bench1（你）");
    await handleUpdate(press(9201, "bm:set:game"));
    expect(textsTo(9201).at(-1)).toContain("游戏 / 动漫");
    await handleUpdate(press(9201, "bm:set:nope"));
    await updateProfile(users[1].id, { publicRank: false, industry: "web3" });
  });

  it("没连 X 的人点进来，提示先连接", async () => {
    await bind(NOX, 9202);
    tgSent.length = 0;
    await handleUpdate(press(9202, "bm"));
    expect(textsTo(9202).at(-1)).toContain("先连接你的 X 账号");
  });
});

describe("周报", () => {
  it("周一 10 点后发一次；关了周报的不发；过了半天不补发", async () => {
    await bind(users[3], 9203);
    await bind(users[4], 9204);
    await updateProfile(users[4].id, { weeklyReport: false });
    const slot = reportSlot();
    const at = new Date(slot.getTime() + 3600_000);
    // 周报那一刻之前的一周数据
    const db = await getDb();
    await db.delete(schema.xStatSnapshots).where(eq(schema.xStatSnapshots.userId, users[3].id));
    await seedWeek(users[3], 4000, 20, at);
    tgSent.length = 0;
    expect(await sendWeeklyReports(at)).toBeGreaterThanOrEqual(1);
    expect(textsTo(9204).length).toBe(0);
    const report = textsTo(9203).at(-1)!;
    expect(report).toContain("📊 本周数据周报");
    expect(report).toContain("本周 +140");
    expect(await sendWeeklyReports(at)).toBe(0);
    expect(await sendWeeklyReports(new Date(slot.getTime() + 13 * 3600_000))).toBe(0);
  });
});

describe("排行榜发频道", () => {
  it("不满 3 个公开的不发；满了发到频道，只列公开的；每周只发一次", async () => {
    const { postBoardToChannel, saveBenchChannel } = await import("@/lib/bench-channel");
    await saveBenchChannel({ enabled: true, chat: "t.me/vd_channel" });
    await updateProfile(users[0].id, { publicRank: true });
    const few = await postBoardToChannel(new Date(), true);
    expect(few.ok).toBe(false);
    await updateProfile(users[1].id, { publicRank: true });
    await updateProfile(users[2].id, { publicRank: true });
    tgSent.length = 0;
    const r = await postBoardToChannel(new Date(), true);
    expect(r).toMatchObject({ ok: true, chat: "@vd_channel", count: 3 });
    const post = tgSent.find((x) => x.method === "sendMessage" && x.params.chat_id === "@vd_channel")!;
    const text = String(post.params.text);
    expect(text).toContain("本周推主涨粉榜");
    expect(text).toContain("@demo_bench0");
    expect(text).not.toContain("@demo_bench3");
    expect(text).toContain("@test_bot");
    // 手动发过了，这周定时的就不再发；半天后不补发
    const at = new Date(reportSlot().getTime() + 3600_000);
    expect(await postBoardToChannel(at)).toMatchObject({ ok: false, reason: "这周已经发过" });
    expect(await postBoardToChannel(new Date(reportSlot().getTime() + 13 * 3600_000))).toMatchObject({ ok: false, reason: "不在发送时间" });
    await saveBenchChannel({ enabled: false, chat: "" });
    for (const u of users.slice(0, 3)) await updateProfile(u.id, { publicRank: false });
  });

  it("频道填错会提示", async () => {
    const { saveBenchChannel } = await import("@/lib/bench-channel");
    await expect(saveBenchChannel({ enabled: true, chat: "随便写" })).rejects.toThrow("看不懂");
  });
});

describe("网页接口", () => {
  it("只看得到公开上榜的人；不是管理员不能改频道设置", async () => {
    const route = await import("@/app/api/benchmark/route");
    const admin = await import("@/app/api/admin/bench-channel/route");
    await updateProfile(users[5].id, { publicRank: true });
    loginAs(users[4]);
    const d = await body(await route.GET(new Request("http://localhost:3000/api/benchmark")));
    expect(d.connected).toBe(true);
    expect((d.board as { handle: string }[]).map((x) => x.handle)).toEqual(["demo_bench5"]);
    expect(JSON.stringify(d)).not.toContain("demo_bench1");
    const bad = await route.PUT(json({ industry: "nope" }, "http://localhost:3000/api/benchmark", "PUT"));
    expect(bad.status).toBe(400);
    const ok = await body(await route.PUT(json({ industry: "game" }, "http://localhost:3000/api/benchmark", "PUT")));
    expect((ok.profile as { industry: string }).industry).toBe("game");
    expect((await admin.GET()).status).toBe(403);
    loginAs(NOX);
    expect((await body(await route.GET(new Request("http://localhost:3000/api/benchmark")))).connected).toBe(false);
    await updateProfile(users[5].id, { publicRank: false });
  });
});
