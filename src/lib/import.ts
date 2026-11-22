/**
 * 素材导入：解析粘贴文本、.txt / .md / .csv 文件和 X 官方存档（tweets.js）。
 * 浏览器和服务器共用。大文件（存档）在浏览器里解析，只把条目发给服务器。
 */

export type SampleSource = "paste" | "file" | "x_archive";

export interface RawSample {
  content: string;
  postedAt?: string; // ISO 时间
}

export interface SkipStats {
  retweet: number;
  tooShort: number;
}

const URL_RE = /https?:\/\/\S+/g;

/** 粘贴文本 / txt / md：有空行时按空行分段，否则一行一条 */
export function parsePlainText(text: string): RawSample[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const blocks = /\n\s*\n/.test(normalized) ? normalized.split(/\n\s*\n/) : normalized.split("\n");
  return blocks.map((b) => ({ content: b.replace(/^#+\s*/, "").trim() })).filter((s) => s.content);
}

/** CSV：优先取名为 text / full_text / content / 内容 的列，否则取第一列 */
export function parseCsv(text: string): RawSample[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const known = ["full_text", "text", "content", "tweet", "内容", "推文"];
  const col = header.findIndex((h) => known.includes(h));
  const dateCol = header.findIndex((h) => ["created_at", "date", "time", "日期", "时间"].includes(h));
  const body = col >= 0 ? rows.slice(1) : rows;
  const c = col >= 0 ? col : 0;
  return body
    .map((r) => ({ content: (r[c] ?? "").trim(), postedAt: dateCol >= 0 ? toIso(r[dateCol]) : undefined }))
    .filter((s) => s.content);
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

interface ArchiveTweet {
  tweet?: { full_text?: string; text?: string; created_at?: string };
}

/**
 * X 官方存档里的 data/tweets.js（或 tweet.js），格式为
 * window.YTD.tweets.part0 = [ { "tweet": { "full_text": ..., "created_at": ... } }, ... ]
 * 跳过转推；回复会去掉开头的 @用户名 后保留。
 */
export function parseXArchive(text: string): { samples: RawSample[]; retweets: number } {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("没有找到推文数据，请确认选择的是存档里的 tweets.js 文件。");
  let items: ArchiveTweet[];
  try {
    items = JSON.parse(text.slice(start)) as ArchiveTweet[];
  } catch {
    throw new Error("tweets.js 解析失败，文件可能不完整。");
  }
  let retweets = 0;
  const samples: RawSample[] = [];
  for (const item of items) {
    const t = item.tweet;
    const raw = t?.full_text ?? t?.text;
    if (!raw) continue;
    if (raw.startsWith("RT @")) {
      retweets++;
      continue;
    }
    samples.push({
      content: decodeEntities(raw.replace(/^(@\w+\s+)+/, "")),
      postedAt: toIso(t?.created_at),
    });
  }
  return { samples, retweets };
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function toIso(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 去掉链接、压缩空白 */
export function cleanContent(content: string): string {
  return content.replace(URL_RE, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** 有效字数：去掉空白和标点后的字符数 */
export function meaningfulLength(content: string): number {
  return [...content.replace(/[\s\p{P}\p{S}]/gu, "")].length;
}

export const MIN_SAMPLE_CHARS = 10;

/** 用于去重：去空白、标点，转小写 */
export function normalizeForHash(content: string): string {
  return content.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

export function detectLang(content: string): "zh" | "en" {
  const chars = [...content.replace(/\s/g, "")];
  if (!chars.length) return "en";
  const cjk = chars.filter((c) => /[㐀-鿿豈-﫿]/.test(c)).length;
  return cjk / chars.length > 0.2 ? "zh" : "en";
}

export function parseFile(name: string, text: string): { samples: RawSample[]; source: SampleSource; retweets: number } {
  const lower = name.toLowerCase();
  if (lower.endsWith(".js") || text.trimStart().startsWith("window.YTD")) {
    const r = parseXArchive(text);
    return { samples: r.samples, source: "x_archive", retweets: r.retweets };
  }
  if (lower.endsWith(".csv")) return { samples: parseCsv(text), source: "file", retweets: 0 };
  return { samples: parsePlainText(text), source: "file", retweets: 0 };
}
