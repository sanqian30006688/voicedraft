/**
 * 新用户上手：在机器人里连接 X（一点 → X 授权 → 回到机器人看到结果）、首次使用的提示。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import { addBalance, MICRO } from "@/lib/billing";
import { MENU } from "@/lib/tg-bot";
import { TIPS } from "@/lib/tg-bot-home";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as callbackRoute from "@/app/api/x/callback/route";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { body, createUser, loginAs, tgSent, type TestUser } from "./helpers";

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
const sentTo = (chat: number) => tgSent.filter((x) => String(x.params.chat_id) === String(chat));
const textsTo = (chat: number) => sentTo(chat).filter((x) => /^(sendMessage|editMessageText)$/.test(x.method)).map((x) => String(x.params.text));
type Markup = { keyboard?: { text: string }[][]; inline_keyboard?: { text: string; callback_data?: string }[][] };
const markups = (chat: number) => sentTo(chat).map((x) => x.params.reply_markup as Markup | undefined).filter((m): m is Markup => !!m);
const inlineData = (chat: number) => markups(chat).flatMap((m) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? ""));

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

const CHAT = 8201;
let U: TestUser;
const urlsTo = (chat: number) =>
  sentTo(chat).flatMap((x) => ((x.params.reply_markup as { inline_keyboard?: { url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat().map((b) => b.url ?? ""));

/** 模拟真实环境：不用演示模式，平台配好了自己的 X 应用 */
function realX() {
  process.env.X_MOCK = "0";
  process.env.X_CLIENT_ID = "platform-app";
}
function mockX() {
  process.env.X_MOCK = "1";
}

async function stateFor(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.xOauthStates).where(eq(schema.xOauthStates.userId, userId)).limit(1);
  return row;
}

beforeAll(async () => {
  await createUser("onb-admin@example.com");
  await saveGate({ enabled: false, chats: [] });
  U = await createUser("onb-u1@example.com");
  await addBalance(U.id, 5 * MICRO, { kind: "adjust", note: "测试" });
  await bind(U, CHAT);
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
  mockX();
});

describe("在机器人里连接 X", () => {
  it("点「🔑 连接 X」：一步步说明 + 直接跳 X 授权页的按钮，用的是平台的 X 应用", async () => {
    realX();
    await handleUpdate(press(CHAT, "xc"));
    const t = textsTo(CHAT).join("\n");
    expect(t).toContain("Authorize app");
    expect(t).toContain("不需要申请任何开发者");
    const url = urlsTo(CHAT).find((u) => u.includes("/oauth2/authorize"))!;
    expect(url).toBeTruthy();
    expect(new URL(url).searchParams.get("client_id")).toBe("platform-app");
    const row = await stateFor(U.id);
    expect(new URL(row.returnTo!).pathname).toBe("/x-connected");
  });

  it("在 X 上点了取消：落地页说没连上，机器人里给「再试一次」", async () => {
    realX();
    await handleUpdate(press(CHAT, "xc"));
    const row = await stateFor(U.id);
    tgSent.length = 0;
    loginAs(null); // 手机上一般没登录网页
    const res = await callbackRoute.GET(new Request(`http://localhost:3000/api/x/callback?state=${row.state}&error=access_denied`));
    expect(res.headers.get("location")).toContain("/x-connected?x_error=");
    expect(textsTo(CHAT).join("\n")).toContain("没连上");
    expect(inlineData(CHAT)).toContain("xc");
  });

  it("授权成功：落地页显示成功，机器人发消息并指向下一步（学文风）", async () => {
    realX();
    await handleUpdate(press(CHAT, "xc"));
    const row = await stateFor(U.id);
    tgSent.length = 0;
    loginAs(null);
    mockX(); // 换令牌这一步走演示，不连真实 X
    const res = await callbackRoute.GET(new Request(`http://localhost:3000/api/x/callback?state=${row.state}&code=abc`));
    expect(res.headers.get("location")).toContain("/x-connected?connected=1");
    const t = textsTo(CHAT).join("\n");
    expect(t).toContain("连接好了");
    expect(t).toContain("下一步");
    expect(inlineData(CHAT)).toContain("sm");
  });

  it("链接过期：机器人里也会说明", async () => {
    realX();
    await handleUpdate(press(CHAT, "xc"));
    const row = await stateFor(U.id);
    const db = await getDb();
    await db.update(schema.xOauthStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.xOauthStates.state, row.state));
    tgSent.length = 0;
    loginAs(null);
    await callbackRoute.GET(new Request(`http://localhost:3000/api/x/callback?state=${row.state}&code=abc`));
    expect(textsTo(CHAT).join("\n")).toContain("过期");
  });

  it("网页上发起的连接：不往机器人发消息", async () => {
    const db = await getDb();
    await db.insert(schema.xOauthStates).values({ state: "web-state-1", userId: U.id, codeVerifier: "v", returnTo: "http://localhost:3000/publish", expiresAt: new Date(Date.now() + 60_000) });
    loginAs(U);
    const res = await callbackRoute.GET(new Request("http://localhost:3000/api/x/callback?state=web-state-1&error=access_denied"));
    expect(res.headers.get("location")).toContain("/publish?x_error=");
    expect(textsTo(CHAT)).toHaveLength(0);
  });
});

describe("首次使用的提示", () => {
  it("没学文风就点写推文：说明要先导入推文，并给按钮", async () => {
    await handleUpdate(message(CHAT, "/draft 比特币又创新高"));
    expect(textsTo(CHAT).join("\n")).toContain("先学会你的文风");
    expect(inlineData(CHAT)).toEqual(expect.arrayContaining(["sm", "cg"]));
  });

  it("「粘贴推文」给出例子", async () => {
    await handleUpdate(press(CHAT, "sp"));
    expect(textsTo(CHAT).join("\n")).toContain("例如");
  });

  it("每个主按钮第一次点给一句「怎么用」，第二次不再给", async () => {
    for (const k of Object.keys(MENU) as (keyof typeof MENU)[]) {
      resetRateLimits();
      tgSent.length = 0;
      await handleUpdate(message(CHAT, MENU[k]));
      expect(textsTo(CHAT)).toContain(TIPS[k]);
      tgSent.length = 0;
      await handleUpdate(message(CHAT, MENU[k]));
      expect(textsTo(CHAT)).not.toContain(TIPS[k]);
    }
  });
});
