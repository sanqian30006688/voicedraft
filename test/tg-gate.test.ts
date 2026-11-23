/**
 * 「必须关注频道 / 进群才能用机器人」+ 新用户赠送（TG 和 X 都绑好后到账，每个账号、TG 号、X 账号各一次）+ 不给用户看单价。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { addBalance, getBalance, getConfig, MICRO, reserve, saveConfig } from "@/lib/billing";
import { resetRateLimits } from "@/lib/rate-limit";
import { getGate, normalizeChat, resetGateCache, saveGate } from "@/lib/tg-gate";
import { connectMock } from "@/lib/x";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as gateRoute from "@/app/api/admin/tg-gate/route";
import { body, createUser, json, loginAs, tgSent, type TestUser } from "./helpers";

// ---------- 假的 Telegram：谁在频道里由 members 决定 ----------
const members = new Set<string>();
const tg = { broken: false };
const prevFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = url.match(/api\.telegram\.org\/bot[^/]+\/(getChatMember|getChat)$/);
  if (m) {
    const p = init?.body ? JSON.parse(String(init.body)) : {};
    tgSent.push({ method: m[1], params: p });
    const reply = (ok: boolean, result: unknown, description?: string) =>
      new Response(JSON.stringify({ ok, result, description }), { status: ok ? 200 : 400, headers: { "content-type": "application/json" } });
    if (tg.broken) return reply(false, null, "Bad Request: member list is inaccessible");
    if (m[1] === "getChat") return reply(true, { title: "我的频道", type: "channel" });
    if (Number(p.user_id) === 123456789) return reply(true, { status: "administrator" }); // 机器人自己
    return reply(true, { status: members.has(String(p.user_id)) ? "member" : "left" });
  }
  return prevFetch(input, init);
}) as typeof fetch;

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
const textsTo = (chat: number) => sentTo(chat).filter((x) => x.method === "sendMessage").map((x) => String(x.params.text));
const answers = () => tgSent.filter((x) => x.method === "answerCallbackQuery").map((x) => String(x.params.text ?? ""));

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

let ADMIN: TestUser;
beforeAll(async () => {
  ADMIN = await createUser("gate-admin@example.com"); // 最早注册的是管理员
  await saveConfig({ ...(await getConfig()), signupBonus: 1, minTopup: 10, reserve: 1 });
});

beforeEach(async () => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
  tg.broken = false;
  await saveGate({ enabled: true, chats: [{ chat: "@mychannel" }] });
});

describe("后台填频道", () => {
  it("各种写法都认：@名字、t.me 链接、数字 ID；邀请链接单独认不出是哪个群", () => {
    expect(normalizeChat("@MyChannel")).toBe("@MyChannel");
    expect(normalizeChat("https://t.me/mychannel")).toBe("@mychannel");
    expect(normalizeChat("t.me/mychannel/")).toBe("@mychannel");
    expect(normalizeChat("mychannel")).toBe("@mychannel");
    expect(normalizeChat("-1001234567890")).toBe("-1001234567890");
    expect(normalizeChat("https://t.me/+AbCdEf")).toBeNull();
  });

  it("只有管理员能改；保存时自动检测并记下频道名", async () => {
    const other = await createUser("gate-notadmin@example.com");
    loginAs(other);
    expect((await gateRoute.PUT(json({ enabled: true, chats: [{ chat: "@x_chan" }] }, undefined, "PUT"))).status).toBe(403);
    loginAs(ADMIN);
    const res = await gateRoute.PUT(json({ enabled: true, chats: [{ chat: "t.me/mychannel" }] }, undefined, "PUT"));
    expect(res.status).toBe(200);
    const d = await body(res);
    expect((d.diag as { ok: boolean }[])[0].ok).toBe(true);
    expect((await getGate()).chats[0]).toMatchObject({ chat: "@mychannel", title: "我的频道" });
  });

  it("私密群没填邀请链接不让保存（用户点不进去）", async () => {
    loginAs(ADMIN);
    const res = await gateRoute.PUT(json({ enabled: true, chats: [{ chat: "-1001234567890" }] }, undefined, "PUT"));
    expect(res.status).toBe(400);
  });
});

describe("没加入频道的人用不了机器人", () => {
  const CHAT = 7001;
  let U: TestUser;
  beforeAll(async () => {
    U = await createUser("gate-u1@example.com");
  });

  it("绑定后没加入：看到加入按钮和「我已加入」，菜单不出来，也不送钱", async () => {
    await bind(U, CHAT);
    const sent = sentTo(CHAT).filter((x) => x.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0].params.text)).toContain("请先加入");
    const kb = JSON.stringify(sent[0].params.reply_markup);
    expect(kb).toContain("https://t.me/mychannel");
    expect(kb).toContain("gate:ok");
    expect(await getBalance(U.id)).toBe(0);
  });

  it("没加入时发命令、点按钮都不处理", async () => {
    await bind(U, CHAT);
    tgSent.length = 0;
    resetRateLimits();
    await handleUpdate(message(CHAT, "/drafts"));
    await handleUpdate(press(CHAT, "wl"));
    expect(textsTo(CHAT).some((t) => t.includes("草稿"))).toBe(false);
    expect(textsTo(CHAT).some((t) => t.includes("余额"))).toBe(false);
    expect(answers()).toContain("请先加入频道/群");
  });

  it("没加入就点「我已加入」：提示还没检测到", async () => {
    await handleUpdate(press(CHAT, "gate:ok"));
    expect(answers().some((t) => t.includes("还没检测到"))).toBe(true);
    expect(await getBalance(U.id)).toBe(0);
  });

  it("加入后点「我已加入」：出菜单、能正常用；还没连 X 不送钱", async () => {
    members.add(String(CHAT));
    await handleUpdate(press(CHAT, "gate:ok"));
    expect(answers()).toContain("已确认加入 ✓");
    expect(await getBalance(U.id)).toBe(0);
    tgSent.length = 0;
    resetRateLimits();
    await handleUpdate(message(CHAT, "/balance"));
    expect(textsTo(CHAT).some((x) => x.includes("用户编号"))).toBe(true); // 开源版 /balance 显示账号编号（没有余额页）
  });

  it("再连上 X：送的 1 USDT 到账，机器人里告诉他", async () => {
    await connectMock(U.id, "u1");
    expect(await getBalance(U.id)).toBe(1 * MICRO);
    expect(textsTo(CHAT).some((t) => t.includes("新用户赠送 1.00 USDT"))).toBe(true);
  });

  it("赠送只给一次：再发消息、再点「我已加入」、重新连 X 都不会再送", async () => {
    resetRateLimits();
    await handleUpdate(press(CHAT, "gate:ok"));
    await handleUpdate(message(CHAT, "/balance"));
    await connectMock(U.id, "u1");
    expect(await getBalance(U.id)).toBe(1 * MICRO);
  });

  it("换个邮箱注册新号，绑定同一个 TG、连一个新 X：不再送", async () => {
    const U2 = await createUser("gate-u1-again@example.com");
    resetRateLimits();
    await bind(U2, CHAT);
    await connectMock(U2.id, "u1-again");
    expect(await getBalance(U2.id)).toBe(0);
  });

  it("把领过的 X 从老号断开、连到新号：不再送；新号换一个没领过的 X 还能领", async () => {
    const U4 = await createUser("gate-u4@example.com");
    const CHAT4 = 7004;
    members.add(String(CHAT4));
    await bind(U4, CHAT4);
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, U.id));
    await connectMock(U4.id, "u1");
    expect(await getBalance(U4.id)).toBe(0);
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, U4.id));
    await connectMock(U4.id, "u4-fresh");
    expect(await getBalance(U4.id)).toBe(1 * MICRO);
  });

  it("先连 X、还没进群：不送；进群后点「我已加入」才到账", async () => {
    const U5 = await createUser("gate-u5@example.com");
    const CHAT5 = 7005;
    await bind(U5, CHAT5);
    await connectMock(U5.id, "u5");
    expect(await getBalance(U5.id)).toBe(0);
    members.add(String(CHAT5));
    resetRateLimits();
    await handleUpdate(press(CHAT5, "gate:ok"));
    expect(await getBalance(U5.id)).toBe(1 * MICRO);
  });

  it("同一个账号同时触发很多次，也只送一次", async () => {
    const U3 = await createUser("gate-u3@example.com");
    const CHAT3 = 7003;
    members.add(String(CHAT3));
    await saveGate({ enabled: false, chats: [] });
    await bind(U3, CHAT3);
    await saveConfig({ ...(await getConfig()), signupBonus: 0 });
    await connectMock(U3.id, "u3");
    await saveConfig({ ...(await getConfig()), signupBonus: 1 });
    expect(await getBalance(U3.id)).toBe(0);
    const { grantNewUserBonus } = await import("@/lib/tg-gate");
    await Promise.all(Array.from({ length: 10 }, () => grantNewUserBonus(U3.id)));
    expect(await getBalance(U3.id)).toBe(1 * MICRO);
  });
});

describe("例外情况", () => {
  it("机器人还不是频道管理员（查不了）：先放行，后台能看到原因", async () => {
    const U = await createUser("gate-broken@example.com");
    const CHAT = 7101;
    tg.broken = true;
    await bind(U, CHAT);
    expect(textsTo(CHAT).some((t) => t.includes("绑定成功"))).toBe(true);
    loginAs(ADMIN);
    const d = await body(await gateRoute.GET());
    expect(JSON.stringify(d.errors)).toContain("inaccessible");
    const diag = await body(await gateRoute.POST(json({ enabled: true, chats: [{ chat: "@mychannel" }] })));
    expect((diag.diag as { ok: boolean; text: string }[])[0]).toMatchObject({ ok: false });
    expect((diag.diag as { text: string }[])[0].text).toContain("管理员");
  });

  it("管理员自己没加入也能用", async () => {
    const CHAT = 7201;
    await bind(ADMIN, CHAT);
    expect(textsTo(CHAT).some((t) => t.includes("绑定成功"))).toBe(true);
  });

  it("关掉门槛：不查频道", async () => {
    await saveGate({ enabled: false, chats: [{ chat: "@mychannel" }] });
    const U = await createUser("gate-off@example.com");
    await bind(U, 7301);
    expect(textsTo(7301).some((t) => t.includes("绑定成功"))).toBe(true);
    expect(tgSent.some((x) => x.method === "getChatMember")).toBe(false);
  });

  it("网页注册不再直接送钱（换邮箱刷不到）", async () => {
    const U = await createUser("gate-web-only@example.com");
    expect(await getBalance(U.id)).toBe(0);
  });
});

describe("私密群：贴邀请链接就行，不用找群 ID", () => {
  const GROUP = -1009876543210;
  const adminUpdate = (status: string): TgUpdate =>
    ({
      update_id: seq++,
      my_chat_member: { chat: { id: GROUP, type: "supergroup", title: "私密交流群" }, from: { id: 9999 }, new_chat_member: { status } },
    }) as unknown as TgUpdate;

  it("机器人被设为群管理员：后台能看到这个群", async () => {
    await handleUpdate(adminUpdate("administrator"));
    loginAs(ADMIN);
    const d = await body(await gateRoute.GET());
    expect(d.adminChats).toEqual([expect.objectContaining({ id: String(GROUP), title: "私密交流群" })]);
  });

  it("没绑定的人拉进来、机器人已经是管理员：不退群", async () => {
    tgSent.length = 0;
    await handleUpdate({
      update_id: seq++,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: GROUP, type: "supergroup", title: "私密交流群" },
        from: { id: 9999 },
        new_chat_members: [{ id: 123456789, is_bot: true }],
      },
    } as TgUpdate);
    await handleUpdate({
      update_id: seq++,
      message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: "supergroup" }, from: { id: 9998 }, text: "大家好".repeat(10) },
    } as TgUpdate);
    expect(tgSent.some((x) => x.method === "leaveChat")).toBe(false);
  });

  it("把 t.me/+ 邀请链接贴在第一栏也能保存：自动对上这个群", async () => {
    loginAs(ADMIN);
    const res = await gateRoute.PUT(json({ enabled: true, chats: [{ chat: "https://t.me/+8bzph_-JCqM4YTJl" }] }, undefined, "PUT"));
    expect(res.status).toBe(200);
    const gate = await getGate();
    expect(gate.chats[0]).toMatchObject({ chat: String(GROUP), invite: "https://t.me/+8bzph_-JCqM4YTJl" });
    // 用户看到的加入按钮就是这个邀请链接
    const U = await createUser("gate-private@example.com");
    resetGateCache();
    await bind(U, 7601);
    expect(JSON.stringify(sentTo(7601).map((x) => x.params.reply_markup))).toContain("https://t.me/+8bzph_-JCqM4YTJl");
  });

  it("机器人还不是任何私密群的管理员时，贴邀请链接给出白话提示", async () => {
    await handleUpdate(adminUpdate("left"));
    loginAs(ADMIN);
    const res = await gateRoute.PUT(json({ enabled: true, chats: [{ chat: "t.me/+abcdef" }] }, undefined, "PUT"));
    expect(res.status).toBe(400);
    expect(String((await body(res)).error)).toContain("把机器人设为管理员");
  });
});

describe("机器人在新版上线前就当了管理员（没收到通知）", () => {
  it("群里有人说一句话：补记下来，不退群", async () => {
    const G = -1001112223334;
    tgSent.length = 0;
    await handleUpdate({
      update_id: seq++,
      message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: G, type: "supergroup", title: "老群" }, from: { id: 9997 }, text: "随便说一句" },
    } as TgUpdate);
    expect(tgSent.some((x) => x.method === "leaveChat")).toBe(false);
    loginAs(ADMIN);
    const d = await body(await gateRoute.GET());
    expect(JSON.stringify(d.adminChats)).toContain(String(G));
  });

  it("频道里发一条帖子：补记下来", async () => {
    await handleUpdate({ update_id: seq++, channel_post: { chat: { id: -1005556667778, type: "channel", title: "老频道" } } } as unknown as TgUpdate);
    loginAs(ADMIN);
    const d = await body(await gateRoute.GET());
    expect(JSON.stringify(d.adminChats)).toContain("老频道");
  });
});

describe("平台方已绑定 TG，把机器人拉进自己的群（顺便成了信息源）", () => {
  it("这个群照样出现在后台「机器人是管理员的群」里", async () => {
    await saveGate({ enabled: false, chats: [] });
    resetRateLimits();
    await bind(ADMIN, 7201);
    const G = -1004443332221;
    const base = { date: Math.floor(Date.now() / 1000), chat: { id: G, type: "supergroup", title: "平台方的群" } };
    await handleUpdate({ update_id: seq++, message: { ...base, message_id: 10, from: { id: 7201 }, new_chat_members: [{ id: 123456789, is_bot: true }] } } as TgUpdate);
    await handleUpdate({ update_id: seq++, message: { ...base, message_id: 11, from: { id: 9996 }, text: "1" } } as TgUpdate);
    loginAs(ADMIN);
    const d = await body(await gateRoute.GET());
    expect(JSON.stringify(d.adminChats)).toContain(String(G));
  });
});
