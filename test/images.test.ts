/**
 * 配图：信息卡（程序排版，不收费）、AI 配图（先扣后退）、真人改做信息卡、按人隔离、发帖时挂在第一条、机器人里的流程。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { GET as listRoute, POST as imagesRoute } from "@/app/api/images/route";
import { GET as imageRoute, PATCH as patchImage } from "@/app/api/images/[id]/route";
import { POST as postsRoute } from "@/app/api/posts/route";
import { addBalance, getBalance, MICRO } from "@/lib/billing";
import * as llm from "@/lib/llm";
import { pruneImages } from "@/lib/images";
import { handleCallback } from "@/lib/tg-bot";
import { handleIncomingImage } from "@/lib/tg-bot-image";
import { connectMock, mockMediaLog } from "@/lib/x";
import { body, createUser, ctx, get, json, loginAs, tgSent, type TestUser } from "./helpers";

let seq = 0;
async function payingUser(balance = 20): Promise<TestUser> {
  const u = await createUser(`img${++seq}@example.com`);
  await addBalance(u.id, balance * MICRO, { kind: "adjust", note: "测试" });
  await connectMock(u.id, `img_${seq}`);
  return u;
}

async function draftOf(userId: string, mode = "quick", text = "Obscura 是一个用 Rust 写的开源无头浏览器") {
  const db = await getDb();
  const [d] = await db
    .insert(schema.drafts)
    .values({ userId, topic: "测试", mode, sentences: [{ text, original: text, locked: false }], finalText: text })
    .returning();
  return d;
}

const post = (b: unknown) => imagesRoute(json(b, "http://localhost:3000/api/images"));

beforeAll(async () => {
  await createUser("owner@example.com"); // 最早注册的是管理员（默认不扣费），先占掉
});

afterEach(() => {
  delete process.env.MOCK_IMAGE;
  delete process.env.GEMINI_API_KEY;
  vi.restoreAllMocks();
});

describe("信息卡", () => {
  it("做一张信息卡不收费；换风格、改标题只重新排版", async () => {
    const a = await payingUser();
    const d = await draftOf(a.id);
    loginAs(a);
    const before = await getBalance(a.id);
    const res = await post({ action: "card", text: d.finalText, draftId: d.id });
    expect(res.status).toBe(200);
    const { image } = (await body(res)) as { image: { id: string; kind: string; spec: { theme: string; handle: string } } };
    expect(image.kind).toBe("card");
    expect(image.spec.handle).toMatch(/^@.*img_/);
    expect(await getBalance(a.id)).toBe(before); // 开源版不扣费

    const r2 = await patchImage(json({ theme: "light", title: "新标题" }, `http://localhost:3000/api/images/${image.id}`, "PATCH"), ctx(image.id));
    const { image: next } = (await body(r2)) as { image: { spec: { theme: string; title: string } } };
    expect(next.spec).toMatchObject({ theme: "light", title: "新标题" });

    const png = await imageRoute(get(`http://localhost:3000/api/images/${image.id}`), ctx(image.id));
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  it("别人的图看不到、改不了、也不能拿来发帖", async () => {
    const a = await payingUser();
    const b = await payingUser();
    const d = await draftOf(a.id);
    loginAs(a);
    const { image } = (await body(await post({ action: "card", text: "内容", draftId: d.id }))) as { image: { id: string } };

    loginAs(b);
    expect((await imageRoute(get(`http://localhost:3000/api/images/${image.id}`), ctx(image.id))).status).toBe(404);
    expect((await patchImage(json({ theme: "bold" }, "http://localhost:3000/api/images/x", "PATCH"), ctx(image.id))).status).toBe(422);
    const list = (await body(await listRoute(get("http://localhost:3000/api/images")))) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
    const pub = await postsRoute(json({ tweets: ["你好"], imageId: image.id }, "http://localhost:3000/api/posts"));
    expect(pub.status).toBe(422);
    // 也不能挂到自己的草稿上
    const own = await draftOf(b.id);
    expect((await post({ action: "attach", draftId: own.id, imageId: image.id })).status).toBe(422);
  });
});

describe("AI 配图", () => {
  it("没配置 Gemini 密钥时不能用", async () => {
    const a = await payingUser();
    loginAs(a);
    const res = await post({ action: "ai", text: "内容" });
    expect(res.status).toBe(422);
    expect(((await body(await listRoute(get("http://localhost:3000/api/images")))) as { aiReady: boolean }).aiReady).toBe(false);
  });

  it("AI 画图不收费（标准、精品都一样）", async () => {
    process.env.MOCK_IMAGE = "1";
    const a = await payingUser();
    loginAs(a);
    const before = await getBalance(a.id);
    const res = await post({ action: "ai", text: "清晨的城市" });
    expect(res.status).toBe(200);
    expect(((await body(res)) as { image: { kind: string } }).image.kind).toBe("ai");
    expect(before - (await getBalance(a.id))).toBe(0); // 开源版不扣费
    await post({ action: "ai_pro", text: "清晨的城市" });
    expect(before - (await getBalance(a.id))).toBe(0); // 开源版不扣费
  });

  it("画图失败自动退款", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("generativelanguage")) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      return realFetch(input, init);
    });
    const a = await payingUser();
    loginAs(a);
    const before = await getBalance(a.id);
    const res = await post({ action: "ai", text: "清晨的城市" });
    expect(res.status).toBe(422);
    expect(await getBalance(a.id)).toBe(before);
  });

  it("内容的主角是真实人物：不让 AI 画，改做信息卡", async () => {
    process.env.MOCK_IMAGE = "1";
    vi.spyOn(llm, "planImage").mockResolvedValue({
      tag: "新闻",
      title: "某位名人的新动态",
      points: ["一", "二", "三"],
      source: "",
      scene: "x",
      people: true,
    });
    const a = await payingUser();
    loginAs(a);
    const before = await getBalance(a.id);
    const r = (await body(await post({ action: "ai", text: "名人新闻" }))) as { image: { kind: string }; fellBack: boolean };
    expect(r.fellBack).toBe(true);
    expect(r.image.kind).toBe("card");
    expect(await getBalance(a.id)).toBe(before); // 开源版不扣费
  });
});

describe("发帖带图", () => {
  it("配图挂在串推的第一条上", async () => {
    const a = await payingUser();
    loginAs(a);
    const { image } = (await body(await post({ action: "card", text: "内容" }))) as { image: { id: string } };
    const n = mockMediaLog.length;
    const res = await postsRoute(json({ tweets: ["第一条带图", "第二条"], imageId: image.id }, "http://localhost:3000/api/posts"));
    const { item } = (await body(res)) as { item: { status: string; imageId: string } };
    expect(item.status).toBe("published");
    expect(item.imageId).toBe(image.id);
    expect(mockMediaLog.slice(n)).toEqual([{ text: "第一条带图", mediaIds: [expect.stringMatching(/^m\d+/)] }]);
  });

  it("保存草稿不会把选好的配图弄丢；被选中的图不会被清理", async () => {
    const a = await payingUser();
    const d = await draftOf(a.id, "single");
    loginAs(a);
    const { image } = (await body(await post({ action: "card", text: "内容", draftId: d.id }))) as { image: { id: string } };
    await post({ action: "attach", draftId: d.id, imageId: image.id });
    const { PATCH: patchDraft } = await import("@/app/api/drafts/[id]/route");
    await patchDraft(json({ meta: { title: "改了标题" } }, `http://localhost:3000/api/drafts/${d.id}`, "PATCH"), ctx(d.id));
    const db = await getDb();
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, d.id));
    expect(row.meta).toMatchObject({ title: "改了标题", imageId: image.id });

    await db.update(schema.images).set({ createdAt: new Date(Date.now() - 40 * 86400_000) });
    await pruneImages();
    const left = await db.select({ id: schema.images.id }).from(schema.images).where(eq(schema.images.userId, a.id));
    expect(left.map((x) => x.id)).toEqual([image.id]);
  });
});

describe("机器人里配图", () => {
  const cb = (userId: string, data: string) =>
    handleCallback(userId, "555", { id: "1", data, message: { message_id: 9, chat: { id: 555 } } }, async () => null);

  it("草稿 → 做信息卡 → 用这张 → 发布时带图", async () => {
    const a = await payingUser();
    const d = await draftOf(a.id);
    const n = tgSent.length;
    await cb(a.id, `im:${d.id}`);
    expect(JSON.stringify(tgSent.slice(n))).toContain(`imk:c:${d.id}`);

    await cb(a.id, `imk:c:${d.id}`);
    const photo = tgSent.slice(n).find((m) => m.method === "sendPhoto");
    expect(photo).toBeTruthy();
    const imageId = String(photo!.params.reply_markup).match(/igu:([0-9a-f-]{36})/)![1];

    await cb(a.id, `igu:${imageId}`);
    const db = await getDb();
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, d.id));
    expect(row.meta?.imageId).toBe(imageId);

    const m = mockMediaLog.length;
    await cb(a.id, `pubok:${d.id}`);
    expect(mockMediaLog.length).toBe(m + 1);
  });

  it("X 长文：选用封面后以文件发回原图", async () => {
    const a = await payingUser();
    const d = await draftOf(a.id, "article", "## 标题\n\n正文");
    const n = tgSent.length;
    await cb(a.id, `imk:v:${d.id}`);
    const photo = tgSent.slice(n).find((m) => m.method === "sendPhoto")!;
    const imageId = String(photo.params.reply_markup).match(/igu:([0-9a-f-]{36})/)![1];
    await cb(a.id, `igu:${imageId}`);
    expect(tgSent.slice(n).some((m) => m.method === "sendDocument")).toBe(true);
  });

  it("直接发一张截图：照内容做成信息卡，不需要草稿", async () => {
    const a = await payingUser();
    const db = await getDb();
    await db.insert(schema.tgBindings).values({ userId: a.id, chatId: `c${a.id}`, boundAt: new Date() });
    const n = tgSent.length;
    await handleIncomingImage(a.id, "555", { fileId: "f1", mime: "image/jpeg", caption: "这个项目不错" });
    expect(JSON.stringify(tgSent.slice(n))).toContain("igr:c");
    expect(JSON.stringify(tgSent.slice(n))).not.toContain("igr:u");
    await cb(a.id, "igr:c");
    const photo = tgSent.slice(n).find((m) => m.method === "sendPhoto");
    expect(String(photo!.params.reply_markup)).toContain("igf:");
  });
});

describe("信息卡样式随机", () => {
  it("每次随机挑配色、要点符号和装饰，不再张张一样；都是合法的取值", async () => {
    const { randomStyle, THEMES, BULLETS, DECORS } = await import("@/lib/image-render");
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = randomStyle();
      expect(THEMES).toContain(s.theme);
      expect(BULLETS).toContain(s.bullet);
      expect(DECORS).toContain(s.decor);
      seen.add(s.theme);
    }
    expect(seen.size).toBeGreaterThan(3);
    expect(randomStyle(() => 0)).toEqual({ theme: THEMES[0], bullet: BULLETS[0], decor: DECORS[0] });
  });
});
