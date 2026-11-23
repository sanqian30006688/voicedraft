import "server-only";
import { fmtUsdt } from "./billing";
import { fmtCount } from "./follow-check-core";
import {
  estimateScan,
  exportCsv,
  listPeople,
  runScan,
  setIgnored,
  summary,
  unfollowOne,
  UNFOLLOW_DAILY_CAP,
  type PersonRow,
  type Tab,
} from "./follow-check";
import { editMessage, sendDocument, sendMessage, type Keyboard } from "./tg-api";
import { clearAwait, clip, errText, getState, sendErr, setState } from "./tg-bot-core";
import { sendConnectX } from "./tg-bot-more";

/**
 * 机器人里的「🔍 互关检测」（☰ 更多 → 🐦 X 账号 → 🔍 互关检测，或 /mutual）：
 * 扫描（先告诉预计扣多少，点确认才扫）、看「未回关」「取关了我」名单、只看蓝V、搜索、一个一个取关或忽略、导出表格。
 * 没有「全部取关」：每点一次只取关一个，每天有上限。
 */

const TABS: Record<string, Tab> = { n: "nofollow", l: "lost", i: "ignored" };
const TAB_KEY: Record<Tab, string> = { nofollow: "n", lost: "l", ignored: "i" };
const TAB_NAME: Record<Tab, string> = { nofollow: "未回关", lost: "取关了我", ignored: "已忽略" };
const PAGE = 8;

const fmtDate = (d: Date) => d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

async function homeCard(userId: string): Promise<{ text: string; buttons: Keyboard } | null> {
  const s = await summary(userId);
  if (!s.connected) return null;
  const lines = [
    "🔍 互关检测",
    "",
    "读你的「关注」和「粉丝」名单，找出你关注了但没回关你的人，以及最近取关了你的人。取关要你自己一个一个点，每天最多 " +
      `${UNFOLLOW_DAILY_CAP} 个，免得被 X 限制。`,
    "",
  ];
  if (s.needsScope) {
    lines.push("⚠️ 要先重新连接一次 X，多授权一项「读取关注和粉丝」。");
    return { text: lines.join("\n"), buttons: [[{ text: "🔑 重新连接 X", callback_data: "xc" }], [{ text: "↩️ 返回", callback_data: "hm:x" }]] };
  }
  if (s.scannedAt) {
    lines.push(`上次扫描：${fmtDate(s.scannedAt)}（关注 ${s.following} · 粉丝 ${s.followers}）`);
    lines.push(`未回关 ${s.noFollowBack} 人 · 取关了我 ${s.lost} 人`);
    lines.push(`今天还能取关 ${s.unfollowLeft} 个`);
  } else {
    lines.push("还没扫描过。点「🔄 扫描」，我先告诉你这次大约扣多少，你确认了才开始。");
  }
  const buttons: Keyboard = [[{ text: s.scannedAt ? "🔄 重新扫描" : "🔄 扫描", callback_data: "mu:s" }]];
  if (s.scannedAt) {
    buttons.push([
      { text: `🙅 未回关（${s.noFollowBack}）`, callback_data: "mu:l:n:0:0" },
      { text: `💔 取关了我（${s.lost}）`, callback_data: "mu:l:l:0:0" },
    ]);
    buttons.push([
      { text: "📄 导出表格", callback_data: "mu:x" },
      { text: `🙈 已忽略（${s.ignored}）`, callback_data: "mu:l:i:0:0" },
    ]);
  }
  buttons.push([{ text: "↩️ 返回", callback_data: "hm:x" }]);
  return { text: lines.join("\n"), buttons };
}

export async function showMutual(userId: string, chatId: string, editMid?: number) {
  const card = await homeCard(userId);
  if (!card) {
    await sendConnectX(userId, chatId, "互关检测要先连接你的 X 账号。");
    return;
  }
  if (editMid) await editMessage(chatId, editMid, card.text, card.buttons);
  else await sendMessage(chatId, card.text, { buttons: card.buttons });
}

function personLine(i: number, p: PersonRow, tab: Tab): string {
  const tags = [`粉丝 ${fmtCount(p.followers)}`];
  if (p.verifiedType) tags.push("蓝V");
  if (tab === "lost") {
    if (p.lostAt) tags.push(`${fmtDate(p.lostAt)} 发现`);
    tags.push(p.iFollow ? "你还关注着 TA" : "你没关注 TA");
  }
  return `${i}. ${clip(p.name || p.handle, 20)} @${p.handle}\n    ${tags.join(" · ")}`;
}

async function listCard(userId: string, tab: Tab, page: number, blue: boolean): Promise<{ text: string; buttons: Keyboard }> {
  const { mutualQ } = await getState(userId);
  const r = await listPeople(userId, { tab, page, size: PAGE, blueOnly: blue, q: mutualQ });
  const k = TAB_KEY[tab];
  const b = blue ? 1 : 0;
  const head = [`${tab === "nofollow" ? "🙅" : tab === "lost" ? "💔" : "🙈"} ${TAB_NAME[tab]}：${r.total} 人${blue ? "（只看蓝V）" : ""}${mutualQ ? `（搜索「${mutualQ}」）` : ""}`];
  if (r.pages > 1) head.push(`第 ${r.page + 1} / ${r.pages} 页`);
  const body = r.rows.length
    ? r.rows.map((p, i) => personLine(i + 1, p, tab))
    : [tab === "nofollow" ? "没有了，你关注的人都回关你了 👍" : tab === "lost" ? "最近没人取关你 👍" : "没有忽略的人"];
  const hint =
    tab === "ignored" ? "点「恢复」放回名单。" : "点「取关」只取关这一个人；点「忽略」以后不再出现在名单里（例如明星、官方号）。";
  const buttons: Keyboard = r.rows.map((p, i) => {
    const n = i + 1;
    const tail = `${k}:${r.page}:${b}`;
    if (tab === "ignored") return [{ text: `${n}. 恢复 @${clip(p.handle, 12)}`, callback_data: `mu:r:${p.targetId}:${tail}` }];
    const row = [];
    if (p.iFollow) row.push({ text: `${n}. 取关`, callback_data: `mu:u:${p.targetId}:${tail}` });
    row.push({ text: `${n}. 忽略`, callback_data: `mu:i:${p.targetId}:${tail}` });
    row.push({ text: `${n}. 主页`, url: `https://x.com/${p.handle}` });
    return row;
  });
  const nav = [];
  if (r.page > 0) nav.push({ text: "⬅️ 上一页", callback_data: `mu:l:${k}:${r.page - 1}:${b}` });
  if (r.page < r.pages - 1) nav.push({ text: "下一页 ➡️", callback_data: `mu:l:${k}:${r.page + 1}:${b}` });
  if (nav.length) buttons.push(nav);
  buttons.push([
    { text: blue ? "✓ 只看蓝V" : "🔵 只看蓝V", callback_data: `mu:l:${k}:0:${blue ? 0 : 1}` },
    mutualQ ? { text: "✖️ 清除搜索", callback_data: `mu:qc:${k}:${b}` } : { text: "🔎 搜索", callback_data: `mu:q:${k}:${b}` },
  ]);
  buttons.push([{ text: "↩️ 返回", callback_data: "mu:h" }]);
  return { text: [...head, "", ...body, "", hint].join("\n"), buttons };
}

async function showList(userId: string, chatId: string, tab: Tab, page: number, blue: boolean, mid?: number) {
  const c = await listCard(userId, tab, page, blue);
  if (mid) await editMessage(chatId, mid, c.text, c.buttons);
  else await sendMessage(chatId, c.text, { buttons: c.buttons });
}

/** 互关检测的按钮（整段 callback_data，以 mu: 开头）；返回给用户的提示 */
export async function handleMutualCallback(userId: string, chatId: string, data: string, mid: number): Promise<string | undefined> {
  const [, cmd, a, b, c, d] = data.split(":");
  try {
    switch (cmd) {
      case "h":
        await clearAwait(userId);
        await showMutual(userId, chatId, mid);
        return;
      case "s":
        await askScan(userId, chatId);
        return;
      case "go":
        await doScan(userId, chatId, mid);
        return;
      case "l": {
        const tab = TABS[a];
        if (!tab) return "这个按钮已经失效了";
        await showList(userId, chatId, tab, Number(b) || 0, c === "1", mid);
        return;
      }
      case "u":
      case "i":
      case "r": {
        const tab = TABS[b];
        if (!tab) return "这个按钮已经失效了";
        let note: string;
        if (cmd === "u") {
          const p = await unfollowOne(userId, a);
          note = `已取关 @${p.handle}`;
        } else {
          const ok = await setIgnored(userId, a, cmd === "i");
          if (!ok) return "名单里没有这个人了";
          note = cmd === "i" ? "已忽略，不再出现在名单里" : "已放回名单";
        }
        await showList(userId, chatId, tab, Number(c) || 0, d === "1", mid);
        return note;
      }
      case "q":
        await setState(userId, { await: { kind: "mutual_search" }, mutualTab: `${a}:${b}` });
        await sendMessage(chatId, "发给我要找的用户名或名字（一部分就行）。发 /cancel 取消。");
        return;
      case "qc": {
        const tab = TABS[a];
        await setState(userId, { mutualQ: undefined });
        if (tab) await showList(userId, chatId, tab, 0, b === "1", mid);
        return "已清除搜索";
      }
      case "x":
        await sendCsv(userId, chatId);
        return;
    }
  } catch (e) {
    // 按钮上弹一句就够了的错误（例如点太快、今天到上限了）
    const msg = errText(e);
    if (cmd === "u" || cmd === "i" || cmd === "r") return msg.slice(0, 190);
    await sendErr(chatId, e);
    return;
  }
  return "这个按钮已经失效了";
}

async function askScan(userId: string, chatId: string) {
  const e = await estimateScan(userId);
  if (e.tooBig) {
    await sendMessage(chatId, `你关注 ${e.following} 人、粉丝 ${e.followers} 人，超过了一次能扫的上限（每个名单 1.5 万人），暂时扫不了。`);
    return;
  }
  const cost = e.costMicro > 0 ? `预计扣 ${fmtUsdt(e.costMicro)} USDT（当前余额 ${fmtUsdt(e.balanceMicro)} USDT）。` : "";
  const lines = [
    "🔄 扫描一次",
    `你关注 ${e.following} 人、粉丝 ${e.followers} 人，这次要读 ${e.people} 人。${cost}`,
    "按实际读到的人数算，少读了会退回。",
  ];
  if (!e.enough) {
    lines.push("", "暂时不能扫描，请稍后再试。");
    await sendMessage(chatId, lines.join("\n"));
    return;
  }
  await sendMessage(chatId, lines.join("\n"), {
    buttons: [
      [
        { text: "✅ 开始扫描", callback_data: "mu:go" },
        { text: "取消", callback_data: "noop:cancel" },
      ],
    ],
  });
}

async function doScan(userId: string, chatId: string, mid: number) {
  if (mid) await editMessage(chatId, mid, "🔄 正在扫描，人多的话要一两分钟…");
  try {
    const r = await runScan(userId);
    const lines = [
      "✅ 扫描完成",
      `关注 ${r.following} · 粉丝 ${r.followers}`,
      `未回关 ${r.noFollowBack} 人`,
      r.first ? "这是第一次扫描，下次再扫就能看出谁取关了你。" : `取关了我 ${r.lost} 人${r.newlyLost ? `（这次新发现 ${r.newlyLost} 人）` : ""}`,
    ];
    const text = lines.join("\n");
    const buttons: Keyboard = [
      [
        { text: "🙅 看未回关", callback_data: "mu:l:n:0:0" },
        { text: "💔 看取关了我", callback_data: "mu:l:l:0:0" },
      ],
      [{ text: "📄 导出表格", callback_data: "mu:x" }],
    ];
    if (mid) await editMessage(chatId, mid, text, buttons);
    else await sendMessage(chatId, text, { buttons });
  } catch (e) {
    if (mid) await editMessage(chatId, mid, "扫描没完成，没有扣钱。");
    throw e;
  }
}

async function sendCsv(userId: string, chatId: string) {
  const csv = await exportCsv(userId);
  const day = new Date().toISOString().slice(0, 10);
  await sendDocument(chatId, new TextEncoder().encode(csv), "text/csv", `互关检测-${day}.csv`, "📄 未回关和取关了我的名单，用 Excel 或 Numbers 打开。");
}

/** 等用户发来搜索词；不是这里在等的返回 false */
export async function handleMutualAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const st = await getState(userId);
  if (st.await?.kind !== "mutual_search") return false;
  const [k, b] = (st.mutualTab ?? "n:0").split(":");
  await setState(userId, { await: undefined, mutualQ: text.trim().slice(0, 30) || undefined, mutualTab: undefined });
  await showList(userId, chatId, TABS[k] ?? "nofollow", 0, b === "1");
  return true;
}
