/**
 * 发帖效果（1 天 / 7 天读数据、哪类好、最佳时间）和热点提醒（多个信息源说同一件事时推到 TG）。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import { connectMock } from "@/lib/x";
import { bestHour, engagement, insights, type PerfRow } from "@/lib/post-metrics-core";
import { collectPostMetrics, myInsights, nextBestTime } from "@/lib/post-metrics";
import { clusterItems, hotClusters } from "@/lib/hot-topics-core";
import { getHotSettings, runHotTopics, saveHotSettings } from "@/lib/hot-topics";
import { addFeedItem } from "@/lib/tg-feed";
import { customerReport } from "@/lib/daily-report";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as perfRoute from "@/app/api/post-metrics/route";
import * as hotRoute from "@/app/api/hot-topics/route";
import { body, createUser, json, loginAs, tgSent, type TestUser } from "./helpers";

const H = 3600_000;
const DAY = 24 * H;
const m = (likes: number, impressions = 100) => ({ impressions, likes, retweets: 0, replies: 0, quotes: 0, bookmarks: 0 });

let seq = 1;
function message(chat: number, text: string): TgUpdate {
  return {
    update_id: 90_000 + seq++,
    message: { message_id: seq, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, from: { id: chat }, text },
  } as TgUpdate;
}
function press(chat: number, data: string): TgUpdate {
  return {
    update_id: 90_000 + seq++,
    callback_query: { id: String(seq), data, message: { message_id: 1, chat: { id: chat, type: "private" } } },
  } as unknown as TgUpdate;
}
const textsTo = (chat: number) =>
  tgSent.filter((x) => String(x.params.chat_id) === String(chat) && /^(sendMessage|editMessageText)$/.test(x.method)).map((x) => String(x.params.text));
const buttonsTo = (chat: number) =>
  tgSent
    .filter((x) => String(x.params.chat_id) === String(chat))
    .flatMap((x) => ((x.params.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat());

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

/** 直接写一条已发出的帖子 */
async function published(u: TestUser, text: string, ago: number, tweetId = `t${seq++}`, xUserId?: string) {
  const db = await getDb();
  const [acc] = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, u.id));
  const [p] = await db
    .insert(schema.posts)
    .values({ userId: u.id, tweets: [text], status: "published", postIds: [tweetId], xUserId: xUserId ?? acc?.xUserId ?? null, publishedAt: new Date(Date.now() - ago) })
    .returning();
  return p;
}

describe("发帖效果：纯函数", () => {
  const row = (kind: PerfRow["kind"], likes: number, hourUtc: number, i: number): PerfRow => ({
    postId: `p${i}`,
    tweetId: `t${i}`,
    kind,
    text: `帖子 ${i}`,
    publishedAt: new Date(Date.UTC(2026, 10, 1 + i, hourUtc)),
    metrics: m(likes),
  });

  it("互动分：转发、引用、回复各 2 分", () => {
    expect(engagement({ impressions: 1, likes: 3, retweets: 1, replies: 1, quotes: 1, bookmarks: 2 })).toBe(11);
  });

  it("找出效果最好的类型和时段；数据不够不推荐时间", () => {
    // 北京时间 21 点（UTC 13 点）发的互动高
    const rows = [
      row("short", 30, 13, 1),
      row("short", 28, 13, 2),
      row("thread", 32, 13, 3),
      row("short", 5, 1, 4),
      row("thread", 6, 1, 5),
      row("short", 4, 1, 6),
    ];
    const i = insights(rows, "Asia/Shanghai");
    expect(i.count).toBe(6);
    expect(i.top[0].postId).toBe("p3");
    expect(i.bestSlot).toMatchObject({ start: 21, end: 24 });
    expect(bestHour(i.bestSlot!)).toBe(22);
    expect(i.kinds.map((k) => k.kind)).toEqual(["thread", "short"]);
    expect(insights(rows.slice(0, 5), "Asia/Shanghai").bestSlot).toBeNull();
    // 删了的帖子不算
    expect(insights([...rows, { ...row("short", 0, 1, 7), metrics: null }], "Asia/Shanghai").count).toBe(6);
  });
});

describe("发帖效果：读数据", () => {
  let A: TestUser;
  let B: TestUser;
  beforeAll(async () => {
    await createUser("perf-admin@example.com");
    await saveGate({ enabled: false, chats: [] });
    A = await createUser("perf-a@example.com");
    B = await createUser("perf-b@example.com");
    await connectMock(A.id, "perfa");
    await connectMock(B.id, "perfb");
  });
  beforeEach(() => {
    resetRateLimits();
    resetGateCache();
    tgSent.length = 0;
  });

  it("满 1 天读一次、满 7 天再读一次；不到 1 天的不读；删了的记下不再读", async () => {
    const fresh = await published(A, "刚发的", 2 * H);
    const day1 = await published(A, "昨天发的", 25 * H);
    const gone = await published(A, "删掉的", 26 * H, "t-deleted-1");
    const week = await published(A, "上周发的", 8 * DAY);
    const old = await published(A, "很久以前", 20 * DAY);
    const other = await published(A, "换账号前发的", 2 * DAY, "t-other", "someone-else");
    const n = await collectPostMetrics(new Date(), true);
    const db = await getDb();
    const rows = await db.select().from(schema.postMetrics).where(eq(schema.postMetrics.userId, A.id));
    expect(n).toBe(3);
    const by = new Map(rows.map((r) => [r.postId, r]));
    expect(by.has(fresh.id) || by.has(old.id) || by.has(other.id)).toBe(false);
    expect(by.get(day1.id)!.d1).toBeTruthy();
    expect(by.get(day1.id)!.d7At).toBeNull();
    expect(by.get(gone.id)!.d1).toBeNull();
    expect(by.get(gone.id)!.d1At).toBeTruthy();
    // 超过 7 天的直接读 7 天的
    expect(by.get(week.id)!.d7).toBeTruthy();
    expect(by.get(week.id)!.d1At).toBeNull();
    // 再跑一次：没有新到点的
    expect(await collectPostMetrics(new Date(), true)).toBe(0);
    // 6 天后：昨天那条到 7 天了，再读一次
    expect(await collectPostMetrics(new Date(Date.now() + 6 * DAY + H), true)).toBeGreaterThanOrEqual(1);
    const [again] = await db.select().from(schema.postMetrics).where(eq(schema.postMetrics.postId, day1.id));
    expect(again.d7).toBeTruthy();
  });

  it("只看得到自己的；网页和机器人都能看", async () => {
    loginAs(B);
    const r = await body(await perfRoute.GET());
    expect(r.count).toBe(0);
    loginAs(A);
    const ra = await body(await perfRoute.GET());
    expect(ra.count).toBeGreaterThan(0);
    expect((await myInsights(B.id)).insights.count).toBe(0);
    await bind(A, 7101);
    tgSent.length = 0;
    await handleUpdate(message(7101, "/perf"));
    expect(textsTo(7101).join("\n")).toContain("📈 发帖效果");
    expect(textsTo(7101).join("\n")).not.toMatch(/USDT/);
  });

  it("数据够了：定时发布多一个「⭐ 最佳时间」", async () => {
    const C = await createUser("perf-c@example.com");
    await connectMock(C.id, "perfc");
    const db = await getDb();
    // 6 条：北京时间 21 点发的互动高
    for (let i = 0; i < 6; i++) {
      const p = await published(C, `帖子 ${i}`, 2 * DAY);
      const hour = i < 3 ? 13 : 1;
      await db.insert(schema.postMetrics).values({
        userId: C.id,
        postId: p.id,
        tweetId: p.postIds[0],
        kind: "short",
        publishedAt: new Date(Date.UTC(2026, 10, 1 + i, hour)),
        d1: m(i < 3 ? 30 : 3),
        d1At: new Date(),
      });
    }
    const best = await nextBestTime(C.id);
    expect(best).not.toBeNull();
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hourCycle: "h23" }).format(best!.at)).toBe("22");
    expect(best!.at.getTime()).toBeGreaterThan(Date.now());
    expect(await nextBestTime(B.id)).toBeNull();
  });

  it("日报里带上最近效果最好的一条", async () => {
    const D = await createUser("perf-d@example.com");
    await connectMock(D.id, "perfd");
    const p = await published(D, "效果很好的一条", 2 * DAY);
    const db = await getDb();
    const now = new Date();
    await db.insert(schema.postMetrics).values({ userId: D.id, postId: p.id, tweetId: p.postIds[0], kind: "short", publishedAt: p.publishedAt!, d1: m(50, 900), d1At: new Date(now.getTime() - DAY) });
    const r = await customerReport(D.id, now, "UTC");
    expect(r?.text).toContain("效果最好的：效果很好的一条");
    expect(r?.text).toContain("👁 900");
  });
});

describe("热点提醒：纯函数", () => {
  const it0 = (id: string, sourceId: string, text: string, alsoSeen: string[] = []) => ({
    id,
    sourceId,
    text,
    createdAt: new Date(),
    alsoSeen: alsoSeen.map((s) => ({ sourceId: s })),
    hotAt: null,
  });
  const NEWS = "美联储今晚宣布降息二十五个基点，这是今年第三次降息，市场普遍预期年底前还会再降一次";

  it("不同信息源说同一件事归成一组，按源的个数算；同一个源说两遍只算一个", () => {
    const items = [
      it0("a", "s1", NEWS),
      it0("b", "s2", `快讯：${NEWS.slice(0, 30)}，美股期货应声上涨`),
      it0("c", "s3", "完全不相干的内容：今天天气不错，适合出去走走晒太阳，顺便买杯咖啡"),
      it0("d", "s1", `${NEWS}（重复发布）`),
    ];
    const groups = clusterItems(items);
    const news = groups.find((g) => g.members.some((x) => x.id === "a"))!;
    expect(news.sources).toBe(2);
    expect(hotClusters(items, 3)).toHaveLength(0);
    // 跨来源去重时没收进来的源也算
    const withDup = [...items.slice(0, 3), it0("e", "s4", `${NEWS}。`, ["s5"])];
    const hot = hotClusters(withDup, 3);
    expect(hot).toHaveLength(1);
    expect(hot[0].sources).toBe(4);
    // 推过的不再推
    expect(hotClusters(withDup.map((x) => (x.id === "a" ? { ...x, hotAt: new Date() } : x)), 3)).toHaveLength(0);
  });
});

describe("热点提醒：推送", () => {
  let U: TestUser;
  let V: TestUser;
  const srcs: string[] = [];
  const NEWS = "某交易所刚刚宣布暂停所有提币，官方称是钱包系统升级，预计需要六个小时，社区担心资金安全";
  beforeAll(async () => {
    U = await createUser("hot-u@example.com");
    V = await createUser("hot-v@example.com");
    const db = await getDb();
    for (const h of ["chan_a", "chan_b", "chan_c", "chan_d"]) {
      const [s] = await db.insert(schema.sources).values({ userId: U.id, type: "tg_channel", handle: h, title: `频道${h.slice(-1).toUpperCase()}` }).returning();
      srcs.push(s.id);
    }
    await db.insert(schema.sources).values({ userId: V.id, type: "tg_channel", handle: "v1" });
    await db.insert(schema.sources).values({ userId: V.id, type: "tg_channel", handle: "v2" });
    await bind(U, 7201);
    await bind(V, 7202);
  });
  beforeEach(() => {
    resetRateLimits();
    tgSent.length = 0;
  });

  it("3 个信息源说同一件事：推一次，带起草按钮；同一件事不再推；别人收不到", async () => {
    await addFeedItem(U.id, { kind: "tg_channel", text: NEWS, sourceId: srcs[0], author: "频道A" });
    // 和第一条几乎一样：跨来源去重不收，但记下这个源也在说
    expect(await addFeedItem(U.id, { kind: "tg_channel", text: `${NEWS}！`, sourceId: srcs[1], author: "频道B" })).toBeNull();
    expect(await runHotTopics(new Date(), true)).toBe(0);
    // 换个说法的第三个源
    await addFeedItem(U.id, { kind: "tg_channel", text: `突发：${NEWS.slice(0, 26)}，币价短线下跌百分之三`, sourceId: srcs[2], author: "频道C" });
    expect(await runHotTopics(new Date(), true)).toBe(1);
    const t = textsTo(7201).join("\n");
    expect(t).toContain("🔥 热点：3 个信息源");
    expect(t).toContain("频道A");
    expect(buttonsTo(7201).some((b) => b.callback_data.startsWith("iw:"))).toBe(true);
    expect(textsTo(7202)).toHaveLength(0);
    // 第四个源也来了：同一件事不再推
    await addFeedItem(U.id, { kind: "tg_channel", text: `${NEWS.slice(0, 30)}，用户排队等提币`, sourceId: srcs[3] });
    expect(await runHotTopics(new Date(), true)).toBe(0);
  });

  it("可以关掉、改成几个源算热点；不合法的值不改；网页也能改", async () => {
    await handleUpdate(press(7201, "ht:on:0"));
    expect((await getHotSettings(U.id)).enabled).toBe(false);
    await handleUpdate(press(7201, "ht:n:2"));
    await handleUpdate(press(7201, "ht:n:99"));
    expect((await getHotSettings(U.id)).minSources).toBe(2);
    loginAs(V);
    const r = await body(await hotRoute.PUT(json({ dailyCap: 1, minSources: 2 }, undefined, "PUT")));
    expect(r.settings).toMatchObject({ dailyCap: 1, minSources: 2, enabled: true });
    expect((await getHotSettings(U.id)).dailyCap).toBe(3);
    await saveHotSettings(U.id, { enabled: true });
  });

  it("每天最多推几条", async () => {
    const db = await getDb();
    const [w1] = await db.insert(schema.sources).values({ userId: V.id, type: "tg_channel", handle: "v3" }).returning();
    const vs = await db.select().from(schema.sources).where(eq(schema.sources.userId, V.id));
    const topics = ["新款手机今天发布，起售价四千九百九十九元，首批货已经抢光，黄牛加价一千", "某城市地铁新线路今天开通运营，全长三十公里，设站二十个，早高峰客流爆满"];
    for (const t of topics) {
      await addFeedItem(V.id, { kind: "tg_channel", text: t, sourceId: vs[0].id });
      await addFeedItem(V.id, { kind: "tg_channel", text: `消息：${t.slice(0, 25)}，网友热议`, sourceId: w1.id });
    }
    expect(await runHotTopics(new Date(), true)).toBe(1);
    expect(textsTo(7202).filter((x) => x.startsWith("🔥"))).toHaveLength(1);
  });
});
