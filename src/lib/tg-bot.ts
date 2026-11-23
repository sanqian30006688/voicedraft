import "server-only";
import { handleAnnounceAwait, handleAnnounceCallback, handleAnnounceMenu } from "./tg-bot-announce";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadStyleCardForDrafting, recentEdits } from "./data";
import { extractPoints, generateCandidates } from "./llm";
import { qualityTag, scoreForCard } from "./quality";
import { bulkSchedule, createJob, queueSummary, retryJob, updateScheduled, type PostRow } from "./publish";
import { getSettings, saveSettings } from "./autopilot";
import { checkMentions, generateFor, ownReply, sendReply, setReplyStatus, type ReplyRow } from "./replies";
import { editButtons, editMessage, sendMessage, type Keyboard } from "./tg-api";
import { getItem, updateItem } from "./tg-feed";
import { draftFinalText, threadTweets } from "./draft-text";
import { joinSentences, splitSentences, trigramSimilarity, weightedLength } from "./text";
import { getAccount } from "./x";
import { sendConnectX, handleMoreAwait, handleMoreCallback, showLongMenu, showPromo, showSamples, showStyleCard, showX, startBlind } from "./tg-bot-more";
import { canAskPromo, clearAwait, clip, defaultPromo, ensureCard, errButtons, errText, fmtTime, getState, sendErr, setState, tweetUrl } from "./tg-bot-core";
import { handleRewardsCallback, handleRewardsMenu } from "./tg-bot-rewards";
import { handleBenchCallback, showBenchmark } from "./tg-bot-bench";
import { handlePerfCallback, showHot, showPerf } from "./tg-bot-perf";
import { nextBestTime } from "./post-metrics";
import { handleFollowAwait, handleFollowCallback, showFollow } from "./tg-bot-follow";
import { handleMutualAwait, handleMutualCallback, showMutual } from "./tg-bot-mutual";
import { requireActive, withCharge } from "./billing";
import { handleAutoAwait, handleAutoCallback, showAuto } from "./tg-bot-auto";
import { canSubmitToOfficial, handleTeamAwait, handleTeamCallback, handleTeamMenu, submitAndNotify } from "./tg-bot-team";
import { handleMemoryAwait, handleMemoryCallback, showMemory } from "./tg-bot-memory";
import { handleImageCallback, imageButtonRow } from "./tg-bot-image";
import { handleAccountMenu, sendWebLogin, firstTip, LEGACY_MENU, MENU, MENU_KEYBOARD, WRITE_BUTTONS, refreshOnboarding, showMine, showMore, showStyleMenu, showXMenu, welcome } from "./tg-bot-home";
import { getReportPrefs, prefsCard, saveReportPrefs, tzCard, tzLabel, TZ_CHOICES } from "./daily-report";
import { stopNudges } from "./x-nudge";

export { BOT_COMMANDS, HELP_TEXT, MENU, welcome } from "./tg-bot-home";

/**
 * 机器人里的常用功能：起草、发布 / 定时、灵感、回复、定时队列、草稿。
 * 全部用按钮操作；每次发布、发送回复都要用户在 TG 里点按钮确认。
 */

const SIMILARITY_WARN = 0.67;

/**
 * 解析用户输入的时间：
 * 21:30（今天，已过则明天）、明天 9:00、后天 10:00、11-20 9:30、11/20 9:30、2026-11-20 09:30、2小时后、30分钟后
 */
export function parseWhen(input: string, now = new Date()): Date | null {
  const s = input.trim().replace(/：/g, ":").replace(/\s+/g, " ");
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(个)?(小时|分钟|分)后$/);
  if (rel) {
    const n = Number(rel[1]);
    return new Date(now.getTime() + n * (rel[3] === "小时" ? 3600_000 : 60_000));
  }
  const m = s.match(/^(?:(今天|明天|后天)|(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?)?\s*(?:(上午|下午|晚上|早上)\s*)?(\d{1,2})(?:[:点](\d{1,2})?)?分?$/);
  if (!m) return null;
  const [, dayWord, y, mo, d, ampm, hh, mm] = m;
  let hour = Number(hh);
  const minute = mm ? Number(mm) : 0;
  if ((ampm === "下午" || ampm === "晚上") && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  const t = new Date(now);
  t.setSeconds(0, 0);
  if (mo && d) {
    t.setFullYear(y ? Number(y) : now.getFullYear(), Number(mo) - 1, Number(d));
    t.setHours(hour, minute);
    if (!y && t < now) t.setFullYear(t.getFullYear() + 1);
  } else {
    t.setHours(hour, minute);
    if (dayWord === "明天") t.setDate(t.getDate() + 1);
    else if (dayWord === "后天") t.setDate(t.getDate() + 2);
    else if (!dayWord && t <= now) t.setDate(t.getDate() + 1);
  }
  return Number.isNaN(t.getTime()) ? null : t;
}

export function presetTime(preset: string, now = new Date()): Date | null {
  const t = new Date(now);
  t.setSeconds(0, 0);
  if (preset === "1h") return new Date(now.getTime() + 3600_000);
  if (preset === "3h") return new Date(now.getTime() + 3 * 3600_000);
  if (preset === "21") {
    t.setHours(21, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t;
  }
  if (preset === "9") {
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0);
    return t;
  }
  return null;
}

// ---------- 起草 ----------

async function askTopic(userId: string, chatId: string, sourceId?: string) {
  await setState(userId, { await: { kind: "topic", sourceId } });
  await sendMessage(
    chatId,
    sourceId
      ? "先说说你对这条内容的看法或想写的角度（一句话就行），我按你的文风写 3 条。"
      : "✍️ 写推文\n发一个主题或观点给我，我按你的文风写 3 条短推。\n想写长一点、或从收进来的内容里挑，点下面：",
    sourceId ? {} : { buttons: WRITE_BUTTONS },
  );
}

async function generateBatch(userId: string, chatId: string, topic: string, sourceId?: string, ref?: string, withPromo = false) {
  const card = await ensureCard(userId, chatId, topic);
  if (!card) return;
  const wait = await sendMessage(chatId, "正在写…");
  try {
    const edits = await recentEdits(userId, 10);
    const promo = await defaultPromo(userId, withPromo);
    const candidates = await withCharge(userId, "generate", () =>
      generateCandidates(
        card,
        { kind: "full", topic: ref ? `${topic}\n\n（参考这条推文，但不要照搬原文：${ref}）` : topic, count: 3 },
        edits,
        promo,
      ),
    );
    const token = randomBytes(4).toString("hex");
    await setState(userId, { await: undefined, batch: { token, topic, sourceId, ref, candidates, promo: !!promo } });
    const quality = scoreForCard(card, candidates);
    const body = candidates.map((c, i) => `【${i + 1}】${qualityTag(quality[i])}\n${c}`).join("\n\n");
    await editMessage(chatId, wait.message_id, `主题：${clip(topic, 60)}\n\n${body}\n\n选一条，选完还能改。`, [
      candidates.map((_, i) => ({ text: `选 ${i + 1}`, callback_data: `pk:${token}:${i}` })),
      [
        { text: "🔄 换一批", callback_data: `more:${token}` },
        ...(!promo && (await canAskPromo(userId)) ? [{ text: "🔗 带推广重写", callback_data: `morep:${token}` }] : []),
      ],
    ]);
  } catch (e) {
    await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
  }
}

async function pickCandidate(userId: string, chatId: string, token: string, index: number, messageId: number) {
  const { batch } = await getState(userId);
  const text = batch?.token === token ? batch.candidates[index] : undefined;
  if (!batch || !text) {
    await sendMessage(chatId, "这批候选已经过期了，请重新起草。");
    return;
  }
  const db = await getDb();
  const card = await loadStyleCardForDrafting(userId);
  const sentences = splitSentences(text).map((t) => ({ text: t, original: t, locked: false }));
  const source = batch.sourceId ? await getItem(userId, batch.sourceId) : null;
  const [row] = await db
    .insert(schema.drafts)
    .values({
      userId,
      topic: batch.topic,
      mode: "quick",
      sentences,
      finalText: joinSentences(sentences.map((s) => s.text)),
      styleCardVersion: card?.version ?? null,
      sourceItemId: source?.id ?? null,
    })
    .returning({ id: schema.drafts.id });
  if (source && source.status !== "saved") await updateItem(userId, source.id, { status: "used" });
  await editButtons(chatId, messageId, [[{ text: `已选第 ${index + 1} 条 ✓`, callback_data: "noop" }]]);
  await showDraft(userId, chatId, row.id);
}

type DraftRow = typeof schema.drafts.$inferSelect;

export async function loadDraft(userId: string, draftId: string): Promise<DraftRow | null> {
  const db = await getDb();
  const [d] = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)))
    .limit(1);
  return d ?? null;
}

/** 草稿要发出的推文：单条一条、串推多条；X 长文不能用 API 发，返回 null */
function tweetsOf(d: DraftRow): string[] | null {
  const parts = d.sentences.map((x) => x.text);
  if (d.mode === "article") return null;
  if (d.mode === "thread") return threadTweets(parts, d.meta?.numbered ?? true);
  return [d.finalText];
}

const MODE_LABEL: Record<string, string> = { quick: "推文", sentence: "推文", single: "单条长推", thread: "串推", article: "X 长文" };

/** 草稿卡片：正文 + 字数 + 发布 / 定时 / 改写。长内容会分几条消息发 */
export async function showDraft(userId: string, chatId: string, draftId: string, messageId?: number) {
  const d = await loadDraft(userId, draftId);
  if (!d) {
    await sendMessage(chatId, "找不到这篇草稿，可能已经删除了。");
    return;
  }
  const tweets = tweetsOf(d);
  const notes: string[] = [];
  let body: string;
  if (d.mode === "thread" && tweets) {
    body = `${d.meta?.title ? `${d.meta.title}\n\n` : ""}${tweets
      .map((t, i) => `【${i + 1}】${weightedLength(t).valid ? "" : "（超过 280）"}\n${t}`)
      .join("\n\n")}`;
    const over = tweets.filter((t) => !weightedLength(t).valid).length;
    notes.push(`串推共 ${tweets.length} 条${over ? `，有 ${over} 条超过 280，改短后才能发` : ""}`);
  } else if (d.mode === "article") {
    body = d.finalText;
    notes.push("X 长文需要在 X 网页的文章编辑器里发布：复制上面的全文过去，【此处插图】的位置放图片。");
  } else {
    body = d.finalText;
    const count = weightedLength(d.finalText);
    notes.push(
      `字数 ${count.weighted}/${count.max}${
        count.valid ? "" : d.mode === "single" ? "，超过 280，需要 X Premium 才能一条发完，这里暂时只能复制后去 X 发" : "，超出了，请改短一点再发"
      }`,
    );
  }
  if (d.sourceItemId) {
    const src = await getItem(userId, d.sourceItemId);
    const sim = src ? trigramSimilarity(d.finalText, src.text) : 0;
    if (sim >= SIMILARITY_WARN) {
      notes.push(`⚠️ 和参考素材的文字重合度 ${Math.round(sim * 100)}%，建议加入你自己的观点。${src?.url ? `\n原文：${src.url}` : ""}`);
    }
  }
  if (d.status === "scheduled") notes.push("（这篇已经在定时队列里）");
  if (d.status === "published") notes.push("（这篇已经发布过）");
  if (d.meta?.imageId && d.mode !== "article") notes.push("🖼 已选好配图，发布时挂在第一条上");

  const canPublish = !!tweets && tweets.every((t) => weightedLength(t).valid);
  const row: Keyboard[number] = [];
  if (canPublish) {
    row.push({ text: d.mode === "thread" ? "🚀 发布串推" : "🚀 发布", callback_data: `pub:${d.id}` });
    row.push({ text: "⏰ 定时", callback_data: `sch:${d.id}` });
  }
  row.push({ text: "✏️ 改写", callback_data: `ed:${d.id}` });
  const buttons: Keyboard = [row, imageButtonRow(d)];
  if (canPublish && (await canSubmitToOfficial(userId))) buttons.push([{ text: "📮 投给官号", callback_data: `tmd:${d.id}` }]);
  const text = `${MODE_LABEL[d.mode] && d.mode !== "quick" && d.mode !== "sentence" ? `〔${MODE_LABEL[d.mode]}〕\n` : ""}${body}\n\n${notes.join("\n")}`;
  if (messageId && text.length <= 3900) {
    await editMessage(chatId, messageId, text, buttons);
    return;
  }
  // 太长的分几段发，按钮放在最后一段
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 3900) {
    const cut = rest.lastIndexOf("\n", 3900) > 2000 ? rest.lastIndexOf("\n", 3900) : 3900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  for (let i = 0; i < chunks.length; i++) {
    await sendMessage(chatId, chunks[i], i === chunks.length - 1 ? { buttons } : {});
  }
}

async function confirmPublish(userId: string, chatId: string, draftId: string, messageId: number) {
  const acc = await getAccount(userId);
  if (!acc || acc.authError) {
    await sendConnectX(userId, chatId, acc ? "X 授权已失效，需要重新连接。" : "还没有连接 X 账号。");
    return;
  }
  const d = await loadDraft(userId, draftId);
  const n = d ? (tweetsOf(d)?.length ?? 0) : 0;
  await editButtons(chatId, messageId, [
    [
      { text: `✅ 确认${n > 1 ? `发 ${n} 条串推` : "发"}到 @${acc.handle}`, callback_data: `pubok:${draftId}` },
      { text: "取消", callback_data: `dr:${draftId}` },
    ],
  ]);
}

async function publishNow(userId: string, chatId: string, draftId: string, messageId: number) {
  const d = await loadDraft(userId, draftId);
  const tweets = d && tweetsOf(d);
  if (!d || !tweets) return sendMessage(chatId, "这篇不能直接发布。");
  if (d.status === "published") return sendMessage(chatId, "这篇已经发布过了。");
  await editButtons(chatId, messageId, [[{ text: "发布中…", callback_data: "noop" }]]);
  try {
    const row = await createJob(userId, { tweets, draftId, imageId: d.meta?.imageId });
    if (row.status === "published") {
      await editButtons(chatId, messageId, []);
      await sendMessage(chatId, `已发布 ✓${tweets.length > 1 ? `（${tweets.length} 条串推）` : ""}\n${tweetUrl(row.handle, row.postIds[0])}`);
    } else {
      await editButtons(chatId, messageId, []);
      await sendMessage(chatId, `发布失败：${row.error ?? "未知原因"}`, {
        buttons: retryButtons(row.id),
      });
    }
  } catch (e) {
    await editButtons(chatId, messageId, [[{ text: "🚀 发布", callback_data: `pub:${draftId}` }]]);
    await sendErr(chatId, e);
  }
}

async function askSchedule(userId: string, chatId: string, draftId: string, messageId: number) {
  // 有足够的发帖数据时，多一个「⭐ 最佳时间」
  const best = await nextBestTime(userId).catch(() => null);
  await editButtons(chatId, messageId, [
    ...(best ? [[{ text: `⭐ 最佳时间（${best.label}）`, callback_data: `st:${draftId}:best` }]] : []),
    [
      { text: "1 小时后", callback_data: `st:${draftId}:1h` },
      { text: "3 小时后", callback_data: `st:${draftId}:3h` },
    ],
    [
      { text: "今晚 21:00", callback_data: `st:${draftId}:21` },
      { text: "明早 9:00", callback_data: `st:${draftId}:9` },
    ],
    [
      { text: "自己填时间", callback_data: `st:${draftId}:custom` },
      { text: "返回", callback_data: `dr:${draftId}` },
    ],
  ]);
}

async function scheduleDraft(userId: string, chatId: string, draftId: string, when: Date, messageId?: number) {
  const d = await loadDraft(userId, draftId);
  const tweets = d && tweetsOf(d);
  if (!d || !tweets) return sendMessage(chatId, "这篇不能定时发布。");
  try {
    const row = await createJob(userId, { tweets, draftId, scheduledAt: when, imageId: d.meta?.imageId });
    if (messageId) await editButtons(chatId, messageId, []);
    await sendMessage(chatId, `已排进定时 ✓ ${fmtTime(row.scheduledAt ?? when)} 发到 @${row.handle}\n到时间会自动发出，发出后我会通知你。`, {
      buttons: [[{ text: "取消这条定时", callback_data: `qc:${row.id}` }]],
    });
  } catch (e) {
    await sendErr(chatId, e);
  }
}

/** 点「改写」：单条整段改；串推 / 长文按段改 */
async function startEdit(userId: string, chatId: string, draftId: string) {
  const d = await loadDraft(userId, draftId);
  if (!d) return sendMessage(chatId, "找不到这篇草稿。");
  if (d.mode === "thread" || d.mode === "article") {
    await setState(userId, { await: { kind: "part", draftId } });
    const unit = d.mode === "thread" ? "条" : "段";
    await sendMessage(
      chatId,
      `要改哪一${unit}？\n• 自己改：发「编号 + 新内容」，例如：3 这里是新内容\n• 让 AI 换：发「换 3」，可以加要求，例如：换 3 更口语一点\n` +
        (d.mode === "article" ? "（小标题以「## 」开头，配图位置以「[配图] 」开头）\n" : "") +
        "改完发 /cancel 结束。",
    );
    await sendMessage(chatId, d.sentences.map((x, i) => `${i + 1}. ${x.text}`).join("\n\n"));
    return;
  }
  await setState(userId, { await: { kind: "edit", draftId } });
  await sendMessage(chatId, "把改好的全文发给我（可以复制下面这段再改）：");
  await sendMessage(chatId, d.finalText);
}

/** 用户发来改好的全文：保存草稿，并记下修改（下次生成会参考） */
async function saveEdit(userId: string, chatId: string, draftId: string, text: string) {
  const d = await loadDraft(userId, draftId);
  if (!d) return sendMessage(chatId, "找不到这篇草稿。");
  const edited = text.trim();
  const parts = d.mode === "single" ? edited.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) : splitSentences(edited);
  await saveParts(userId, d, parts);
  if (edited !== d.finalText.trim()) {
    const db = await getDb();
    await db.insert(schema.editLogs).values({ userId, draftId: d.id, original: d.finalText, edited });
  }
  await clearAwait(userId);
  await showDraft(userId, chatId, d.id);
}

export async function saveParts(userId: string, d: DraftRow, parts: string[]) {
  const db = await getDb();
  const sentences = parts.map((t) => ({ text: t, original: t, locked: false }));
  await db
    .update(schema.drafts)
    .set({ sentences, finalText: draftFinalText(d.mode, parts, d.meta), updatedAt: new Date() })
    .where(and(eq(schema.drafts.id, d.id), eq(schema.drafts.userId, userId)));
}

// ---------- 灵感 ----------

async function showIdeas(userId: string, chatId: string) {
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.feedItems)
    .where(and(eq(schema.feedItems.userId, userId), inArray(schema.feedItems.status, ["new", "saved"])))
    .orderBy(desc(sql`coalesce(${schema.feedItems.publishedAt}, ${schema.feedItems.createdAt})`))
    .limit(5);
  if (!items.length) {
    await sendMessage(chatId, "灵感里还没有新内容。在 TG 里看到好内容，转发给我就会收进来；也可以订阅公开频道。", {
      buttons: IDEA_FOOTER,
    });
    return;
  }
  await sendMessage(chatId, `最近 ${items.length} 条灵感：`);
  for (const it of items) await sendIdea(chatId, it);
  await sendMessage(chatId, "还可以：", { buttons: IDEA_FOOTER });
}

const IDEA_FOOTER: Keyboard = [
  [
    { text: "📡 订阅的频道", callback_data: "chs" },
    { text: "🔖 X 书签", callback_data: "xm" },
  ],
];

function ideaButtons(id: string): Keyboard {
  return [
    [
      { text: "🔍 提炼要点", callback_data: `ip:${id}` },
      { text: "✍️ 用它起草", callback_data: `iw:${id}` },
    ],
    [
      { text: "⭐ 收藏", callback_data: `is:${id}` },
      { text: "🙈 忽略", callback_data: `ix:${id}` },
    ],
  ];
}

async function sendIdea(chatId: string, it: typeof schema.feedItems.$inferSelect) {
  const head = [it.author, it.url].filter(Boolean).join(" · ");
  await sendMessage(chatId, `${head ? `${head}\n\n` : ""}${clip(it.text, 600)}`, { buttons: ideaButtons(it.id) });
}

async function showPoints(userId: string, chatId: string, id: string) {
  const item = await getItem(userId, id);
  if (!item) return sendMessage(chatId, "找不到这条灵感。");
  let points = item.points;
  if (!points?.length) {
    const wait = await sendMessage(chatId, "正在提炼…");
    try {
      await requireActive(userId, "points");
      const card = await loadStyleCardForDrafting(userId);
      points = await extractPoints(item.text, card?.traits.topics ?? []);
      await updateItem(userId, id, { points });
      await editMessage(chatId, wait.message_id, "可以写的角度：");
    } catch (e) {
      await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
      return;
    }
  }
  await sendMessage(chatId, points.map((p, i) => `${i + 1}. ${p}`).join("\n\n") + "\n\n点一个直接起草，或者说说你自己的角度。", {
    buttons: [
      points.map((_, i) => ({ text: `写 ${i + 1}`, callback_data: `ipw:${id}:${i}` })),
      [{ text: "我自己说角度", callback_data: `iw:${id}` }],
    ],
  });
}

// ---------- 回复 ----------

function replyText(r: ReplyRow) {
  const who = `@${r.authorHandle}${r.authorName ? `（${r.authorName}）` : ""}`;
  const lines =
    r.source === "timeline"
      ? [`👀 你关注的 ${who} 发了（${r.matchReason ?? "你关注的人"}）：`, clip(r.text, 500), tweetUrl(r.authorHandle, r.tweetId)]
      : [`${who}：`, clip(r.text, 500)];
  if (r.inReplyToText) lines.push("", `回复的是你的：${clip(r.inReplyToText, 120)}`);
  if (r.candidates.length) lines.push("", "回复候选：", ...r.candidates.map((c, i) => `${i + 1}. ${c}`));
  else lines.push("", "（还没有候选，点「写候选」）");
  return lines.join("\n");
}

function replyButtons(r: ReplyRow): Keyboard {
  return [
    r.candidates.map((_, i) => ({ text: `发送 ${i + 1}`, callback_data: `rs:${r.id}:${i}` })),
    [
      { text: "✏️ 自己写", callback_data: `re:${r.id}` },
      { text: r.candidates.length ? "🔄 换一批" : "写候选", callback_data: `rm:${r.id}` },
      { text: "跳过", callback_data: `rk:${r.id}` },
    ],
  ].filter((row) => row.length);
}

async function sendReplyCard(chatId: string, r: ReplyRow) {
  await sendMessage(chatId, replyText(r), { buttons: replyButtons(r) });
}

async function showReplies(userId: string, chatId: string) {
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.replyItems)
    .where(and(eq(schema.replyItems.userId, userId), inArray(schema.replyItems.status, ["pending", "failed"])))
    .orderBy(asc(schema.replyItems.createdAt))
    .limit(5);
  const acc = await getAccount(userId);
  if (!acc) {
    await sendConnectX(userId, chatId, "还没有连接 X 账号。");
    return;
  }
  const checkButtons: Keyboard = [
    [
      { text: "🔄 检查新的 @我", callback_data: "rchk" },
      { text: "👀 关注的人", callback_data: "fs" },
    ],
  ];
  if (!items.length) {
    await sendMessage(chatId, "暂时没有要回复的。", { buttons: checkButtons });
    return;
  }
  await sendMessage(chatId, `有 ${items.length} 条等你回复（点「发送」就会发出）：`);
  for (const r of items) await sendReplyCard(chatId, r);
  await sendMessage(chatId, "要拉新的：", { buttons: checkButtons });
}

/** 定时拉到新提及后，把还没推送过的回复候选推到 TG */
export async function notifyNewReplies(userId: string) {
  const db = await getDb();
  const [bind] = await db
    .select({ chatId: schema.tgBindings.chatId })
    .from(schema.tgBindings)
    .where(eq(schema.tgBindings.userId, userId))
    .limit(1);
  if (!bind?.chatId) return;
  const items = await db
    .select()
    .from(schema.replyItems)
    .where(
      and(
        eq(schema.replyItems.userId, userId),
        eq(schema.replyItems.status, "pending"),
        isNull(schema.replyItems.tgNotifiedAt),
        ne(sql`jsonb_array_length(${schema.replyItems.candidates})`, 0),
        gt(schema.replyItems.createdAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    )
    .orderBy(asc(schema.replyItems.createdAt))
    .limit(10);
  for (const r of items) {
    await sendReplyCard(bind.chatId, r);
    await db.update(schema.replyItems).set({ tgNotifiedAt: new Date() }).where(eq(schema.replyItems.id, r.id));
  }
}

/** 定时帖发出（或失败）后通知 */
/** 失败的发布任务：重试时串推从断点继续，不会重复发已发出的 */
function retryButtons(postId: string): Keyboard {
  return [[{ text: "🔁 重试", callback_data: `rt:${postId}` }]];
}

async function retryPost(userId: string, chatId: string, postId: string, messageId: number) {
  await editButtons(chatId, messageId, [[{ text: "重试中…", callback_data: "noop" }]]);
  try {
    const row = await retryJob(userId, postId);
    if (row.status === "published") {
      await editButtons(chatId, messageId, []);
      await sendMessage(chatId, `已发布 ✓\n${tweetUrl(row.handle, row.postIds[0])}`);
    } else {
      await editButtons(chatId, messageId, retryButtons(postId));
      await sendMessage(chatId, `还是没发出去：${row.error ?? "未知原因"}`);
    }
  } catch (e) {
    await editButtons(chatId, messageId, retryButtons(postId));
    return errText(e);
  }
}

export async function notifyPostResult(post: PostRow) {
  if (!post.scheduledAt) return;
  const db = await getDb();
  const [bind] = await db
    .select({ chatId: schema.tgBindings.chatId })
    .from(schema.tgBindings)
    .where(eq(schema.tgBindings.userId, post.userId))
    .limit(1);
  if (!bind?.chatId) return;
  const preview = clip(post.tweets[0] ?? "", 80);
  if (post.status === "published") {
    await sendMessage(bind.chatId, `定时推文已发出 ✓\n${preview}\n${tweetUrl(post.handle, post.postIds[0])}`);
    await notifySubmissionAuthor(post, `你投给官号的稿子已在 @${post.handle} 发出 ✓\n${tweetUrl(post.handle, post.postIds[0])}`);
  } else if (post.status === "failed") {
    await sendMessage(bind.chatId, `定时推文发布失败：${post.error ?? "未知原因"}\n${preview}`, {
      buttons: retryButtons(post.id),
    });
  }
}

/** 这条定时帖是团队投稿通过后排的：也告诉投稿人 */
async function notifySubmissionAuthor(post: PostRow, text: string) {
  const db = await getDb();
  const [sub] = await db
    .select({ author: schema.teamSubmissions.authorUserId })
    .from(schema.teamSubmissions)
    .where(eq(schema.teamSubmissions.postId, post.id))
    .limit(1);
  if (!sub || sub.author === post.userId) return;
  const [b] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, sub.author)).limit(1);
  if (b?.chatId) await sendMessage(b.chatId, text).catch(() => {});
}

/** 用户自己写的回复：记下最接近的那条候选作为「原稿」，用于学习修改习惯 */
async function sendCustomReply(userId: string, chatId: string, replyId: string, text: string) {
  await clearAwait(userId);
  try {
    const item = await ownReply(userId, replyId);
    const original = item.candidates
      .map((c) => ({ c, s: trigramSimilarity(c, text) }))
      .sort((a, b) => b.s - a.s)
      .find((x) => x.s > 0.3)?.c;
    const row = await sendReply(userId, replyId, text, original);
    await sendMessage(chatId, `已回复 @${row.authorHandle} ✓`);
  } catch (e) {
    await sendErr(chatId, e);
  }
}

// ---------- 定时队列 / 草稿 ----------

const DELAYS: [number, string][] = [
  [30, "30 分钟"],
  [60, "1 小时"],
  [180, "3 小时"],
  [360, "6 小时"],
  [720, "12 小时"],
  [1440, "1 天"],
  [4320, "3 天"],
];

/** 定时帖一键管理：全部暂停 / 恢复 / 延后 / 删除 */
export async function showQueueTools(userId: string, chatId: string, mid?: number) {
  const q = await queueSummary(userId);
  const text =
    q.scheduled + q.paused === 0
      ? "📅 定时帖管理\n现在没有还没发的定时帖。"
      : `📅 定时帖管理\n排着 ${q.scheduled} 条${q.next ? `（最早 ${fmtTime(q.next)}）` : ""}` +
        (q.paused ? `\n已暂停 ${q.paused} 条（到点不会发）` : "");
  const buttons: Keyboard = [];
  if (q.scheduled + q.paused > 0) {
    buttons.push([
      ...(q.scheduled ? [{ text: "⏸ 全部暂停", callback_data: "qb:p" }] : []),
      ...(q.paused ? [{ text: "▶️ 全部恢复", callback_data: "qb:r" }] : []),
    ]);
    buttons.push([
      { text: "⏰ 全部延后", callback_data: "qb:l" },
      { text: "🗑 全部删除", callback_data: "qb:x" },
    ]);
    buttons.push([{ text: "📋 一条条看", callback_data: "qb:v" }]);
  }
  if (mid) await editMessage(chatId, mid, text, buttons);
  else await sendMessage(chatId, text, { buttons });
}

async function queueToolsCallback(userId: string, chatId: string, a: string, mid: number): Promise<string | undefined> {
  if (a === "m") return void (await showQueueTools(userId, chatId));
  if (a === "v") return void (await showQueue(userId, chatId, false));
  if (a === "p") {
    const n = await bulkSchedule(userId, "pause");
    const auto = await getSettings(userId);
    if (auto.enabled) await saveSettings(userId, { enabled: false });
    await showQueueTools(userId, chatId, mid);
    if (auto.enabled) {
      await sendMessage(chatId, `已暂停 ${n} 条定时帖。自动发帖也一起暂停了，不会再排新的。`, {
        buttons: [[{ text: "🤖 自动发帖设置", callback_data: "au" }]],
      });
    }
    return `已暂停 ${n} 条`;
  }
  if (a === "r") {
    const n = await bulkSchedule(userId, "resume");
    await showQueueTools(userId, chatId, mid);
    const auto = await getSettings(userId);
    if (!auto.enabled) {
      await sendMessage(chatId, `已恢复 ${n} 条定时帖，过了点的会从 2 分钟后开始按原来的间隔发。自动发帖还是暂停的，要的话可以重新开。`, {
        buttons: [[{ text: "▶️ 也开启自动发帖", callback_data: "aut:1" }]],
      });
    }
    return `已恢复 ${n} 条`;
  }
  if (a === "l") {
    await editMessage(chatId, mid, "所有还没发的定时帖（包括暂停的）一起往后推多久？彼此间隔不变。", [
      DELAYS.slice(0, 4).map(([m, l]) => ({ text: l, callback_data: `qd:${m}` })),
      DELAYS.slice(4).map(([m, l]) => ({ text: l, callback_data: `qd:${m}` })),
      [{ text: "返回", callback_data: "qb:back" }],
    ]);
    return;
  }
  if (a === "x") {
    const q = await queueSummary(userId);
    await editMessage(chatId, mid, `确定删除全部 ${q.scheduled + q.paused} 条还没发的定时帖？删了就不会发出，也没法恢复。`, [
      [
        { text: "🗑 确定全部删除", callback_data: "qb:xx" },
        { text: "算了", callback_data: "qb:back" },
      ],
    ]);
    return;
  }
  if (a === "xx") {
    const n = await bulkSchedule(userId, "cancel");
    await showQueueTools(userId, chatId, mid);
    return `已删除 ${n} 条`;
  }
  await showQueueTools(userId, chatId, mid);
}

async function showQueue(userId: string, chatId: string, tools = true) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.userId, userId), inArray(schema.posts.status, ["scheduled", "paused"])))
    .orderBy(asc(schema.posts.scheduledAt))
    .limit(10);
  if (!rows.length) {
    await sendMessage(chatId, "定时队列是空的。起草后点「⏰ 定时」就能排进来。");
    return;
  }
  if (tools) await showQueueTools(userId, chatId);
  for (const p of rows) {
    await sendMessage(
      chatId,
      `${p.status === "paused" ? "⏸ 已暂停 · " : ""}${p.scheduledAt ? fmtTime(p.scheduledAt) : ""}${p.tweets.length > 1 ? `（串推 ${p.tweets.length} 条）` : ""}\n${clip(p.tweets[0], 400)}`,
      {
        buttons: [
          [
            ...(p.status === "scheduled" ? [{ text: "🚀 现在就发", callback_data: `qn:${p.id}` }] : []),
            { text: "取消", callback_data: `qc:${p.id}` },
          ],
        ],
      },
    );
  }
}

const MODE_TAG: Record<string, string> = { thread: "[串推] ", article: "[X 长文] ", single: "[长推] " };

async function showDrafts(userId: string, chatId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.drafts.id, mode: schema.drafts.mode, text: schema.drafts.finalText, updatedAt: schema.drafts.updatedAt })
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.userId, userId),
        inArray(schema.drafts.status, ["draft", "copied"]),
        ne(schema.drafts.finalText, ""),
      ),
    )
    .orderBy(desc(schema.drafts.updatedAt))
    .limit(6);
  if (!rows.length) {
    await sendMessage(chatId, "还没有没发出的草稿。点「✍️ 写推文」写一条。");
    return;
  }
  await sendMessage(
    chatId,
    "最近的草稿：\n\n" + rows.map((r, i) => `${i + 1}. ${MODE_TAG[r.mode] ?? ""}${clip(r.text.replace(/\s+/g, " "), 60)}`).join("\n"),
    { buttons: [rows.map((r, i) => ({ text: `${i + 1}`, callback_data: `dro:${r.id}` }))] },
  );
}

// ---------- 入口 ----------

/** 菜单按钮或 /命令；返回 true 表示已处理 */
export async function handleMenu(userId: string, chatId: string, raw: string): Promise<boolean> {
  // 老用户手机上还是旧键盘：旧按钮照样能用，处理完顺便换成新菜单
  const legacy = LEGACY_MENU[raw];
  const text = legacy ?? raw;
  const t = text.trim();
  const cmd = t.startsWith("/") ? t.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase() : "";
  const rest = cmd ? t.slice(t.split(/\s+/)[0].length).trim() : "";
  const handled = await route(userId, chatId, text, cmd, rest);
  if (handled && legacy && cmd !== "/help") {
    await sendMessage(chatId, "菜单换新了，常用功能都在下面 6 个按钮里 👇", { keyboard: MENU_KEYBOARD });
  }
  return handled;
}

async function route(userId: string, chatId: string, text: string, cmd: string, rest: string): Promise<boolean> {
  // 主菜单按钮第一次点：先给一句「怎么用」
  const key = (Object.keys(MENU) as (keyof typeof MENU)[]).find((k) => MENU[k] === text);
  if (key && !(key === "write" && rest)) await firstTip(userId, chatId, key);
  if (text === MENU.write || cmd === "/write" || cmd === "/draft") {
    if (rest) await generateBatch(userId, chatId, rest);
    else await askTopic(userId, chatId);
  } else if (cmd === "/ideas") {
    await clearAwait(userId);
    await showIdeas(userId, chatId);
  } else if (text === MENU.replies || cmd === "/replies") {
    await clearAwait(userId);
    await showReplies(userId, chatId);
  } else if (text === MENU.mine || cmd === "/mine") {
    await clearAwait(userId);
    await showMine(userId, chatId);
  } else if (cmd === "/queue") {
    await clearAwait(userId);
    await showQueue(userId, chatId);
  } else if (cmd === "/drafts") {
    await clearAwait(userId);
    await showDrafts(userId, chatId);
  } else if (cmd === "/long") {
    await clearAwait(userId);
    await showLongMenu(chatId);
  } else if (cmd === "/card") {
    await clearAwait(userId);
    await showStyleCard(userId, chatId);
  } else if (cmd === "/samples") {
    await clearAwait(userId);
    await showSamples(userId, chatId);
  } else if (text === MENU.more || cmd === "/more") {
    await clearAwait(userId);
    await showMore(chatId);
  } else if (text === MENU.auto || cmd === "/auto") {
    await clearAwait(userId);
    await showAuto(userId, chatId);
  } else if (cmd === "/stats" || cmd === "/rank") {
    await clearAwait(userId);
    await showBenchmark(userId, chatId);
  } else if (cmd === "/perf") {
    await clearAwait(userId);
    await showPerf(userId, chatId);
  } else if (cmd === "/hot") {
    await clearAwait(userId);
    await showHot(userId, chatId);
  } else if (cmd === "/memory") {
    await clearAwait(userId);
    await showMemory(userId, chatId);
  } else if (cmd === "/promo") {
    await clearAwait(userId);
    await showPromo(userId, chatId);
  } else if (cmd === "/follow") {
    await clearAwait(userId);
    await showFollow(userId, chatId);
  } else if (cmd === "/mutual" || cmd === "/unfollow") {
    await clearAwait(userId);
    await showMutual(userId, chatId);
  } else if (cmd === "/bookmarks") {
    await clearAwait(userId);
    await showX(userId, chatId);
  } else if (cmd === "/blind") {
    await clearAwait(userId);
    await startBlind(userId, chatId);
  } else if (await handleAnnounceMenu(userId, chatId, cmd, rest)) {
    // 公告：/notice（管理员）、/notify（更新通知开关）
  } else if (await handleTeamMenu(userId, chatId, cmd, rest)) {
    // 团队 / 投稿
  } else if (await handleAccountMenu(userId, chatId, cmd)) {
    // 我的账号：用户编号（开源版没有余额 / 充值）
  } else if (await handleRewardsMenu(userId, chatId, text, cmd, "/checkin")) {
    // 签到 / 邀请
  } else if (cmd === "/help" || cmd === "/menu" || cmd === "/start") {
    await clearAwait(userId);
    await welcome(chatId, false, userId);
  } else if (cmd === "/web") {
    await clearAwait(userId);
    await sendWebLogin(userId, chatId);
  } else if (cmd === "/cancel") {
    await clearAwait(userId);
    await sendMessage(chatId, "好的，已取消。");
  } else {
    return false;
  }
  return true;
}

/** 用户直接发来的文字（不是转发）：按当前等待的内容处理，否则问要起草还是收进灵感 */
export async function handleText(userId: string, chatId: string, text: string) {
  if (await handleMenu(userId, chatId, text)) return;
  const { await: waiting } = await getState(userId);
  switch (waiting?.kind) {
    case "topic":
      await generateBatch(userId, chatId, text, waiting.sourceId, waiting.ref);
      return;
    case "edit":
      await saveEdit(userId, chatId, waiting.draftId, text);
      return;
    case "reply":
      await sendCustomReply(userId, chatId, waiting.replyId, text);
      return;
    case "schedule": {
      const when = parseWhen(text);
      if (!when) {
        await sendMessage(chatId, "没看懂这个时间。可以这样写：21:30、明天 9:00、11-20 9:30、2小时后。发 /cancel 取消。");
        return;
      }
      await clearAwait(userId);
      await scheduleDraft(userId, chatId, waiting.draftId, when);
      return;
    }
  }
  if (await handleAnnounceAwait(userId, chatId, text)) return;
  if (await handleAutoAwait(userId, chatId, text)) return;
  if (await handleMemoryAwait(userId, chatId, text)) return;
  if (await handleFollowAwait(userId, chatId, text)) return;
  if (await handleMutualAwait(userId, chatId, text)) return;
  if (await handleMoreAwait(userId, chatId, text)) return;
  if (await handleTeamAwait(userId, chatId, text)) return;
  await setState(userId, { await: { kind: "choose", text: clip(text, 3000) } });
  await sendMessage(chatId, "要拿这段文字做什么？", {
    buttons: [
      [
        { text: "✍️ 当主题起草", callback_data: "tc:draft" },
        { text: "💡 收进灵感", callback_data: "tc:save" },
      ],
    ],
  });
}

export interface CallbackQuery {
  id: string;
  data?: string;
  from?: TgFrom;
  message?: { message_id: number; chat: { id: number } };
}

/** 发消息 / 点按钮的 TG 用户 */
export interface TgFrom {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** 消息下方按钮的点击 */
export async function handleCallback(
  userId: string,
  chatId: string,
  cq: CallbackQuery,
  saveIdea: (t: string) => Promise<string | null>,
): Promise<string | undefined> {
  const data = cq.data ?? "";
  const mid = cq.message?.message_id ?? 0;
  const [action, a, b] = data.split(":");
  if (action.startsWith("im") || action.startsWith("ig")) {
    if (await handleImageCallback(userId, chatId, action, a ?? "", b ?? "", mid)) return;
  }
  if (action === "mu") return handleMutualCallback(userId, chatId, data, mid);
  switch (action) {
    case "noop":
      if (a === "cancel") await editButtons(chatId, mid, [[{ text: "已取消", callback_data: "noop" }]]);
      return;
    case "hm":
      return homeCallback(userId, chatId, a, mid);
    case "rt":
      return retryPost(userId, chatId, a, mid);
    case "pk":
      await pickCandidate(userId, chatId, a, Number(b), mid);
      return;
    case "rp":
      return reportCallback(userId, chatId, a, b, mid);
    case "xn":
      // 「连接 X」提醒上的「不再提醒」
      await stopNudges(userId);
      await editButtons(chatId, mid, [[{ text: "🔑 连接 X", callback_data: "xc" }]]);
      return "好的，不再提醒";
    case "more":
    case "morep": {
      const { batch } = await getState(userId);
      if (!batch || batch.token !== a) return "这批候选已经过期了";
      await editButtons(chatId, mid, []);
      await generateBatch(userId, chatId, batch.topic, batch.sourceId, batch.ref, action === "morep" || !!batch.promo);
      return;
    }
    case "dr":
      await clearAwait(userId);
      await showDraft(userId, chatId, a, mid || undefined);
      return;
    case "dro":
      await showDraft(userId, chatId, a);
      return;
    case "pub":
      await confirmPublish(userId, chatId, a, mid);
      return;
    case "pubok":
      await publishNow(userId, chatId, a, mid);
      return;
    case "sch":
      await askSchedule(userId, chatId, a, mid);
      return;
    case "st": {
      if (b === "custom") {
        await setState(userId, { await: { kind: "schedule", draftId: a } });
        await sendMessage(chatId, "发给我想发的时间，例如：21:30、明天 9:00、11-20 9:30、2小时后。");
        return;
      }
      const when = b === "best" ? ((await nextBestTime(userId))?.at ?? null) : presetTime(b);
      if (when) await scheduleDraft(userId, chatId, a, when, mid);
      else if (b === "best") await sendMessage(chatId, "发帖数据还不够推荐时间，请选别的时间。");
      return;
    }
    case "ed":
      await startEdit(userId, chatId, a);
      return;
    case "tc": {
      const { await: waiting } = await getState(userId);
      if (waiting?.kind !== "choose") return "已过期，请重新发一次";
      await editButtons(chatId, mid, []);
      if (a === "draft") {
        await generateBatch(userId, chatId, waiting.text);
      } else {
        await clearAwait(userId);
        const ok = await saveIdea(waiting.text);
        await sendMessage(chatId, ok ? "已收进灵感 ✓" : "这条之前收过了。");
      }
      return;
    }
    case "ip":
      await showPoints(userId, chatId, a);
      return;
    case "ipw": {
      const item = await getItem(userId, a);
      const point = item?.points?.[Number(b)];
      if (!point) return "找不到这个要点";
      await generateBatch(userId, chatId, point, a);
      return;
    }
    case "iw":
      await askTopic(userId, chatId, a);
      return;
    case "is":
      await updateItem(userId, a, { status: "saved" });
      await editButtons(chatId, mid, ideaButtons(a).slice(0, 1));
      return "已收藏";
    case "ix":
      await updateItem(userId, a, { status: "dismissed" });
      await editButtons(chatId, mid, []);
      return "已忽略";
    case "rs": {
      try {
        const item = await ownReply(userId, a);
        const text = item.candidates[Number(b)];
        if (!text) return "找不到这条候选";
        await editButtons(chatId, mid, [[{ text: "发送中…", callback_data: "noop" }]]);
        const row = await sendReply(userId, a, text, text);
        await editButtons(chatId, mid, [[{ text: `已发送第 ${Number(b) + 1} 条 ✓`, callback_data: "noop" }]]);
        if (row.replyPostId) await sendMessage(chatId, `已回复 @${row.authorHandle} ✓\n${tweetUrl(null, row.replyPostId)}`);
      } catch (e) {
        await sendErr(chatId, e);
        const item = await ownReply(userId, a).catch(() => null);
        if (item) await editButtons(chatId, mid, replyButtons(item));
      }
      return;
    }
    case "re":
      await setState(userId, { await: { kind: "reply", replyId: a } });
      await sendMessage(chatId, "把要发的回复发给我（可以复制候选再改），发 /cancel 取消。");
      return;
    case "rm": {
      try {
        await editButtons(chatId, mid, [[{ text: "正在写…", callback_data: "noop" }]]);
        const row = await generateFor(userId, await ownReply(userId, a));
        if (row.status === "skipped") {
          await editMessage(chatId, mid, `${replyText(row)}\n\n已跳过：${row.skipReason ?? ""}`);
        } else {
          await editMessage(chatId, mid, replyText(row), replyButtons(row));
        }
      } catch (e) {
        await sendErr(chatId, e);
      }
      return;
    }
    case "rk":
      try {
        await setReplyStatus(userId, a, "skipped");
        await editButtons(chatId, mid, [[{ text: "已跳过", callback_data: "noop" }]]);
      } catch (e) {
        return errText(e);
      }
      return;
    case "rchk": {
      try {
        const r = await checkMentions(userId);
        if (r.message) await sendMessage(chatId, r.message);
        await showReplies(userId, chatId);
      } catch (e) {
        await sendErr(chatId, e);
      }
      return;
    }
    case "qn":
      try {
        await updateScheduled(userId, a, { scheduledAt: new Date() });
        await editButtons(chatId, mid, [[{ text: "马上发出，发出后通知你", callback_data: "noop" }]]);
      } catch (e) {
        return errText(e);
      }
      return;
    case "qb":
      return queueToolsCallback(userId, chatId, a, mid);
    case "qd": {
      const n = await bulkSchedule(userId, "delay", Number(a) || 0);
      await showQueueTools(userId, chatId, mid);
      return `${n} 条都往后推了 ${DELAYS.find(([m]) => m === Number(a))?.[1] ?? `${a} 分钟`}`;
    }
    case "qc":
      try {
        await updateScheduled(userId, a, { cancel: true });
        await editButtons(chatId, mid, [[{ text: "已取消定时", callback_data: "noop" }]]);
      } catch (e) {
        return errText(e);
      }
      return;
  }
  const ann = await handleAnnounceCallback(userId, chatId, action, a ?? "", b ?? "", mid);
  if (ann !== null) return ann;
  const memory = await handleMemoryCallback(userId, chatId, action, a, mid);
  if (memory !== null) return memory;
  const auto = await handleAutoCallback(userId, chatId, action, a, b, mid);
  if (auto !== null) return auto;
  const follow = await handleFollowCallback(userId, chatId, action, a, mid);
  if (follow !== null) return follow;
  if (await handleRewardsCallback(userId, chatId, action, a)) return;
  if (action === "bm" && a === "write") {
    await askTopic(userId, chatId);
    return;
  }
  const bench = await handleBenchCallback(userId, chatId, action, a, b, mid);
  if (bench !== null) return bench;
  const perf = await handlePerfCallback(userId, chatId, action, a, b, mid);
  if (perf !== null) return perf;
  if (action === "tmd") {
    const d = await loadDraft(userId, a);
    const tweets = d && tweetsOf(d);
    if (!tweets) return "这篇草稿现在不能投稿";
    await submitAndNotify(userId, chatId, tweets);
    return;
  }
  const team = await handleTeamCallback(userId, chatId, action, a, b, mid, (p) => presetTime(p));
  if (team !== null) return team;
  const more = await handleMoreCallback(userId, chatId, action, a, b, mid, () => welcome(chatId, false, userId));
  return more === null ? "这个按钮已经失效了" : more;
}

/** 主菜单和子菜单里的按钮（hm:xxx） */
async function homeCallback(userId: string, chatId: string, what: string, mid: number): Promise<string | undefined> {
  switch (what) {
    case "start":
      await refreshOnboarding(userId, chatId, mid);
      return "已刷新";
    case "more":
      await showMore(chatId, mid);
      return;
    case "style":
      await showStyleMenu(userId, chatId, mid);
      return;
    case "x":
      await showXMenu(userId, chatId, mid);
      return;
    case "card":
      await clearAwait(userId);
      await showStyleCard(userId, chatId);
      return;
    case "long":
      await clearAwait(userId);
      await showLongMenu(chatId);
      return;
    case "ideas":
      await clearAwait(userId);
      await showIdeas(userId, chatId);
      return;
    case "drafts":
      await showDrafts(userId, chatId);
      return;
    case "queue":
      await showQueue(userId, chatId);
      return;
    case "replies":
      await clearAwait(userId);
      await showReplies(userId, chatId);
      return;
  }
  return;
}

/** 📰 每日日报设置（rp:xxx） */
async function reportCallback(userId: string, chatId: string, what: string, arg: string, mid: number): Promise<string | undefined> {
  let p = await getReportPrefs(userId);
  let note: string | undefined;
  if (what === "on") {
    p = await saveReportPrefs(userId, { enabled: arg === "1" });
    note = p.enabled ? "日报已开启" : "日报已关闭";
  } else if (what === "h") {
    p = await saveReportPrefs(userId, { hour: Number(arg), enabled: true });
    note = `改成每天 ${p.hour} 点`;
  } else if (what === "z") {
    const t = TZ_CHOICES[Number(arg)];
    if (t) p = await saveReportPrefs(userId, { tz: t.tz });
    note = `时区：${tzLabel(p.tz)}`;
  } else if (what === "tz") {
    const c = tzCard(p);
    await editMessage(chatId, mid, c.text, c.buttons);
    return;
  }
  const c = prefsCard(p);
  // 从日报下面点进来的：另发一张卡，不把日报本身改掉
  if (what === "menu" && mid) await sendMessage(chatId, c.text, { buttons: c.buttons });
  else await editMessage(chatId, mid, c.text, c.buttons);
  return note;
}
