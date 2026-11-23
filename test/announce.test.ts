/**
 * 功能更新和公告：更新记录上线后自动起草、管理员在 TG 里审核群发；手动公告；
 * 只在用户当地白天送达（紧急除外）、可以不再接收、停用机器人的不重试、碰到限速停下。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import {
  createManual,
  deliverBatch,
  getAnnouncement,
  listAnnouncements,
  resetAnnounceTimers,
  runAnnouncements,
  saveAnnounceConfig,
  startSending,
  syncChangelog,
} from "@/lib/announce";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as annRoute from "@/app/api/admin/announcements/route";
import * as annIdRoute from "@/app/api/admin/announcements/[id]/route";
import { body, createUser, ctx, json, loginAs, tgSent, type TestUser } from "./helpers";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";

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
    callback_query: { id: String(seq), data, from: { id: chat }, message: { message_id: 1, chat: { id: chat, type: "private" } } },
  } as unknown as TgUpdate;
}
async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

const fails = new Map<string, { status: number; description: string }>();
(globalThis as { __tgFail?: typeof fails }).__tgFail = fails;

const msgs = (chat: number) => tgSent.filter((x) => x.method === "sendMessage" && String(x.params.chat_id) === String(chat));
const annTo = (chat: number) => msgs(chat).filter((x) => JSON.stringify(x.params.reply_markup ?? "").includes("an:off")).map((x) => String(x.params.text));
const kb = (x: { params: Record<string, unknown> }) => JSON.stringify(x.params.reply_markup ?? "");

// 今天北京时间中午 12 点 / 凌晨 2 点（离开始发送不到 3 天，不会被当成过期）
const today = new Date();
const NOON = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 4));
const NIGHT = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 18));

const ADMIN_CHAT = 9500;
let ADMIN: TestUser, A: TestUser, B: TestUser, C: TestUser;
beforeAll(async () => {
  ADMIN = await createUser("ann-admin@example.com");
  await saveGate({ enabled: false, chats: [] });
  A = await createUser("ann-a@example.com");
  B = await createUser("ann-b@example.com");
  C = await createUser("ann-c@example.com");
  await bind(ADMIN, ADMIN_CHAT);
  await bind(A, 9501);
  await bind(B, 9502);
  await bind(C, 9503);
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  resetAnnounceTimers();
  fails.clear();
  tgSent.length = 0;
});

const entry = (id: string, title: string) => ({ id, date: "2026-11-14", title, text: `${title}的说明` });

describe("上线后自动起草", () => {
  let annId = "";

  it("新的更新记录：合成一条草稿发给管理员审核，用户先不收", async () => {
    const ann = await syncChangelog([entry("t-1", "功能一"), entry("t-2", "功能二")]);
    expect(ann?.status).toBe("draft");
    expect(ann?.body).toContain("📢 功能更新");
    expect(ann?.body).toContain("🆕 功能一");
    annId = ann!.id;
    const card = msgs(ADMIN_CHAT).at(-1)!;
    expect(String(card.params.text)).toContain("要发给 4 位用户吗");
    expect(kb(card)).toContain(`an:go:${annId}`);
    expect(kb(card)).toContain(`an:ed:${annId}`);
    expect(annTo(9501)).toHaveLength(0);
  });

  it("同样的记录不再起草；又上线新的：并进同一条草稿", async () => {
    expect(await syncChangelog([entry("t-1", "功能一"), entry("t-2", "功能二")])).toBeNull();
    const ann = await syncChangelog([entry("t-1", "功能一"), entry("t-2", "功能二"), entry("t-3", "功能三")]);
    expect(ann?.id).toBe(annId);
    expect(ann?.body).toContain("🆕 功能二");
    expect(ann?.body).toContain("🆕 功能三");
    expect(ann?.entryIds).toEqual(["t-1", "t-2", "t-3"]);
  });

  it("普通用户点不了审核按钮", async () => {
    await handleUpdate(press(9501, `an:go:${annId}`));
    expect((await getAnnouncement(annId))?.status).toBe("draft");
  });

  it("管理员在 TG 里改文字", async () => {
    await handleUpdate(press(ADMIN_CHAT, `an:ed:${annId}`));
    await handleUpdate(message(ADMIN_CHAT, "📢 功能更新\n\n改过的文字"));
    expect((await getAnnouncement(annId))?.body).toBe("📢 功能更新\n\n改过的文字");
    expect(String(msgs(ADMIN_CHAT).at(-1)!.params.text)).toContain("改过的文字");
  });

  it("管理员点「发给所有用户」：白天每人收到一条，带「不再接收」；发完告诉管理员", async () => {
    await handleUpdate(press(ADMIN_CHAT, `an:go:${annId}`));
    expect((await getAnnouncement(annId))?.status).toBe("sending");
    tgSent.length = 0;
    expect(await deliverBatch(NOON, { gapMs: 0 })).toBe(4);
    for (const c of [9501, 9502, 9503]) {
      expect(annTo(c)).toHaveLength(1);
      expect(annTo(c)[0]).toContain("改过的文字");
      expect(annTo(c)[0]).toContain("不再接收");
    }
    expect((await getAnnouncement(annId))?.status).toBe("sent");
    expect(msgs(ADMIN_CHAT).some((m) => String(m.params.text).includes("公告发完了：送达 4 人"))).toBe(true);
    // 不会重复发
    tgSent.length = 0;
    expect(await deliverBatch(NOON, { gapMs: 0 })).toBe(0);
    expect(annTo(9501)).toHaveLength(0);
  });
});

describe("手动公告", () => {
  it("半夜不发，到白天再发；紧急的马上发", async () => {
    const a = await startSending((await createManual(ADMIN.id, "服务器维护")).id);
    expect(a.body.startsWith("📢 平台公告")).toBe(true);
    expect(await deliverBatch(NIGHT, { gapMs: 0 })).toBe(0);
    expect((await getAnnouncement(a.id))?.status).toBe("sending");
    expect(await deliverBatch(NOON, { gapMs: 0 })).toBe(4);
    expect((await getAnnouncement(a.id))?.status).toBe("sent");

    tgSent.length = 0;
    const u = await startSending((await createManual(ADMIN.id, "紧急：暂停发帖")).id, true);
    expect(await deliverBatch(NIGHT, { gapMs: 0 })).toBe(4);
    expect(annTo(9502)[0]).toContain("紧急：暂停发帖");
    expect((await getAnnouncement(u.id))?.status).toBe("sent");
  });

  it("点「不再接收」以后不再收到；「☰ 更多 → 🔔 更新通知」能再打开", async () => {
    await handleUpdate(press(9501, "an:off"));
    await startSending((await createManual(ADMIN.id, "第三条")).id, true);
    await deliverBatch(NOON, { gapMs: 0 });
    expect(annTo(9501)).toHaveLength(0);
    expect(annTo(9502)).toHaveLength(1);

    await handleUpdate(press(9501, "an:menu"));
    expect(kb(tgSent.at(-2) ?? tgSent.at(-1)!) + kb(tgSent.at(-1)!)).toContain("an:on");
    await handleUpdate(press(9501, "an:on"));
    tgSent.length = 0;
    await startSending((await createManual(ADMIN.id, "第四条")).id, true);
    await deliverBatch(NOON, { gapMs: 0 });
    expect(annTo(9501)).toHaveLength(1);
  });

  it("停用了机器人的记为 blocked、不重试；碰到限速这一轮停下，下一轮接着发", async () => {
    fails.set("9502", { status: 403, description: "Forbidden: bot was blocked by the user" });
    fails.set("9503", { status: 429, description: "Too Many Requests: retry after 5" });
    const a = await startSending((await createManual(ADMIN.id, "第五条")).id, true);
    await deliverBatch(NOON, { gapMs: 0 });
    expect((await getAnnouncement(a.id))?.status).toBe("sending");
    // 还在限速暂停期内：什么都不发
    fails.delete("9503");
    expect(await deliverBatch(new Date(NOON.getTime() + 2000), { gapMs: 0 })).toBe(0);
    expect(await deliverBatch(new Date(NOON.getTime() + 6000), { gapMs: 0 })).toBeGreaterThan(0);
    const [item] = (await listAnnouncements(1)).filter((x) => x.id === a.id);
    expect(item.status).toBe("sent");
    expect(item.stats).toEqual({ sent: 3, blocked: 1, failed: 0 });
  });

  it("管理员在机器人里 /notice 写公告：先给预览卡片；普通用户 /notice 不起作用", async () => {
    const before = (await listAnnouncements(50)).length;
    await handleUpdate(message(9501, "/notice 我也想发"));
    expect((await listAnnouncements(50)).length).toBe(before);

    await handleUpdate(message(ADMIN_CHAT, "/notice"));
    await handleUpdate(message(ADMIN_CHAT, "下周一上线新功能"));
    const [ann] = await listAnnouncements(1);
    expect(ann.status).toBe("draft");
    expect(ann.body).toContain("下周一上线新功能");
    const card = msgs(ADMIN_CHAT).at(-1)!;
    expect(kb(card)).toContain(`an:go:${ann.id}`);
    await handleUpdate(press(ADMIN_CHAT, `an:x:${ann.id}`));
    expect((await getAnnouncement(ann.id))?.status).toBe("cancelled");
  });
});

describe("自动模式和关闭", () => {
  it("关闭：上线新记录不起草", async () => {
    await saveAnnounceConfig({ mode: "off" });
    expect(await syncChangelog([entry("t-off", "关着的时候")])).toBeNull();
  });

  it("自动：等够设定的分钟数后自动开始发", async () => {
    await saveAnnounceConfig({ mode: "auto", delayMin: 0 });
    const ann = await syncChangelog([entry("t-auto", "自动的功能")]);
    expect(String(msgs(ADMIN_CHAT).at(-1)!.params.text)).toContain("分钟后自动发给");
    const db = await getDb();
    await db.update(schema.announcements).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(schema.announcements.id, ann!.id));
    await runAnnouncements(new Date(Date.now() + 60_000), true);
    expect((await getAnnouncement(ann!.id))?.status).not.toBe("draft");
    await saveAnnounceConfig({ mode: "review", delayMin: 30 });
  });
});

describe("网页后台接口", () => {
  it("只有管理员能用", async () => {
    loginAs(A);
    expect((await annRoute.GET()).status).toBe(403);
    expect((await annRoute.POST(json({ body: "x", send: true }))).status).toBe(403);
  });

  it("管理员：看列表、存草稿、改文字、发给自己看看、发送", async () => {
    loginAs(ADMIN);
    const list = await body(await annRoute.GET());
    expect(list.recipients).toBe(4);
    const created = await body(await annRoute.POST(json({ body: "网页写的公告" })));
    const id = (created.announcement as { id: string }).id;
    expect((await annIdRoute.PATCH(json({ body: "📢 改过" }, undefined, "PATCH"), ctx(id))).status).toBe(200);
    tgSent.length = 0;
    expect((await annIdRoute.POST(json({ action: "test" }), ctx(id))).status).toBe(200);
    expect(annTo(ADMIN_CHAT)[0]).toContain("📢 改过");
    expect((await annIdRoute.POST(json({ action: "send" }), ctx(id))).status).toBe(200);
    expect((await annIdRoute.POST(json({ action: "send" }), ctx(id))).status).toBe(400);
    expect((await annRoute.POST(json({ body: "   " }))).status).toBe(400);
  });
});
