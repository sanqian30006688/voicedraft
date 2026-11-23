import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { THEME_LABEL, type Aspect } from "./image-render";
import {
  attachToDraft,
  getImage,
  isImageAiConfigured,
  MAX_IMAGE_BYTES,
  makeAi,
  makeCard,
  nextTheme,
  restyle,
  saveUpload,
  type ImageInfo,
  type RefImage,
} from "./images";
import { draftFinalText } from "./draft-text";
import { downloadFile, editButtons, sendDocument, sendMessage, sendPhoto, type Keyboard } from "./tg-api";
import { clearAwait, errButtons, errText, getState, sendErr, setState } from "./tg-bot-core";

/**
 * 机器人里的配图：
 * 草稿卡片上点「🖼 配图」→ 选信息卡 / AI 配图 / 发一张自己的图 → 预览，可以换风格、换一张、选用。
 * 直接发一张图（例如截图）给机器人 → 做成信息卡，或者按内容让 AI 重新画（不复刻原图）。
 * X 长文的封面是 5:2，选用后以「文件」发回原图，下载后在 X 长文编辑器里上传。
 *
 * 按钮：im:<草稿> 配图菜单；imk:<c|a|p|v>:<草稿或 0> 做一张；igs:<t|h>:<图> 换风格 / 标题开关；
 * igu:<图> 选用；ign:<草稿> 不要图；igf:<图> 发原图文件；igr:<u|c|a> 处理刚发来的图
 */

type DraftRow = typeof schema.drafts.$inferSelect;

async function loadDraft(userId: string, id: string): Promise<DraftRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const [d] = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, userId)))
    .limit(1);
  return d ?? null;
}

function draftText(d: DraftRow): string {
  return d.finalText || draftFinalText(d.mode, d.sentences.map((s) => s.text), d.meta);
}

/** 草稿卡片上的配图按钮 */
export function imageButtonRow(d: { id: string; meta: { imageId?: string } | null }): Keyboard[number] {
  return [{ text: d.meta?.imageId ? "🖼 配图（已选）" : "🖼 配图", callback_data: `im:${d.id}` }];
}

async function showMenu(userId: string, chatId: string, draftId: string) {
  const d = await loadDraft(userId, draftId);
  if (!d) return sendMessage(chatId, "找不到这篇草稿。");
  const article = d.mode === "article";
  const rows: Keyboard = [[{ text: article ? "📝 做文字封面" : "📝 做信息卡", callback_data: `imk:${article ? "v" : "c"}:${d.id}` }]];
  if (isImageAiConfigured()) {
    rows.push([
      { text: "🎨 AI 配图", callback_data: `imk:a:${d.id}` },
      { text: "✨ AI 精品图", callback_data: `imk:p:${d.id}` },
    ]);
  }
  rows.push([{ text: "📎 我发一张图", callback_data: `imu:${d.id}` }]);
  if (d.meta?.imageId) rows.push([{ text: "不要图了", callback_data: `ign:${d.id}` }]);
  await sendMessage(
    chatId,
    [
      article ? "给这篇 X 长文做封面（5:2）：" : "给这篇配图：",
      "📝 信息卡：把要点排版成图，字是程序打的，一个都不会错",
      ...(isImageAiConfigured() ? ["🎨 AI 配图：AI 按内容画一张新图（不带字），标题由程序叠上去"] : []),
      "📎 发一张图给我：可以直接用，也可以让我照着它的内容做信息卡或重新画（不会照搬原图）",
    ].join("\n"),
    { buttons: rows },
  );
}

function resultButtons(img: ImageInfo, draftId: string | null, op: string): Keyboard {
  const rows: Keyboard = [];
  const first: Keyboard[number] = [];
  if (img.kind === "card") first.push({ text: `换风格（${THEME_LABEL[nextTheme(img.spec?.theme)]}）`, callback_data: `igs:t:${img.id}` });
  if (img.kind === "ai") first.push({ text: img.spec?.showTitle ? "去掉标题字" : "加上标题字", callback_data: `igs:h:${img.id}` });
  if (img.kind !== "upload" && draftId) first.push({ text: "🔄 换一张", callback_data: `imk:${op}:${draftId ?? "0"}` });
  if (first.length) rows.push(first);
  if (draftId) {
    rows.push([
      { text: "✅ 用这张", callback_data: `igu:${img.id}` },
      { text: "不要图", callback_data: `ign:${draftId}` },
    ]);
  } else {
    rows.push([{ text: "📄 发原图文件", callback_data: `igf:${img.id}` }]);
  }
  return rows;
}

function opOf(img: ImageInfo): string {
  if (img.kind === "ai") return "a";
  return img.spec?.layout === "cover" ? "v" : "c";
}

async function sendResult(chatId: string, userId: string, img: ImageInfo, op: string, note = "") {
  const full = await getImage(userId, img.id);
  const caption =
    (note ? `${note}\n` : "") +
    (img.kind === "card"
      ? "图上的字是程序排的，不会有错别字。可以换风格（不另收费）。"
      : img.kind === "ai"
        ? "AI 画的新图，标题由程序叠上去。"
        : "用你自己的图。");
  await sendPhoto(chatId, full.data, caption, { buttons: resultButtons(img, full.draftId, op) });
}

/** 做一张：c 信息卡、v 文字封面（5:2）、a AI 配图、p AI 精品图；ref 是刚发来的参考图 */
async function make(userId: string, chatId: string, op: string, draftId: string | null, ref?: RefImage | null, extra = "") {
  const d = draftId ? await loadDraft(userId, draftId) : null;
  if (draftId && !d) return sendMessage(chatId, "找不到这篇草稿。");
  const text = [d ? draftText(d) : "", extra].filter(Boolean).join("\n\n");
  const aspect: Aspect = d?.mode === "article" ? "5:2" : "16:9";
  const wait = await sendMessage(chatId, op === "a" || op === "p" ? "AI 正在画，大约半分钟…" : "正在排版…");
  try {
    if (op === "a" || op === "p") {
      const r = await makeAi(userId, { text, draftId: d?.id, ref, aspect, pro: op === "p" });
      await sendResult(chatId, userId, r.image, r.fellBack ? "c" : op, r.fellBack ? "内容涉及真实人物，AI 画容易被当成造假图，所以改做了信息卡（没按 AI 画图收费）。" : "");
    } else {
      const img = await makeCard(userId, { text, draftId: d?.id, ref, aspect, layout: op === "v" ? "cover" : "card" });
      await sendResult(chatId, userId, img, op);
    }
  } catch (e) {
    await sendMessage(chatId, `配图没做成：${errText(e)}`, { buttons: errButtons(e) });
  } finally {
    await editButtons(chatId, wait.message_id, []);
  }
}

async function pickImage(userId: string, chatId: string, imageId: string, mid: number) {
  const img = await getImage(userId, imageId);
  if (!img.draftId) return sendMessage(chatId, "这张图没有对应的草稿。");
  await attachToDraft(userId, img.draftId, img.id);
  await editButtons(chatId, mid, [[{ text: "已选用这张 ✓", callback_data: "noop" }]]);
  const d = await loadDraft(userId, img.draftId);
  if (d?.mode === "article") {
    await sendDocument(
      chatId,
      img.data,
      img.mime,
      `cover.${img.mime === "image/jpeg" ? "jpg" : "png"}`,
      "这是封面原图（文件形式，不会被压缩）。X 长文没有发布接口：下载后在 X 长文编辑器里上传为封面。",
    );
    return;
  }
  await sendMessage(chatId, "配图选好了，发布时会挂在第一条上。", {
    buttons: [[{ text: "回到草稿", callback_data: `dr:${img.draftId}` }]],
  });
}

/** 用户发来一张图：存下来，问要怎么用 */
export async function handleIncomingImage(
  userId: string,
  chatId: string,
  file: { fileId: string; mime: string; size?: number; caption?: string },
) {
  if ((file.size ?? 0) > MAX_IMAGE_BYTES) return sendMessage(chatId, "图片太大了（最大 5MB）。");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mime)) return sendMessage(chatId, "只支持 PNG、JPG、WebP 图片。");
  const { await: waiting } = await getState(userId);
  const draftId = waiting?.kind === "image" ? waiting.draftId : undefined;
  await setState(userId, {
    await: { kind: "image_ref", draftId, fileId: file.fileId, mime: file.mime, caption: file.caption?.slice(0, 2000) },
  });
  const rows: Keyboard = [];
  if (draftId && file.mime !== "image/webp") rows.push([{ text: "✅ 直接用这张", callback_data: "igr:u" }]);
  rows.push([{ text: "📝 照内容做信息卡", callback_data: "igr:c" }]);
  if (isImageAiConfigured()) rows.push([{ text: "🎨 照内容让 AI 重新画", callback_data: "igr:a" }]);
  await sendMessage(
    chatId,
    draftId
      ? "收到图片。要直接用，还是照着它的内容重新做一张？（重新做不会照搬原图，字由程序排版）"
      : "收到图片。要把它的内容做成信息卡，还是让 AI 按内容重新画一张？（不会照搬原图）",
    { buttons: rows },
  );
}

async function fromRef(userId: string, chatId: string, op: string, mid: number) {
  const { await: waiting } = await getState(userId);
  if (waiting?.kind !== "image_ref") return sendMessage(chatId, "这张图已经过期了，请重新发一次。");
  await clearAwait(userId);
  await editButtons(chatId, mid, []);
  let data: Uint8Array;
  try {
    data = await downloadFile(waiting.fileId, MAX_IMAGE_BYTES);
  } catch (e) {
    return sendErr(chatId, e);
  }
  const ref: RefImage = { mime: waiting.mime, base64: Buffer.from(data).toString("base64") };
  if (op === "u") {
    if (!waiting.draftId) return;
    try {
      const img = await saveUpload(userId, { ref, draftId: waiting.draftId });
      await sendResult(chatId, userId, img, "u");
    } catch (e) {
      await sendErr(chatId, e);
    }
    return;
  }
  const d = waiting.draftId ? await loadDraft(userId, waiting.draftId) : null;
  await make(userId, chatId, op === "a" ? "a" : d?.mode === "article" ? "v" : "c", waiting.draftId ?? null, ref, waiting.caption ?? "");
}

export async function handleImageCallback(userId: string, chatId: string, action: string, a: string, b: string, mid: number): Promise<boolean> {
  try {
    switch (action) {
      case "im":
        await showMenu(userId, chatId, a);
        return true;
      case "imk":
        await make(userId, chatId, a, b && b !== "0" ? b : null);
        return true;
      case "imu":
        await setState(userId, { await: { kind: "image", draftId: a } });
        await sendMessage(chatId, "把图发给我（直接发图片即可，最大 5MB）。");
        return true;
      case "igs": {
        const cur = await getImage(userId, b);
        const img = await restyle(userId, b, a === "t" ? { theme: nextTheme(cur.spec?.theme) } : { showTitle: !cur.spec?.showTitle });
        await editButtons(chatId, mid, []);
        await sendResult(chatId, userId, img, opOf(img));
        return true;
      }
      case "igu":
        await pickImage(userId, chatId, a, mid);
        return true;
      case "ign":
        await attachToDraft(userId, a, null);
        await editButtons(chatId, mid, [[{ text: "不配图 ✓", callback_data: "noop" }]]);
        return true;
      case "igf": {
        const img = await getImage(userId, a);
        await sendDocument(chatId, img.data, img.mime, `image.${img.mime === "image/jpeg" ? "jpg" : "png"}`, "原图文件（不会被压缩）。");
        return true;
      }
      case "igr":
        await fromRef(userId, chatId, a, mid);
        return true;
    }
  } catch (e) {
    await sendErr(chatId, e);
    return true;
  }
  return false;
}
