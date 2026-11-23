/**
 * 账号记忆、内容质量分、跨来源去重。
 * 每位客户的记忆只给自己用；质量分纯代码算；同一件事从别的源再收一次会被挡掉。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { GET as getMemory, PUT as putMemory } from "@/app/api/memory/route";
import { POST as refreshMemoryRoute } from "@/app/api/memory/refresh/route";
import { POST as qualityRoute } from "@/app/api/quality/route";
import { POST as generateRoute } from "@/app/api/generate/route";
import { addBalance, MICRO } from "@/lib/billing";
import { loadStyleCardForDrafting } from "@/lib/data";
import { cleanMemory, memoryPromptBlock, needsRefresh } from "@/lib/memory-core";
import { refreshDueMemories } from "@/lib/memory";
import { buildSystemPrompt } from "@/lib/prompts";
import { qualityCtx, scoreText } from "@/lib/quality";
import { addFeedItem } from "@/lib/tg-feed";
import { handleUpdate } from "@/lib/telegram";
import { createUser, json, loginAs, tgSent, type TestUser } from "./helpers";

let A: TestUser;
let B: TestUser;

const SAMPLES = [
  "说白了，小团队做产品，第一步是找到十个愿意付钱的人。",
  "我一直觉得，先卖再做，比闷头做半年靠谱得多。",
  "融资讲故事那套，我是真不喜欢，能赚钱才是硬道理。",
  "今天又砍掉了一个功能，做减法比做加法难多了。",
  "独立开发第二年，最大的体会：别追热点，守住自己的用户。",
  "用户说要的，和用户真正会付钱的，往往不是一回事。",
];

async function seed(u: TestUser) {
  const db = await getDb();
  const traits = { catchphrases: ["说白了"], bannedWords: ["赋能"], openings: "", stance: "", humor: "", topics: ["做产品"], notes: "" };
  await db.insert(schema.styleCards).values({ userId: u.id, lang: "zh", version: 1, traits, source: "generated" });
  await db.insert(schema.samples).values(
    SAMPLES.map((content, i) => ({ userId: u.id, content, contentHash: `${u.id}-${i}`, lang: "zh", source: "paste" })),
  );
}

beforeAll(async () => {
  await createUser("admin@example.com");
  A = await createUser("a@example.com");
  B = await createUser("b@example.com");
  for (const u of [A, B]) await addBalance(u.id, 50 * MICRO, { kind: "adjust", note: "测试" });
  await seed(A);
  const db = await getDb();
  await db.insert(schema.tgBindings).values({ userId: A.id, chatId: "1001", boundAt: new Date() });
});

describe("账号记忆：纯函数", () => {
  it("清理：去空、去重、截条数", () => {
    const m = cleanMemory({ persona: "  x ", topics: ["a", "a", "", "b"], positions: Array.from({ length: 30 }, (_, i) => `p${i}`) });
    expect(m.persona).toBe("x");
    expect(m.topics).toEqual(["a", "b"]);
    expect(m.positions).toHaveLength(12);
    expect(m.opposes).toEqual([]);
  });

  it("新增 10 条本人推文才再整理", () => {
    expect(needsRefresh(0, null)).toBe(false);
    expect(needsRefresh(6, null)).toBe(true);
    expect(needsRefresh(15, { postsAtBuild: 6, builtAt: new Date() })).toBe(false);
    expect(needsRefresh(16, { postsAtBuild: 6, builtAt: new Date() })).toBe(true);
  });

  it("拼进提示词：观点、反对的观点、最近发过的都在", () => {
    const block = memoryPromptBlock(
      cleanMemory({ persona: "讲小团队做产品", positions: ["认为先卖再做"], opposes: ["反对融资讲故事"] }),
      ["昨天刚发的一条"],
    );
    expect(block).toContain("账号定位：讲小团队做产品");
    expect(block).toContain("认为先卖再做");
    expect(block).toContain("反对的观点（不要写出支持这些的内容）：反对融资讲故事");
    expect(block).toContain("昨天刚发的一条");
    expect(memoryPromptBlock(null, [])).toBe("");
  });
});

describe("账号记忆：整理、修改、带进生成", () => {
  it("还没整理时是空的；点整理后有内容", async () => {
    loginAs(A);
    let r = await (await getMemory()).json();
    expect(r.builtAt).toBeNull();
    expect(r.posts).toBe(SAMPLES.length);
    const res = await refreshMemoryRoute();
    expect(res.status).toBe(200);
    r = await (await getMemory()).json();
    expect(r.builtAt).not.toBeNull();
    expect(r.memory.persona).toBeTruthy();
    expect(r.recent.length).toBeGreaterThan(0);
  });

  it("推文太少不能整理", async () => {
    loginAs(B);
    const res = await refreshMemoryRoute();
    expect(res.status).toBe(400);
  });

  it("用户改过之后，自动整理不会删掉用户写的", async () => {
    loginAs(A);
    const cur = (await (await getMemory()).json()).memory;
    const res = await putMemory(json({ memory: { ...cur, opposes: ["反对为了融资讲故事"] } }, undefined, "PUT"));
    expect(res.status).toBe(200);
    expect((await res.json()).edited).toBe(true);
    await refreshMemoryRoute();
    const after = (await (await getMemory()).json()).memory;
    expect(after.opposes).toContain("反对为了融资讲故事");
  });

  it("生成时带上记忆和最近发过的；关掉后都不带", async () => {
    let card = await loadStyleCardForDrafting(A.id, "小团队");
    expect(card?.memory?.opposes).toContain("反对为了融资讲故事");
    expect(card?.recent?.length).toBeGreaterThan(0);
    const prompt = buildSystemPrompt(card!);
    expect(prompt).toContain("# 账号记忆");
    expect(prompt).toContain("反对为了融资讲故事");
    expect(prompt).toContain("最近发过的");

    loginAs(A);
    await putMemory(json({ enabled: false }, undefined, "PUT"));
    card = await loadStyleCardForDrafting(A.id, "小团队");
    expect(card?.memory).toBeNull();
    expect(card?.recent).toEqual([]);
    expect(buildSystemPrompt(card!)).not.toContain("# 账号记忆");
    await putMemory(json({ enabled: true }, undefined, "PUT"));
  });

  it("每位客户只看到自己的记忆", async () => {
    loginAs(B);
    const r = await (await getMemory()).json();
    expect(r.memory.opposes).toEqual([]);
    expect(r.posts).toBe(0);
    const card = await loadStyleCardForDrafting(B.id);
    expect(card).toBeNull();
  });

  it("后台：有风格卡、推文够、还没整理过的客户自动整理", async () => {
    const C = await createUser("c@example.com");
    await addBalance(C.id, 50 * MICRO, { kind: "adjust", note: "测试" });
    await seed(C);
    await refreshDueMemories(10);
    const db = await getDb();
    const [row] = await db.select().from(schema.accountMemories).where(eq(schema.accountMemories.userId, C.id));
    expect(row?.builtAt).toBeTruthy();
    expect(row.postsAtBuild).toBe(SAMPLES.length);
    // 没有新推文，不会再整理
    const before = row.builtAt!.getTime();
    await refreshDueMemories(10);
    const [again] = await db.select().from(schema.accountMemories).where(eq(schema.accountMemories.userId, C.id));
    expect(again.builtAt!.getTime()).toBe(before);
  });

  it("TG：/memory 能看，能补一条反对的观点", async () => {
    const start = tgSent.length;
    const msg = (id: number, text: string) =>
      handleUpdate({ update_id: id, message: { message_id: id, date: Date.now() / 1000, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text } });
    await msg(101, "/memory");
    const shown = tgSent.slice(start).map((m) => String(m.params.text ?? "")).join("\n");
    expect(shown).toContain("账号记忆");
    expect(shown).toContain("反对为了融资讲故事");
    await handleUpdate({
      update_id: 102,
      callback_query: { id: "cq1", from: { id: 1001 }, data: "mma:opposes", message: { message_id: 5, chat: { id: 1001 } } },
    } as Parameters<typeof handleUpdate>[0]);
    await msg(103, "反对上来就做 App");
    const card = await loadStyleCardForDrafting(A.id);
    expect(card?.memory?.opposes).toContain("反对上来就做 App");
  });
});

describe("内容质量分", () => {
  const ctx = qualityCtx(SAMPLES, ["赋能"], ["今天又砍掉了一个功能，做减法比做加法难多了。"]);

  it("像本人的写法分高", () => {
    const q = scoreText("说白了，用户愿意付钱之前，别急着加功能。", ctx);
    expect(q.score).toBeGreaterThanOrEqual(80);
    expect(q.level).toBe("good");
  });

  it("AI 腔套话、本人不用的词扣分", () => {
    const q = scoreText("总而言之，AI 赋能小团队，值得注意的是效率至关重要！！", ctx);
    expect(q.score).toBeLessThan(60);
    expect(q.notes.join()).toContain("AI 腔");
  });

  it("和最近发过的重复扣分", () => {
    const q = scoreText("今天又砍掉了一个功能，做减法比做加法难多了！", ctx);
    expect(q.notes.join()).toContain("最近发过");
    expect(q.score).toBeLessThanOrEqual(60);
  });

  it("超过 280 字直接 0 分", () => {
    expect(scoreText("长".repeat(200), ctx).score).toBe(0);
  });

  it("起草接口给每条完整候选打分；单独打分接口不收费", async () => {
    loginAs(A);
    const res = await generateRoute(json({ task: { kind: "full", topic: "小团队做产品", count: 3 } }));
    const d = await res.json();
    expect(d.quality).toHaveLength(d.candidates.length);
    expect(typeof d.quality[0].score).toBe("number");
    const q = await qualityRoute(json({ text: "说白了，先卖再做。" }));
    expect(q.status).toBe(200);
    expect((await q.json()).quality.score).toBeGreaterThan(0);
  });
});

describe("跨来源去重", () => {
  const story = "OpenAI 今天发布了新模型，推理速度比上一代快三倍，价格降低一半，开发者下周可以开始申请使用。";

  it("别的源再收一次同一件事会被挡掉，同一个源和手动转发不挡", async () => {
    const db = await getDb();
    const [s1, s2] = await db
      .insert(schema.sources)
      .values([
        { userId: A.id, type: "rss", handle: "https://a.example.com/feed" },
        { userId: A.id, type: "rss", handle: "https://b.example.com/feed" },
      ])
      .returning();
    expect(await addFeedItem(A.id, { kind: "web", text: story, sourceId: s1.id })).toBeTruthy();
    // 另一个网站换了几个字报同一件事
    expect(await addFeedItem(A.id, { kind: "web", text: `快讯：${story.replace("今天", "刚刚")}`, sourceId: s2.id })).toBeNull();
    // 同一个源里的不比
    expect(await addFeedItem(A.id, { kind: "web", text: `${story}（更新）`, sourceId: s1.id })).toBeTruthy();
    // 用户自己转发的照收
    expect(await addFeedItem(A.id, { kind: "tg_forward", text: `${story}我觉得值得关注一下。` })).toBeTruthy();
    // 不同的事照收
    expect(
      await addFeedItem(A.id, { kind: "web", text: "苹果宣布明年起所有新款电脑都改用自研芯片，旧款继续提供五年系统更新。", sourceId: s2.id }),
    ).toBeTruthy();
  });

  it("只在同一位客户里去重", async () => {
    const db = await getDb();
    const [s] = await db.insert(schema.sources).values({ userId: B.id, type: "rss", handle: "https://c.example.com/feed" }).returning();
    expect(await addFeedItem(B.id, { kind: "web", text: story, sourceId: s.id })).toBeTruthy();
  });
});
