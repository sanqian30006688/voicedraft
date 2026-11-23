/**
 * 自动发帖：信息源采集 → 按文风写 → 重合度检查 → 确认 / 全自动排期。
 * 每位客户只用自己的源、自己的余额、自己的 X 账号，结果只推给自己。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";

// 不真的查 DNS：示例网站都当成公网地址
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host.startsWith("intranet") ? "10.0.0.5" : "93.184.216.34", family: 4 }]),
}));

// 控制 AI 的输出：默认写一条和原文无关的；需要时让它照抄原文
const llmMode = { copy: false, cliche: false, cut: false, img: "ok" as "ok" | "nsfw" | "photo" };
vi.mock("@/lib/llm", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...real,
    classifySourceImage: vi.fn(async () =>
      llmMode.img === "ok"
        ? { usable: true, kind: "screenshot", reason: "截图" }
        : llmMode.img === "nsfw"
          ? { usable: false, kind: "photo", reason: "图片涉及色情或暴力" }
          : { usable: false, kind: "photo", reason: "摄影作品" },
    ),
    generateFromSource: vi.fn(async (_card: unknown, task: { source: string; shape?: { kind: string } }) =>
      task.shape?.kind === "thread"
        ? [
            [
              `第一条：一家社区书店怎样靠读书会活下来。${Math.random().toString(36).slice(2, 6)}`,
              "第二条：他们每周办两次读书会，会员费覆盖了房租。",
              "第三条：书店不只卖书，更像一个让人愿意常来的地方。",
            ].join("\n\n---\n\n"),
          ]
        : task.shape?.kind === "long"
          ? [
              `一家社区书店怎样靠读书会活下来：${"他们每周办两次读书会，会员费覆盖了房租，老顾客还会带朋友来。".repeat(5)}${Math.random().toString(36).slice(2, 6)}`,
            ]
          : llmMode.copy
        ? [task.source.slice(0, 120)]
        : llmMode.cut
          ? ["我觉得这件事最值得说的是，", "说到底还是要看："]
        : llmMode.cliche
          ? [`总而言之，AI 赋能小团队，值得注意的是效率至关重要，让我们一起来看看！${Math.random().toString(36).slice(2, 6)}`]
          : [`我自己的看法：慢一点没关系，先把一件小事做完再说。${Math.random().toString(36).slice(2, 6)}`],
    ),
  };
});

// 假网站
const site: Record<string, { body: string; type?: string; status?: number }> = {};
let rssItems = 6;
// 每篇讲不同的事（讲同一件事的会被当成重复跳过）
const TOPICS = [
  "三个人的团队如何在半年里把产品做出来，并拿到第一批付费用户。",
  "一家咖啡店老板分享，把菜单从四十种砍到十二种以后，营业额反而涨了三成。",
  "有位独立开发者说，他每周只在周三下午回邮件，其他时间全部用来写代码。",
  "某城市试点周末免费公交，三个月后市中心商铺的客流明显增加。",
  "研究发现，每天午后散步二十分钟的人，晚上入睡时间平均提前了一刻钟。",
  "一位老师把作业改成每周一次的小项目，学生交作业的比例从六成升到九成。",
  "图书馆延长开放到晚上十点后，年轻读者的借阅量翻了一倍。",
  "一位农民用无人机给果园打药，原来要三天的活现在一个上午就做完了。",
  "小区把闲置车库改成共享工具间，邻居之间借电钻、梯子再也不用上门敲门。",
  "一家出版社开始在书的最后一页印上编辑的手写感想，读者反馈出奇地好。",
];
function rss() {
  const items = Array.from({ length: rssItems }, (_, i) => {
    const n = rssItems - i;
    return `<item><title>第 ${n} 篇：小团队怎样把产品做出来</title><link>https://news.example.com/p/${n}</link>
      <description><![CDATA[<p>第 ${n} 篇：${TOPICS[(n + 4) % TOPICS.length]}</p>]]></description>
      <pubDate>${new Date(Date.now() - i * 50 * 3600_000).toUTCString()}</pubDate></item>`;
  }).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>示例新闻</title>${items}</channel></rss>`;
}
const prevFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://pbs.twimg.com/")) {
    return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"), {
      headers: { "content-type": "image/png" },
    });
  }
  if (url.startsWith("https://news.example.com/feed")) return new Response(rss(), { headers: { "content-type": "application/rss+xml" } });
  const hit = site[url];
  if (hit) return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type ?? "text/html; charset=utf-8" } });
  if (/robots\.txt$/.test(url)) return new Response("", { status: 404 });
  if (/example\.com/.test(url)) return new Response("not found", { status: 404 });
  return prevFetch(input, init);
}) as typeof fetch;

import { getDb, schema } from "@/db";
import { connectMock } from "@/lib/x";
import { addBalance, getBalance, MICRO } from "@/lib/billing";
import { approveAuto, skipAuto, gapLabel, inWindow, nextInWindow, pickGapMin, processUser, saveSettings } from "@/lib/autopilot";
import { parseGap } from "@/lib/tg-bot-auto";
import { addAnySource, classifyInput } from "@/lib/sources";
import { refreshSource } from "@/lib/tg-feed";
import { handleUpdate } from "@/lib/telegram";
import { extractArticle, extractLinks, isPrivateAddress, normalizeUrl, parseFeed, parseRobots, robotsAllows } from "@/lib/web-fetch";
import { parseXHandle } from "@/lib/x";
import { createUser, tgSent, type TestUser } from "./helpers";

let OWNER: TestUser;
let A: TestUser;
let B: TestUser;
const ALL_DAY = { startHour: 0, endHour: 24 };

beforeAll(async () => {
  OWNER = await createUser("admin@example.com"); // 第一个注册的是管理员（不扣费），下面两位是普通顾客
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
  site["https://news.example.com/"] = {
    body: `<html><head><title>示例新闻</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>`,
  };
  site["https://blocked.example.com/robots.txt"] = { body: "User-agent: *\nDisallow: /", type: "text/plain" };
  site["https://blocked.example.com/"] = { body: "<html><title>x</title></html>" };
});

describe("解析", () => {
  it("RSS / Atom", () => {
    const r = parseFeed(rss(), "https://news.example.com/feed.xml");
    expect(r.title).toBe("示例新闻");
    expect(r.entries[0].link).toBe(`https://news.example.com/p/${rssItems}`);
    expect(r.entries[0].text).toContain("三个人的团队");
    const atom = parseFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>博客</title><entry><title>标题一</title><link rel="alternate" href="/a/1"/><updated>2026-11-01T00:00:00Z</updated><summary>摘要内容很长很长很长很长</summary></entry></feed>`,
      "https://blog.example.com/atom.xml",
    );
    expect(atom.entries[0]).toMatchObject({ title: "标题一", link: "https://blog.example.com/a/1" });
  });

  it("论坛列表页取文章链接，正文页取正文", () => {
    const links = extractLinks(
      `<nav><a href="/login">登录一下吧朋友们</a></nav>
       <a href="/thread/1">如何在三个月里学会做产品</a><a href="/thread/2">独立开发者的第一年复盘</a>
       <a href="https://other.com/x">别的网站的一篇文章标题</a><a href="/tag/ai">AI 标签页面链接</a><a href="/t/3">短</a>`,
      "https://bbs.example.com/forum/1",
    );
    expect(links.map((l) => l.url)).toEqual(["https://bbs.example.com/thread/1", "https://bbs.example.com/thread/2"]);
    const art = extractArticle(`<html><head><title>标题</title></head><body><header>菜单</header><article><p>第一段正文内容，足够长的一句话放在这里。</p><p>第二段。</p></article></body></html>`);
    expect(art.title).toBe("标题");
    expect(art.text).toContain("第一段正文内容");
    expect(art.text).not.toContain("菜单");
    expect(extractArticle(`<meta property="article:published_time" content="2020-01-02T03:04:05Z"><p>正文正文正文正文正文正文正文正文</p>`).publishedAt?.toISOString()).toBe(
      "2020-01-02T03:04:05.000Z",
    );
  });

  it("robots.txt：最长匹配，Allow 优先", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: other\nDisallow: /");
    expect(robotsAllows(rules, "/public")).toBe(true);
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/private/ok/1")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: VoiceDraftBot\nDisallow: /\nUser-agent: *\nAllow: /"), "/a")).toBe(false);
  });

  it("地址和输入识别", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.2")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(parseXHandle("https://x.com/elonmusk")).toBe("elonmusk");
    expect(parseXHandle("https://x.com/elonmusk/status/123")).toBeNull();
    expect(classifyInput("@somebody")).toEqual({ kind: "x_user", handle: "somebody" });
    expect(classifyInput("t.me/durov")?.kind).toBe("tg");
    expect(classifyInput("news.example.com")?.kind).toBe("url");
  });

  it("发帖时段（含跨午夜）", () => {
    expect(inWindow(9, 8, 23)).toBe(true);
    expect(inWindow(3, 8, 23)).toBe(false);
    expect(inWindow(1, 20, 2)).toBe(true);
    const t = nextInWindow(new Date("2026-11-12T18:00:00Z"), { startHour: 8, endHour: 23, tz: "Asia/Shanghai" }); // 上海 02:00
    expect(t.toISOString()).toBe("2026-11-13T00:00:00.000Z"); // 上海 08:00
  });
});

describe("采集与自动发帖", () => {
  let srcId: string;

  it("网页里找到 RSS 就订阅 RSS；订阅时读到的只用够新的（48 小时内发布）", async () => {
    const r = await addAnySource(A.id, "news.example.com");
    expect(r.type).toBe("rss");
    expect(r.added).toBe(5);
    srcId = r.id;
    await saveSettings(A.id, { enabled: true, mode: "review", ...ALL_DAY });
    // 最新那篇是刚发布的：拿去写；其余都是两天以前的：不用
    expect(await processUser(A.id)).toBe("review");
    expect(await processUser(A.id)).toBe("idle");
    const db = await getDb();
    const [first] = await db.select().from(schema.autoPosts).where(eq(schema.autoPosts.userId, A.id));
    await skipAuto(A.id, first.id);
  });

  it("有新文章：按文风写好推给本人确认；B 看不到 A 的源", async () => {
    rssItems = 7;
    expect(await refreshSource(A.id, srcId)).toBe(1);
    const before = await getBalance(A.id);
    const sentBefore = tgSent.length;
    expect(await processUser(A.id)).toBe("review");
    expect(await getBalance(A.id)).toBe(before); // 开源版不扣费
    const pushed = tgSent.slice(sentBefore).filter((m) => m.method === "sendMessage");
    expect(pushed).toHaveLength(1);
    expect(pushed[0].params.chat_id).toBe("1001");
    expect(String(pushed[0].params.text)).toContain("等你确认");

    await saveSettings(B.id, { enabled: true, ...ALL_DAY });
    expect(await processUser(B.id)).toBe("idle");
    // B 也不能刷新、处理 A 的东西
    await expect(refreshSource(B.id, srcId)).rejects.toThrow();
    const db = await getDb();
    const [row] = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, A.id), eq(schema.autoPosts.status, "review")));
    await expect(approveAuto(B.id, row.id)).rejects.toThrow("找不到");

    // A 确认 → 排进定时，用 A 自己的 X 账号
    const { job } = await approveAuto(A.id, row.id);
    expect(job.status).toBe("scheduled");
    expect(job.xUserId).toBe("mock-alice");
    await expect(approveAuto(A.id, row.id)).rejects.toThrow();
  });

  it("和原文太像就不用，钱退回", async () => {
    rssItems = 8;
    await refreshSource(A.id, srcId);
    llmMode.copy = true;
    const before = await getBalance(A.id);
    expect(await processUser(A.id)).toBe("skipped");
    llmMode.copy = false;
    expect(await getBalance(A.id)).toBe(before);
    const db = await getDb();
    const rows = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, A.id), eq(schema.autoPosts.status, "skipped")));
    expect(rows.some((r) => r.note?.includes("太像"))).toBe(true);
  });

  it("全自动模式直接排进定时；到每天上限就停", async () => {
    await saveSettings(A.id, { mode: "auto", dailyCap: 2 });
    rssItems = 9;
    await refreshSource(A.id, srcId);
    expect(await processUser(A.id)).toBe("scheduled");
    const db = await getDb();
    const [row] = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, A.id), eq(schema.autoPosts.status, "scheduled")));
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, row.postId!));
    expect(post.status).toBe("scheduled");
    expect(post.userId).toBe(A.id);
    expect(row.quality).toBeGreaterThanOrEqual(60);
    rssItems = 10;
    await refreshSource(A.id, srcId);
    expect(await processUser(A.id)).toBe("cap");
  });

  it("全自动模式下质量分太低的不直接发，改成等确认", async () => {
    await saveSettings(A.id, { mode: "auto", dailyCap: 5, perSourceDaily: 10 });
    rssItems = 11;
    await refreshSource(A.id, srcId);
    llmMode.cliche = true;
    try {
      expect(await processUser(A.id)).toBe("review");
    } finally {
      llmMode.cliche = false;
    }
    const db = await getDb();
    const rows = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, A.id), eq(schema.autoPosts.status, "review")));
    const low = rows.find((r) => r.note?.includes("质量分"));
    expect(low).toBeTruthy();
    expect(low!.quality).toBeLessThan(60);
    expect(low!.postId).toBeNull();
    await saveSettings(A.id, { dailyCap: 2, perSourceDaily: 2 });
  });

  it("X 用户的推文：重合度上限 50%", async () => {
    const r = await addAnySource(B.id, "https://x.com/someone");
    expect(r.type).toBe("x_user");
    const db = await getDb();
    // 模拟新推文：订阅之后收进来的
    const { addFeedItem } = await import("@/lib/tg-feed");
    await addFeedItem(B.id, {
      kind: "x_user",
      text: "一个人做产品最怕的不是没想法，而是想法太多，每个都做一半，最后一个都没做完，所以要学会砍掉。",
      sourceId: r.id,
    });
    llmMode.copy = true;
    expect(await processUser(B.id)).toBe("skipped");
    llmMode.copy = false;
    const [row] = await db.select().from(schema.autoPosts).where(eq(schema.autoPosts.userId, B.id));
    expect(row.note).toContain("上限 50%");
  });

  it("老内容不用（论坛老帖被顶上来、RSS 补发旧文）；同一个源每天有上限", async () => {
    const { addFeedItem } = await import("@/lib/tg-feed");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    // 之前收进来的都先忽略，只看这个测试新加的
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    await addFeedItem(B.id, {
      kind: "x_user",
      text: "三年前的一条老推文：那时候大家都还在讨论要不要做移动端，现在看来答案很明显了吧。",
      publishedAt: new Date(Date.now() - 3 * 365 * 86400_000),
      sourceId: src.id,
    });
    expect(await processUser(B.id)).toBe("idle");
    await saveSettings(B.id, { perSourceDaily: 1 });
    for (const t of ["第一条新内容：小团队做产品，先找到十个愿意付钱的用户再说别的。", "第二条新内容：别急着融资，先证明有人每天在用你的东西才是正事。"]) {
      await addFeedItem(B.id, { kind: "x_user", text: t, publishedAt: new Date(), sourceId: src.id });
    }
    expect(await processUser(B.id)).toBe("review");
    expect(await processUser(B.id)).toBe("idle");
  });

  it("原文信息太少（只有链接、表情）不写也不扣费；写出来停在半句的不用并退钱；同一件事只写一次", async () => {
    const { addFeedItem } = await import("@/lib/tg-feed");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    await saveSettings(B.id, { perSourceDaily: 20, dailyCap: 20 });
    const before = await getBalance(B.id);
    await addFeedItem(B.id, { kind: "x_user", text: "Big news 👇 https://t.co/abc123 @someone #AI", publishedAt: new Date(), sourceId: src.id });
    expect(await processUser(B.id)).toBe("skipped");
    expect(await getBalance(B.id)).toBe(before);
    let rows = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "skipped")));
    expect(rows.some((r) => r.note?.includes("信息太少"))).toBe(true);

    await addFeedItem(B.id, { kind: "x_user", text: "有位研究员说，城市里的行道树每多一成，夏天街面温度能降两度左右，比装遮阳棚划算得多。", publishedAt: new Date(), sourceId: src.id });
    llmMode.cut = true;
    try {
      expect(await processUser(B.id)).toBe("skipped");
    } finally {
      llmMode.cut = false;
    }
    expect(await getBalance(B.id)).toBe(before);
    rows = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "skipped")));
    expect(rows.some((r) => r.note?.includes("没说完"))).toBe(true);

    // 另一个号发了几乎一样的消息：已经写过一条了，不再写
    const t = "某城市宣布地铁明年起全线通宵运营，首批先开两条线路，周五周六晚上试行。";
    await addFeedItem(B.id, { kind: "x_user", text: t, publishedAt: new Date(), sourceId: src.id });
    expect(await processUser(B.id)).toBe("review");
    await addFeedItem(B.id, { kind: "x_user", text: `转：${t}`, publishedAt: new Date(), sourceId: src.id });
    expect(await processUser(B.id)).toBe("skipped");
    rows = await db.select().from(schema.autoPosts).where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "skipped")));
    expect(rows.some((r) => r.note?.includes("同一件事"))).toBe(true);
  });

  it("开了自动配图：每条配一张信息卡，确认发出时一起带上；改了正文就重做一张", async () => {
    const { addFeedItem } = await import("@/lib/tg-feed");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    await saveSettings(B.id, { withImage: true, mode: "review" });
    const sentBefore = tgSent.length;
    await addFeedItem(B.id, { kind: "x_user", text: "一家面包店把每天卖剩的面包做成第二天早上的半价套餐，浪费少了，熟客也多了。", publishedAt: new Date(), sourceId: src.id });
    expect(await processUser(B.id)).toBe("review");
    const [row] = await db
      .select()
      .from(schema.autoPosts)
      .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "review")))
      .orderBy(desc(schema.autoPosts.createdAt))
      .limit(1);
    expect(row.imageId).toBeTruthy();
    const [img] = await db.select().from(schema.images).where(eq(schema.images.id, row.imageId!));
    expect(img.userId).toBe(B.id);
    // 推给本人确认时先发图预览
    expect(tgSent.slice(sentBefore).some((m) => m.method === "sendPhoto" && m.params.chat_id === "2002")).toBe(true);
    const { job } = await approveAuto(B.id, row.id, { text: `${row.text}（改了一句）` });
    expect(job.imageId).toBeTruthy();
    expect(job.imageId).not.toBe(row.imageId);
    await saveSettings(B.id, { withImage: false });
  });

  it("链接放评论区：正文不带链接，发出时第二条回复第一条放原文里的链接；指回 X 自己的链接不用", async () => {
    const { addFeedItem } = await import("@/lib/tg-feed");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    const s = await saveSettings(B.id, { attachLink: true });
    expect(s.attachLink).toBe(true);
    const on = await saveSettings(B.id, { linkReply: true, mode: "review" });
    expect(on.linkReply).toBe(true);
    expect(on.attachLink).toBe(false); // 两个只能开一个
    await addFeedItem(B.id, {
      kind: "x_user",
      text: "整理了一份用树莓派搭家庭相册服务器的完整教程，从装系统到自动备份都写了 https://guide.example.org/pi-photos 欢迎收藏",
      publishedAt: new Date(),
      sourceId: src.id,
    });
    expect(await processUser(B.id)).toBe("review");
    const [row] = await db
      .select()
      .from(schema.autoPosts)
      .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "review")))
      .orderBy(desc(schema.autoPosts.createdAt))
      .limit(1);
    expect(row.replyLink).toBe("https://guide.example.org/pi-photos");
    expect(row.text).not.toContain("http");
    const { job } = await approveAuto(B.id, row.id);
    expect(job.tweets).toHaveLength(2);
    expect(job.tweets[0]).toBe(row.text);
    expect(job.tweets[1]).toContain("https://guide.example.org/pi-photos");

    await addFeedItem(B.id, {
      kind: "x_user",
      text: "某地图书馆宣布明年起所有分馆周日也开放，晚上延长到九点，方便上班族借书 https://x.com/someone/status/123",
      publishedAt: new Date(),
      sourceId: src.id,
    });
    expect(await processUser(B.id)).toBe("review");
    const [row2] = await db
      .select()
      .from(schema.autoPosts)
      .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "review")))
      .orderBy(desc(schema.autoPosts.createdAt))
      .limit(1);
    expect(row2.replyLink).toBeNull();
    await skipAuto(B.id, row2.id);
    await saveSettings(B.id, { linkReply: false });
  });

  it("长原文不压缩：不是 X 会员写成串推，会员写成一条长推；短原文还是一条", async () => {
    const { addFeedItem } = await import("@/lib/tg-feed");
    const { generateFromSource } = await import("@/lib/llm");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    await saveSettings(B.id, { mode: "review", longForm: true });
    const long = (tag: string) =>
      `${tag}：城南一家只有二十平米的社区书店，三年前差点关门。店主没有去做网上促销，而是开始每周办两次读书会，` +
      "每次十几个人，选书由会员轮流决定，读完一起吃顿简单的饭。会员一年交三百块，现在有两百多位，会员费刚好覆盖房租。" +
      "店主说，书店能活下来不是因为书卖得多，而是大家把这里当成每周固定要来的地方；很多会员会带朋友来，新会员大多是这么来的。" +
      "他们还把店里一面墙留给会员写书评，每月评一次最受欢迎的书评，送一本新书。店主的建议是：小店别想着跟网店比价格，要比的是人和人之间的关系。";
    const latest = async () =>
      (
        await db
          .select()
          .from(schema.autoPosts)
          .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "review")))
          .orderBy(desc(schema.autoPosts.createdAt))
          .limit(1)
      )[0];

    // 不是会员：写成串推
    await db.update(schema.xAccounts).set({ premium: false, premiumCheckedAt: new Date() }).where(eq(schema.xAccounts.userId, B.id));
    await addFeedItem(B.id, { kind: "x_user", text: long("书店一"), publishedAt: new Date(), sourceId: src.id });
    expect(await processUser(B.id)).toBe("review");
    expect(vi.mocked(generateFromSource).mock.lastCall?.[1].shape?.kind).toBe("thread");
    const thread = await latest();
    const { job } = await approveAuto(B.id, thread.id);
    expect(job.tweets).toHaveLength(3);

    // 会员：一条长推（超过 280 也能排进去）
    await db.update(schema.xAccounts).set({ premium: true, premiumCheckedAt: new Date() }).where(eq(schema.xAccounts.userId, B.id));
    const other =
      "一位乡村老师分享了她用三年时间改造学校图书角的经过：一开始只有两个书架、不到两百本旧书，孩子们几乎不去。" +
      "她先请家长每家捐一本书，再让每个班选出两名小管理员负责登记和推荐，每周五下午留出四十分钟全校自由阅读。" +
      "第二年她申请到一笔小额公益基金，买了三百多本绘本和科普书，还把教室后面的角落铺上地垫，孩子们可以坐着看。" +
      "到了第三年，全校平均每人每学期借书从不到两本涨到了十一本，期末作文里引用课外书的孩子也明显多了。" +
      "她说最有用的不是买了多少书，而是让孩子自己当管理员，他们会互相推荐，阅读就变成了一件大家一起做的事。";
    await addFeedItem(B.id, { kind: "x_user", text: other, publishedAt: new Date(), sourceId: src.id });
    const r = await processUser(B.id);
    expect(vi.mocked(generateFromSource).mock.lastCall?.[1].shape?.kind).toBe("long");
    expect(r).toBe("review");
    const lp = await latest();
    const { job: job2 } = await approveAuto(B.id, lp.id);
    expect(job2.tweets).toHaveLength(1);
    expect(job2.tweets[0].length).toBeGreaterThan(140);

    // 短原文：还是一条普通推文
    await addFeedItem(B.id, { kind: "x_user", text: "某市地铁明年开始周末通宵运营，先试点两条线路。", publishedAt: new Date(), sourceId: src.id });
    await processUser(B.id);
    expect(vi.mocked(generateFromSource).mock.lastCall?.[1].shape?.kind).toBe("single");
    await db.update(schema.xAccounts).set({ premium: false }).where(eq(schema.xAccounts.userId, B.id));
  });

  it("配图原图优先：截图类原图直接用；摄影、色情的不用，改做信息卡；别的网站的图不下载", async () => {
    const { resetRateLimits } = await import("@/lib/rate-limit");
    resetRateLimits(); // 前面的测试同一分钟里调了很多次 AI
    const { addFeedItem } = await import("@/lib/tg-feed");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    await saveSettings(B.id, { withImage: true, mode: "review", longForm: false });
    const imageOf = async () => {
      const [row] = await db
        .select()
        .from(schema.autoPosts)
        .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "review")))
        .orderBy(desc(schema.autoPosts.createdAt))
        .limit(1);
      if (!row.imageId) throw new Error(`没有图：${row.note}`);
      const [img] = await db.select().from(schema.images).where(eq(schema.images.id, row.imageId));
      await skipAuto(B.id, row.id);
      return img;
    };
    const texts = [
      "某款笔记软件今天上线了离线同步，断网时写的内容联网后会自动合并，冲突的段落会并排显示让你选。",
      "一份新的调查显示，远程办公的团队里每周固定开一次视频周会的，项目延期的比例比不开会的低三成。",
      "有开发者做了个小工具，把命令行里的报错信息自动翻译成中文，并给出最常见的三种修复办法。",
      "某城市公交把到站时间精确到秒，乘客等车时间平均少了四分钟，投诉也明显减少了。",
    ];

    // 截图类：用原图
    const before = await getBalance(B.id);
    await addFeedItem(B.id, { kind: "x_user", text: texts[0], publishedAt: new Date(), sourceId: src.id, media: ["https://pbs.twimg.com/media/abc.jpg"] });
    expect(await processUser(B.id)).toBe("review");
    expect((await imageOf()).kind).toBe("source");
    const spent = before - (await getBalance(B.id));
    expect(spent).toBe(0); // 开源版不扣费

    // 摄影作品、色情：不用原图，改做信息卡
    for (const [mode, text] of [["photo", texts[1]], ["nsfw", texts[2]]] as const) {
      llmMode.img = mode;
      await addFeedItem(B.id, { kind: "x_user", text, publishedAt: new Date(), sourceId: src.id, media: ["https://pbs.twimg.com/media/def.jpg"] });
      expect(await processUser(B.id)).toBe("review");
      expect((await imageOf()).kind).toBe("card");
    }
    llmMode.img = "ok";

    // 不是 X / TG 图片服务器上的图：不下载
    await addFeedItem(B.id, { kind: "x_user", text: texts[3], publishedAt: new Date(), sourceId: src.id, media: ["https://evil.example.com/a.png"] });
    expect(await processUser(B.id)).toBe("review");
    expect((await imageOf()).kind).toBe("card");
    await saveSettings(B.id, { withImage: false, longForm: true });
  });

  it("给已排进定时的自动帖补原图：去原帖找图，能用的换上；别人的帖子不动", async () => {
    const { resetRateLimits } = await import("@/lib/rate-limit");
    resetRateLimits();
    const { addFeedItem } = await import("@/lib/tg-feed");
    const { backfillSourceImages } = await import("@/lib/autopilot");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    await saveSettings(B.id, { mode: "auto", withImage: false, dailyCap: 50, perSourceDaily: 50 });
    await addFeedItem(B.id, {
      kind: "x_user",
      text: "一款开源的截图标注工具发布了 2.0 版，加了自动打码和长截图拼接，体积只有原来的一半。",
      url: "https://x.com/someone/status/777001",
      publishedAt: new Date(),
      sourceId: src.id,
    });
    // 模拟文案和前面的测试很像，可能被转成等确认：确认一下就排进定时了
    if ((await processUser(B.id)) === "review") {
      const [rv] = await db
        .select()
        .from(schema.autoPosts)
        .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "review")))
        .orderBy(desc(schema.autoPosts.createdAt))
        .limit(1);
      await approveAuto(B.id, rv.id);
    }
    const aBefore = await db.select({ id: schema.posts.id, imageId: schema.posts.imageId }).from(schema.posts).where(eq(schema.posts.userId, A.id));

    const r = await backfillSourceImages(B.id);
    expect(r.used).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select()
      .from(schema.autoPosts)
      .where(and(eq(schema.autoPosts.userId, B.id), eq(schema.autoPosts.status, "scheduled")))
      .orderBy(desc(schema.autoPosts.createdAt))
      .limit(1);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, row.postId!));
    expect(post.imageId).toBeTruthy();
    expect(post.imageId).toBe(row.imageId);
    const [img] = await db.select().from(schema.images).where(eq(schema.images.id, post.imageId!));
    expect(img).toMatchObject({ kind: "source", userId: B.id });
    // 再点一次不会重复换
    expect((await backfillSourceImages(B.id)).used).toBe(0);
    const aAfter = await db.select({ id: schema.posts.id, imageId: schema.posts.imageId }).from(schema.posts).where(eq(schema.posts.userId, A.id));
    expect(aAfter).toEqual(aBefore);
    await saveSettings(B.id, { mode: "review" });
  });

  it("色情 / 成人内容的原文不写，不扣费", async () => {
    const { addFeedItem } = await import("@/lib/tg-feed");
    const db = await getDb();
    const [src] = await db.select().from(schema.sources).where(and(eq(schema.sources.userId, B.id), eq(schema.sources.type, "x_user")));
    await db.update(schema.feedItems).set({ status: "dismissed" }).where(eq(schema.feedItems.userId, B.id));
    const before = await getBalance(B.id);
    await addFeedItem(B.id, { kind: "x_user", text: "今晚福利姬直播，私信领取完整视频，名额有限先到先得，错过再等一个月哦。", publishedAt: new Date(), sourceId: src.id });
    expect(await processUser(B.id)).toBe("skipped");
    expect(await getBalance(B.id)).toBe(before);
  });

  it("内网地址、robots 不让读的网站都拒绝", async () => {
    await expect(addAnySource(A.id, "http://127.0.0.1/")).rejects.toThrow("内网");
    await expect(addAnySource(A.id, "https://intranet.example.com/")).rejects.toThrow("内网");
    await expect(addAnySource(A.id, "https://blocked.example.com/")).rejects.toThrow("robots");
  });
});

describe("TG 群当信息源", () => {
  const botId = 123456789;
  it("已绑定的人拉机器人进群 → 成为他的信息源；群消息只进他的灵感池", async () => {
    await handleUpdate({
      update_id: 1,
      message: { message_id: 1, date: Date.now() / 1000, chat: { id: -100777, type: "supergroup", title: "产品交流群" }, from: { id: 1001 }, new_chat_members: [{ id: botId, is_bot: true }] },
    });
    const db = await getDb();
    const src = await db.select().from(schema.sources).where(eq(schema.sources.type, "tg_group"));
    expect(src).toHaveLength(1);
    expect(src[0].userId).toBe(A.id);
    await handleUpdate({
      update_id: 2,
      message: { message_id: 2, date: Date.now() / 1000, chat: { id: -100777, type: "supergroup", title: "产品交流群" }, from: { id: 5555 }, text: "今天群里讨论：小团队做产品，第一步应该先找到愿意付钱的十个用户。" },
    });
    const items = await db.select().from(schema.feedItems).where(eq(schema.feedItems.kind, "tg_group"));
    expect(items).toHaveLength(1);
    expect(items[0].userId).toBe(A.id);
  });

  it("没绑定的人拉机器人进群 → 机器人退出", async () => {
    const before = tgSent.length;
    await handleUpdate({
      update_id: 3,
      message: { message_id: 1, date: Date.now() / 1000, chat: { id: -100888, type: "group", title: "陌生群" }, from: { id: 9999 }, new_chat_members: [{ id: botId, is_bot: true }] },
    });
    expect(tgSent.slice(before).some((m) => m.method === "leaveChat")).toBe(true);
    const db = await getDb();
    expect(await db.select().from(schema.sources).where(eq(schema.sources.handle, "-100888"))).toHaveLength(0);
  });
});

describe("每天条数和间隔：平台方自己的账号放开，客户有上限", () => {
  it("管理员可设 100 条以上、1–10 分钟随机；客户最多 50 条、最短 10 分钟", async () => {
    const own = await saveSettings(OWNER.id, { dailyCap: 300, minGapMin: 1, maxGapMin: 10 });
    expect(own).toMatchObject({ dailyCap: 300, minGapMin: 1, maxGapMin: 10 });
    const cust = await saveSettings(A.id, { dailyCap: 300, minGapMin: 1, maxGapMin: 10 });
    expect(cust).toMatchObject({ dailyCap: 50, minGapMin: 10, maxGapMin: 10 });
  });

  it("间隔在范围里随机", () => {
    const s = { minGapMin: 1, maxGapMin: 10 };
    expect(pickGapMin(s, 0)).toBe(1);
    expect(pickGapMin(s, 0.999)).toBeCloseTo(9.991);
    expect(pickGapMin({ minGapMin: 5, maxGapMin: 0 }, 0.7)).toBe(5);
    expect(gapLabel(s)).toBe("1–10 分钟随机");
    expect(parseGap("1-10")).toEqual([1, 10]);
    expect(parseGap("3～8 分钟")).toEqual([3, 8]);
    expect(parseGap("5")).toEqual([5, 5]);
    expect(parseGap("abc")).toBeNull();
  });
});

describe("机器人里改「同一个信息源每天最多用几条」", () => {
  it("发数字就保存", async () => {
    const { setState } = await import("@/lib/tg-bot-core");
    const { handleAutoAwait } = await import("@/lib/tg-bot-auto");
    const { getSettings } = await import("@/lib/autopilot");
    await setState(A.id, { await: { kind: "autoset", field: "per" } });
    expect(await handleAutoAwait(A.id, "1001", "10")).toBe(true);
    expect((await getSettings(A.id)).perSourceDaily).toBe(10);
  });
});

describe("发帖时段自己设，默认全天", () => {
  it("没设过的人默认 24 小时都能发", async () => {
    const { getSettings, hoursLabel } = await import("@/lib/autopilot");
    const s = await getSettings("00000000-0000-4000-8000-00000000abcd");
    expect([s.startHour, s.endHour]).toEqual([0, 24]);
    expect(hoursLabel(s)).toBe("全天 24 小时");
    expect(inWindow(3, s.startHour, s.endHour)).toBe(true);
  });

  it("看得懂各种写法", async () => {
    const { parseHours, hoursLabel } = await import("@/lib/autopilot");
    expect(parseHours("9-23")).toEqual([9, 23]);
    expect(parseHours("9点到23点")).toEqual([9, 23]);
    expect(parseHours("22～6")).toEqual([22, 6]);
    expect(parseHours("全天")).toEqual([0, 24]);
    expect(parseHours("24小时")).toEqual([0, 24]);
    expect(parseHours("9-9")).toBeNull();
    expect(parseHours("25-3")).toBeNull();
    expect(parseHours("abc")).toBeNull();
    expect(hoursLabel({ startHour: 22, endHour: 6 })).toBe("22:00–6:00（跨夜）");
  });

  it("在机器人里发「9-23」就保存，再发「全天」改回来", async () => {
    const { setState } = await import("@/lib/tg-bot-core");
    const { handleAutoAwait } = await import("@/lib/tg-bot-auto");
    const { getSettings } = await import("@/lib/autopilot");
    await setState(A.id, { await: { kind: "autoset", field: "hours" } });
    expect(await handleAutoAwait(A.id, "1001", "9-23")).toBe(true);
    let s = await getSettings(A.id);
    expect([s.startHour, s.endHour]).toEqual([9, 23]);
    await setState(A.id, { await: { kind: "autoset", field: "hours" } });
    await handleAutoAwait(A.id, "1001", "全天");
    s = await getSettings(A.id);
    expect([s.startHour, s.endHour]).toEqual([0, 24]);
  });
});
