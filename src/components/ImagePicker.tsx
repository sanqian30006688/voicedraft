"use client";

import { useEffect, useRef, useState } from "react";
import { inputClass, secondaryButton } from "./ui";

/**
 * 配图：信息卡（程序排版，字不会错）/ AI 配图（无字插图 + 程序叠标题）/ 用自己的图。
 * 可以附一张参考图（例如截图）：AI 只用它看懂内容，不复刻原图。
 * format=article 时做 5:2 的长文封面，只能下载后自己传到 X。
 */

interface ImageInfo {
  id: string;
  kind: string;
  spec: { theme: string; showTitle: boolean; title: string; layout: string } | null;
}

const THEMES = [
  { key: "dark", label: "深色科技" },
  { key: "light", label: "浅色简约" },
  { key: "bold", label: "醒目大字" },
  { key: "ocean", label: "深海蓝" },
  { key: "forest", label: "墨绿" },
  { key: "sunset", label: "晚霞" },
  { key: "mint", label: "薄荷" },
  { key: "rose", label: "浅粉" },
  { key: "mono", label: "黑白" },
  { key: "paper", label: "报纸" },
];

async function readFile(file: File): Promise<{ mime: string; base64: string }> {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mime: file.type, base64: btoa(bin) };
}

export default function ImagePicker(props: {
  text: string;
  format: "tweet" | "article";
  getDraftId?: () => Promise<string | null>;
  initialImageId?: string | null;
  onChange: (imageId: string | null) => void;
}) {
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [ref, setRef] = useState<{ mime: string; base64: string; name: string } | null>(null);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { onChange, initialImageId } = props;
  const article = props.format === "article";

  useEffect(() => {
    void fetch("/api/images")
      .then((r) => r.json())
      .then((d: { items?: ImageInfo[]; aiReady?: boolean }) => {
        setAiReady(!!d.aiReady);
        const found = initialImageId ? d.items?.find((i) => i.id === initialImageId) : undefined;
        if (found) {
          setImage(found);
          onChange(found.id);
        }
      })
      .catch(() => {});
  }, [initialImageId, onChange]);

  async function attach(id: string | null) {
    const draftId = await props.getDraftId?.();
    if (draftId) {
      await fetch("/api/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "attach", draftId, imageId: id }),
      });
    }
  }

  async function make(action: "card" | "cover" | "ai" | "ai_pro" | "upload") {
    setBusy(action);
    setError(null);
    setNote(null);
    try {
      const draftId = (await props.getDraftId?.()) ?? null;
      const body =
        action === "upload"
          ? { action, draftId, ref: ref && { mime: ref.mime, base64: ref.base64 } }
          : {
              action,
              draftId,
              text: props.text,
              ref: ref && { mime: ref.mime, base64: ref.base64 },
              aspect: article ? "5:2" : "16:9",
            };
      const res = await fetch("/api/images", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as { image?: ImageInfo; fellBack?: boolean; error?: string };
      if (!res.ok || !data.image) throw new Error(data.error || "配图失败了");
      setImage(data.image);
      setVersion((v) => v + 1);
      if (data.fellBack) setNote("内容涉及真实人物，AI 画容易被当成造假图，所以改做了信息卡（没按 AI 画图收费）。");
      onChange(data.image.id);
      await attach(data.image.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "配图失败了");
    } finally {
      setBusy(null);
    }
  }

  async function restyle(change: Record<string, unknown>) {
    if (!image) return;
    setBusy("restyle");
    setError(null);
    try {
      const res = await fetch(`/api/images/${image.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = (await res.json()) as { image?: ImageInfo; error?: string };
      if (!res.ok || !data.image) throw new Error(data.error || "改不了");
      setImage(data.image);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "改不了");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setImage(null);
    onChange(null);
    await attach(null);
  }

  const theme = image?.spec?.theme ?? "dark";
  const nextTheme = THEMES[(THEMES.findIndex((t) => t.key === theme) + 1) % THEMES.length];

  return (
    <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{article ? "长文封面" : "配图"}</span>
        <button className={secondaryButton} disabled={!!busy} onClick={() => make(article ? "cover" : "card")}>
          {busy === "card" || busy === "cover" ? "排版中…" : article ? "📝 做文字封面" : "📝 做信息卡"}
        </button>
        {aiReady && (
          <>
            <button className={secondaryButton} disabled={!!busy} onClick={() => make("ai")}>
              {busy === "ai" ? "AI 画图中…" : "🎨 AI 配图"}
            </button>
            <button className={secondaryButton} disabled={!!busy} onClick={() => make("ai_pro")}>
              {busy === "ai_pro" ? "AI 画图中…" : "✨ AI 精品图"}
            </button>
          </>
        )}
        <button className={secondaryButton} disabled={!!busy} onClick={() => fileRef.current?.click()}>
          📎 {ref ? "换参考图" : "附一张图"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 5 * 1024 * 1024) return setError("图片太大了（最大 5MB）");
            setRef({ ...(await readFile(f)), name: f.name });
          }}
        />
      </div>
      {ref && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <span>
            已附图：{ref.name}。点上面的按钮会参考它的内容（AI 只读懂内容，不复刻原图）
            {ref.mime !== "image/webp" && "，也可以"}
          </span>
          {ref.mime !== "image/webp" && (
            <button className="underline underline-offset-4" disabled={!!busy} onClick={() => make("upload")}>
              直接用这张（自己的图）
            </button>
          )}
          <button className="underline underline-offset-4" onClick={() => setRef(null)}>
            去掉
          </button>
        </div>
      )}
      {!aiReady && <p className="text-xs text-zinc-500">AI 配图还没开通（管理员在「后台」填好 Gemini 密钥后就有）。</p>}
      {error && <p className="text-red-600">{error}</p>}
      {note && <p className="text-amber-700 dark:text-amber-400">{note}</p>}
      {image && (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/images/${image.id}?v=${version}`}
            alt="配图预览"
            className={`w-full max-w-xl rounded-lg border border-zinc-200 dark:border-zinc-800 ${busy ? "opacity-50" : ""}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            {image.spec && (
              <>
                {image.kind === "card" && (
                  <button className={secondaryButton} disabled={!!busy} onClick={() => restyle({ theme: nextTheme.key })}>
                    换风格（{nextTheme.label}）
                  </button>
                )}
                {image.kind === "ai" && (
                  <button className={secondaryButton} disabled={!!busy} onClick={() => restyle({ showTitle: !image.spec!.showTitle })}>
                    {image.spec.showTitle ? "去掉标题字" : "加上标题字"}
                  </button>
                )}
                <button className={secondaryButton} disabled={!!busy} onClick={() => setEditTitle(image.spec!.title)}>
                  改标题
                </button>
              </>
            )}
            {image.kind !== "upload" && (
              <button className={secondaryButton} disabled={!!busy} onClick={() => make(image.kind === "ai" ? "ai" : article ? "cover" : "card")}>
                🔄 换一张
              </button>
            )}
            <a className={secondaryButton} href={`/api/images/${image.id}?download=1`}>
              下载原图
            </a>
            <button className={secondaryButton} disabled={!!busy} onClick={remove}>
              不要图
            </button>
          </div>
          {editTitle !== null && (
            <div className="flex flex-wrap gap-2">
              <input className={`${inputClass} max-w-md`} value={editTitle} maxLength={40} onChange={(e) => setEditTitle(e.target.value)} />
              <button
                className={secondaryButton}
                disabled={!!busy || !editTitle.trim()}
                onClick={async () => {
                  await restyle({ title: editTitle });
                  setEditTitle(null);
                }}
              >
                保存标题
              </button>
              <button className={secondaryButton} onClick={() => setEditTitle(null)}>
                取消
              </button>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            {article
              ? "X 长文没有发布接口：下载原图后，在 X 长文编辑器里上传为封面。"
              : "发布时这张图会挂在第一条上。换风格、改标题不另收费。"}
          </p>
        </div>
      )}
    </div>
  );
}
