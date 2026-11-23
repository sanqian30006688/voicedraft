/**
 * 两位顾客（A 和 B）各自用网页，互相看不到、改不了、删不掉对方的数据。
 * 每个接口都按真实请求调用，只把「当前登录的人」换来换去。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { saveAccount, exchangeCode } from "@/lib/x";
import { body, createUser, ctx, get, json, loginAs, type TestUser } from "./helpers";

import * as samplesRoute from "@/app/api/samples/route";
import * as sampleRoute from "@/app/api/samples/[id]/route";
import * as draftsRoute from "@/app/api/drafts/route";
import * as draftRoute from "@/app/api/drafts/[id]/route";
import * as promoRoute from "@/app/api/promo/route";
import * as promoItemRoute from "@/app/api/promo/[id]/route";
import * as feedRoute from "@/app/api/tg-feed/route";
import * as feedItemRoute from "@/app/api/tg-feed/[id]/route";
import * as feedPointsRoute from "@/app/api/tg-feed/[id]/points/route";
import * as sourcesItemRoute from "@/app/api/tg-feed/sources/[id]/route";
import * as inspRoute from "@/app/api/inspiration/route";
import * as inspItemRoute from "@/app/api/inspiration/[id]/route";
import * as repliesRoute from "@/app/api/replies/route";
import * as replyItemRoute from "@/app/api/replies/[id]/route";
import * as postsRoute from "@/app/api/posts/route";
import * as postItemRoute from "@/app/api/posts/[id]/route";
import * as styleRoute from "@/app/api/style-card/route";
import * as rollbackRoute from "@/app/api/style-card/rollback/route";
import * as learnRoute from "@/app/api/style-card/learn/route";
import * as blindRoute from "@/app/api/blind-test/route";
import * as blindItemRoute from "@/app/api/blind-test/[id]/route";
import * as generateRoute from "@/app/api/generate/route";
import * as editsRoute from "@/app/api/edits/route";
import * as xAccountRoute from "@/app/api/x/account/route";
import * as meRoute from "@/app/api/me/route";

const SECRET = "A 的秘密内容";
const traits = { catchphrases: ["A 的口头禅"], bannedWords: [], openings: "", stance: "", humor: "", topics: [], notes: "" };

let A: TestUser;
let B: TestUser;
const ids: Record<string, string> = {};

beforeAll(async () => {
  A = await createUser("a@example.com");
  B = await createUser("b@example.com");
  const db = await getDb();

  // ---- A 准备一整套数据 ----
  loginAs(A);
  await samplesRoute.POST(json({ source: "paste", items: [{ content: `${SECRET}：素材一，今天聊聊写作这件事` }, { content: `${SECRET}：素材二，明天再说说读书心得` }] }));
  const [sample] = await db.select().from(schema.samples).where(eq(schema.samples.userId, A.id));
  ids.sample = sample.id;

  const [card] = await db.insert(schema.styleCards).values({ userId: A.id, lang: "zh", version: 1, traits, source: "generated" }).returning();
  ids.card = card.id;

  const promo = await body(await promoRoute.POST(json({ kind: "tg", name: `${SECRET}群`, url: "https://t.me/a_secret_group", blurb: "" })));
  ids.promo = promo.id as string;

  await feedRoute.POST(json({ text: `${SECRET}：一条灵感，长度足够长` }));
  const [feed] = await db.select().from(schema.feedItems).where(eq(schema.feedItems.userId, A.id));
  ids.feed = feed.id;

  const [source] = await db.insert(schema.sources).values({ userId: A.id, type: "tg_channel", handle: "a_secret_channel" }).returning();
  ids.source = source.id;

  const draft = await body(
    await draftsRoute.POST(json({ topic: `${SECRET}主题`, mode: "quick", sentences: [{ text: `${SECRET}草稿`, original: "", locked: false }] })),
  );
  ids.draft = draft.id as string;

  const [insp] = await db
    .insert(schema.inspirations)
    .values({ userId: A.id, source: "x_link", tweetId: "111", authorHandle: "someone", text: `${SECRET}书签` })
    .returning();
  ids.insp = insp.id;

  await saveAccount(A.id, await exchangeCode("mock", "mock"));
  const [reply] = await db
    .insert(schema.replyItems)
    .values({ userId: A.id, tweetId: "222", authorId: "9", authorHandle: "fan", text: `${SECRET}提及` })
    .returning();
  ids.reply = reply.id;

  const post = await body(await postsRoute.POST(json({ tweets: [`${SECRET}定时帖`], scheduledAt: new Date(Date.now() + 86400_000).toISOString() })));
  ids.post = (post.item as { id: string }).id;

  const [blind] = await db
    .insert(schema.blindTests)
    .values({ userId: A.id, styleCardVersion: 1, items: [{ text: SECRET, isAi: true }, { text: "x", isAi: false }] })
    .returning();
  ids.blind = blind.id;

  const [learning] = await db
    .insert(schema.styleLearnings)
    .values({ userId: A.id, editCount: 1, lastEditAt: new Date(), suggestion: { observations: [], traits }, baseVersion: 1 })
    .returning();
  ids.learning = learning.id;
});

/** A 的数据有没有一个字出现在 B 拿到的内容里 */
const leaks = (data: unknown) => JSON.stringify(data).includes(SECRET) || JSON.stringify(data).includes("a_secret");

describe("B 的列表里看不到 A 的任何东西", () => {
  it.each([
    ["素材", () => samplesRoute.GET()],
    ["草稿", () => draftsRoute.GET()],
    ["推广链接", () => promoRoute.GET()],
    ["TG 灵感和订阅的频道", () => feedRoute.GET(get())],
    ["X 书签灵感", () => inspRoute.GET(get())],
    ["已处理的书签灵感", () => inspRoute.GET(get("http://localhost:3000/api/inspiration?view=done"))],
    ["回复队列", () => repliesRoute.GET(get())],
    ["发布 / 定时队列", () => postsRoute.GET()],
    ["风格卡", () => styleRoute.GET()],
    ["盲测记录", () => blindRoute.GET()],
    ["X 账号", () => xAccountRoute.GET()],
    ["账号概况", () => meRoute.GET()],
  ])("%s", async (_name, call) => {
    loginAs(B);
    const res = await call();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(leaks(data)).toBe(false);
  });

  it("B 没连 X，不会显示成 A 的 X 账号", async () => {
    loginAs(B);
    const data = await body(await xAccountRoute.GET());
    expect(data.account).toBeNull();
  });
});

describe("B 拿着 A 的编号也读不到、改不了、删不掉", () => {
  it("草稿", async () => {
    loginAs(B);
    expect((await draftRoute.GET(get(), ctx(ids.draft))).status).toBe(404);
    expect((await draftRoute.PATCH(json({ topic: "改掉" }), ctx(ids.draft))).status).toBe(404);
    await draftRoute.DELETE(get(), ctx(ids.draft));
  });

  it("素材", async () => {
    loginAs(B);
    expect((await sampleRoute.PATCH(json({ excluded: true }), ctx(ids.sample))).status).toBe(404);
    await sampleRoute.DELETE(get(), ctx(ids.sample));
    await samplesRoute.DELETE(); // 「删除全部素材」只删自己的
  });

  it("推广链接", async () => {
    loginAs(B);
    expect((await promoItemRoute.PATCH(json({ kind: "tg", name: "改掉", url: "https://t.me/x", blurb: "" }), ctx(ids.promo))).status).toBe(404);
    expect((await promoRoute.PATCH(json({ defaultId: ids.promo }))).status).toBe(404);
    await promoItemRoute.DELETE(get(), ctx(ids.promo));
    // 用 A 的推广链接生成内容
    const res = await generateRoute.POST(json({ task: { kind: "full", topic: "t", count: 1 }, promoId: ids.promo }));
    expect(res.status).toBe(404);
  });

  it("TG 灵感和频道", async () => {
    loginAs(B);
    expect((await feedItemRoute.GET(get(), ctx(ids.feed))).status).toBe(404);
    expect((await feedItemRoute.PATCH(json({ status: "dismissed" }), ctx(ids.feed))).status).toBe(404);
    expect((await feedPointsRoute.POST(get(), ctx(ids.feed))).status).toBe(404);
    await feedItemRoute.DELETE(get(), ctx(ids.feed));
    await sourcesItemRoute.PATCH(json({ enabled: false }), ctx(ids.source));
    await sourcesItemRoute.DELETE(get(), ctx(ids.source));
    expect((await sourcesItemRoute.POST(get(), ctx(ids.source))).status).not.toBe(200);
  });

  it("用 A 的灵感起草时，不会关联到 A 的灵感", async () => {
    loginAs(B);
    const d = await body(
      await draftsRoute.POST(json({ topic: "B", mode: "quick", sentences: [], sourceItemId: ids.feed })),
    );
    const db = await getDb();
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, d.id as string));
    expect(row.sourceItemId).toBeNull();
    expect(row.userId).toBe(B.id);
  });

  it("修改记录不会挂到 A 的草稿上", async () => {
    loginAs(B);
    await editsRoute.POST(json({ original: "a", edited: "b", draftId: ids.draft }));
    const db = await getDb();
    const rows = await db.select().from(schema.editLogs).where(eq(schema.editLogs.userId, B.id));
    expect(rows.every((r) => r.draftId === null)).toBe(true);
  });

  it("X 书签灵感", async () => {
    loginAs(B);
    for (const action of ["dismiss", "restore", "used", "quote"]) {
      expect((await inspItemRoute.POST(json({ action }), ctx(ids.insp))).status).toBe(422);
    }
    await inspItemRoute.POST(json({ action: "delete" }), ctx(ids.insp));
  });

  it("回复队列", async () => {
    loginAs(B);
    for (const b of [{ action: "skip" }, { action: "restore" }, { action: "regenerate" }, { action: "delete_x" }, { action: "send", text: "hi" }]) {
      expect((await replyItemRoute.POST(json(b), ctx(ids.reply))).status).toBe(422);
    }
  });

  it("定时发布", async () => {
    loginAs(B);
    for (const b of [{ action: "cancel" }, { action: "retry" }, { action: "delete_x" }, { action: "edit", tweets: ["B 改的"] }]) {
      expect((await postItemRoute.POST(json(b), ctx(ids.post))).status).toBe(422);
    }
  });

  it("风格卡、学习建议、盲测", async () => {
    loginAs(B);
    expect((await rollbackRoute.POST(json({ id: ids.card }))).status).toBe(404);
    expect((await learnRoute.PATCH(json({ id: ids.learning, action: "accept" }))).status).not.toBe(200);
    expect((await blindItemRoute.POST(json({ guesses: [0] }), ctx(ids.blind))).status).toBe(404);
  });

  it("B 改自己的 X 自动回复设置，不会动到 A 的", async () => {
    loginAs(B);
    expect((await xAccountRoute.PATCH(json({ autoReplyEnabled: true }))).status).toBe(404);
    await xAccountRoute.DELETE();
  });

  it("没登录什么都拿不到", async () => {
    loginAs(null);
    for (const r of [await samplesRoute.GET(), await draftsRoute.GET(), await postsRoute.GET(), await repliesRoute.GET(get())]) {
      expect(r.status).toBe(401);
    }
  });
});

describe("B 折腾完以后，A 的数据一样不少、一字未改", () => {
  it("全部还在", async () => {
    const db = await getDb();
    const own = <T extends typeof schema.samples | typeof schema.drafts | typeof schema.promoLinks | typeof schema.feedItems | typeof schema.sources | typeof schema.inspirations | typeof schema.replyItems | typeof schema.posts | typeof schema.styleLearnings | typeof schema.blindTests | typeof schema.xAccounts>(
      t: T,
    ) => db.select().from(t as typeof schema.samples).where(eq((t as typeof schema.samples).userId, A.id)) as unknown as Promise<T["$inferSelect"][]>;
    expect(await own(schema.samples)).toHaveLength(2);
    expect((await own(schema.samples)).every((s) => !s.excluded)).toBe(true);
    expect(await own(schema.drafts)).toHaveLength(1);
    expect((await own(schema.drafts))[0].topic).toBe(`${SECRET}主题`);
    expect((await own(schema.promoLinks))[0].name).toBe(`${SECRET}群`);
    expect((await own(schema.feedItems))[0].status).toBe("new");
    expect((await own(schema.sources))[0].enabled).toBe(true);
    expect((await own(schema.inspirations))[0].status).toBe("new");
    expect((await own(schema.replyItems))[0].status).toBe("pending");
    expect((await own(schema.posts))[0].status).toBe("scheduled");
    expect((await own(schema.posts))[0].tweets).toEqual([`${SECRET}定时帖`]);
    expect((await own(schema.styleLearnings))[0].status).toBe("pending");
    expect((await own(schema.blindTests))[0].completedAt).toBeNull();
    expect(await own(schema.xAccounts)).toHaveLength(1);
  });

  it("A 自己照常能看到自己的数据", async () => {
    loginAs(A);
    expect(leaks(await (await samplesRoute.GET()).json())).toBe(true);
    expect(leaks(await (await postsRoute.GET()).json())).toBe(true);
    expect((await draftRoute.GET(get(), ctx(ids.draft))).status).toBe(200);
  });
});
