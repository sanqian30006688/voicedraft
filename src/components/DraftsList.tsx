"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { weightedLength } from "@/lib/text";
import { secondaryButton } from "./ui";

interface DraftItem {
  id: string;
  topic: string;
  mode: string;
  status: "draft" | "copied" | "scheduled" | "published";
  finalText: string;
  updatedAt: string;
}

const STATUS_LABEL = { draft: "草稿", copied: "已复制", scheduled: "已排期", published: "已发布" };
const MODE_LABEL: Record<string, string> = { single: "单条长推", thread: "串推", article: "X 长文" };

/** 草稿箱里的长度说明：普通推文和单条长推按 X 加权字数，串推按条数，长文按字数 */
function sizeLabel(d: DraftItem) {
  if (d.mode === "thread") return `${d.finalText ? d.finalText.split("\n\n---\n\n").length : 0} 条`;
  if (d.mode === "article") return `约 ${d.finalText.replace(/\s/g, "").length} 字`;
  return `${weightedLength(d.finalText).weighted}/280`;
}

export default function DraftsList() {
  const [items, setItems] = useState<DraftItem[] | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/drafts")
      .then((r) => r.json())
      .then((d: { items: DraftItem[] }) => setItems(d.items));
  }, []);
  useEffect(load, [load]);

  async function copy(d: DraftItem) {
    await navigator.clipboard.writeText(d.finalText);
    setCopiedId(d.id);
    setTimeout(() => setCopiedId(null), 1500);
    await fetch(`/api/drafts/${d.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "copied" }),
    });
    setItems((list) => list?.map((x) => (x.id === d.id && x.status === "draft" ? { ...x, status: "copied" } : x)) ?? null);
  }

  async function remove(d: DraftItem) {
    if (!confirm("删除这篇草稿？")) return;
    setItems((list) => list?.filter((x) => x.id !== d.id) ?? null);
    await fetch(`/api/drafts/${d.id}`, { method: "DELETE" });
  }

  if (!items) return <p className="text-sm text-zinc-500">加载中…</p>;
  if (!items.length) {
    return (
      <p className="text-sm text-zinc-500">
        还没有草稿。在 <Link className="underline underline-offset-4" href="/">起草</Link> 或{" "}
        <Link className="underline underline-offset-4" href="/long">长文</Link> 页面生成内容后，会自动保存到这里。
      </p>
    );
  }

  return (
    <div>
      <h2 className="mb-3 font-medium">草稿箱 · {items.length} 篇</h2>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {items.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
            <Link href={`/draft/${d.id}`} className="flex-1 text-sm leading-6 hover:underline">
              <span className={`whitespace-pre-wrap ${MODE_LABEL[d.mode] ? "line-clamp-4" : ""}`}>
                {d.finalText.replace(/\n{2,}/g, "\n") || <span className="text-zinc-400">（空）</span>}
              </span>
              <div className="mt-1 text-xs text-zinc-400">
                {MODE_LABEL[d.mode] ? `${MODE_LABEL[d.mode]} · ` : ""}
                {STATUS_LABEL[d.status]} · {sizeLabel(d)} · 主题：{d.topic} ·{" "}
                {new Date(d.updatedAt).toLocaleString("zh-CN")}
              </div>
            </Link>
            <div className="flex shrink-0 justify-end gap-1">
              <Link className={`${secondaryButton} text-xs`} href={`/draft/${d.id}`}>
                继续编辑
              </Link>
              <button className={`${secondaryButton} text-xs`} onClick={() => copy(d)} disabled={!d.finalText}>
                {copiedId === d.id ? "已复制" : "复制"}
              </button>
              <button className={`${secondaryButton} text-xs`} onClick={() => remove(d)}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
