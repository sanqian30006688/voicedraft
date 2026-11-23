/**
 * 读网页、RSS、论坛列表页。
 *
 * 规矩：
 * - 只读公开页面，遵守网站的 robots.txt（网站说不让程序读的路径就不读）
 * - 只连公网地址（不让人借我们的服务器去访问内网）
 * - 每页最多 2MB，20 秒超时；国内常见的 GBK 编码也能读
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class WebError extends Error {}

export const USER_AGENT = "Mozilla/5.0 (compatible; VoiceDraftBot/1.0)";
const ROBOTS_AGENT = "voicedraftbot";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

// ---------- 地址检查 ----------

/** 把用户输入整理成 http(s) 地址；不是网址时返回 null */
export function normalizeUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/]+:\d+/.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") && !isIP(u.hostname)) return null;
    if (u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** 内网、本机、保留地址 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

async function assertPublicHost(u: URL) {
  if (u.port && u.port !== "80" && u.port !== "443") throw new WebError("只支持普通网址（不带端口号的）");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$|\.localhost$/i.test(host)) throw new WebError("这个地址是内网地址，不能读");
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new WebError(`找不到网站 ${host}，请检查网址`);
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new WebError("这个地址是内网地址，不能读");
}

// ---------- 读取 ----------

export interface Fetched {
  url: string;
  contentType: string;
  body: string;
}

function charsetOf(contentType: string, head: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1];
  return (fromHeader || fromMeta || "utf-8").toLowerCase();
}

function decode(buf: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 2048));
  let cs = charsetOf(contentType, head);
  if (cs === "gb2312" || cs === "gbk") cs = "gb18030";
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function rawGet(url: string, accept: string): Promise<{ url: string; status: number; contentType: string; buf: Uint8Array }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    await assertPublicHost(u);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new WebError(`连不上 ${u.hostname}，稍后会自动重试`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(Math.min(size, MAX_BYTES));
    let off = 0;
    for (const c of chunks) {
      buf.set(c.subarray(0, buf.length - off), off);
      off += c.length;
      if (off >= buf.length) break;
    }
    return { url: current, status: res.status, contentType: res.headers.get("content-type") ?? "", buf };
  }
  throw new WebError("网址跳转次数太多");
}

// ---------- robots.txt ----------

interface RobotsRules {
  allow: string[];
  disallow: string[];
}

const robotsCache = ((globalThis as { __vdRobots?: Map<string, { at: number; rules: RobotsRules }> }).__vdRobots ??= new Map());

/** 解析 robots.txt，取对我们生效的规则（有专门写给我们的组就用那组，否则用 *） */
export function parseRobots(txt: string, agent = ROBOTS_AGENT): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let cur: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "disallow" && val) cur.rules.disallow.push(val);
    if (key === "allow" && val) cur.rules.allow.push(val);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: use.flatMap((g) => g.rules.allow),
    disallow: use.flatMap((g) => g.rules.disallow),
  };
}

function ruleMatch(rule: string, path: string): number {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(`^${body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path) ? body.length : -1;
}

/** 这个路径能不能读：最长匹配的规则说了算，一样长时 Allow 优先 */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allowed = true;
  for (const r of rules.disallow) {
    const n = ruleMatch(r, path);
    if (n > best) {
      best = n;
      allowed = false;
    }
  }
  for (const r of rules.allow) {
    const n = ruleMatch(r, path);
    if (n >= best && n >= 0) {
      best = n;
      allowed = true;
    }
  }
  return allowed;
}

async function checkRobots(url: string) {
  const u = new URL(url);
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > 6 * 3600_000) {
    let rules: RobotsRules = { allow: [], disallow: [] };
    try {
      const r = await rawGet(`${u.origin}/robots.txt`, "text/plain");
      // 401/403 视为整个网站都不让读；404 等视为没有限制
      if (r.status === 401 || r.status === 403) rules = { allow: [], disallow: ["/"] };
      else if (r.status >= 200 && r.status < 300) rules = parseRobots(decode(r.buf, r.contentType));
    } catch {
      // 读不到 robots.txt 时按没有限制处理
    }
    entry = { at: Date.now(), rules };
    if (robotsCache.size > 2000) robotsCache.clear();
    robotsCache.set(key, entry);
  }
  if (!robotsAllows(entry.rules, u.pathname + u.search)) {
    throw new WebError(`${u.hostname} 的 robots.txt 不允许程序读取这个页面，按网站规定不读`);
  }
}

/** 读一个页面：先看 robots.txt，再读，最后按编码转成文字 */
export async function fetchPage(url: string, accept = "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5"): Promise<Fetched> {
  await checkRobots(url);
  const r = await rawGet(url, accept);
  if (r.status === 404 || r.status === 410) throw new WebError("这个网页不存在了（404）");
  if (r.status === 401 || r.status === 403) throw new WebError("这个网页需要登录或不让程序读取，只能读公开页面");
  if (r.status === 429) throw new WebError("网站嫌读得太频繁，稍后会自动重试");
  if (r.status < 200 || r.status >= 300) throw new WebError(`网站返回 ${r.status}，稍后会自动重试`);
  if (r.url !== url) await checkRobots(r.url);
  return { url: r.url, contentType: r.contentType, body: decode(r.buf, r.contentType) };
}

// ---------- 解析 ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** HTML 片段 → 纯文本（保留段落换行） */
export function htmlToPlain(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FeedEntry {
  title: string;
  link: string;
  text: string;
  publishedAt: Date | null;
}

export function isFeed(body: string, contentType = ""): boolean {
  if (/(rss|atom)\+xml/i.test(contentType)) return true;
  const head = body.slice(0, 1500);
  return /<rss[\s>]|<feed[\s>][\s\S]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom|<rdf:RDF/i.test(head);
}

function tag(chunk: string, name: string): string | null {
  const m = chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(htmlToPlain(s));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 解析 RSS 2.0 / RSS 1.0 / Atom，最新的在前 */
export function parseFeed(xml: string, base: string): { title: string; entries: FeedEntry[] } {
  const atom = /<feed[\s>]/i.test(xml.slice(0, 1500)) && !/<rss[\s>]/i.test(xml.slice(0, 1500));
  const channelTitle = htmlToPlain(tag(xml.replace(/<(item|entry)[\s>][\s\S]*$/i, ""), "title") ?? "");
  const chunks = xml.split(atom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1);
  const entries: FeedEntry[] = [];
  for (const c of chunks) {
    const title = htmlToPlain(tag(c, "title") ?? "");
    let link = "";
    if (atom) {
      link =
        c.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i)?.[1] ??
        c.match(/<link(?![^>]*rel=["'](?!alternate))[^>]*href=["']([^"']+)/i)?.[1] ??
        "";
    } else {
      link = htmlToPlain(tag(c, "link") ?? "") || htmlToPlain(tag(c, "guid") ?? "");
    }
    const bodyHtml = tag(c, "content:encoded") ?? tag(c, "content") ?? tag(c, "description") ?? tag(c, "summary") ?? "";
    // description 里经常是转义过的 HTML，要先还原再去标签
    const text = htmlToPlain(decodeEntities(bodyHtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")));
    const publishedAt = toDate(tag(c, "pubDate") ?? tag(c, "published") ?? tag(c, "updated") ?? tag(c, "dc:date"));
    if (!title && !text) continue;
    let abs = "";
    try {
      abs = link ? new URL(decodeEntities(link.trim()), base).toString() : "";
    } catch {
      abs = "";
    }
    entries.push({ title, link: abs, text, publishedAt });
  }
  entries.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  return { title: channelTitle, entries };
}

/** 网页里声明的 RSS / Atom 订阅地址 */
export function discoverFeed(html: string, base: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (!/rel=["']?alternate/i.test(t) || !/type=["']?application\/(rss|atom)\+xml/i.test(t)) continue;
    const href = t.match(/href=["']([^"']+)/i)?.[1];
    if (!href) continue;
    try {
      return new URL(decodeEntities(href), base).toString();
    } catch {
      continue;
    }
  }
  return null;
}

export function pageTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i)?.[1];
  const t = og ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return decodeEntities(t).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 列表页（论坛版块、新闻栏目）里的文章链接：同一个网站、链接文字像标题（至少 6 个字）、
 * 不是登录 / 注册 / 翻页 / 标签这类功能链接。按在页面上出现的顺序返回。
 */
export function extractLinks(html: string, base: string): { url: string; title: string }[] {
  const baseUrl = new URL(base);
  const host = baseUrl.hostname.replace(/^www\./, "");
  const body = html.replace(/<(script|style|noscript|nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ");
  const out: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/href=["']([^"']+)/i)?.[1];
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) continue;
    const title = htmlToPlain(m[2]).replace(/\s+/g, " ").trim();
    if (title.replace(/\s/g, "").length < 6) continue;
    let u: URL;
    try {
      u = new URL(decodeEntities(href), baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname.replace(/^www\./, "") !== host) continue;
    u.hash = "";
    const path = u.pathname + u.search;
    if (path === "/" || path === baseUrl.pathname + baseUrl.search) continue;
    if (/(login|logon|signin|signup|register|logout|password|search|tag|tags|category|page[=/]\d|\/page\/|member|user|profile|about|contact|privacy|terms|help|faq)\b/i.test(path)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|mp4|mp3)$/i.test(u.pathname)) continue;
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, title: title.slice(0, 200) });
  }
  return out;
}

/**
 * 文章正文：优先 <article> / 常见正文容器，否则取段落最多的那块。
 * 只用来给 AI 当素材，不需要排版完美。
 */
/** 文章的发布时间：meta 标签、JSON-LD、<time datetime>；找不到返回 null */
export function articleDate(html: string): Date | null {
  const raw =
    html.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|datePublished|pubdate|publishdate|date)["'][^>]+content=["']([^"']+)/i)?.[1] ??
    html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86400_000 ? null : d;
}

export function extractArticle(html: string): { title: string; text: string; publishedAt: Date | null } {
  const title = pageTitle(html);
  const cleaned = html.replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const candidates: string[] = [];
  const article = cleaned.match(/<article\b[\s\S]*?<\/article>/gi);
  if (article) candidates.push(...article);
  for (const m of cleaned.matchAll(/<(div|section|td)\b[^>]*(?:class|id)=["'][^"']*(content|article|post|entry|main|body|message|thread|topic|t_f|postmessage)[^"']*["'][^>]*>/gi)) {
    candidates.push(cleaned.slice(m.index!, m.index! + 60_000));
  }
  let best = "";
  for (const c of candidates) {
    const text = htmlToPlain(c);
    if (text.length > best.length) best = text;
  }
  if (best.length < 80) {
    const paras = [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlToPlain(m[1])).filter((t) => t.length > 15);
    const joined = paras.join("\n");
    if (joined.length > best.length) best = joined;
  }
  if (best.length < 40) {
    const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)/i)?.[1];
    if (desc) best = decodeEntities(desc);
  }
  return { title, text: best.slice(0, 8000).trim(), publishedAt: articleDate(html) };
}
