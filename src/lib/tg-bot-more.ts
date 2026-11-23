import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { cardHistory, editsSinceLastLearning, getActiveCard, LEARN_MIN, loadStyleCardForDrafting, pendingLearning, recentEdits, saveCardVersion, addSamples } from "./data";
import { parseFile, parsePlainText } from "./import";
import { addByLink, generateQuotesFor, markQuoted, ownInspiration, setInspirationStatus, syncBookmarks, BOOKMARK_SCOPE, type InspirationRow } from "./inspiration";
import { generateLong, LENGTH_SPEC, type LongFormat, type LongLength } from "./longform";
import { PROMO_KIND_LABEL, PROMO_MODE_LABEL, PROMO_MODES, type PromoKind, type PromoMode } from "./promo";
import { getPromoLink, getPromoSettings, listPromoLinks, PromoLinkFields, savePromoSettings } from "./promo-data";
import { createJob } from "./publish";
import type { StyleTraits } from "./style-card";
import { StyleError, BLIND_PAIRS, createBlindTest, createLearning, decideLearning, generateStyleCard, rollbackCard, submitBlindTest, blindHistory } from "./style-actions";
import { botToken, callBot, editButtons, editMessage, sendMessage, type Keyboard } from "./tg-api";
import { addChannel, listSources, removeSource } from "./tg-feed";
import { ChannelError, parseChannelHandle } from "./tg-channel";
import { clearAwait, clip, defaultPromo, ensureCard, errButtons, errText, getState, sendErr, setState, tweetUrl } from "./tg-bot-core";
import { longformItem, requireActive, withCharge } from "./billing";
import { loadDraft, saveParts, showDraft } from "./tg-bot";
import { nudgeAfterFirstCard, TG_X_LANDING } from "./tg-bot-home";

/** 写长文并按价目表扣费（列提纲不扣，但要余额高于停用线、每天有次数上限） */
async function runLong(userId: string, ...args: Parameters<typeof generateLong>) {
  const item = longformItem(args[1]);
  if (item) return withCharge(userId, item, () => generateLong(...args));
  await requireActive(userId, "outline");
  return generateLong(...args);
}
import { lt } from "drizzle-orm";
import { authorizeUrl, connectMock, createPkce, getAccount, hasScope, isXConfigured, isXMock, redirectUri } from "./x";

/**
 * 机器人里的其余功能：素材导入、风格卡、推广链接、长文、X 书签与引用推文、风格盲测。
 * 和 tg-bot.ts 一样全部按钮操作；发布前都要用户确认。
 */

// ---------- 素材 ----------

/** Telegram 机器人能下载的文件上限 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function showSamples(userId: string, chatId: string) {
  const db = await getDb();
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.samples)
    .where(eq(schema.samples.userId, userId));
  const card = await getActiveCard(userId);
  await sendMessage(
    chatId,
    "📥 导入你写过的推文（用来学你的文风）\n" +
      `现在有 ${total} 条${total < 5 ? "，至少要 5 条，10 条以上更好" : total < 30 ? "，30 条以上会更像你" : " ✓"}。\n\n` +
      "最简单：点「📋 粘贴推文」，打开你的 X 主页，复制几条你自己写的推文发给我，每条之间空一行。\n\n" +
      "推文很多的话：把 X 官方存档里的 tweets.js 文件直接发给我（X「设置 → 你的账号 → 下载数据存档」），也可以发 .txt / .csv。\n\n" +
      "链接、转推、重复和太短的内容会自动去掉。",
    {
      buttons: [
        [
          { text: "📋 粘贴推文", callback_data: "sp" },
          { text: card ? "🎨 更新风格卡" : "🎨 生成风格卡", callback_data: "cg" },
        ],
      ],
    },
  );
}

async function importResult(chatId: string, r: { added: number; duplicate: number; tooShort: number }, extra = "") {
  await sendMessage(
    chatId,
    `导入完成：新增 ${r.added} 条${r.duplicate ? `，重复 ${r.duplicate} 条` : ""}${r.tooShort ? `，太短跳过 ${r.tooShort} 条` : ""}${extra}。`,
    { buttons: r.added ? [[{ text: "🎨 用这些素材生成风格卡", callback_data: "cg" }]] : undefined },
  );
}

/** 用户发来文件：当作素材导入 */
export async function handleDocument(
  userId: string,
  chatId: string,
  doc: { file_id: string; file_name?: string; file_size?: number },
) {
  const name = doc.file_name ?? "file.txt";
  if (!/\.(js|txt|md|csv)$/i.test(name)) {
    await sendMessage(chatId, "只支持 tweets.js、.txt、.md、.csv 文件。图片和其他文件暂时用不上。");
    return;
  }
  if ((doc.file_size ?? 0) > MAX_FILE_BYTES) {
    await sendMessage(chatId, "文件超过 20MB，Telegram 不让机器人下载。请在网页上的「素材」页上传，或者只发 tweets.js 这一个文件。");
    return;
  }
  const wait = await sendMessage(chatId, "正在读取文件…");
  try {
    const file = await callBot<{ file_path: string }>("getFile", { file_id: doc.file_id });
    const base = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
    const res = await fetch(`${base}/file/bot${botToken()}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`下载失败（${res.status}）`);
    const { samples, source, retweets } = parseFile(name, await res.text());
    if (!samples.length) {
      await editMessage(chatId, wait.message_id, "文件里没有找到推文。");
      return;
    }
    let total = { added: 0, duplicate: 0, tooShort: 0 };
    for (let i = 0; i < samples.length; i += 2000) {
      const r = await addSamples(userId, samples.slice(i, i + 2000), source);
      total = { added: total.added + r.added, duplicate: total.duplicate + r.duplicate, tooShort: total.tooShort + r.tooShort };
    }
    await editMessage(chatId, wait.message_id, "读取完成");
    await importResult(chatId, total, retweets ? `，转推 ${retweets} 条不算` : "");
  } catch (e) {
    await editMessage(chatId, wait.message_id, `导入失败：${e instanceof Error ? e.message : e}`);
  }
}

async function importPasted(userId: string, chatId: string, text: string) {
  await clearAwait(userId);
  const items = parsePlainText(text);
  if (!items.length) {
    await sendMessage(chatId, "没有找到内容。");
    return;
  }
  await importResult(chatId, await addSamples(userId, items, "paste"));
}

// ---------- 风格卡 ----------

const TRAIT_FIELDS: { key: keyof StyleTraits; label: string; list: boolean }[] = [
  { key: "catchphrases", label: "常用词 / 口头禅", list: true },
  { key: "bannedWords", label: "从不使用的词", list: true },
  { key: "openings", label: "开头方式", list: false },
  { key: "stance", label: "观点表达", list: false },
  { key: "humor", label: "幽默类型", list: false },
  { key: "topics", label: "话题领域", list: true },
  { key: "notes", label: "其他习惯", list: false },
];

const SOURCE_LABEL: Record<string, string> = { generated: "AI 生成", edited: "手动修改", learned: "学习修改", rollback: "恢复旧版" };

function traitsText(t: StyleTraits) {
  return TRAIT_FIELDS.map((f) => {
    const v = t[f.key];
    return `${f.label}：${Array.isArray(v) ? v.join("、") || "无" : v || "无"}`;
  }).join("\n");
}

export async function showStyleCard(userId: string, chatId: string) {
  const card = await getActiveCard(userId);
  if (!card) {
    await sendMessage(chatId, "还没有风格卡。先导入至少 5 条你写过的推文（建议 30 条以上），再生成。", {
      buttons: [
        [
          { text: "📥 导入素材", callback_data: "sm" },
          { text: "🎨 生成风格卡", callback_data: "cg" },
        ],
      ],
    });
    return;
  }
  const [newEdits, pending] = await Promise.all([editsSinceLastLearning(userId), pendingLearning(userId)]);
  const buttons: Keyboard = [
    [
      { text: "✏️ 修改", callback_data: "ce" },
      { text: "🔄 重新生成", callback_data: "cg" },
      { text: "🕘 历史版本", callback_data: "ch" },
    ],
  ];
  if (!pending && newEdits.length >= LEARN_MIN) buttons.push([{ text: `🧠 总结我最近 ${newEdits.length} 次修改`, callback_data: "cl" }]);
  await sendMessage(chatId, `风格卡 v${card.version}（${SOURCE_LABEL[card.source] ?? card.source}）\n\n${traitsText(card.traits)}`, { buttons });
  if (pending) await showLearning(chatId, pending.id, pending.suggestion);
}

async function showLearning(chatId: string, id: string, suggestion: { observations: string[]; traits: StyleTraits }) {
  await sendMessage(
    chatId,
    `根据你的修改，AI 发现：\n${suggestion.observations.map((o) => `• ${o}`).join("\n")}\n\n建议的风格卡：\n${traitsText(suggestion.traits)}`,
    {
      buttons: [
        [
          { text: "✅ 采纳", callback_data: `cla:${id}` },
          { text: "忽略", callback_data: `cld:${id}` },
        ],
      ],
    },
  );
}

async function regenerateCard(userId: string, chatId: string) {
  const wait = await sendMessage(chatId, "正在分析你的文风，稍等…");
  try {
    const r = await generateStyleCard(userId);
    await editMessage(chatId, wait.message_id, `风格卡 v${r.version} 已生成（分析了 ${r.analyzed} 条素材）✓`);
    await showStyleCard(userId, chatId);
    if (r.version === 1) await nudgeAfterFirstCard(userId, chatId);
  } catch (e) {
    const fewSamples = e instanceof StyleError && e.message.includes("条素材");
    await editMessage(chatId, wait.message_id, errText(e), fewSamples ? [[{ text: "📋 粘贴推文", callback_data: "sp" }]] : errButtons(e));
  }
}

async function saveTrait(userId: string, chatId: string, field: string, text: string) {
  await clearAwait(userId);
  const f = TRAIT_FIELDS.find((x) => x.key === field);
  const card = await getActiveCard(userId);
  if (!f || !card) return sendMessage(chatId, "风格卡不存在了，请重新打开。");
  const value = f.list
    ? text
        .split(/[、,，;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 30)
    : text.trim().slice(0, f.key === "notes" ? 1000 : 300);
  const row = await saveCardVersion(userId, card.lang, { ...card.traits, [f.key]: value }, "edited");
  await sendMessage(chatId, `已保存为风格卡 v${row.version} ✓`);
  await showStyleCard(userId, chatId);
}

// ---------- 推广链接 ----------

function guessKind(url: string): PromoKind {
  if (/t\.me|telegram/i.test(url)) return "tg";
  if (/qq\.com|^\d{5,12}$/i.test(url)) return "qq";
  if (/discord/i.test(url)) return "discord";
  if (/weixin|wechat|mp\.weixin/i.test(url)) return "wechat";
  return "other";
}

export async function showPromo(userId: string, chatId: string, messageId?: number) {
  const [links, settings] = await Promise.all([listPromoLinks(userId), getPromoSettings(userId)]);
  const lines = [
    "推广链接：起草时可以在结尾带上你的 TG 群、QQ 群等。",
    `现在：${PROMO_MODE_LABEL[settings.mode]}`,
    "",
    ...(links.length
      ? links.map((l, i) => `${i + 1}. [${PROMO_KIND_LABEL[l.kind]}] ${l.name}${l.id === settings.defaultId ? "（默认）" : ""}\n   ${l.url}${l.blurb ? `\n   引导语：${l.blurb}` : ""}`)
      : ["还没有推广链接。"]),
  ];
  const buttons: Keyboard = [
    PROMO_MODES.map((m) => ({
      text: `${settings.mode === m ? "✓ " : ""}${m === "always" ? "每篇都带" : m === "ask" ? "每篇自己选" : "不带"}`,
      callback_data: `pm:${m}`,
    })),
    ...links.map((l, i) => [
      ...(l.id === settings.defaultId ? [] : [{ text: `设 ${i + 1} 为默认`, callback_data: `pd:${l.id}` }]),
      { text: `删除 ${i + 1}`, callback_data: `px:${l.id}` },
    ]),
    [{ text: "➕ 添加推广链接", callback_data: "pa" }],
  ];
  if (messageId) await editMessage(chatId, messageId, lines.join("\n"), buttons);
  else await sendMessage(chatId, lines.join("\n"), { buttons });
}

async function addPromo(userId: string, chatId: string, text: string) {
  const [name, url, blurb = ""] = text.split("\n").map((x) => x.trim());
  const parsed = PromoLinkFields.safeParse({ kind: guessKind(url ?? ""), name, url, blurb });
  if (!parsed.success || !url) {
    await sendMessage(chatId, "格式不对。请分三行发：\n第一行 名称\n第二行 链接或群号\n第三行 引导语（可以不写）\n发 /cancel 取消。");
    return;
  }
  await clearAwait(userId);
  const db = await getDb();
  const [row] = await db.insert(schema.promoLinks).values({ userId, ...parsed.data }).returning({ id: schema.promoLinks.id });
  const settings = await getPromoSettings(userId);
  if (!settings.defaultId) await savePromoSettings(userId, { defaultId: row.id });
  await sendMessage(chatId, `已添加「${parsed.data.name}」✓`);
  await showPromo(userId, chatId);
}

// ---------- 长文 ----------

const FORMAT_LABEL: Record<LongFormat, string> = { single: "单条长推", thread: "串推", article: "X 长文" };
const LENGTH_LABEL: Record<LongLength, string> = { short: "短", medium: "中", long: "长" };

export async function showLongMenu(chatId: string) {
  await sendMessage(
    chatId,
    "写长一点的内容，选一种形式：\n• 单条长推：一条写一两百字（超过 280 加权字数需要 X Premium）\n• 串推：多条连起来的线程，先列提纲再写\n• X 长文：带标题和小标题的文章（在 X 网页上发布）",
    {
      buttons: [
        (["single", "thread", "article"] as const).map((f) => ({ text: FORMAT_LABEL[f], callback_data: `lf:${f}` })),
      ],
    },
  );
}

async function askLength(chatId: string, format: LongFormat, messageId: number) {
  await editMessage(chatId, messageId, `${FORMAT_LABEL[format]}：写多长？`, [
    (["short", "medium", "long"] as const).map((l) => ({
      text: `${LENGTH_LABEL[l]}（${LENGTH_SPEC[format][l]}）`,
      callback_data: `ll:${format}:${l}`,
    })),
  ]);
}

async function longCandidates(userId: string, chatId: string, format: LongFormat, length: LongLength, topic: string) {
  const card = await ensureCard(userId, chatId, topic);
  if (!card) return;
  const wait = await sendMessage(chatId, format === "single" ? "正在写…" : "正在列提纲…");
  try {
    const edits = await recentEdits(userId, 10);
    const promo = await defaultPromo(userId);
    const token = randomBytes(4).toString("hex");
    if (format === "single") {
      const r = await runLong(userId, card, { kind: "candidates", format: "single", length, topic, notes: "", count: 3 }, edits, promo);
      await setState(userId, { await: undefined, long: { token, format, length, topic, title: "", outline: [], candidates: r.items } });
      await editMessage(chatId, wait.message_id, `${r.items.map((c, i) => `【${i + 1}】\n${c}`).join("\n\n")}\n\n选一条，选完还能改。`, [
        r.items.map((_, i) => ({ text: `选 ${i + 1}`, callback_data: `lpk:${token}:${i}` })),
        [{ text: "🔄 换一批", callback_data: `lre:${token}` }],
      ]);
      return;
    }
    const r = await runLong(userId, card, { kind: "outline", format, length, topic, notes: "" }, edits, promo);
    await setState(userId, { await: undefined, long: { token, format, length, topic, title: r.title, outline: r.items } });
    await editMessage(chatId, wait.message_id, outlineText(r.title, r.items), outlineButtons(token));
  } catch (e) {
    await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
  }
}

function outlineText(title: string, outline: string[]) {
  return `标题：${title}\n\n提纲：\n${outline.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\n满意就按提纲写全文，也可以先改提纲。`;
}

function outlineButtons(token: string): Keyboard {
  return [
    [{ text: "✍️ 按提纲写全文", callback_data: `lw:${token}` }],
    [
      { text: "✏️ 改提纲", callback_data: `le:${token}` },
      { text: "🔄 重新列", callback_data: `lre:${token}` },
    ],
  ];
}

async function saveOutline(userId: string, chatId: string, text: string) {
  const { long } = await getState(userId);
  if (!long) {
    await clearAwait(userId);
    return sendMessage(chatId, "长文已经过期了，请重新开始。");
  }
  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  let title = long.title;
  if (lines[0] && /^标题[:：]/.test(lines[0])) title = lines.shift()!.replace(/^标题[:：]\s*/, "");
  const outline = lines.map((x) => x.replace(/^\d+[.、)）]\s*/, "")).filter(Boolean).slice(0, 20);
  if (!outline.length) return sendMessage(chatId, "没看到提纲内容，请一行一点发给我。");
  await setState(userId, { await: undefined, long: { ...long, title, outline } });
  await sendMessage(chatId, outlineText(title, outline), { buttons: outlineButtons(long.token) });
}

async function writeLong(userId: string, chatId: string, token: string, messageId: number) {
  const { long } = await getState(userId);
  if (!long || long.token !== token) return sendMessage(chatId, "这个提纲已经过期了，请重新开始。");
  const card = await ensureCard(userId, chatId, long.topic);
  if (!card) return;
  await editButtons(chatId, messageId, [[{ text: "正在写全文，可能要一两分钟…", callback_data: "noop" }]]);
  try {
    const edits = await recentEdits(userId, 10);
    const promo = await defaultPromo(userId);
    const r = await runLong(
      userId,
      card,
      { kind: "write", format: long.format, length: long.length, topic: long.topic, notes: "", title: long.title, outline: long.outline },
      edits,
      promo,
    );
    const id = await createLongDraft(userId, long.format, long.topic, r.items, {
      title: r.title || long.title,
      outline: long.outline,
      length: long.length,
      numbered: true,
    });
    await editButtons(chatId, messageId, []);
    await showDraft(userId, chatId, id);
  } catch (e) {
    await editButtons(chatId, messageId, outlineButtons(token));
    await sendErr(chatId, e);
  }
}

async function createLongDraft(
  userId: string,
  format: LongFormat,
  topic: string,
  parts: string[],
  meta: { title?: string; outline?: string[]; length?: LongLength; numbered?: boolean },
) {
  const db = await getDb();
  const card = await loadStyleCardForDrafting(userId);
  const [row] = await db
    .insert(schema.drafts)
    .values({
      userId,
      topic,
      mode: format,
      sentences: parts.map((t) => ({ text: t, original: t, locked: false })),
      finalText: "",
      meta,
      styleCardVersion: card?.version ?? null,
    })
    .returning();
  const d = await loadDraft(userId, row.id);
  if (d) await saveParts(userId, d, parts);
  return row.id;
}

async function pickLongSingle(userId: string, chatId: string, token: string, index: number, messageId: number) {
  const { long } = await getState(userId);
  const text = long?.token === token ? long.candidates?.[index] : undefined;
  if (!long || !text) return sendMessage(chatId, "这批候选已经过期了，请重新开始。");
  const parts = text
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const id = await createLongDraft(userId, "single", long.topic, parts, { length: long.length });
  await editButtons(chatId, messageId, [[{ text: `已选第 ${index + 1} 条 ✓`, callback_data: "noop" }]]);
  await showDraft(userId, chatId, id);
}

/** 串推 / 长文按段修改：「3 新内容」直接替换，「换 3 要求」让 AI 写 3 个替换候选 */
async function editPart(userId: string, chatId: string, draftId: string, text: string) {
  const d = await loadDraft(userId, draftId);
  if (!d) {
    await clearAwait(userId);
    return sendMessage(chatId, "找不到这篇草稿。");
  }
  const parts = d.sentences.map((x) => x.text);
  const ai = text.match(/^换\s*(\d+)\s*([\s\S]*)$/);
  if (ai) {
    const position = Number(ai[1]) - 1;
    if (position < 0 || position >= parts.length) return sendMessage(chatId, `编号要在 1 到 ${parts.length} 之间。`);
    const card = await ensureCard(userId, chatId, d.topic);
    if (!card) return;
    const wait = await sendMessage(chatId, "正在写…");
    try {
      const r = await runLong(
        userId,
        card,
        {
          kind: "rewrite",
          format: d.mode as LongFormat,
          topic: d.topic,
          notes: d.meta?.notes ?? "",
          title: d.meta?.title ?? "",
          parts,
          position,
          instruction: ai[2].trim(),
          count: 3,
        },
        await recentEdits(userId, 10),
        await defaultPromoFor(userId, parts[position]),
      );
      const { long } = await getState(userId);
      const token = long?.token ?? randomBytes(4).toString("hex");
      await setState(userId, {
        long: {
          ...(long ?? { token, format: d.mode as LongFormat, length: "medium", topic: d.topic, title: "", outline: [] }),
          rewrite: { draftId, position, candidates: r.items },
        },
      });
      await editMessage(chatId, wait.message_id, `第 ${position + 1} 段的替换：\n\n${r.items.map((c, i) => `【${i + 1}】\n${c}`).join("\n\n")}`, [
        r.items.map((_, i) => ({ text: `用 ${i + 1}`, callback_data: `lrp:${i}` })),
        [{ text: "保持原样", callback_data: `dr0:${draftId}` }],
      ]);
    } catch (e) {
      await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
    }
    return;
  }
  const m = text.match(/^(\d+)[\s.、:：]+([\s\S]+)$/);
  if (!m) return sendMessage(chatId, "格式：「3 新内容」直接替换第 3 段，或「换 3」让 AI 重写。发 /cancel 结束修改。");
  const position = Number(m[1]) - 1;
  if (position < 0 || position >= parts.length) return sendMessage(chatId, `编号要在 1 到 ${parts.length} 之间。`);
  await replacePart(userId, chatId, draftId, position, m[2].trim());
}

/** 被换的那段本来带着推广链接时，替换候选也要带 */
async function defaultPromoFor(userId: string, part: string) {
  const settings = await getPromoSettings(userId);
  const link = await getPromoLink(userId, settings.defaultId);
  return link && part.includes(link.url.trim()) ? link : null;
}

async function replacePart(userId: string, chatId: string, draftId: string, position: number, text: string) {
  const d = await loadDraft(userId, draftId);
  if (!d) return sendMessage(chatId, "找不到这篇草稿。");
  const parts = d.sentences.map((x) => x.text);
  const old = parts[position];
  parts[position] = text;
  await saveParts(userId, d, parts);
  if (old && old.trim() !== text.trim()) {
    const db = await getDb();
    await db.insert(schema.editLogs).values({ userId, draftId, original: old, edited: text });
  }
  await sendMessage(chatId, `第 ${position + 1} 段已更新 ✓ 继续发「编号 + 内容」改别的，或发 /cancel 结束。`);
  await showDraft(userId, chatId, draftId);
}

// ---------- 连接 X ----------

/**
 * 在机器人里连接 X：直接给出 X 的授权链接（授权状态存数据库，不需要网页登录）。
 * 用的是平台自己的 X 应用，顾客不需要任何开发者密钥。
 * 授权完成后先落到 /x-connected 页面，同时机器人发消息告诉结果和下一步。
 */
export async function sendConnectX(userId: string, chatId: string, why: string) {
  if (!isXConfigured()) {
    await sendMessage(chatId, `${why}平台的 X 连接还没准备好，请稍后再试，或联系客服。`);
    return;
  }
  if (isXMock()) {
    await connectMock(userId);
    await sendMessage(chatId, "已连接 X（测试模式）✓");
    return;
  }
  const { verifier, challenge, state } = createPkce();
  const db = await getDb();
  await db.delete(schema.xOauthStates).where(lt(schema.xOauthStates.expiresAt, new Date()));
  await db.insert(schema.xOauthStates).values({
    state,
    userId,
    codeVerifier: verifier,
    returnTo: `${new URL(redirectUri()).origin}${TG_X_LANDING}`,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const local = /^(127\.0\.0\.1|localhost)$/.test(new URL(redirectUri()).hostname);
  await sendMessage(chatId, connectXText(why, local), {
    buttons: [[{ text: "🔗 去 X 授权", url: authorizeUrl(state, challenge) }]],
  });
}

export function connectXText(why: string, local = false) {
  return (
    (why ? `${why}\n\n` : "") +
    "🔑 连接你的 X 账号（约 1 分钟）\n" +
    "1. 点下面「🔗 去 X 授权」\n" +
    "2. 在打开的 X 页面上点「Authorize app」（授权应用）\n" +
    "3. 看到「连接成功」就可以关掉页面回到这里，我会发消息告诉你\n\n" +
    "小提示：\n" +
    "• 想用哪个 X 号发推，就先登录哪个号再授权（X 页面上会显示当前登录的账号）\n" +
    "• 在 Telegram 里打开后要你重新登录 X 的话，点右上角「⋯」选「在浏览器中打开」会更顺\n" +
    "• 你不需要申请任何开发者账号或密钥\n" +
    "• 链接 10 分钟内有效，过期了再点一次「🔑 连接 X」" +
    (local ? "\n注意：要在运行 VoiceDraft 的那台电脑上打开这个链接。" : "")
  );
}

// ---------- X 书签与引用推文 ----------

export async function showX(userId: string, chatId: string) {
  const acc = await getAccount(userId);
  if (!acc || acc.authError) {
    await sendConnectX(userId, chatId, acc ? "X 授权已失效，需要重新连接。" : "还没有连接 X 账号。");
    return;
  }
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.inspirations)
    .where(and(eq(schema.inspirations.userId, userId), eq(schema.inspirations.status, "new")))
    .orderBy(desc(schema.inspirations.createdAt))
    .limit(5);
  const footer: Keyboard = [
    [
      hasScope(acc, BOOKMARK_SCOPE) ? { text: "🔄 同步书签", callback_data: "xs" } : { text: "🔑 重新授权", callback_data: "xc" },
      { text: "🔗 贴推文链接", callback_data: "xl" },
    ],
  ];
  if (!items.length) {
    await sendMessage(
      chatId,
      `X 书签和推文：还没有待处理的。${hasScope(acc, BOOKMARK_SCOPE) ? "点「同步书签」把你在 X 上收藏的推文拿过来。" : "读取书签需要重新授权一次（点「重新授权」）。"}也可以贴一条推文链接。`,
      { buttons: footer },
    );
    return;
  }
  await sendMessage(chatId, `X 书签 / 推文（${items.length} 条待处理）：`);
  for (const it of items) await sendXItem(chatId, it);
  await sendMessage(chatId, "还可以：", { buttons: footer });
}

async function sendXItem(chatId: string, it: InspirationRow) {
  await sendMessage(chatId, `@${it.authorHandle}${it.authorName ? `（${it.authorName}）` : ""}：\n${clip(it.text, 600)}\n${tweetUrl(it.authorHandle, it.tweetId)}`, {
    buttons: [
      [
        { text: "💬 写引用", callback_data: `xq:${it.id}` },
        { text: "✍️ 用它起草", callback_data: `xd:${it.id}` },
        { text: "🙈 不感兴趣", callback_data: `xx:${it.id}` },
      ],
    ],
  });
}

async function writeQuotes(userId: string, chatId: string, id: string) {
  const wait = await sendMessage(chatId, "正在写引用…");
  try {
    const item = await ownInspiration(userId, id);
    const promo = await defaultPromo(userId);
    const row = await generateQuotesFor(userId, item, promo);
    const c = row?.quoteCandidates ?? [];
    if (!c.length) {
      await editMessage(chatId, wait.message_id, "没有写出合适的引用，换一条试试。");
      return;
    }
    await editMessage(chatId, wait.message_id, `引用 @${item.authorHandle} 时附上：\n\n${c.map((x, i) => `【${i + 1}】\n${x}`).join("\n\n")}`, [
      c.map((_, i) => ({ text: `用 ${i + 1}`, callback_data: `xu:${id}:${i}` })),
      [
        { text: "✏️ 自己写", callback_data: `xw:${id}` },
        { text: "🔄 换一批", callback_data: `xq:${id}` },
      ],
    ]);
  } catch (e) {
    await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
  }
}

async function confirmQuote(userId: string, chatId: string, inspId: string, text: string) {
  const item = await ownInspiration(userId, inspId);
  await setState(userId, { await: undefined, quote: { inspId, tweetId: item.tweetId, handle: item.authorHandle, text } });
  const acc = await getAccount(userId);
  await sendMessage(chatId, `将引用 @${item.authorHandle} 的推文，发布：\n\n${text}`, {
    buttons: [
      [
        { text: `✅ 确认发到 @${acc?.handle ?? "X"}`, callback_data: "xp" },
        { text: "取消", callback_data: "noop:cancel" },
      ],
    ],
  });
}

async function publishQuote(userId: string, chatId: string, messageId: number) {
  const { quote } = await getState(userId);
  if (!quote) return sendMessage(chatId, "这条引用已经过期了，请重新写。");
  await editButtons(chatId, messageId, [[{ text: "发布中…", callback_data: "noop" }]]);
  try {
    const row = await createJob(userId, { tweets: [quote.text], quoteTweetId: quote.tweetId });
    if (row.status === "published") {
      await markQuoted(userId, quote.tweetId);
      await setState(userId, { quote: undefined });
      await editButtons(chatId, messageId, []);
      await sendMessage(chatId, `已引用发布 ✓\n${tweetUrl(row.handle, row.postIds[0])}`);
    } else {
      await editButtons(chatId, messageId, [[{ text: "🔁 再试一次", callback_data: "xp" }]]);
      await sendMessage(chatId, `发布失败：${row.error ?? "未知原因"}`);
    }
  } catch (e) {
    await editButtons(chatId, messageId, [[{ text: "🔁 再试一次", callback_data: "xp" }]]);
    await sendErr(chatId, e);
  }
}

// ---------- 公开频道 ----------

const MAX_SOURCES = 50;

export async function showChannels(userId: string, chatId: string, messageId?: number) {
  const rows = await listSources(userId);
  const text = rows.length
    ? `订阅的公开频道（每 30 分钟检查一次新消息，收进灵感）：\n${rows
        .map((r, i) => `${i + 1}. ${r.title ?? r.handle}（@${r.handle}）${r.error ? `\n   ⚠️ ${r.error}` : ""}`)
        .join("\n")}`
    : "还没有订阅频道。订阅后，频道的新消息会自动收进灵感（只能订阅公开频道）。";
  const buttons: Keyboard = [
    ...rows.slice(0, 20).map((r, i) => [{ text: `取消订阅 ${i + 1}`, callback_data: `chx:${r.id}` }]),
    [{ text: "➕ 订阅频道", callback_data: "cha" }],
  ];
  if (messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, { buttons });
}

async function subscribeChannel(userId: string, chatId: string, input: string) {
  const handle = parseChannelHandle(input);
  if (!handle) return sendMessage(chatId, "请发公开频道的用户名或链接，例如 @durov 或 https://t.me/durov。发 /cancel 取消。");
  await clearAwait(userId);
  if ((await listSources(userId)).length >= MAX_SOURCES) return sendMessage(chatId, `最多订阅 ${MAX_SOURCES} 个频道。`);
  const wait = await sendMessage(chatId, "正在读取频道…");
  try {
    const r = await addChannel(userId, handle);
    await editMessage(chatId, wait.message_id, `已订阅「${r.title}」✓ 先收进了最近 ${r.added} 条。`);
  } catch (e) {
    await editMessage(chatId, wait.message_id, e instanceof ChannelError ? e.message : "订阅失败，请稍后再试。");
  }
}

// ---------- 盲测 ----------

function blindButtons(picks: number[], total: number): Keyboard {
  const nums = Array.from({ length: total }, (_, i) => ({
    text: picks.includes(i) ? `${i + 1} 🤖` : `${i + 1}`,
    callback_data: `bp:${i}`,
  }));
  return [nums.slice(0, 5), nums.slice(5, 10), [{ text: `提交（已选 ${picks.length} 条）`, callback_data: "bs" }]];
}

export async function startBlind(userId: string, chatId: string) {
  const history = await blindHistory(userId, 3);
  const wait = await sendMessage(
    chatId,
    `风格盲测：下面会有 ${BLIND_PAIRS * 2} 条推文，${BLIND_PAIRS} 条是你写的，${BLIND_PAIRS} 条是 AI 按你的风格卡写的。挑出你认为是 AI 写的。\n正在准备…`,
  );
  try {
    const t = await createBlindTest(userId);
    await setState(userId, { blind: { id: t.id, picks: [] } });
    await editMessage(chatId, wait.message_id, `挑出 ${t.aiCount} 条 AI 写的（点编号，带 🤖 的是你选的）：\n\n${t.items.map((x, i) => `${i + 1}. ${x}`).join("\n\n")}`, blindButtons([], t.items.length));
    if (history.length) {
      await sendMessage(chatId, `之前的误判率：${history.map((h) => `v${h.styleCardVersion} ${h.misjudgeRate}%`).join("，")}（越高说明越像你）`);
    }
  } catch (e) {
    await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
  }
}

async function toggleBlind(userId: string, chatId: string, index: number, messageId: number) {
  const { blind } = await getState(userId);
  if (!blind) return "这次盲测已经结束了";
  const picks = blind.picks.includes(index) ? blind.picks.filter((x) => x !== index) : [...blind.picks, index];
  await setState(userId, { blind: { ...blind, picks } });
  await editButtons(chatId, messageId, blindButtons(picks, BLIND_PAIRS * 2));
}

async function finishBlind(userId: string, chatId: string, messageId: number) {
  const { blind } = await getState(userId);
  if (!blind) return sendMessage(chatId, "这次盲测已经结束了。");
  try {
    const r = await submitBlindTest(userId, blind.id, blind.picks);
    await setState(userId, { blind: undefined });
    await editButtons(chatId, messageId, []);
    const lines = r.answers.map((isAi, i) => {
      const guessed = blind.picks.includes(i);
      return `${i + 1}. ${isAi ? "🤖 AI" : "🙋 你"}${guessed === isAi ? "" : "（猜错）"}：${clip(r.texts[i], 40)}`;
    });
    await sendMessage(
      chatId,
      `误判率 ${r.misjudgeRate}%（猜错 ${r.wrong}/${r.total}）。${r.misjudgeRate >= 40 ? "AI 写得已经挺像你了。" : "还能更像：多导入一些素材、多改改候选，风格卡会越来越准。"}\n\n${lines.join("\n")}`,
    );
  } catch (e) {
    await sendErr(chatId, e);
  }
}

// ---------- 更多 ----------

// ---------- 入口 ----------

/** 正在等的输入（素材、风格卡字段、推广链接、长文主题 / 提纲、按段修改、推文链接、引用）；返回 true 表示已处理 */
export async function handleMoreAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const { await: waiting } = await getState(userId);
  switch (waiting?.kind) {
    case "samples":
      await importPasted(userId, chatId, text);
      return true;
    case "trait":
      await saveTrait(userId, chatId, waiting.field, text);
      return true;
    case "promo":
      await addPromo(userId, chatId, text);
      return true;
    case "long":
      await longCandidates(userId, chatId, waiting.format, waiting.length, text.trim());
      return true;
    case "outline":
      await saveOutline(userId, chatId, text);
      return true;
    case "part":
      await editPart(userId, chatId, waiting.draftId, text.trim());
      return true;
    case "xlink": {
      await clearAwait(userId);
      try {
        const item = await addByLink(userId, text.trim());
        await sendXItem(chatId, item);
      } catch (e) {
        await sendErr(chatId, e);
      }
      return true;
    }
    case "channel":
      await subscribeChannel(userId, chatId, text.trim());
      return true;
    case "quote":
      await confirmQuote(userId, chatId, waiting.inspId, text.trim());
      return true;
  }
  return false;
}

/** 这些功能的按钮；返回 undefined 表示已处理，字符串是给用户的提示，null 表示不是这里的按钮 */
export async function handleMoreCallback(
  userId: string,
  chatId: string,
  action: string,
  a: string,
  b: string,
  mid: number,
  showHelp: () => Promise<void>,
): Promise<string | undefined | null> {
  switch (action) {
    // 素材
    case "sm":
      await showSamples(userId, chatId);
      return;
    case "sp":
      await setState(userId, { await: { kind: "samples" } });
      await sendMessage(
        chatId,
        "📋 把你写过的推文发给我，每条之间空一行，一次可以发很多条。例如：\n\n" +
          "今天又被行情教育了，追高的手真该剁掉。\n\n" +
          "周末读完《穷查理宝典》，最大的收获是：先想清楚怎么不亏。\n\n" +
          "发完点「🎨 生成文风」就好。发 /cancel 取消。",
      );
      return;
    // 风格卡
    case "cg":
      await regenerateCard(userId, chatId);
      return;
    case "ce":
      await editButtons(chatId, mid, [
        ...[0, 3].map((start) => TRAIT_FIELDS.slice(start, start + 3).map((f) => ({ text: f.label, callback_data: `cf:${f.key}` }))),
        [{ text: TRAIT_FIELDS[6].label, callback_data: `cf:${TRAIT_FIELDS[6].key}` }],
      ]);
      return;
    case "cf": {
      const f = TRAIT_FIELDS.find((x) => x.key === a);
      const card = await getActiveCard(userId);
      if (!f || !card) return "风格卡不存在了";
      await setState(userId, { await: { kind: "trait", field: f.key } });
      const v = card.traits[f.key];
      await sendMessage(
        chatId,
        `发给我新的「${f.label}」${f.list ? "（多个用顿号或逗号隔开）" : ""}，会保存为新版本。发 /cancel 取消。\n\n现在是：`,
      );
      await sendMessage(chatId, Array.isArray(v) ? v.join("、") || "（空）" : v || "（空）");
      return;
    }
    case "ch": {
      const history = (await cardHistory(userId)).slice(0, 8);
      if (!history.length) return "还没有历史版本";
      await sendMessage(
        chatId,
        `历史版本（点一个恢复，会另存为新版本）：\n${history
          .map((h) => `v${h.version} · ${SOURCE_LABEL[h.source] ?? h.source} · ${h.createdAt.toLocaleDateString("zh-CN")}${h.isActive ? "（当前）" : ""}`)
          .join("\n")}`,
        { buttons: [history.filter((h) => !h.isActive).slice(0, 6).map((h) => ({ text: `恢复 v${h.version}`, callback_data: `cr:${h.id}` }))].filter((r) => r.length) },
      );
      return;
    }
    case "cr": {
      try {
        const r = await rollbackCard(userId, a);
        await editButtons(chatId, mid, []);
        await sendMessage(chatId, `已恢复 v${r.from} 的内容，保存为 v${r.version} ✓`);
      } catch (e) {
        return errText(e);
      }
      return;
    }
    case "cl": {
      const wait = await sendMessage(chatId, "正在总结你的修改习惯…");
      try {
        const row = await createLearning(userId);
        await editMessage(chatId, wait.message_id, "总结好了：");
        await showLearning(chatId, row.id, row.suggestion);
      } catch (e) {
        await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
      }
      return;
    }
    case "cla":
    case "cld":
      try {
        const r = await decideLearning(userId, a, action === "cla" ? "accept" : "dismiss");
        await editButtons(chatId, mid, [[{ text: r.version ? `已采纳，风格卡 v${r.version} ✓` : "已忽略", callback_data: "noop" }]]);
      } catch (e) {
        return errText(e);
      }
      return;
    // 推广
    case "mp":
      await showPromo(userId, chatId);
      return;
    case "pm":
      if (!(PROMO_MODES as readonly string[]).includes(a)) return "无效的选项";
      await savePromoSettings(userId, { mode: a as PromoMode });
      await showPromo(userId, chatId, mid);
      return a === "always" ? "起草时会自动带上默认链接" : a === "ask" ? "起草出候选后可以点「带推广重写」" : "已关闭推广";
    case "pd":
      if (!(await getPromoLink(userId, a))) return "找不到这条链接";
      await savePromoSettings(userId, { defaultId: a });
      await showPromo(userId, chatId, mid);
      return;
    case "px": {
      const db = await getDb();
      await db.delete(schema.promoLinks).where(and(eq(schema.promoLinks.id, a), eq(schema.promoLinks.userId, userId)));
      await showPromo(userId, chatId, mid);
      return "已删除";
    }
    case "pa":
      await setState(userId, { await: { kind: "promo" } });
      await sendMessage(chatId, "分三行发给我：\n第一行 名称（例如：独立开发交流群）\n第二行 链接或群号\n第三行 引导语（可以不写，例如：想一起聊的可以进群）");
      return;
    // 长文
    case "lf":
      if (!["single", "thread", "article"].includes(a)) return "无效的选项";
      await askLength(chatId, a as LongFormat, mid);
      return;
    case "ll":
      await setState(userId, { await: { kind: "long", format: a as LongFormat, length: b as LongLength } });
      await editButtons(chatId, mid, []);
      await sendMessage(chatId, `写${FORMAT_LABEL[a as LongFormat]}，主题是什么？可以带上你的观点和想写的要点。`);
      return;
    case "lpk":
      await pickLongSingle(userId, chatId, a, Number(b), mid);
      return;
    case "lre": {
      const { long } = await getState(userId);
      if (!long || long.token !== a) return "已经过期了，请重新开始";
      await editButtons(chatId, mid, []);
      await longCandidates(userId, chatId, long.format, long.length, long.topic);
      return;
    }
    case "lw":
      await writeLong(userId, chatId, a, mid);
      return;
    case "le": {
      const { long } = await getState(userId);
      if (!long || long.token !== a) return "已经过期了，请重新开始";
      await setState(userId, { await: { kind: "outline" } });
      await sendMessage(chatId, "把改好的提纲发给我，一行一点；第一行写「标题：…」可以改标题。复制下面这段改最方便：");
      await sendMessage(chatId, [`标题：${long.title}`, ...long.outline.map((o, i) => `${i + 1}. ${o}`)].join("\n"));
      return;
    }
    case "lrp": {
      const { long } = await getState(userId);
      const rw = long?.rewrite;
      const text = rw?.candidates[Number(a)];
      if (!rw || !text) return "已经过期了";
      await editButtons(chatId, mid, [[{ text: `已用第 ${Number(a) + 1} 个 ✓`, callback_data: "noop" }]]);
      await replacePart(userId, chatId, rw.draftId, rw.position, text);
      return;
    }
    case "dr0":
      await editButtons(chatId, mid, []);
      return "保持原样";
    // X 书签
    case "xm":
      await showX(userId, chatId);
      return;
    case "xs": {
      try {
        const r = await syncBookmarks(userId);
        await sendMessage(chatId, r.added ? `同步到 ${r.added} 条新书签 ✓` : "没有新书签。");
        if (r.added) await showX(userId, chatId);
      } catch (e) {
        await sendErr(chatId, e);
      }
      return;
    }
    case "xc":
      await sendConnectX(userId, chatId, "");
      return;
    case "xl":
      await setState(userId, { await: { kind: "xlink" } });
      await sendMessage(chatId, "把推文链接发给我（x.com/用户名/status/数字）。");
      return;
    case "xq":
      await writeQuotes(userId, chatId, a);
      return;
    case "xu": {
      const item = await ownInspiration(userId, a).catch(() => null);
      const text = item?.quoteCandidates[Number(b)];
      if (!text) return "找不到这条候选";
      await confirmQuote(userId, chatId, a, text);
      return;
    }
    case "xw":
      await setState(userId, { await: { kind: "quote", inspId: a } });
      await sendMessage(chatId, "把要附上的话发给我（可以复制候选再改）。");
      return;
    case "xp":
      await publishQuote(userId, chatId, mid);
      return;
    case "xd": {
      const item = await ownInspiration(userId, a).catch(() => null);
      if (!item) return "找不到这条推文";
      await setInspirationStatus(userId, a, "used").catch(() => null);
      await setState(userId, { await: { kind: "topic", ref: `@${item.authorHandle}：${clip(item.text, 1000)}` } });
      await sendMessage(chatId, `参考 @${item.authorHandle} 这条，说说你的看法或想写的角度（一句话就行），我按你的文风写 3 条。不要照搬原文。`);
      return;
    }
    case "xx":
      await setInspirationStatus(userId, a, "dismissed").catch(() => null);
      await editButtons(chatId, mid, []);
      return "已标为不感兴趣";
    // 频道
    case "chs":
      await showChannels(userId, chatId);
      return;
    case "cha":
      await setState(userId, { await: { kind: "channel" } });
      await sendMessage(chatId, "发频道的用户名或链接给我（例如 @durov 或 https://t.me/durov）。");
      return;
    case "chx":
      await removeSource(userId, a, true);
      await showChannels(userId, chatId, mid);
      return "已取消订阅，收进来的内容会保留";
    // 盲测
    case "bt":
      await startBlind(userId, chatId);
      return;
    case "bp":
      return toggleBlind(userId, chatId, Number(a), mid);
    case "bs":
      await finishBlind(userId, chatId, mid);
      return;
    case "hp":
      await showHelp();
      return;
  }
  return null;
}
