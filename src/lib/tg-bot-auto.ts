import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  gapLabel,
  hoursLabel,
  parseHours,
  GAP_MAX,
  limitsFor,
  approveAuto,
  backfillSourceImages,
  editAuto,
  getSettings,
  listAuto,
  MODE_LABEL,
  rewriteAuto,
  reviewButtons,
  reviewText,
  saveSettings,
  skipAuto,
} from "./autopilot";
import { addAnySource, classifyInput, SOURCE_LABEL } from "./sources";
import { editButtons, editMessage, sendMessage, type Keyboard } from "./tg-api";
import { clearAwait, clip, errButtons, errText, fmtTime, getState, setState, tweetUrl } from "./tg-bot-core";
import { removeSource } from "./tg-feed";
import { getAccount } from "./x";

/**
 * 机器人里的「自动发帖」：开关、模式、每天上限、信息源，以及等确认的自动帖（排期 / 立即发 / 改 / 重写 / 跳过）。
 */

/** 每天条数、间隔（最短-最长分钟）的快捷按钮：平台方自己的账号和客户不一样 */
const PRESETS = {
  owner: { caps: [20, 50, 100, 200], gaps: [[1, 10], [5, 15], [30, 90]] as [number, number][] },
  customer: { caps: [5, 10, 20, 50], gaps: [[10, 30], [30, 90], [60, 180]] as [number, number][] },
};

/** 「1-10」「5」「3～8」→ 最短、最长分钟数 */
export function parseGap(input: string): [number, number] | null {
  const m = input.replace(/分钟?|min/gi, "").trim().match(/^(\d{1,4})\s*(?:[-~～到至—–]\s*(\d{1,4}))?$/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (lo < 1 || hi > GAP_MAX) return null;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

export async function showAuto(userId: string, chatId: string, mid?: number) {
  const s = await getSettings(userId);
  const lim = await limitsFor(userId);
  const preset = lim.owner ? PRESETS.owner : PRESETS.customer;
  const db = await getDb();
  const srcs = await db.select().from(schema.sources).where(eq(schema.sources.userId, userId));
  const pending = (await listAuto(userId, 50)).filter((r) => r.status === "review").length;
  const text =
    `🤖 自动发：${s.enabled ? "已开启 ✅" : "已暂停 ⏸"}\n\n` +
    `模式：${MODE_LABEL[s.mode as "review" | "auto"] ?? s.mode}\n` +
    `每天最多：${s.dailyCap} 条，两条间隔 ${gapLabel(s)}\n` +
    `发帖时段：${hoursLabel(s)}（${s.tz}）\n` +
    `只用 ${s.maxAgeHours < 24 ? `${s.maxAgeHours} 小时` : `${s.maxAgeHours / 24} 天`}内发布的内容，同一个源每天最多 ${s.perSourceDaily} 条，最新的先写\n` +
    `信息源：${srcs.length} 个（开着自动发的 ${srcs.filter((x) => x.autopilot).length} 个）\n` +
    (pending ? `等你确认：${pending} 条\n` : "") +
    "\n信息源里有新内容时，我按你的文风写成推文；和原文重合太多的不发（X 用户的推文上限 50%，其他 67%）。每条从余额扣，没写成的退回。";
  const buttons: Keyboard = [
    [
      { text: s.enabled ? "⏸ 暂停" : "▶️ 开启", callback_data: `aut:${s.enabled ? 0 : 1}` },
      { text: s.mode === "auto" ? "改成先确认" : "改成全自动", callback_data: `aum:${s.mode === "auto" ? "review" : "auto"}` },
    ],
    preset.caps.map((n) => ({ text: n === s.dailyCap ? `· ${n} 条 ·` : `${n} 条/天`, callback_data: `auc:${n}` })),
    preset.gaps.map(([lo, hi]) => {
      const on = s.minGapMin === lo && s.maxGapMin === hi;
      return { text: on ? `· 隔 ${lo}–${hi} 分 ·` : `隔 ${lo}–${hi} 分`, callback_data: `aug:${lo}:${hi}` };
    }),
    [
      { text: "✏️ 自己填每天条数", callback_data: "auv:cap" },
      { text: "✏️ 自己填间隔", callback_data: "auv:gap" },
    ],
    [{ text: `🕘 发帖时段：${hoursLabel(s)}（点这里改）`, callback_data: "auv:hours" }],
    [{ text: `📊 同一个信息源每天最多：${s.perSourceDaily} 条（点这里改）`, callback_data: "auv:per" }],
    [
      { text: "➕ 加信息源", callback_data: "aus" },
      { text: "📋 信息源", callback_data: "aul" },
    ],
    [
      { text: pending ? `🗂 待确认（${pending}）` : "🗂 最近的自动帖", callback_data: "aq" },
      { text: s.attachLink ? "附原文链接：开" : "附原文链接：关", callback_data: `auk:${s.attachLink ? 0 : 1}` },
    ],
    [{ text: s.longForm ? "📏 长原文写长（不压缩）：开" : "📏 长原文写长（不压缩）：关", callback_data: `auw:${s.longForm ? 0 : 1}` }],
    [{ text: s.linkReply ? "💬 链接放评论区：开" : "💬 链接放评论区：关", callback_data: `auy:${s.linkReply ? 0 : 1}` }],
    [{ text: "📅 已排好的定时帖：暂停 / 延后 / 删除", callback_data: "qb:m" }],
    [{ text: "🖼 给已排好的帖子换上原图", callback_data: "aubf" }],
    [{ text: s.withImage ? "🖼 自动配图（原图优先，没有就信息卡）：开" : "🖼 自动配图（原图优先，没有就信息卡）：关", callback_data: `aui:${s.withImage ? 0 : 1}` }],
    [
      { text: "📡 订阅的 TG 频道", callback_data: "chs" },
      { text: "🔥 热点提醒", callback_data: "ht:m" },
    ],
  ];
  if (mid) await editMessage(chatId, mid, text, buttons);
  else await sendMessage(chatId, text, { buttons });
}

async function askSource(userId: string, chatId: string) {
  await setState(userId, { await: { kind: "autosrc" } });
  await sendMessage(
    chatId,
    "把信息源发给我（一次一个）：\n" +
      "• 网站、新闻栏目、论坛版块的网址（有 RSS 会自动用 RSS）\n" +
      "• 单篇文章的网址\n" +
      "• X 用户主页：x.com/用户名 或 @用户名（读推文按条扣费）\n" +
      "• 公开 TG 频道：t.me/频道名\n" +
      "• TG 群：把我拉进群并设为管理员，会自动加进来\n\n" +
      "只读公开内容，网站在 robots.txt 里不让程序读的不读。发 /cancel 取消。",
  );
}

async function addFromText(userId: string, chatId: string, text: string) {
  const c = classifyInput(text);
  if (c?.kind === "url") {
    await clearAwait(userId);
    await setState(userId, { pendingSrc: c.url });
    await sendMessage(chatId, `${c.url}\n\n这个网址要怎么用？`, {
      buttons: [
        [
          { text: "📡 订阅：定时看新文章", callback_data: "auf:follow" },
          { text: "📄 只用这一篇", callback_data: "auf:once" },
        ],
      ],
    });
    return;
  }
  await clearAwait(userId);
  await doAdd(userId, chatId, text, "follow");
}

async function doAdd(userId: string, chatId: string, input: string, mode: "follow" | "once") {
  const wait = await sendMessage(chatId, "正在读取…");
  try {
    const r = await addAnySource(userId, input, mode);
    await editMessage(
      chatId,
      wait.message_id,
      `已加入信息源 ✓\n${SOURCE_LABEL[r.type] ?? r.type}：${r.title}\n这次先收进 ${r.added} 条到灵感（其中最近 ${(await getSettings(userId)).maxAgeHours} 小时内发布的会拿去自动发，更早的只放在灵感里）。`,
      [[{ text: "🤖 自动发帖设置", callback_data: "au" }]],
    );
  } catch (e) {
    await editMessage(chatId, wait.message_id, `没加上：${errText(e)}`, [[{ text: "再试一个", callback_data: "aus" }]]);
  }
}

async function listSourcesMsg(userId: string, chatId: string) {
  const db = await getDb();
  const rows = await db.select().from(schema.sources).where(eq(schema.sources.userId, userId)).orderBy(desc(schema.sources.createdAt)).limit(20);
  if (!rows.length) {
    await sendMessage(chatId, "还没有信息源。", { buttons: [[{ text: "➕ 加信息源", callback_data: "aus" }]] });
    return;
  }
  for (const s of rows) {
    await sendMessage(
      chatId,
      `${SOURCE_LABEL[s.type] ?? s.type}：${s.title ?? s.handle}\n` +
        `${s.autopilot ? "新内容会自动发帖" : "只收进灵感，不自动发"}` +
        (s.lastFetchedAt ? `\n上次检查：${fmtTime(s.lastFetchedAt)}` : "") +
        (s.error ? `\n⚠️ ${s.error}` : ""),
      {
        buttons: [
          [
            { text: s.autopilot ? "不自动发" : "自动发", callback_data: `aup:${s.id}:${s.autopilot ? 0 : 1}` },
            { text: "🗑 删除", callback_data: `aud:${s.id}` },
          ],
        ],
      },
    );
  }
}

async function showQueue(userId: string, chatId: string) {
  const rows = await listAuto(userId, 10);
  const pending = rows.filter((r) => r.status === "review");
  if (pending.length) {
    for (const r of pending.slice(0, 5)) {
      await sendMessage(chatId, reviewText(r, r.sourceText ? { title: r.sourceTitle, text: r.sourceText, url: r.sourceUrl } : null), {
        buttons: reviewButtons(r.id),
      });
    }
    return;
  }
  if (!rows.length) {
    await sendMessage(chatId, "还没有自动帖。开启自动发帖、加好信息源后，有新内容时我会写。");
    return;
  }
  const label = (r: (typeof rows)[number]) =>
    r.postStatus === "published"
      ? "已发出"
      : r.postStatus === "scheduled"
        ? `定时 ${r.scheduledAt ? fmtTime(r.scheduledAt) : ""}`
        : r.postStatus === "failed"
          ? "发布失败"
          : r.status === "skipped"
            ? `没发：${r.note ?? ""}`
            : r.status;
  await sendMessage(
    chatId,
    "最近的自动帖：\n\n" + rows.map((r, i) => `${i + 1}. [${label(r)}] ${clip((r.text || r.sourceText || "").replace(/\s+/g, " "), 60)}`).join("\n"),
  );
}

/** 正在等的输入；返回 true 表示已处理 */
export async function handleAutoAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const { await: waiting } = await getState(userId);
  if (waiting?.kind === "autosrc") {
    await addFromText(userId, chatId, text);
    return true;
  }
  if (waiting?.kind === "autoset") {
    const lim = await limitsFor(userId);
    if (waiting.field === "cap" || waiting.field === "per") {
      const n = Number(text.trim().replace(/条.*$/, ""));
      if (!Number.isInteger(n) || n < 1 || n > lim.capMax) {
        await sendMessage(chatId, `请发 1 到 ${lim.capMax} 之间的整数。发 /cancel 取消。`);
        return true;
      }
      await clearAwait(userId);
      await saveSettings(userId, waiting.field === "cap" ? { dailyCap: n } : { perSourceDaily: n });
    } else if (waiting.field === "hours") {
      const h = parseHours(text);
      if (!h) {
        await sendMessage(chatId, "没看懂。发「9-23」表示 9 点到 23 点发，发「全天」表示 24 小时都发。发 /cancel 取消。");
        return true;
      }
      await clearAwait(userId);
      await saveSettings(userId, { startHour: h[0], endHour: h[1] });
    } else {
      const g = parseGap(text);
      if (!g || g[0] < lim.gapMin) {
        await sendMessage(
          chatId,
          g
            ? `间隔最短 ${lim.gapMin} 分钟，请再发一次。发 /cancel 取消。`
            : `没看懂。发「${lim.gapMin}-${lim.gapMin * 3}」表示每条之间在这个范围里随机隔几分钟，发一个数字表示固定间隔。发 /cancel 取消。`,
        );
        return true;
      }
      await clearAwait(userId);
      await saveSettings(userId, { minGapMin: g[0], maxGapMin: g[1] });
    }
    await showAuto(userId, chatId);
    return true;
  }
  if (waiting?.kind === "autoedit") {
    await clearAwait(userId);
    try {
      const r = await editAuto(userId, waiting.autoId, text);
      await sendMessage(chatId, `改好了（和原文重合 ${r.similarity ?? 0}%）：\n\n${r.text}`, { buttons: reviewButtons(r.id) });
    } catch (e) {
      await sendMessage(chatId, errText(e), { buttons: [...errButtons(e), ...reviewButtons(waiting.autoId)] });
    }
    return true;
  }
  return false;
}

/** 按钮；返回 null 表示不是这里的按钮 */
export async function handleAutoCallback(userId: string, chatId: string, action: string, a: string, b: string, mid: number): Promise<string | undefined | null> {
  switch (action) {
    case "au":
      await showAuto(userId, chatId);
      return;
    case "aut":
      if (a === "1") {
        const db = await getDb();
        const [x] = await db.select({ id: schema.xAccounts.id }).from(schema.xAccounts).where(eq(schema.xAccounts.userId, userId)).limit(1);
        if (!x) return "请先连接 X 账号（⚙️ 更多 → 连接 X）";
      }
      await saveSettings(userId, { enabled: a === "1" });
      await showAuto(userId, chatId, mid);
      return a === "1" ? "已开启" : "已暂停";
    case "aum":
      await saveSettings(userId, { mode: a === "auto" ? "auto" : "review" });
      await showAuto(userId, chatId, mid);
      return a === "auto" ? "改成全自动了：写好直接排进定时" : "改成先确认了：写好推给你，点了才发";
    case "auc":
      await saveSettings(userId, { dailyCap: Number(a) || 5 });
      await showAuto(userId, chatId, mid);
      return;
    case "aug":
      await saveSettings(userId, { minGapMin: Number(a) || 1, maxGapMin: Number(b) || 0 });
      await showAuto(userId, chatId, mid);
      return `每条之间随机隔 ${a}–${b} 分钟`;
    case "auv": {
      const lim = await limitsFor(userId);
      const field = a === "gap" ? "gap" : a === "per" ? "per" : a === "hours" ? "hours" : "cap";
      await setState(userId, { await: { kind: "autoset", field } });
      await sendMessage(
        chatId,
        field === "hours"
          ? `每天几点到几点可以发？按 ${(await getSettings(userId)).tz} 时间。\n发「9-23」表示 9 点到 23 点发，发「22-6」表示晚上 10 点到早上 6 点发，发「全天」表示 24 小时都发。发 /cancel 取消。`
          : field === "per"
          ? `同一个信息源（比如一个 X 主页）每天最多拿几条来写？发一个数字（最多 ${lim.capMax}）。信息源少、想发得多就调大。发 /cancel 取消。`
          : a === "gap"
          ? `两条之间隔几分钟？发「${lim.gapMin}-${lim.gapMin * 10}」表示每次在这个范围里随机，发一个数字表示固定间隔（最短 ${lim.gapMin} 分钟）。发 /cancel 取消。`
          : `每天最多发几条？发一个数字（最多 ${lim.capMax}）。发 /cancel 取消。`,
      );
      return;
    }
    case "auk":
      await saveSettings(userId, { attachLink: a === "1" });
      await showAuto(userId, chatId, mid);
      return a === "1" ? "会附上原文链接（按带链接的帖子计费）" : "不附原文链接";
    case "auw": {
      await saveSettings(userId, { longForm: a === "1" });
      await showAuto(userId, chatId, mid);
      if (a !== "1") return "长原文也只写一条（最多约 135 个汉字）";
      const acc = await getAccount(userId);
      return acc?.premium
        ? "长原文会写成一条长推（你的 X 是会员，可以发长推）"
        : "长原文会写成串推，把要点讲完（你的 X 不是会员，一条最多 280 字；开通会员后会自动改成一条长推）";
    }
    case "auy":
      await saveSettings(userId, { linkReply: a === "1" });
      await showAuto(userId, chatId, mid);
      return a === "1"
        ? "原文里有链接（教程、文章）时，正文不放链接，发出后在评论区回复一条带链接的（那一条按带链接的帖子计费）"
        : "不在评论区放链接了";
    case "aui":
      await saveSettings(userId, { withImage: a === "1" });
      await showAuto(userId, chatId, mid);
      return a === "1" ? "会给每条配图：原帖有能用的图（截图、图表、产品图等）就用原图，没有就做一张信息卡（每张另计费）" : "不配图了";
    case "aus":
      await askSource(userId, chatId);
      return;
    case "auf": {
      const { pendingSrc } = await getState(userId);
      if (!pendingSrc) return "这个网址已经过期了，请重新发";
      await editButtons(chatId, mid, []);
      await setState(userId, { pendingSrc: undefined });
      await doAdd(userId, chatId, pendingSrc, a === "once" ? "once" : "follow");
      return;
    }
    case "aul":
      await listSourcesMsg(userId, chatId);
      return;
    case "aup": {
      const db = await getDb();
      await db
        .update(schema.sources)
        .set({ autopilot: b === "1" })
        .where(and(eq(schema.sources.id, a), eq(schema.sources.userId, userId)));
      await editButtons(chatId, mid, [
        [
          { text: b === "1" ? "不自动发" : "自动发", callback_data: `aup:${a}:${b === "1" ? 0 : 1}` },
          { text: "🗑 删除", callback_data: `aud:${a}` },
        ],
      ]);
      return b === "1" ? "这个源的新内容会自动发帖" : "这个源只收进灵感";
    }
    case "aud":
      await removeSource(userId, a, true);
      await editButtons(chatId, mid, [[{ text: "已删除", callback_data: "noop" }]]);
      return;
    case "aubf": {
      await sendMessage(chatId, "正在去原帖找图，找到能用的就换上（截图、图表、产品图这类；摄影、手绘、人物照片不用）…");
      try {
        const r = await backfillSourceImages(userId);
        const lines = [
          `✅ 换上原图：${r.used} 条`,
          r.unsuitable ? `原图不适合转用（保持原样）：${r.unsuitable} 条` : "",
          r.noImage ? `原帖没有图（保持原样）：${r.noImage} 条` : "",
          r.left ? `还有 ${r.left} 条没处理${r.stopped ? `（${r.stopped}）` : ""}，过一会儿再点一次` : "",
        ].filter(Boolean);
        await sendMessage(chatId, lines.join("\n"));
      } catch (e) {
        await sendMessage(chatId, `没换成：${errText(e)}`);
      }
      return;
    }
    case "aq":
      await showQueue(userId, chatId);
      return;
    case "aa":
    case "an":
      try {
        await editButtons(chatId, mid, [[{ text: "处理中…", callback_data: "noop" }]]);
        const { job } = await approveAuto(userId, a, { now: action === "an" });
        if (job.status === "published") {
          await editButtons(chatId, mid, [[{ text: "已发出 ✓", callback_data: "noop" }]]);
          await sendMessage(chatId, `已发布 ✓\n${tweetUrl(job.handle, job.postIds[0])}`);
        } else if (job.status === "scheduled") {
          await editButtons(chatId, mid, [[{ text: `已排进定时：${job.scheduledAt ? fmtTime(job.scheduledAt) : ""}`, callback_data: "noop" }]]);
        } else {
          await editButtons(chatId, mid, reviewButtons(a));
          await sendMessage(chatId, `没发出去：${job.error ?? "未知原因"}`, { buttons: errButtons(new Error(job.error ?? "")) });
        }
      } catch (e) {
        await editButtons(chatId, mid, reviewButtons(a));
        return errText(e);
      }
      return;
    case "ae":
      await setState(userId, { await: { kind: "autoedit", autoId: a } });
      await sendMessage(chatId, "把改好的推文发给我（整条发）。发 /cancel 取消。");
      return;
    case "ar":
      try {
        await editButtons(chatId, mid, [[{ text: "重写中…", callback_data: "noop" }]]);
        const r = await rewriteAuto(userId, a);
        await editButtons(chatId, mid, []);
        await sendMessage(chatId, `换了个写法（和原文重合 ${r.similarity ?? 0}%）：\n\n${r.text}`, { buttons: reviewButtons(r.id) });
      } catch (e) {
        await editButtons(chatId, mid, reviewButtons(a));
        return errText(e);
      }
      return;
    case "ax":
      try {
        await skipAuto(userId, a);
        await editButtons(chatId, mid, [[{ text: "已跳过", callback_data: "noop" }]]);
      } catch (e) {
        return errText(e);
      }
      return;
  }
  return null;
}

/** TG 群：拉机器人进群的人如果已绑定，就把这个群加成他的信息源 */
export async function addGroupSource(ownerUserId: string, chatId: string, title: string) {
  const db = await getDb();
  const [row] = await db
    .insert(schema.sources)
    .values({ userId: ownerUserId, type: "tg_group", handle: chatId, title, intervalMin: 0, autoSince: new Date(), lastFetchedAt: new Date() })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** 收到群消息时：找出把这个群当信息源的客户 */
export async function groupOwners(chatId: string) {
  const db = await getDb();
  return db
    .select({ id: schema.sources.id, userId: schema.sources.userId, title: schema.sources.title })
    .from(schema.sources)
    .where(and(eq(schema.sources.type, "tg_group"), eq(schema.sources.handle, chatId), inArray(schema.sources.enabled, [true])));
}
