/**
 * 日报：顾客的昨日小结（按各自时区和钟点发、每天一次、能关掉、不显示价格、没动静不发），
 * 平台方的经营日报（注册、首充、充值、消耗、AI / X 成本、毛利），以及接口用量的记录。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { addBalance, MICRO } from "@/lib/billing";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import {
  businessStats,
  customerReport,
  getReportPrefs,
  localDayHour,
  REPORT_SECTIONS,
  runDailyReports,
  saveAdminReportConfig,
  saveReportPrefs,
  yesterdayRange,
} from "@/lib/daily-report";
import { recordAiUsage, recordXCall, usageBetween, usageFetch, DEFAULT_COSTS } from "@/lib/usage";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as reportRoute from "@/app/api/admin/report/route";
import { body, createUser, json, loginAs, tgSent, type TestUser } from "./helpers";

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

// 「明天」这个时候：今天造的数据都落在日报的「昨天」里
const tomorrow = () => new Date(Date.now() + 86400_000);
const nowHour = () => localDayHour(tomorrow(), "Asia/Shanghai").hour;

const ADMIN_CHAT = 9100;
const A_CHAT = 9101;
const B_CHAT = 9102;
let ADMIN: TestUser;
let A: TestUser;
let B: TestUser;

beforeAll(async () => {
  ADMIN = await createUser("report-admin@example.com");
  await saveGate({ enabled: false, chats: [] });
  A = await createUser("report-a@example.com");
  B = await createUser("report-b@example.com");
  await bind(ADMIN, ADMIN_CHAT);
  await bind(A, A_CHAT);
  await bind(B, B_CHAT);
  // 钟点设成「明天这个时候」的钟点：不管测试在几点跑都算「到点了」
  for (const u of [A, B]) await saveReportPrefs(u.id, { hour: nowHour() });
  await saveAdminReportConfig({ enabled: false });
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
});

describe("时区", () => {
  it("北京时间 9 点 = UTC 1 点；昨天的范围是北京时间的 0 点到 0 点", () => {
    const now = new Date("2026-11-13T01:10:00Z");
    expect(localDayHour(now, "Asia/Shanghai")).toEqual({ day: "2026-11-13", hour: 9 });
    const r = yesterdayRange(now, "Asia/Shanghai");
    expect(r.day).toBe("2026-11-12");
    expect(r.from.toISOString()).toBe("2026-11-11T16:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-12T16:00:00.000Z");
    // 纽约 11 月是冬令时（UTC-5）
    const ny = yesterdayRange(now, "America/New_York");
    expect(ny.day).toBe("2026-11-11");
    expect(ny.from.toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });
});

describe("顾客日报", () => {
  beforeAll(async () => {
    const db = await getDb();
    const now = new Date();
    await addBalance(A.id, 30 * MICRO, { kind: "adjust", note: "测试" });
    const [p1, p2] = await db
      .insert(schema.posts)
      .values([
        { userId: A.id, tweets: ["第一条"], status: "published", publishedAt: now },
        { userId: A.id, tweets: ["第二条"], status: "published", publishedAt: now },
        { userId: A.id, tweets: ["没发出去"], status: "failed" },
      ])
      .returning();
    await db.insert(schema.autoPosts).values([
      { userId: A.id, text: "自动发的", status: "published", postId: p2.id },
      { userId: A.id, text: "等确认 1", status: "review" },
      { userId: A.id, text: "等确认 2", status: "review" },
    ]);
    void p1;
    await db.insert(schema.replyItems).values({
      userId: A.id,
      tweetId: "t-1",
      authorId: "a-1",
      authorHandle: "someone",
      text: "你怎么看？",
      candidates: ["候选一", "候选二"],
    });
  });

  it("到点发一份：发了几条、自动几条、待确认、回复候选；不出现价格", async () => {
    const r = await runDailyReports(tomorrow(), true);
    expect(r.customers).toBe(1); // B 什么都没有，不发
    const t = textsTo(A_CHAT).join("\n");
    expect(t).toContain("昨日小结");
    expect(t).toContain("发出 2 条帖子（其中自动发帖 1 条）");
    expect(t).toContain("1 条没发出去");
    expect(t).toContain("自动发帖有 2 条等你确认");
    expect(t).toContain("新的回复候选 1 条");
    expect(t).not.toContain("预计还能发"); // 开源版不计费，日报不带余额估算
    expect(t).not.toContain("USDT");
    expect(textsTo(B_CHAT)).toEqual([]);
  });

  it("同一天不重复发", async () => {
    const r = await runDailyReports(tomorrow(), true);
    expect(r.customers).toBe(0);
    expect(textsTo(A_CHAT)).toEqual([]);
  });

  it("还没到设定的钟点不发", async () => {
    await saveReportPrefs(A.id, { hour: 23 });
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(schema.dailyReportSettings).set({ lastSentDay: null }).where(eq(schema.dailyReportSettings.userId, A.id));
    // 找一个北京时间 22 点的时刻
    const at = new Date(Date.UTC(2030, 0, 1, 14, 0)); // 北京时间 22:00
    await runDailyReports(at, true);
    expect(textsTo(A_CHAT)).toEqual([]);
    await saveReportPrefs(A.id, { hour: nowHour() });
  });

  it("过了设定钟点 4 小时就不补发（服务停了大半天再起来不会半夜发早报）", async () => {
    await saveReportPrefs(A.id, { hour: 9 });
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(schema.dailyReportSettings).set({ lastSentDay: null }).where(eq(schema.dailyReportSettings.userId, A.id));
    await runDailyReports(new Date(Date.UTC(2030, 0, 1, 7, 0)), true); // 北京时间 15:00
    expect(textsTo(A_CHAT)).toEqual([]);
    await saveReportPrefs(A.id, { hour: nowHour() });
  });


  it("在机器人里关掉日报就不发；也能改时间和时区", async () => {
    await handleUpdate(press(B_CHAT, "rp:m"));
    expect(textsTo(B_CHAT).join("\n")).toContain("每日日报");
    await handleUpdate(press(B_CHAT, "rp:on:0"));
    expect((await getReportPrefs(B.id)).enabled).toBe(false);
    tgSent.length = 0;
    await runDailyReports(tomorrow(), true);
    expect(textsTo(B_CHAT)).toEqual([]);

    await handleUpdate(press(B_CHAT, "rp:h:8")); // 选钟点同时重新打开
    await handleUpdate(press(B_CHAT, "rp:z:4")); // 伦敦
    expect(await getReportPrefs(B.id)).toEqual({ enabled: true, hour: 8, tz: "Europe/London" });
  });

  it("「更多」里有日报设置入口", async () => {
    await handleUpdate(message(B_CHAT, "/more"));
    const data = tgSent.flatMap((x) => ((x.params.reply_markup as { inline_keyboard?: { callback_data?: string }[][] })?.inline_keyboard ?? []).flat().map((b) => b.callback_data));
    expect(data).toContain("rp:m");
  });

  it("可以往日报里加新的一块（给以后的同行对比留的口子）", async () => {
    REPORT_SECTIONS.push(async () => ({ lines: ["🏆 同行对比：测试"], active: false }));
    const rep = await customerReport(A.id, tomorrow());
    expect(rep?.text).toContain("同行对比");
    REPORT_SECTIONS.pop();
  });
});

describe("接口用量和经营日报", () => {
  it("AI 按 token、X 按条记下来，按单价算成本", async () => {
    const from = new Date(Date.now() - 3600_000 * 2);
    await recordAiUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 });
    // 轻量模型（Haiku）按自己的单价：1000×0.1 + 500×0.5 = 350 微 USDT
    await recordAiUsage({ input_tokens: 1000, output_tokens: 500 }, "claude-haiku-5-5");
    await recordXCall("POST", "/tweets", { data: { id: "1" } });
    await recordXCall("GET", "/users/1/mentions", { data: [{}, {}, {}] });
    await recordXCall("POST", "/oauth2/token", {});
    const t = await usageBetween(from, new Date(Date.now() + 3600_000));
    expect(t.ai).toMatchObject({ input: 2000, output: 1000, cache_read: 10_000, calls: 2 });
    expect(t.x).toMatchObject({ post: 1, read: 3 });
    // Sonnet：1000×2 + 500×10 + 10000×0.1 = 8000；Haiku：350；合计 8350 微 USDT
    expect(t.ai.costMicro).toBe(8_350);
    expect(t.x.costMicro).toBe(Math.round((DEFAULT_COSTS.xPost + 3 * DEFAULT_COSTS.xRead) * MICRO));
  });

  it("AI 客户端的 fetch 照常返回，同时记下 usage", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "m", usage: { input_tokens: 7, output_tokens: 3 } }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const res = await usageFetch("https://api.anthropic.com/v1/messages", { method: "POST" });
      expect((await res.json()).id).toBe("m");
    } finally {
      globalThis.fetch = real;
    }
    await new Promise((r) => setTimeout(r, 50));
    const t = await usageBetween(new Date(Date.now() - 7200_000), new Date(Date.now() + 3600_000));
    expect(t.ai.input).toBe(2007);
  });

  it("经营日报：新注册、首充、充值、用户消耗、成本、毛利；管理员自己不算", async () => {
    await addBalance(A.id, 50 * MICRO, { kind: "topup", note: "测试充值" });
    await addBalance(A.id, -2 * MICRO, { kind: "charge" });
    await addBalance(ADMIN.id, 100 * MICRO, { kind: "topup", note: "管理员自己" });
    const s = await businessStats(tomorrow());
    expect(s.signups).toBe(2);
    expect(s.boundTg).toBe(2);
    expect(s.firstTopups).toBe(1);
    expect(s.topupCount).toBe(1);
    expect(s.topupMicro).toBe(50 * MICRO);
    expect(s.spentMicro).toBe(2 * MICRO);
    expect(s.grossMicro).toBe(2 * MICRO - s.usage.costMicro);
  });

  it("到点发到管理员的 TG，每天一次；后台能看预览、改单价、立即发一份", async () => {
    await saveAdminReportConfig({ enabled: true, hour: 0, lastSentDay: null });
    const r = await runDailyReports(tomorrow(), true);
    expect(r.admin).toBe(true);
    const t = textsTo(ADMIN_CHAT).join("\n");
    expect(t).toContain("经营日报");
    expect(t).toContain("首充 1 人");
    expect(t).toContain("毛利");
    expect((await runDailyReports(tomorrow(), true)).admin).toBe(false);

    loginAs(ADMIN);
    const g = await body(await reportRoute.GET());
    expect(String(g.preview)).toContain("经营日报");
    const put = await reportRoute.PUT(json({ enabled: true, hour: 8, tz: "Asia/Shanghai", costs: { ...DEFAULT_COSTS, xPost: 0.02 } }, undefined, "PUT"));
    expect(put.status).toBe(200);
    tgSent.length = 0;
    expect((await reportRoute.POST()).status).toBe(200);
    expect(textsTo(ADMIN_CHAT).join("\n")).toContain("经营日报");

    loginAs(A);
    expect((await reportRoute.GET()).status).toBe(403);
  });
});
