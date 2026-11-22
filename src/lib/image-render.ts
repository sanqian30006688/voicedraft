import "server-only";
import { createElement, type CSSProperties, type ReactNode } from "react";

/**
 * 配图排版：图上的每一个字都由程序用真正的中文字体排上去，不让 AI 画字（AI 画中文会写错字）。
 * - 信息卡（card）：标签 + 标题 + 3–4 个要点 + 来源 + 账号水印
 * - 封面（cover）：大标题；可以铺一张 AI 画的无字背景
 */

export const THEMES = ["dark", "light", "bold", "ocean", "forest", "sunset", "mint", "rose", "mono", "paper"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABEL: Record<Theme, string> = {
  dark: "深色科技",
  light: "浅色简约",
  bold: "醒目大字",
  ocean: "深海蓝",
  forest: "墨绿",
  sunset: "晚霞",
  mint: "薄荷",
  rose: "浅粉",
  mono: "黑白",
  paper: "报纸",
};

/** 要点前面的符号和装饰：同一个配色也能排出不同的样子 */
export const BULLETS = ["square", "dot", "number", "dash", "ring"] as const;
export const DECORS = ["none", "topbar", "sidebar", "corner"] as const;

/** 随机挑一套样式（自动发帖每条都不一样） */
export function randomStyle(rand = Math.random): { theme: Theme; bullet: (typeof BULLETS)[number]; decor: (typeof DECORS)[number] } {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  return { theme: pick(THEMES), bullet: pick(BULLETS), decor: pick(DECORS) };
}

/** 16:9 是 X 单图最合适的比例；5:2 是 X 长文封面 */
export type Aspect = "16:9" | "5:2";
export const SIZE: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1200, height: 675 },
  "5:2": { width: 1500, height: 600 },
};

export interface CardSpec {
  layout: "card" | "cover";
  theme: Theme;
  aspect: Aspect;
  tag?: string;
  title: string;
  points: string[];
  /** 资料来源：只写名称，不放链接 */
  source?: string;
  /** 账号水印，例如 @yourhandle */
  handle?: string;
  /** 封面上要不要标题字 */
  showTitle: boolean;
  /** 要点符号，默认方块 */
  bullet?: (typeof BULLETS)[number];
  /** 装饰条，默认没有 */
  decor?: (typeof DECORS)[number];
}

/** 限制长度，免得排版溢出 */
export function normalizeSpec(s: CardSpec): CardSpec {
  const cut = (t: string | undefined, n: number) => (t ? Array.from(t.trim()).slice(0, n).join("") : undefined);
  return {
    ...s,
    tag: cut(s.tag, 12),
    title: cut(s.title, 40) || "无标题",
    points: s.points.map((p) => cut(p, 40) ?? "").filter(Boolean).slice(0, 4),
    source: cut(s.source, 30),
    handle: cut(s.handle, 30),
  };
}

interface Palette {
  bg: string;
  text: string;
  sub: string;
  accent: string;
  muted: string;
  tagBorder: string;
  /** 标签文字和要点符号的颜色（不写就用 accent） */
  tagText?: string;
  bullet?: string;
}

const PALETTE: Record<Theme, Palette> = {
  dark: {
    bg: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 60%, #312e81 100%)",
    text: "#f8fafc",
    sub: "#e2e8f0",
    accent: "#a5b4fc",
    muted: "#94a3b8",
    tagBorder: "#6366f1",
    tagText: "#c7d2fe",
    bullet: "#818cf8",
  },
  light: {
    bg: "linear-gradient(135deg, #fffbf5 0%, #f5efe6 100%)",
    text: "#1c1917",
    sub: "#44403c",
    accent: "#c2410c",
    muted: "#78716c",
    tagBorder: "#ea580c",
  },
  bold: {
    bg: "#fde047",
    text: "#0a0a0a",
    sub: "#171717",
    accent: "#0a0a0a",
    muted: "#404040",
    tagBorder: "#0a0a0a",
  },
  ocean: {
    bg: "linear-gradient(160deg, #042f2e 0%, #0c4a6e 100%)",
    text: "#f0fdfa",
    sub: "#ccfbf1",
    accent: "#5eead4",
    muted: "#7dd3fc",
    tagBorder: "#2dd4bf",
  },
  forest: {
    bg: "linear-gradient(135deg, #052e16 0%, #14532d 100%)",
    text: "#f7fee7",
    sub: "#dcfce7",
    accent: "#bef264",
    muted: "#86efac",
    tagBorder: "#84cc16",
  },
  sunset: {
    bg: "linear-gradient(135deg, #4c0519 0%, #9a3412 60%, #c2410c 100%)",
    text: "#fff7ed",
    sub: "#ffedd5",
    accent: "#fdba74",
    muted: "#fed7aa",
    tagBorder: "#fb923c",
  },
  mint: {
    bg: "linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)",
    text: "#052e16",
    sub: "#14532d",
    accent: "#059669",
    muted: "#4b7a5f",
    tagBorder: "#10b981",
  },
  rose: {
    bg: "linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)",
    text: "#3f0d1a",
    sub: "#5f1a2b",
    accent: "#e11d48",
    muted: "#9f5468",
    tagBorder: "#fb7185",
  },
  mono: {
    bg: "#0a0a0a",
    text: "#fafafa",
    sub: "#d4d4d4",
    accent: "#ffffff",
    muted: "#a3a3a3",
    tagBorder: "#fafafa",
  },
  paper: {
    bg: "#f4f1ea",
    text: "#111111",
    sub: "#2b2b2b",
    accent: "#b91c1c",
    muted: "#6b6b6b",
    tagBorder: "#111111",
  },
};

type Props = { style?: CSSProperties; children?: ReactNode; src?: string; width?: number; height?: number };
const h = (type: string, props: Props, ...children: ReactNode[]) => createElement(type, props, ...children);

/** 标题越长字越小 */
function titleSize(title: string, base: number): number {
  const n = Array.from(title).length;
  if (n <= 14) return base;
  if (n <= 20) return Math.round(base * 0.92);
  if (n <= 28) return Math.round(base * 0.84);
  return Math.round(base * 0.72);
}

/** 标题里第一个「：」前面的部分用强调色（例如「Obscura：用 Rust 写的…」） */
function titleNode(title: string, color: string, accent: string) {
  const i = title.search(/[：:]/);
  if (i <= 0 || i > 16) return [title];
  return [h("span", { style: { color: accent } }, title.slice(0, i)), h("span", { style: { color } }, title.slice(i))];
}

/** 要点前面的符号 */
function bulletNode(kind: (typeof BULLETS)[number], i: number, color: string, font: number) {
  const box = { marginRight: 24, flexShrink: 0 } as const;
  const mid = Math.round(font * 0.46);
  switch (kind) {
    case "dot":
      return h("div", { style: { ...box, width: 16, height: 16, borderRadius: 999, background: color, marginTop: mid } });
    case "number":
      return h("div", { style: { ...box, display: "flex", minWidth: 40, fontWeight: 700, color } }, `${String(i + 1).padStart(2, "0")}`);
    case "dash":
      return h("div", { style: { ...box, width: 28, height: 4, background: color, marginTop: mid + 6 } });
    case "ring":
      return h("div", { style: { ...box, width: 18, height: 18, borderRadius: 999, border: `4px solid ${color}`, marginTop: mid - 1 } });
    default:
      return h("div", { style: { ...box, width: 18, height: 18, borderRadius: 5, background: color, marginTop: mid - 1 } });
  }
}

/** 装饰：顶部色条、左侧色条、右上角色块 */
function decorNode(kind: (typeof DECORS)[number], color: string, width: number, height: number) {
  const abs = { position: "absolute", display: "flex" } as const;
  switch (kind) {
    case "topbar":
      return h("div", { style: { ...abs, left: 0, top: 0, width, height: 12, background: color } });
    case "sidebar":
      return h("div", { style: { ...abs, left: 0, top: 0, width: 14, height, background: color } });
    case "corner":
      return h("div", { style: { ...abs, right: -120, top: -120, width: 320, height: 320, borderRadius: 999, background: color, opacity: 0.18 } });
    default:
      return null;
  }
}

export function cardElement(spec: CardSpec, background?: string) {
  const s = normalizeSpec(spec);
  const p = PALETTE[s.theme];
  const { width, height } = SIZE[s.aspect];
  const footer = h(
    "div",
    { style: { display: "flex", justifyContent: "space-between", fontSize: 22, color: background ? "#e5e7eb" : p.muted } },
    h("div", { style: { display: "flex" } }, s.source ? `资料来源：${s.source}` : ""),
    h("div", { style: { display: "flex", color: background ? "#f8fafc" : p.accent } }, s.handle ?? ""),
  );

  if (s.layout === "cover") {
    const bigTitle = s.showTitle
      ? h(
          "div",
          {
            style: {
              display: "flex",
              flexWrap: "wrap",
              fontSize: titleSize(s.title, s.aspect === "5:2" ? 76 : 72),
              fontWeight: 700,
              lineHeight: 1.25,
              color: background ? "#ffffff" : p.text,
              maxWidth: width - 160,
            },
          },
          ...(background ? [s.title] : titleNode(s.title, p.text, p.accent)),
        )
      : null;
    return h(
      "div",
      {
        style: {
          width,
          height,
          display: "flex",
          position: "relative",
          background: background ? "#000" : p.bg,
          fontFamily: "Noto Sans SC",
        },
      },
      background ? h("img", { src: background, width, height, style: { position: "absolute", left: 0, top: 0, width, height, objectFit: "cover" } }) : null,
      background && s.showTitle
        ? h("div", {
            style: {
              position: "absolute",
              left: 0,
              top: 0,
              width,
              height,
              background: "linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.72) 100%)",
            },
          })
        : null,
      h(
        "div",
        {
          style: {
            position: "absolute",
            left: 0,
            top: 0,
            width,
            height,
            display: "flex",
            flexDirection: "column",
            justifyContent: background ? "flex-end" : "center",
            padding: "56px 80px",
          },
        },
        s.tag && s.showTitle
          ? h(
              "div",
              {
                style: {
                  display: "flex",
                  alignSelf: "flex-start",
                  fontSize: 22,
                  color: background ? "#fff" : p.accent,
                  border: `2px solid ${background ? "rgba(255,255,255,0.8)" : p.tagBorder}`,
                  borderRadius: 999,
                  padding: "6px 20px",
                  marginBottom: 20,
                },
              },
              s.tag,
            )
          : null,
        bigTitle,
        s.showTitle && (s.source || s.handle) ? h("div", { style: { display: "flex", height: 28 } }) : null,
        s.showTitle && (s.source || s.handle) ? footer : null,
      ),
    );
  }

  return h(
    "div",
    {
      style: {
        width,
        height,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        background: p.bg,
        padding: "56px 80px 48px",
        fontFamily: "Noto Sans SC",
        color: p.text,
      },
    },
    decorNode(s.decor ?? "none", p.bullet ?? p.accent, width, height),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" } },
    s.tag
      ? h(
          "div",
          {
            style: {
              display: "flex",
              alignSelf: "flex-start",
              fontSize: 22,
              color: p.tagText ?? p.accent,
              border: `2px solid ${p.tagBorder}`,
              borderRadius: 999,
              padding: "6px 20px",
              marginBottom: 28,
            },
          },
          s.tag,
        )
      : null,
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", fontSize: titleSize(s.title, s.points.length > 3 ? 64 : 70), fontWeight: 700, lineHeight: 1.25 } },
      ...titleNode(s.title, p.text, p.accent),
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", marginTop: 40 } },
      ...s.points.map((pt, i) =>
        h(
          "div",
          { style: { display: "flex", alignItems: "flex-start", fontSize: s.points.length > 3 ? 34 : 37, lineHeight: 1.45, marginBottom: 18, color: p.sub } },
          bulletNode(s.bullet ?? "square", i, p.bullet ?? p.accent, s.points.length > 3 ? 34 : 37),
          h("div", { style: { display: "flex", flex: 1 } }, pt),
        ),
      ),
    ),
    ),
    footer,
  );
}

/** 卡片上用到的全部文字（下载字体时只取这些字，体积小） */
export function specText(spec: CardSpec): string {
  const s = normalizeSpec(spec);
  return [s.tag, s.title, ...s.points, s.source ? `资料来源：${s.source}` : "", s.handle].filter(Boolean).join("");
}

// ---------- 字体 ----------

const fontCache = new Map<string, ArrayBuffer>();

/** 从 Google Fonts 按需下载思源黑体（Noto Sans SC），只含这张图用到的字 */
async function loadFont(text: string, weight: 400 | 700): Promise<ArrayBuffer> {
  const chars = Array.from(new Set(Array.from(`${text}…·：，0123456789`))).sort().join("");
  const key = `${weight}:${chars}`;
  const hit = fontCache.get(key);
  if (hit) return hit;
  const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@${weight}&text=${encodeURIComponent(chars)}`;
  const css = await (await fetch(cssUrl, { signal: AbortSignal.timeout(15_000) })).text();
  const url = css.match(/src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error("字体下载失败");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error("字体下载失败");
  const data = await res.arrayBuffer();
  if (fontCache.size > 200) fontCache.clear();
  fontCache.set(key, data);
  return data;
}

// 测试里不下载字体、不真的渲染：返回一张 1×1 的 PNG
const TINY_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

export class RenderError extends Error {}

/** 把卡片渲染成 PNG；background 是 AI 画的无字背景（data URL） */
export async function renderCard(spec: CardSpec, background?: string): Promise<Uint8Array> {
  if (process.env.IMAGE_RENDER_MOCK === "1") return TINY_PNG;
  const text = specText(spec);
  let fonts;
  try {
    const [regular, bold] = await Promise.all([loadFont(text, 400), loadFont(text, 700)]);
    fonts = [
      { name: "Noto Sans SC", data: regular, weight: 400 as const, style: "normal" as const },
      { name: "Noto Sans SC", data: bold, weight: 700 as const, style: "normal" as const },
    ];
  } catch {
    throw new RenderError("排版用的中文字体下载失败，请稍后再试");
  }
  const { ImageResponse } = await import("next/og");
  const { width, height } = SIZE[spec.aspect];
  const res = new ImageResponse(cardElement(spec, background), { width, height, fonts });
  return new Uint8Array(await res.arrayBuffer());
}
