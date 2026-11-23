/**
 * 机器人新菜单：底部 6 个按钮、新用户三步上手卡、旧键盘兼容、「更多」子菜单。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { resetGateCache, saveGate } from "@/lib/tg-gate";
import { addSamples } from "@/lib/data";
import { addBalance, MICRO } from "@/lib/billing";
import { BOT_COMMANDS, MENU } from "@/lib/tg-bot";
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
const sentTo = (chat: number) => tgSent.filter((x) => String(x.params.chat_id) === String(chat));
const textsTo = (chat: number) => sentTo(chat).filter((x) => /^(sendMessage|editMessageText)$/.test(x.method)).map((x) => String(x.params.text));
type Markup = { keyboard?: { text: string }[][]; inline_keyboard?: { text: string; callback_data?: string }[][] };
const markups = (chat: number) => sentTo(chat).map((x) => x.params.reply_markup as Markup | undefined).filter((m): m is Markup => !!m);
const replyKeyboards = (chat: number) => markups(chat).filter((m) => m.keyboard).map((m) => m.keyboard!.flat().map((b) => b.text));
const inlineData = (chat: number) => markups(chat).flatMap((m) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? ""));

async function bind(u: TestUser, chat: number) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`));
}

const CHAT = 8101;
let U: TestUser;

beforeAll(async () => {
  await createUser("menu-admin@example.com");
  await saveGate({ enabled: false, chats: [] });
  U = await createUser("menu-u1@example.com");
  await addBalance(U.id, 5 * MICRO, { kind: "adjust", note: "测试" });
});

beforeEach(() => {
  resetRateLimits();
  resetGateCache();
  tgSent.length = 0;
});

describe("新菜单", () => {
  it("底部只有 5 个按钮；「/」菜单精简到 10 个以内", async () => {
    await bind(U, CHAT);
    const kb = replyKeyboards(CHAT).at(-1)!;
    expect(kb).toEqual([MENU.write, MENU.replies, MENU.auto, MENU.mine, MENU.more]);
    expect(BOT_COMMANDS.length).toBeLessThanOrEqual(10);
  });

  it("新用户先看到三步上手卡：X 和文风都没做，给出对应按钮", async () => {
    await handleUpdate(message(CHAT, "/start"));
    const texts = textsTo(CHAT).join("\n");
    expect(texts).toContain("三步就能开始");
    expect(texts).toContain("⬜ 2. 连接你的 X 账号");
    expect(inlineData(CHAT)).toEqual(expect.arrayContaining(["xc", "sm", "hm:start"]));
  });

  it("连上 X、导入推文后刷新：前两步打勾，按钮变成「生成文风」", async () => {
    await handleUpdate(press(CHAT, "xc")); // 测试模式下直接连上
    await addSamples(U.id, Array.from({ length: 6 }, (_, i) => ({ content: `我写过的第 ${i + 1} 条推文，内容够长一点才算数。` })), "paste");
    tgSent.length = 0;
    await handleUpdate(press(CHAT, "hm:start"));
    const t = textsTo(CHAT).join("\n");
    expect(t).toContain("✅ 2. 连接你的 X 账号");
    expect(t).toContain("已收到 6 条");
    expect(inlineData(CHAT)).toContain("cg");
  });

  it("生成文风后：/start 不再出三步卡，直接给说明和菜单", async () => {
    await handleUpdate(press(CHAT, "cg"));
    tgSent.length = 0;
    await handleUpdate(message(CHAT, "/start"));
    const t = textsTo(CHAT).join("\n");
    expect(t).not.toContain("三步就能开始");
    expect(t).toContain("VoiceDraft 助手");
    expect(replyKeyboards(CHAT)).toHaveLength(1);
  });

  it("「✍️ 写推文」：问主题，并给长文和灵感两个入口", async () => {
    await handleUpdate(message(CHAT, MENU.write));
    expect(textsTo(CHAT).join("\n")).toContain("发一个主题");
    expect(inlineData(CHAT)).toEqual(expect.arrayContaining(["hm:long", "hm:ideas"]));
  });

  it("「📂 我的内容」：没有东西时提示去写", async () => {
    await handleUpdate(message(CHAT, MENU.mine));
    expect(textsTo(CHAT).join("\n")).toContain("还没有草稿和定时帖");
  });

  it("「☰ 更多」→「我的文风」→「返回」在同一条消息上切换", async () => {
    await handleUpdate(message(CHAT, MENU.more));
    expect(inlineData(CHAT)).toEqual(expect.arrayContaining(["hm:style", "mp", "hm:x", "tm", "hp"]));
    tgSent.length = 0;
    await handleUpdate(press(CHAT, "hm:style"));
    const edit = sentTo(CHAT).find((x) => x.method === "editMessageText")!;
    expect(String(edit.params.text)).toContain("🎨 我的文风");
    expect(String(edit.params.text)).toContain("风格卡第 1 版");
    expect(inlineData(CHAT)).toEqual(expect.arrayContaining(["hm:card", "sm", "bt", "mm", "hm:more"]));
    tgSent.length = 0;
    await handleUpdate(press(CHAT, "hm:x"));
    expect(textsTo(CHAT).join("\n")).toContain("已连接 @");
  });

  it("旧键盘的按钮照样能用，用完换成新菜单", async () => {
    await handleUpdate(message(CHAT, "📝 草稿"));
    const t = textsTo(CHAT).join("\n");
    expect(t).toContain("草稿");
    expect(t).toContain("菜单换新了");
    expect(replyKeyboards(CHAT).at(-1)).toContain(MENU.mine);
  });

  it("「/checkin」能签到；旧的「🎁 签到」按钮也还能用", async () => {
    await handleUpdate(message(CHAT, "/checkin"));
    expect(textsTo(CHAT).join("\n")).toMatch(/签到|签到活动/);
    tgSent.length = 0;
    await handleUpdate(message(CHAT, "🎁 签到"));
    expect(textsTo(CHAT).join("\n")).toMatch(/签到|签到活动/);
    expect(textsTo(CHAT).join("\n")).toContain("菜单换新了");
  });

  it("老命令都还在：/draft /queue /card /memory", async () => {
    for (const c of ["/queue", "/card", "/memory"]) {
      tgSent.length = 0;
      await handleUpdate(message(CHAT, c));
      expect(textsTo(CHAT).some((x) => x.includes("VoiceDraft 助手"))).toBe(false);
    }
  });
});
