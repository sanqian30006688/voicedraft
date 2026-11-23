"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isLongMode } from "@/lib/draft-text";
import LongformPage, { type LoadedLongDraft } from "./LongformPage";
import Workbench, { type LoadedDraft } from "./Workbench";

type AnyDraft = (LoadedDraft | LoadedLongDraft) & { mode: string };

/** 打开草稿箱里的一篇草稿，继续编辑 */
export default function DraftLoader() {
  const { id } = useParams<{ id: string }>();
  const [draft, setDraft] = useState<AnyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/drafts/${id}`)
      .then(async (r) => {
        const d = (await r.json()) as AnyDraft & { error?: string };
        if (!r.ok) throw new Error(d.error || "加载草稿失败");
        if (!cancelled) setDraft(d);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <p className="text-sm text-zinc-500">
        {error}。<Link className="underline underline-offset-4" href="/drafts">回到草稿箱</Link>
      </p>
    );
  }
  // 页面状态可能在导航之间被保留，id 变了但还没加载完时不显示旧草稿
  if (!draft || draft.id !== id) return <p className="text-sm text-zinc-500">加载中…</p>;
  // 长文草稿（单条长推 / 串推 / X 长文）在长文页里打开
  if (isLongMode(draft.mode)) return <LongformPage initial={draft as LoadedLongDraft} />;
  return <Workbench initial={draft as LoadedDraft} />;
}
