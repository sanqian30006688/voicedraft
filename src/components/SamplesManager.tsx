"use client";

import { useCallback, useEffect, useState } from "react";
import { parseFile, parsePlainText, type RawSample, type SampleSource } from "@/lib/import";
import { useMe } from "./AppShell";
import { card, primaryButton, secondaryButton } from "./ui";

interface Sample {
  id: string;
  content: string;
  lang: string;
  source: SampleSource;
  postedAt: string | null;
  excluded: boolean;
  pinned: boolean;
}

const SOURCE_LABEL: Record<SampleSource, string> = { paste: "粘贴", file: "文件", x_archive: "X 存档" };
const BATCH = 1000;

export default function SamplesManager() {
  const { refresh: refreshMe } = useMe();
  const [items, setItems] = useState<Sample[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/samples")
      .then((r) => r.json())
      .then((d: { items: Sample[]; total: number }) => {
        setItems(d.items);
        setTotal(d.total);
        setLoaded(true);
      })
      .catch(() => setError("加载素材失败"));
  }, []);

  useEffect(load, [load]);

  async function importItems(samples: RawSample[], source: SampleSource, extra = "") {
    if (!samples.length) {
      setError("没有识别到内容");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const sum = { added: 0, duplicate: 0, tooShort: 0 };
    try {
      for (let i = 0; i < samples.length; i += BATCH) {
        setNotice(`正在导入 ${Math.min(i + BATCH, samples.length)} / ${samples.length}…`);
        const res = await fetch("/api/samples", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source, items: samples.slice(i, i + BATCH) }),
        });
        const d = (await res.json()) as typeof sum & { error?: string };
        if (!res.ok) throw new Error(d.error || "导入失败");
        sum.added += d.added;
        sum.duplicate += d.duplicate;
        sum.tooShort += d.tooShort;
      }
      setNotice(
        `导入了 ${sum.added} 条。` +
          (sum.duplicate ? `跳过重复 ${sum.duplicate} 条。` : "") +
          (sum.tooShort ? `跳过太短或只有链接的 ${sum.tooShort} 条。` : "") +
          extra,
      );
      setPaste("");
      load();
      refreshMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const { samples, source, retweets } = parseFile(file.name, text);
      await importItems(samples, source, retweets ? `跳过转推 ${retweets} 条。` : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function patch(id: string, body: Partial<Pick<Sample, "excluded" | "pinned">>) {
    setItems((list) => list.map((s) => (s.id === id ? { ...s, ...body } : s)));
    await fetch(`/api/samples/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function remove(id: string) {
    setItems((list) => list.filter((s) => s.id !== id));
    setTotal((t) => t - 1);
    await fetch(`/api/samples/${id}`, { method: "DELETE" });
    refreshMe();
  }

  async function removeAll() {
    if (!confirm(`确定删除全部 ${total} 条素材吗？删除后不能恢复。`)) return;
    await fetch("/api/samples", { method: "DELETE" });
    load();
    refreshMe();
  }

  const usable = items.filter((s) => !s.excluded).length;

  return (
    <div className="space-y-8">
      <section className={`${card} space-y-4`}>
        <div>
          <h2 className="font-medium">导入你写过的推文</h2>
          <p className="mt-1 text-sm text-zinc-500">
            建议至少 30 条。会自动去掉链接、重复内容和少于 10 个字的内容。
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">方式一：上传文件</h3>
          <p className="text-sm text-zinc-500">
            支持 X 官方存档里的 <code>data/tweets.js</code>（在 X 的「设置 → 你的账号 → 下载数据存档」申请），也支持 .txt、.md、.csv。
          </p>
          <label className={`${secondaryButton} inline-block cursor-pointer`}>
            选择文件
            <input type="file" accept=".js,.txt,.md,.csv" className="sr-only" onChange={onFile} disabled={busy} />
          </label>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">方式二：直接粘贴</h3>
          <p className="text-sm text-zinc-500">一行一条；如果一条有多行，就用空行把每条隔开。</p>
          <textarea
            aria-label="粘贴推文"
            className="w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <button
            className={primaryButton}
            disabled={busy || !paste.trim()}
            onClick={() => importItems(parsePlainText(paste), "paste")}
          >
            导入粘贴的内容
          </button>
        </div>

        {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">
            已有素材 {total} 条
            {total > 0 && <span className="ml-2 text-sm font-normal text-zinc-500">（参与学习的 {usable} 条）</span>}
          </h2>
          {total > 0 && (
            <button className="text-sm text-red-600 underline underline-offset-4" onClick={removeAll}>
              删除全部
            </button>
          )}
        </div>
        {total > items.length && (
          <p className="mb-2 text-sm text-zinc-500">只显示最近的 {items.length} 条。</p>
        )}
        {!loaded ? (
          <p className="text-sm text-zinc-500">加载中…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-zinc-500">还没有素材。</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                <div className={`flex-1 text-sm leading-6 ${s.excluded ? "text-zinc-400 line-through" : ""}`}>
                  {s.pinned && <span className="mr-1 rounded bg-amber-100 px-1 text-xs text-amber-800">代表句</span>}
                  {s.content}
                  <div className="mt-1 text-xs text-zinc-400">
                    {SOURCE_LABEL[s.source]}
                    {s.postedAt && ` · ${new Date(s.postedAt).toLocaleDateString("zh-CN")}`}
                    {s.lang === "en" && " · 英文"}
                  </div>
                </div>
                <div className="flex shrink-0 justify-end gap-1 text-xs">
                  <button className={secondaryButton} onClick={() => patch(s.id, { pinned: !s.pinned })}>
                    {s.pinned ? "取消代表句" : "设为代表句"}
                  </button>
                  <button className={secondaryButton} onClick={() => patch(s.id, { excluded: !s.excluded })}>
                    {s.excluded ? "恢复" : "不代表我"}
                  </button>
                  <button className={secondaryButton} onClick={() => remove(s.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
