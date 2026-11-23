/**
 * 每位顾客绑定自己的 X 和 TG：
 * - 一个 X 账号 / 一个 TG 账号只能绑一个用户
 * - TG 机器人按聊天对应到正确的用户，拿别人的编号点按钮也没用
 * - X 授权链接不能被别人「借用」
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { connectMock, getAccount, X_TAKEN_MESSAGE } from "@/lib/x";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as callbackRoute from "@/app/api/x/callback/route";
import * as draftsRoute from "@/app/api/drafts/route";
import { body, createUser, get, json, loginAs, tgSent, type TestUser } from "./helpers";

let A: TestUser;
let B: TestUser;
const CHAT_A = 1001;
const CHAT_B = 2002;
const STRANGER = 3003;
let seq = 1;

function message(chat: number, text: string, extra: Record<string, unknown> = {}): TgUpdate {
  return {
    update_id: seq++,
    message: { message_id: seq, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, text, ...extra },
  } as TgUpdate;
}
function press(chat: number, data: string): TgUpdate {
  return {
    update_id: seq++,
    callback_query: { id: String(seq), data, message: { message_id: 1, chat: { id: chat, type: "private" } } },
  } as unknown as TgUpdate;
}
/** 机器人最近发给某个聊天的文字 */
function lastTextTo(chat: number): string {
  const m = [...tgSent].reverse().find((x) => x.method === "sendMessage" && String(x.params.chat_id) === String(chat));
  return String(m?.params.text ?? "");
}
function allTextTo(chat: number): string {
  return tgSent
    .filter((x) => String(x.params.chat_id) === String(chat))
    .map((x) => JSON.stringify(x.params))
    .join("\n");
}
async function bindCode(user: TestUser) {
  loginAs(user);
  const r = await body(await bindRoute.POST());
  return new URL(r.url as string).searchParams.get("start")!;
}
async function bindingOf(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId));
  return row?.chatId ?? null;
}

beforeAll(async () => {
  A = await createUser("a@example.com");
  B = await createUser("b@example.com");
});

describe("TG 绑定", () => {
  it("各自用自己的绑定链接，绑到各自的账号", async () => {
    const codeA = await bindCode(A);
    const codeB = await bindCode(B);
    await handleUpdate(message(CHAT_A, `/start ${codeA}`));
    await handleUpdate(message(CHAT_B, `/start ${codeB}`));
    expect(await bindingOf(A.id)).toBe(String(CHAT_A));
    expect(await bindingOf(B.id)).toBe(String(CHAT_B));
  });

  it("绑定链接只能用一次：别人拿到用过的链接也绑不上", async () => {
    const codeA = await bindCode(A);
    await handleUpdate(message(CHAT_A, `/start ${codeA}`));
    await handleUpdate(message(STRANGER, `/start ${codeA}`));
    expect(lastTextTo(STRANGER)).toContain("已过期或已用过");
    expect(await bindingOf(A.id)).toBe(String(CHAT_A));
  });

  it("没绑定的人发消息：自动开一个自己的新账号，看不到别人的东西", async () => {
    await handleUpdate(message(STRANGER, "/drafts"));
    expect(allTextTo(STRANGER)).toContain("自动开好");
    await handleUpdate(message(STRANGER, "/drafts"));
    await handleUpdate(message(STRANGER, "随便写点东西看看能不能进到别人的灵感池"));
    const db = await getDb();
    const own = await db.select({ userId: schema.tgBindings.userId }).from(schema.tgBindings).where(eq(schema.tgBindings.chatId, String(STRANGER)));
    expect(own).toHaveLength(1);
    expect([A.id, B.id]).not.toContain(own[0].userId);
    expect((await db.select().from(schema.feedItems)).filter((r) => r.userId !== own[0].userId)).toHaveLength(0);
  });

  it("转发给机器人的内容只进自己的灵感池", async () => {
    await handleUpdate(message(CHAT_A, "A 转发的一条频道消息，内容足够长", { forward_origin: { type: "user" } }));
    await handleUpdate(message(CHAT_B, "B 转发的一条频道消息，内容足够长", { forward_origin: { type: "user" } }));
    const db = await getDb();
    const rows = await db.select().from(schema.feedItems);
    expect(rows.find((r) => r.text.startsWith("A "))?.userId).toBe(A.id);
    expect(rows.find((r) => r.text.startsWith("B "))?.userId).toBe(B.id);
  });

  it("在 B 的聊天里点带着 A 的草稿编号的按钮，看不到也发不出 A 的草稿", async () => {
    loginAs(A);
    const d = await body(
      await draftsRoute.POST(json({ topic: "A 的私密主题", mode: "quick", sentences: [{ text: "A 的私密草稿", original: "", locked: false }] })),
    );
    const before = tgSent.length;
    for (const data of [`dr:${d.id}`, `dro:${d.id}`, `pub:${d.id}`, `pubok:${d.id}`, `ed:${d.id}`, `st:${d.id}:1h`]) {
      await handleUpdate(press(CHAT_B, data));
    }
    const toB = tgSent.slice(before).map((x) => JSON.stringify(x.params)).join("\n");
    expect(toB).not.toContain("A 的私密");
    const db = await getDb();
    expect(await db.select().from(schema.posts)).toHaveLength(0);
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, d.id as string));
    expect(row.status).toBe("draft");
  });

  it("B 在机器人里看草稿、灵感，只看到自己的", async () => {
    for (const cmd of ["/drafts", "/ideas", "/replies", "/queue", "/promo", "/samples"]) await handleUpdate(message(CHAT_B, cmd));
    expect(allTextTo(CHAT_B)).not.toMatch(/A 的私密|A 转发/);
  });

  it("一个 TG 账号只能绑一个用户：同一个 TG 去绑 B，就会从 A 那里解绑", async () => {
    const codeB = await bindCode(B);
    await handleUpdate(message(CHAT_A, `/start ${codeB}`));
    expect(await bindingOf(B.id)).toBe(String(CHAT_A));
    expect(await bindingOf(A.id)).toBeNull();
    // B 原来的 TG 收到换绑通知，之后再发消息不会进到任何人的账号
    expect(lastTextTo(CHAT_B)).toContain("换绑");
    // B 原来的 TG 再发消息：开的是它自己的新账号，进不了 B
    resetRateLimits();
    await handleUpdate(message(CHAT_B, "/drafts"));
    expect(allTextTo(CHAT_B)).toContain("自动开好");
    expect(await bindingOf(B.id)).toBe(String(CHAT_A));
  });

  it("在机器人里 /unbind 只解除自己的绑定", async () => {
    const codeA = await bindCode(A);
    await handleUpdate(message(CHAT_B, `/start ${codeA}`));
    await handleUpdate(message(CHAT_B, "/unbind"));
    expect(await bindingOf(A.id)).toBeNull();
    expect(await bindingOf(B.id)).toBe(String(CHAT_A));
  });
});

describe("X 绑定", () => {
  it("各自连接自己的 X 账号", async () => {
    await connectMock(A.id, "alice");
    await connectMock(B.id, "bob");
    expect((await getAccount(A.id))?.handle).toBe("demo_alice");
    expect((await getAccount(B.id))?.handle).toBe("demo_bob");
  });

  it("一个 X 账号只能绑一个用户：B 想连 A 的 X 账号会被拒绝，A 不受影响", async () => {
    await expect(connectMock(B.id, "alice")).rejects.toThrow(X_TAKEN_MESSAGE);
    expect((await getAccount(A.id))?.handle).toBe("demo_alice");
    expect((await getAccount(B.id))?.handle).toBe("demo_bob");
  });

  it("A 断开以后，这个 X 账号就可以绑到别的用户", async () => {
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, A.id));
    await connectMock(B.id, "alice");
    expect((await getAccount(B.id))?.handle).toBe("demo_alice");
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, B.id));
    await connectMock(A.id, "alice");
    await connectMock(B.id, "bob");
  });

  it("换了 X 账号后，旧账号收到的待回复提及不会用新账号去回", async () => {
    const db = await getDb();
    await db.insert(schema.replyItems).values({ userId: B.id, tweetId: "777", authorId: "1", authorHandle: "x", text: "hi" });
    await connectMock(B.id, "bob2");
    const [r] = await db.select().from(schema.replyItems).where(eq(schema.replyItems.tweetId, "777"));
    expect(r.status).toBe("skipped");
    await connectMock(B.id, "bob");
  });
});

describe("X 授权回调", () => {
  async function startState(user: TestUser, state: string) {
    const db = await getDb();
    await db.insert(schema.xOauthStates).values({
      state,
      userId: user.id,
      codeVerifier: "v",
      returnTo: "http://localhost:3000/publish",
      expiresAt: new Date(Date.now() + 600_000),
    });
  }
  const cb = (state: string) => callbackRoute.GET(get(`http://127.0.0.1:3000/api/x/callback?state=${state}&code=c`));

  it("A 发起的授权链接被已登录的 B 点开，不会把 B 的 X 绑到 A 身上", async () => {
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, A.id));
    await startState(A, "state-a-1");
    loginAs(B);
    const res = await cb("state-a-1");
    expect(res.headers.get("location")).toContain("x_error");
    expect(await getAccount(A.id)).toBeNull();
  });

  it("A 自己完成授权（或在 TG 里点链接、浏览器没登录）可以正常连接", async () => {
    await startState(A, "state-a-2");
    loginAs(A);
    expect((await cb("state-a-2")).headers.get("location")).toContain("connected=1");
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, A.id));
    await startState(A, "state-a-3");
    loginAs(null);
    expect((await cb("state-a-3")).headers.get("location")).toContain("connected=1");
    expect((await getAccount(A.id))?.userId).toBe(A.id);
  });
});
