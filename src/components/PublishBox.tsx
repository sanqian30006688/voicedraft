"use client";

import Link from "next/link";
import { useState } from "react";
import { weightedLength } from "@/lib/text";
import { useMe } from "./AppShell";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface PostItem {
  id: string;
  status: string;
  scheduledAt: string | null;
  postIds: string[];
  handle: string | null;
  error: string | null;
}

/** datetime-local 需要的本地时间字符串 */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function postUrl(handle: string | null, id: string) {
  return `https://x.com/${handle ?? "i/web"}/status/${id}`;
}

/**
 * 「发布到 X」：立即发布或定时发布。每次都要用户二次确认后才真正发出。
 * tweets 有多条时按串推（线程）发出。
 */
export default function PublishBox(props: {
  tweets: string[];
  getDraftId?: () => Promise<string | null>;
  onDone?: (status: "published" | "scheduled") => void;
  /** 有值时作为引用推文发出 */
  quoteTweetId?: string;
  /** 配图（挂在第一条上） */
  imageId?: string | null;
}) {
  const { me } = useMe();
  const [mode, setMode] = useState<"idle" | "now" | "schedule">("idle");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PostItem | null>(null);

  const tweets = props.tweets.map((t) => t.trim());
  const isThread = tweets.length > 1;
  const invalid = tweets.some((t) => !t || !weightedLength(t).valid);

  if (!me.x) {
    return (
      <p className="text-xs text-zinc-500">
        <Link className="underline underline-offset-4" href="/publish">
          连接 X 账号
        </Link>
        后，可以在这里直接发布或定时发布。
      </p>
    );
  }
  if (me.x.authError) {
    return (
      <p className="text-xs text-red-600">
        X 授权已失效，请到{" "}
        <Link className="underline underline-offset-4" href="/publish">
          发布页
        </Link>{" "}
        重新连接。
      </p>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const scheduledAt = mode === "schedule" ? new Date(when) : null;
      if (scheduledAt && (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now())) {
        throw new Error("请选择一个将来的时间");
      }
      const draftId = (await props.getDraftId?.()) ?? undefined;
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tweets,
          draftId,
          scheduledAt: scheduledAt?.toISOString(),
          quoteTweetId: props.quoteTweetId,
          imageId: props.imageId ?? undefined,
        }),
      });
      const data = (await res.json()) as { item?: PostItem; error?: string };
      if (!res.ok || !data.item) throw new Error(data.error || "发布失败");
      setResult(data.item);
      setMode("idle");
      if (data.item.status === "published" || data.item.status === "scheduled") props.onDone?.(data.item.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "发布失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-2 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
      {mode === "idle" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button className={primaryButton} disabled={invalid || busy} onClick={() => setMode("now")}>
            发布到 X
          </button>
          <button className={secondaryButton} disabled={invalid || busy} onClick={() => setMode("schedule")}>
            定时发布
          </button>
          <span className="text-xs text-zinc-500">
            @{me.x.handle}
            {invalid && " · 有内容为空或超过 280，先改好再发"}
          </span>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
          {mode === "schedule" && (
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">发布时间（本机时区）</span>
              <input
                type="datetime-local"
                className={`${inputClass} max-w-xs`}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </label>
          )}
          <p>
            {mode === "now" ? "确认现在" : `确认在 ${when ? new Date(when).toLocaleString("zh-CN") : "—"} `}以 <b>@{me.x.handle}</b> 发布
            {props.quoteTweetId ? "这条引用推文" : isThread ? ` ${tweets.length} 条串推` : "这条推文"}
            {props.imageId ? "（带 1 张配图）" : ""}？
            {mode === "now" && " 发出后会立即公开。"}
          </p>
          <div className="flex gap-2">
            <button className={primaryButton} disabled={busy} onClick={submit}>
              {busy ? "处理中…" : mode === "now" ? "确认发布" : "确认定时"}
            </button>
            <button className={secondaryButton} disabled={busy} onClick={() => setMode("idle")}>
              取消
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
      {result?.status === "published" && result.postIds[0] && (
        <p className="text-green-700 dark:text-green-400">
          已发布。
          <a className="ml-1 underline underline-offset-4" href={postUrl(result.handle, result.postIds[0])} target="_blank" rel="noreferrer">
            在 X 上查看
          </a>
        </p>
      )}
      {result?.status === "scheduled" && (
        <p className="text-green-700 dark:text-green-400">
          已加入定时队列，{new Date(result.scheduledAt!).toLocaleString("zh-CN")} 发出。
          <Link className="ml-1 underline underline-offset-4" href="/publish">
            查看队列
          </Link>
        </p>
      )}
      {result?.status === "failed" && <p className="text-red-600">{result.error}</p>}
    </div>
  );
}
