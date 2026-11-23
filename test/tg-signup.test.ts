/**
 * 机器人优先注册：没在网页注册过的人，在 TG 里点「开始」就自动开账号。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import * as bindRoute from "@/app/api/telegram/bind/route";
import { getDb, schema } from "@/db";
import { getBalance, getConfig, MICRO, saveConfig } from "@/lib/billing";
import * as tgLoginRoute from "@/app/api/auth/tg-login/route";
import { createWebLoginLink, consumeWebLogin } from "@/lib/web-login";
import { eq, like } from "drizzle-orm";
import { connectMock } from "@/lib/x";
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

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}


async function accountsOf(chat: number) {
  const db = await getDb();
  return db.select().from(schema.users).where(like(schema.users.email, `tg${chat}@%`));
}
async function boundUser(chat: number) {
  const db = await getDb();
  const [r] = await db.select({ userId: schema.tgBindings.userId }).from(schema.tgBindings).where(eq(schema.tgBindings.chatId, String(chat)));
  return r?.userId ?? null;
}

beforeAll(async () => {
  await createUser("signup-admin@example.com");
  await saveConfig({ ...(await getConfig()), signupBonus: 1 });
  await saveGate({ enabled: false, chats: [] });
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
});

describe("在机器人里点开始就能用", () => {
  it("新人点「开始」：自动开账号、有编号、送新人额度、给菜单和三步卡", async () => {
    await handleUpdate(message(9001, "/start"));
    const t = textsTo(9001).join("\n");
    expect(t).toContain("自动开好");
    expect(t).toMatch(/编号 \d+/);
    expect(t).toContain("三步就能开始");
    expect(t).toContain("连好送 1.00 USDT");
    expect(t).not.toContain("还没有绑定");
    const [u] = await accountsOf(9001);
    expect(await boundUser(9001)).toBe(u.id);
    // 新人赠送要等 X 也连好
    expect(await getBalance(u.id)).toBe(0);
    await connectMock(u.id, "s9001");
    expect(await getBalance(u.id)).toBe(1 * MICRO);
  });

  it("再点「开始」、同时发好几条：还是同一个账号，不重复送", async () => {
    await Promise.all([handleUpdate(message(9001, "/start")), handleUpdate(message(9001, "你好")), handleUpdate(message(9001, "/start"))]);
    const list = await accountsOf(9001);
    expect(list).toHaveLength(1);
    expect(await getBalance(list[0].id)).toBe(1 * MICRO);
    expect(textsTo(9001).join("\n")).not.toContain("自动开好");
  });

  it("新人第一条消息不是 /start（随便打字、点旧按钮）：也自动开账号", async () => {
    await handleUpdate(message(9002, "在吗"));
    expect(textsTo(9002).join("\n")).toContain("自动开好");
    await handleUpdate(press(9003, "hm:more"));
    expect(textsTo(9003).join("\n")).toContain("自动开好");
    expect(await accountsOf(9003)).toHaveLength(1);
  });

  it("开了「必须进群」：新人先看到进群提示，加入前不送额度", async () => {
    await saveGate({ enabled: true, chats: [{ chat: "@mychannel" }] });
    try {
      await handleUpdate(message(9004, "/start"));
      const t = textsTo(9004).join("\n");
      expect(t).toContain("我已加入");
      expect(t).not.toContain("三步就能开始");
      const [u] = await accountsOf(9004);
      expect(await getBalance(u.id)).toBe(0);
    } finally {
      await saveGate({ enabled: false, chats: [] });
    }
  });

  it("新开的账号能直接在机器人里连接 X", async () => {
    await handleUpdate(press(9001, "xc"));
    const db = await getDb();
    const acc = await db.select().from(schema.xAccounts).where(eq(schema.xAccounts.userId, (await boundUser(9001))!));
    expect(acc).toHaveLength(1);
  });

  it("已在网页注册的人：用绑定链接照样绑到网页账号，不会多开一个", async () => {
    const W = await createUser("signup-web@example.com");
    await bind(W, 9010);
    expect(await boundUser(9010)).toBe(W.id);
    expect(await accountsOf(9010)).toHaveLength(0);
  });

  it("先在机器人里开了账号、后来又用网页账号的绑定链接：换成网页账号，并提示", async () => {
    await handleUpdate(message(9011, "/start"));
    const W = await createUser("signup-web2@example.com");
    tgSent.length = 0;
    await bind(W, 9011);
    expect(await boundUser(9011)).toBe(W.id);
    expect(textsTo(9011).join("\n")).toContain("已换成你在网页上注册的账号");
  });
});

describe("机器人开的账号也能用网页版", () => {
  it("/web 给一次性登录链接；用一次就失效", async () => {
    await handleUpdate(message(9001, "/web"));
    expect(textsTo(9001).join("\n")).toContain("网页版");
    const uid = (await boundUser(9001))!;
    process.env.PUBLIC_URL = "http://localhost:3000";
    const link = (await createWebLoginLink(uid))!;
    const t = new URL(link).searchParams.get("t")!;
    const res = await tgLoginRoute.GET(new Request(link));
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(await consumeWebLogin(t)).toBeNull();
  });
});
