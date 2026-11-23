/**
 * 每 3 天提醒还没连 X 的人去连 X（提到新人赠送），最多 5 次，可以点「不再提醒」。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { getConfig, saveConfig } from "@/lib/billing";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import { connectMock } from "@/lib/x";
import { NUDGE_MAX, runXNudges } from "@/lib/x-nudge";
import * as bindRoute from "@/app/api/telegram/bind/route";
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
const nudgesTo = (chat: number) =>
  tgSent
    .filter((x) => x.method === "sendMessage" && String(x.params.chat_id) === String(chat) && JSON.stringify(x.params.reply_markup ?? "").includes("xn:off"))
    .map((x) => String(x.params.text));

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

// 北京时间中午 12 点；绑定时间是「现在」，所以这一天肯定已经满 3 天
const NOON = Date.parse("2030-01-01T04:00:00Z");
const DAY = 86400_000;
const at = (days: number, hourShift = 0) => new Date(NOON + days * DAY + hourShift * 3600_000);

let A: TestUser, B: TestUser, C: TestUser;
beforeAll(async () => {
  await createUser("nudge-admin@example.com");
  await saveConfig({ ...(await getConfig()), signupBonus: 1 });
  await saveGate({ enabled: false, chats: [] });
  A = await createUser("nudge-a@example.com");
  B = await createUser("nudge-b@example.com");
  C = await createUser("nudge-c@example.com");
  await bind(A, 9301);
  await bind(B, 9302);
  await bind(C, 9303);
  await connectMock(C.id, "c"); // C 已经连了 X
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
});

describe("提醒连接 X", () => {
  it("刚绑定不到 3 天：不提醒", async () => {
    await runXNudges(new Date(Date.now() + DAY), true);
    expect(nudgesTo(9301)).toHaveLength(0);
  });

  it("满 3 天：没连 X 的人收到提醒，带「连接 X」「不再提醒」，提到送 1 USDT；连了 X 的人不收", async () => {
    await runXNudges(at(0), true);
    const t = nudgesTo(9301);
    expect(t).toHaveLength(1);
    expect(t[0]).toContain("1.00 USDT");
    const kb = JSON.stringify(tgSent.find((x) => String(x.params.chat_id) === "9301")?.params.reply_markup);
    expect(kb).toContain('"xc"');
    expect(kb).toContain("xn:off");
    expect(nudgesTo(9302)).toHaveLength(1);
    expect(nudgesTo(9303)).toHaveLength(0);
  });

  it("半夜不发；同一天、隔一天都不重复发，满 3 天再发", async () => {
    await runXNudges(at(3, 14), true); // 北京时间凌晨 2 点
    await runXNudges(at(1), true);
    await runXNudges(at(2), true);
    expect(nudgesTo(9301)).toHaveLength(0);
    await runXNudges(at(3), true);
    expect(nudgesTo(9301)).toHaveLength(1);
  });

  it("点「不再提醒」：之后不再收到", async () => {
    await handleUpdate(press(9302, "xn:off"));
    expect(tgSent.some((x) => x.method === "answerCallbackQuery" && String(x.params.text).includes("不再提醒"))).toBe(true);
    tgSent.length = 0;
    await runXNudges(at(30), true);
    expect(nudgesTo(9302)).toHaveLength(0);
  });

  it(`最多提醒 ${NUDGE_MAX} 次`, async () => {
    for (let d = 33; d <= 90; d += 3) await runXNudges(at(d), true);
    // 前面已经发过 3 次（第 0、3、30 天）
    expect(nudgesTo(9301)).toHaveLength(NUDGE_MAX - 3);
  });

  it("连上 X 以后不再提醒；领过赠送的老用户提醒里不提送钱", async () => {
    const D = await createUser("nudge-d@example.com");
    await bind(D, 9304);
    await runXNudges(at(100), true);
    expect(nudgesTo(9304)).toHaveLength(1);
    await connectMock(D.id, "d");
    tgSent.length = 0;
    await runXNudges(at(103), true);
    expect(nudgesTo(9304)).toHaveLength(0);

    // 断开 X 后：已经领过赠送，提醒里不再说送钱
    const { getDb, schema } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, D.id));
    await runXNudges(at(106), true);
    const t = nudgesTo(9304);
    expect(t).toHaveLength(1);
    expect(t[0]).not.toContain("USDT");
  });
});
