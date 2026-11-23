import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  INDUSTRIES,
  boardLines,
  industryLabel,
  isIndustry,
  reportSlot,
  statLines,
  weeklyReportText,
  type BoardSort,
} from "./benchmark-core";
import { dueReportUsers, getProfile, leaderboard, markReported, myBenchmark, updateProfile } from "./benchmark";
import { editMessage, sendMessage, type Keyboard } from "./tg-api";

/**
 * 机器人里的「📊 数据和排行」（在「☰ 更多」里）：
 * 我的数据 + 同类对比和名次、排行榜（只列自愿公开的）、改行业、公开上榜开关、周报开关。
 * 每周一北京时间 10 点推周报，最后一个按钮带回「写推文」。
 */

const BACK: Keyboard[number] = [{ text: "↩️ 返回", callback_data: "bm" }];

const PUBLIC_NOTE =
  "开启「公开上榜」后，你的 @用户名、行业、粉丝数、本周涨粉会出现在排行榜上，所有用机器人的人都能看到。随时可以关。";

async function show(chatId: string, mid: number | undefined, text: string, buttons: Keyboard) {
  if (mid) await editMessage(chatId, mid, text, buttons);
  else await sendMessage(chatId, text, { buttons });
}

/** 📊 我的数据 */
export async function showBenchmark(userId: string, chatId: string, mid?: number) {
  const b = await myBenchmark(userId);
  if (!b) {
    await show(chatId, mid, "📊 数据和排行\n先连接你的 X 账号，我每天帮你记一次粉丝、关注和发帖数，再和同类账号比一比。", [
      [{ text: "🔑 连接 X", callback_data: "xc" }],
      [{ text: "↩️ 返回", callback_data: "hm:more" }],
    ]);
    return;
  }
  const head = "📊 我的数据";
  const body = b.stat
    ? statLines({ handle: b.handle, industry: b.profile.industry, stat: b.stat, cmp: b.cmp, viaApp: b.viaApp, publicRank: b.profile.publicRank })
    : [`@${b.handle}`, "", "暂时读不到 X 上的数据，明天会自动再试。"];
  const auto = b.profile.industrySource === "auto" && b.profile.industry ? "（自动判断的，不对可以改）" : "";
  const text = [head, ...body].join("\n").replace(/(🏷 行业：[^\n]+)/, `$1${auto}`);
  await show(chatId, mid, text, [
    [
      { text: "📈 发帖效果", callback_data: "pf:e" },
      { text: "🏆 排行榜", callback_data: "bm:lb:g" },
    ],
    [{ text: "🏷 改行业", callback_data: "bm:ind" }],
    [
      { text: b.profile.publicRank ? "🙈 取消公开上榜" : "📣 公开上榜", callback_data: b.profile.publicRank ? "bm:pub:0" : "bm:pubask" },
      { text: b.profile.weeklyReport ? "🔕 关掉周报" : "🔔 打开周报", callback_data: b.profile.weeklyReport ? "bm:wr:0" : "bm:wr:1" },
    ],
    [{ text: "↩️ 返回", callback_data: "hm:more" }],
  ]);
}

/** 🏆 排行榜。sort: g 按本周涨粉 / f 按粉丝；带 i 表示只看我这一行 */
async function showBoard(userId: string, chatId: string, mid: number, mode: string) {
  const sort: BoardSort = mode.startsWith("f") ? "followers" : "growth";
  const mine = mode.endsWith("i");
  const profile = await getProfile(userId);
  const industry = mine ? profile.industry : null;
  const entries = await leaderboard(userId, industry);
  const scope = industry ? industryLabel(industry) : "全部行业";
  const lines = boardLines(entries, sort, scope);
  if (!profile.publicRank) lines.push("", PUBLIC_NOTE);
  const s = sort === "growth" ? "g" : "f";
  const rows: Keyboard = [
    [
      { text: sort === "growth" ? "• 按涨粉" : "按涨粉", callback_data: `bm:lb:g${mine ? "i" : ""}` },
      { text: sort === "followers" ? "• 按粉丝" : "按粉丝", callback_data: `bm:lb:f${mine ? "i" : ""}` },
    ],
  ];
  if (profile.industry) {
    rows.push([{ text: mine ? "看全部行业" : `只看${industryLabel(profile.industry)}`, callback_data: `bm:lb:${s}${mine ? "" : "i"}` }]);
  }
  if (!profile.publicRank) rows.push([{ text: "📣 公开上榜", callback_data: "bm:pubask" }]);
  rows.push(BACK);
  await editMessage(chatId, mid, lines.join("\n"), rows);
}

async function showIndustryPicker(userId: string, chatId: string, mid: number) {
  const p = await getProfile(userId);
  const rows: Keyboard = [];
  for (let i = 0; i < INDUSTRIES.length; i += 2) {
    rows.push(
      INDUSTRIES.slice(i, i + 2).map((ind) => ({ text: `${p.industry === ind.code ? "✓ " : ""}${ind.label}`, callback_data: `bm:set:${ind.code}` })),
    );
  }
  rows.push(BACK);
  await editMessage(chatId, mid, `🏷 你的账号属于哪一行？\n现在是：${industryLabel(p.industry)}\n同类对比和排行榜按这个分组。`, rows);
}

/** bm:xxx 按钮；不是这里的返回 null */
export async function handleBenchCallback(userId: string, chatId: string, action: string, a: string, b: string, mid: number): Promise<string | undefined | null> {
  if (action !== "bm") return null;
  switch (a) {
    case undefined:
    case "":
      await showBenchmark(userId, chatId, mid);
      return;
    case "lb":
      await showBoard(userId, chatId, mid, b || "g");
      return;
    case "ind":
      await showIndustryPicker(userId, chatId, mid);
      return;
    case "set":
      if (!isIndustry(b)) return "没有这个行业";
      await updateProfile(userId, { industry: b });
      await showBenchmark(userId, chatId, mid);
      return `已改成「${industryLabel(b)}」`;
    case "pubask":
      await editMessage(chatId, mid, `📣 公开上榜\n\n${PUBLIC_NOTE}\n\n不公开也照样能看同类对比和自己的名次，只是别人看不到你是谁。`, [
        [
          { text: "✅ 确定公开", callback_data: "bm:pub:1" },
          { text: "先不了", callback_data: "bm" },
        ],
      ]);
      return;
    case "pub":
      await updateProfile(userId, { publicRank: b === "1" });
      await showBenchmark(userId, chatId, mid);
      return b === "1" ? "已公开上榜" : "已取消公开，排行榜上不再显示你";
    case "wr":
      await updateProfile(userId, { weeklyReport: b === "1" });
      if (mid) await showBenchmark(userId, chatId, mid);
      return b === "1" ? "每周一会收到周报" : "以后不再推送周报";
  }
  return "这个按钮已经失效了";
}

// ---------- 每周周报 ----------

/** 发送时刻过去超过这么久就不补发了（例如刚上线时不会在周五补发上周一的周报） */
const LATE_MS = 12 * 3600_000;

/** 每周一北京时间 10 点后：给该收周报的人各发一份。数据还不够（不满 1 天）的这周跳过 */
export async function sendWeeklyReports(now = new Date(), max = 20): Promise<number> {
  const slot = reportSlot(now);
  if (now.getTime() - slot.getTime() > LATE_MS) return 0;
  const db = await getDb();
  let sent = 0;
  for (const userId of await dueReportUsers(slot, max)) {
    // 先记下已发，出错也不会每 30 秒重发
    await markReported(userId, now);
    try {
      const b = await myBenchmark(userId, now, false);
      if (!b?.stat || b.stat.weeklyGrowth === null) continue;
      const [bind] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
      if (!bind?.chatId) continue;
      const text = weeklyReportText({ handle: b.handle, industry: b.profile.industry, stat: b.stat, cmp: b.cmp, viaApp: b.viaApp, publicRank: b.profile.publicRank });
      await sendMessage(bind.chatId, text, {
        buttons: [
          [{ text: "✍️ 帮我写一条", callback_data: "bm:write" }],
          [
            { text: "🏆 排行榜", callback_data: "bm:lb:g" },
            { text: "🔕 不要周报", callback_data: "bm:wr:0" },
          ],
        ],
      });
      sent++;
    } catch (e) {
      console.error("[benchmark] 发周报失败", e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
