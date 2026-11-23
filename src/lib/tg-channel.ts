/**
 * 公开 TG 频道：读取 t.me/s/频道名 的公开预览页（Telegram 官方提供给所有人看的网页版）。
 * 只限公开频道；私密频道、群组、不存在的频道没有预览页，会被拒绝。
 */

export interface ChannelPost {
  /** 频道内消息编号，越新越大 */
  id: number;
  text: string;
  url: string;
  publishedAt: Date | null;
  /** 图片地址 */
  media?: string[];
}

export interface ChannelPage {
  handle: string;
  title: string;
  posts: ChannelPost[];
}

export class ChannelError extends Error {}

/** 把用户输入的 @name、t.me/name、https://t.me/s/name 等统一成频道用户名 */
export function parseChannelHandle(input: string): string | null {
  const s = input.trim();
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)\/?(?:\d+\/?)?(?:\?.*)?$/i) ??
    s.match(/^@?([A-Za-z0-9_]+)$/);
  const name = m?.[1];
  if (!name || name.length < 4 || name.length > 32) return null;
  // joinchat、+邀请码 这类是私密链接
  if (/^(joinchat|addstickers|share|proxy|s)$/i.test(name)) return null;
  return name;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** 消息正文 HTML → 纯文本：换行保留，标签去掉，表情图片换成它的 alt 文字 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "$1")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 解析预览页 HTML（单独导出方便测试） */
export function parseChannelHtml(handle: string, html: string): ChannelPage {
  const title = decodeEntities(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? handle).trim();
  const posts: ChannelPost[] = [];
  const chunks = html.split(/data-post="/).slice(1);
  for (const chunk of chunks) {
    const m = chunk.match(/^([A-Za-z0-9_]+)\/(\d+)"/);
    if (!m) continue;
    const id = Number(m[2]);
    const textHtml = chunk.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!textHtml) continue; // 纯图片 / 视频 / 贴纸，没有文字
    const text = htmlToText(textHtml);
    if (!text) continue;
    const dt = chunk.match(/<time datetime="([^"]+)"/)?.[1];
    const publishedAt = dt ? new Date(dt) : null;
    // 消息里的图片（公开预览页上的 CDN 地址）
    const media = [...chunk.matchAll(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g)].map((x) => x[1]).slice(0, 4);
    posts.push({
      id,
      text,
      media,
      url: `https://t.me/${m[1]}/${id}`,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    });
  }
  posts.sort((a, b) => a.id - b.id);
  return { handle, title, posts };
}

/** 读一条频道消息的图片（嵌入页 t.me/频道/编号?embed=1），给之前没记图的消息补图用 */
export async function fetchChannelPostPhotos(postUrl: string): Promise<string[]> {
  const m = postUrl.match(/^https:\/\/t\.me\/([A-Za-z0-9_]+)\/(\d+)$/);
  if (!m) return [];
  try {
    const res = await fetch(`https://t.me/${m[1]}/${m[2]}?embed=1`, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; VoiceDraft)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return [...html.matchAll(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g)].map((x) => x[1]).slice(0, 4);
  } catch {
    return [];
  }
}

/** 拉取频道最新约 20 条公开消息 */
export async function fetchChannel(handle: string): Promise<ChannelPage> {
  let res: Response;
  try {
    res = await fetch(`https://t.me/s/${encodeURIComponent(handle)}`, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; VoiceDraft)", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ChannelError("连不上 Telegram，请检查网络（在国内需要能访问 t.me）");
  }
  // 不存在、私密频道或群组没有预览页，会被重定向到 t.me/频道名
  if (res.status >= 300 && res.status < 400) {
    throw new ChannelError(`@${handle} 不是公开频道，或没有开放网页预览`);
  }
  if (!res.ok) throw new ChannelError(`读取 @${handle} 失败（${res.status}），稍后会自动重试`);
  // 页面打开了但没有文字消息也算成功，只是暂时没有内容
  return parseChannelHtml(handle, await res.text());
}
