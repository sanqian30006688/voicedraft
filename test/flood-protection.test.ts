/**
 * 防刷测试：有人狂点机器人、狂调接口时，挡在查数据库、调 AI、扣钱之前。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { addBalance, AI_LIMITS, getBalance, MICRO, requireActive, UsageLimitError, withCharge } from "@/lib/billing";
import { ban, BAN_STEPS_MS, bannedFor, resetRateLimits } from "@/lib/rate-limit";
import { floodCheck, TG_LIMITS } from "@/lib/tg-guard";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as webhookRoute from "@/app/api/telegram/webhook/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import { body, createUser, json, loginAs, tgSent, type TestUser } from "./helpers";

let A: TestUser;
const CHAT_A = 5001;
let seq = 1;

function message(chat: number, text: string, type = "private"): TgUpdate {
  return {
    update_id: seq++,
    message: { message_id: seq, date: Math.floor(Date.now() / 1000), chat: { id: chat, type }, text },
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

beforeAll(async () => {
  A = await createUser("flood-a@example.com");
  loginAs(A);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(CHAT_A, `/start ${code}`));
});

beforeEach(() => {
  resetRateLimits();
  tgSent.length = 0;
});

describe("TG 机器人：狂发消息", () => {
  it("已绑定的人 1 秒内发 100 条：只处理前 10 条，提醒一次「太快了」，其余静默丢弃", async () => {
    for (let i = 0; i < 100; i++) await handleUpdate(message(CHAT_A, "/drafts"));
    const texts = textsTo(CHAT_A);
    expect(texts.filter((t) => t.includes("太快了"))).toHaveLength(1);
    // 每条 /drafts 回一条消息：10 条正常回复 + 1 条提醒（其余的有的触发封禁提示）
    expect(texts.length).toBeLessThanOrEqual(TG_LIMITS.burst.limit + 2);
  });

  it("持续刷屏会被临时封禁，封禁期间完全不理", async () => {
    for (let i = 0; i < 200; i++) await handleUpdate(message(CHAT_A, "/drafts"));
    const texts = textsTo(CHAT_A);
    expect(texts.some((t) => t.includes("检测到刷屏"))).toBe(true);
    const before = sentTo(CHAT_A).length;
    for (let i = 0; i < 20; i++) await handleUpdate(message(CHAT_A, "/drafts"));
    expect(sentTo(CHAT_A).length).toBe(before);
  });

  it("封禁时长一天内逐级加长：10 分钟 → 1 小时 → 6 小时 → 24 小时", () => {
    const now = 1_000_000_000;
    expect(ban("x", now)).toBe(BAN_STEPS_MS[0]);
    expect(ban("x", now + 1000)).toBe(BAN_STEPS_MS[1]);
    expect(ban("x", now + 2000)).toBe(BAN_STEPS_MS[2]);
    expect(ban("x", now + 3000)).toBe(BAN_STEPS_MS[3]);
    expect(ban("x", now + 4000)).toBe(BAN_STEPS_MS[3]);
    expect(bannedFor("x", now + 4000 + BAN_STEPS_MS[3] + 1)).toBe(0);
  });

  it("过了时间窗口自动恢复", () => {
    const t0 = 2_000_000_000;
    for (let i = 0; i < TG_LIMITS.burst.limit; i++) expect(floodCheck("c1", t0).action).toBe("ok");
    expect(floodCheck("c1", t0).action).toBe("warn");
    expect(floodCheck("c1", t0).action).toBe("drop");
    expect(floodCheck("c1", t0 + TG_LIMITS.burst.windowMs + 1).action).toBe("ok");
  });

  it("没绑定的陌生人狂发 50 条：只自动开一个账号，超过的消息被挡掉", async () => {
    const STRANGER = 6001;
    for (let i = 0; i < 50; i++) await handleUpdate(message(STRANGER, `hello ${i}`));
    const texts = textsTo(STRANGER);
    expect(texts.filter((t) => t.includes("自动开好"))).toHaveLength(1);
    // 只有前 10 条（10 秒内的上限）会被处理，其余都挡掉
    expect(texts.length).toBeLessThanOrEqual(TG_LIMITS.burst.limit + 3);
    const { getDb, schema } = await import("@/db");
    const { like } = await import("drizzle-orm");
    const db = await getDb();
    expect(await db.select().from(schema.users).where(like(schema.users.email, `tg${STRANGER}@%`))).toHaveLength(1);
  });

  it("被反复拉进群：只回一次并退群", async () => {
    for (let i = 0; i < 10; i++) await handleUpdate(message(-7001, "hi", "group"));
    expect(sentTo(-7001).filter((x) => x.method === "leaveChat")).toHaveLength(1);
  });

  it("反复试绑定码：10 分钟最多试 5 次", async () => {
    const CHAT = 6002;
    for (let i = 0; i < 6; i++) await handleUpdate(message(CHAT, `/start fake-code-${i}`));
    const texts = textsTo(CHAT);
    expect(texts.filter((t) => t.includes("已过期"))).toHaveLength(TG_LIMITS.bindTries.limit);
    expect(texts.at(-1)).toContain("试得太多次");
  });

  it("同一个按钮连点两下：第二下只提示「别重复点」，不会做两次", async () => {
    await handleUpdate(press(CHAT_A, "dl"));
    await handleUpdate(press(CHAT_A, "dl"));
    const answers = sentTo(CHAT_A).length + tgSent.filter((x) => x.method === "answerCallbackQuery").length;
    expect(answers).toBeGreaterThan(0);
    const notes = tgSent.filter((x) => x.method === "answerCallbackQuery").map((x) => String(x.params.text ?? ""));
    expect(notes.filter((t) => t.includes("别重复点"))).toHaveLength(1);
  });
});

describe("TG webhook（线上部署时的入口）", () => {
  const SECRET = "s3cret-s3cret-s3cret-123";
  const req = (update: unknown, secret = SECRET) =>
    new Request("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(update),
    });

  it("密钥不对、没设、或太短：一律拒绝", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    expect((await webhookRoute.POST(req(message(CHAT_A, "/drafts"), "wrong-wrong-wrong-wrong!"))).status).toBe(403);
    process.env.TELEGRAM_WEBHOOK_SECRET = "short";
    expect((await webhookRoute.POST(req(message(CHAT_A, "/drafts"), "short"))).status).toBe(403);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect((await webhookRoute.POST(req(message(CHAT_A, "/drafts"), ""))).status).toBe(403);
    expect(tgSent).toHaveLength(0);
  });

  it("同一条更新被重发或重放：只处理一次", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const u = message(CHAT_A, "/drafts");
    expect((await webhookRoute.POST(req(u))).status).toBe(200);
    const n = tgSent.length;
    expect(n).toBeGreaterThan(0);
    expect((await webhookRoute.POST(req(u))).status).toBe(200);
    expect(tgSent.length).toBe(n);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it("超大的请求直接丢掉", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const big = message(CHAT_A, "x".repeat(300 * 1024));
    expect((await webhookRoute.POST(req(big))).status).toBe(413);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });
});

describe("AI 功能不能被批量触发", () => {
  it("每分钟最多发起 20 次，超了直接挡掉", async () => {
    const u = await createUser("flood-ai@example.com");
    await addBalance(u.id, 10 * MICRO, { kind: "adjust", note: "测试" });
    for (let i = 0; i < AI_LIMITS.perMinute; i++) {
      // 不收费功能有每日上限，这里换着用几种，只看每分钟的线
      await requireActive(u.id, i % 2 ? "points" : "outline");
    }
    await expect(requireActive(u.id, "points")).rejects.toBeInstanceOf(UsageLimitError);
  });

  it("被挡下的收费请求不扣钱、不调 AI", async () => {
    const u = await createUser("flood-ai2@example.com");
    await addBalance(u.id, 10 * MICRO, { kind: "adjust", note: "测试" });
    let calls = 0;
    for (let i = 0; i < AI_LIMITS.perMinute; i++) await withCharge(u.id, "generate", async () => ++calls);
    const bal = await getBalance(u.id);
    await expect(withCharge(u.id, "generate", async () => ++calls)).rejects.toBeInstanceOf(UsageLimitError);
    expect(calls).toBe(AI_LIMITS.perMinute);
    expect(await getBalance(u.id)).toBe(bal);
  });
});

describe("网页登录 / 注册", () => {
  const from = (ip: string, data: unknown) => {
    const r = json(data);
    r.headers.set("x-forwarded-for", ip);
    return r;
  };

  it("同一邮箱输错 10 次密码后被锁住，连对的密码也要等", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await loginRoute.POST(from(`1.1.1.${i}`, { email: A.email, password: "wrong-password" }));
      expect(r.status).toBe(401);
    }
    const r = await loginRoute.POST(from("1.1.2.1", { email: A.email, password: "password-123" }));
    expect(r.status).toBe(429);
  });

  it("同一个来源 15 分钟最多试 30 次登录", async () => {
    for (let i = 0; i < 30; i++) {
      await loginRoute.POST(from("2.2.2.2", { email: `nobody${i}@example.com`, password: "x" }));
    }
    const r = await loginRoute.POST(from("2.2.2.2", { email: A.email, password: "password-123" }));
    expect(r.status).toBe(429);
    // 别的来源不受影响
    expect((await loginRoute.POST(from("3.3.3.3", { email: A.email, password: "password-123" }))).status).toBe(200);
  });

  it("同一个来源每小时最多注册 5 个号", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await signupRoute.POST(from("4.4.4.4", { email: `bulk${i}@example.com`, password: "password-123" }));
      expect(r.status).toBe(200);
    }
    const r = await signupRoute.POST(from("4.4.4.4", { email: "bulk9@example.com", password: "password-123" }));
    expect(r.status).toBe(429);
  });
});
