"use client";

import { useCallback, useEffect, useState } from "react";
import { MEMORY_FIELDS, type AccountMemory } from "@/lib/memory-core";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface MemoryData {
  memory: AccountMemory;
  enabled: boolean;
  edited: boolean;
  builtAt: string | null;
  error: string | null;
  posts: number;
  nextIn: number;
  recent: string[];
}

type Draft = Record<keyof AccountMemory, string>;

const toDraft = (m: AccountMemory): Draft => ({
  persona: m.persona,
  topics: m.topics.join("\n"),
  positions: m.positions.join("\n"),
  opposes: m.opposes.join("\n"),
  phrasing: m.phrasing.join("\n"),
  avoid: m.avoid.join("\n"),
});

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

const fromDraft = (d: Draft): AccountMemory => ({
  persona: d.persona.trim(),
  topics: lines(d.topics),
  positions: lines(d.positions),
  opposes: lines(d.opposes),
  phrasing: lines(d.phrasing),
  avoid: lines(d.avoid),
});

const HINT: Record<string, string> = {
  topics: "每行一个",
  positions: "每行一条，例如「认为先做出来比想清楚更重要」",
  opposes: "每行一条，例如「反对只谈方法论不动手」",
  phrasing: "每行一条，例如「常用『说白了』引出结论」",
  avoid: "每行一条，例如「不聊政治」",
};

export default function MemoryPage() {
  const [data, setData] = useState<MemoryData | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (d: MemoryData) => {
    setData(d);
    setDraft(toDraft(d.memory));
  };
  const load = useCallback(() => {
    fetch("/api/memory")
      .then((r) => r.json())
      .then(apply)
      .catch(() => setError("加载失败"));
  }, []);
  useEffect(load, [load]);

  async function run(label: string, url: string, init: RequestInit, done: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
      const d = (await res.json()) as MemoryData & { error?: string };
      if (!res.ok) throw new Error(d.error || "操作失败");
      if (d.memory) apply(d);
      else load();
      setNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!data || !draft) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;
  const dirty = JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(toDraft(data.memory)));
  const empty = !data.builtAt && !data.edited;

  return (
    <div className="space-y-6">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">账号记忆</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={!!busy}
              onChange={(e) =>
                run("toggle", "/api/memory", { method: "PUT", body: JSON.stringify({ enabled: e.target.checked }) }, e.target.checked ? "已开启" : "已关闭，生成时不再带记忆")
              }
            />
            生成时带上
          </label>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          记住这个账号经常聊什么、坚持和反对什么观点、喜欢怎么说，还有最近发过什么。起草、长文、回复、引用、自动发帖每次都会带上，人设前后一致，不会今天像财经博主、明天像新闻搬运号。
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {data.builtAt ? `上次整理：${new Date(data.builtAt).toLocaleString()}` : "还没整理过"}，读了 {data.posts} 条你的推文
          {data.builtAt && data.nextIn > 0 ? `；再多 ${data.nextIn} 条会自动重新整理` : ""}。整理不收费。
          {data.edited && " 你改过记忆，之后自动整理只会补充，不会删掉你写的。"}
        </p>
        {data.error && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">上次自动整理没成功：{data.error}</p>}
        <div className="mt-3 flex gap-2">
          <button
            className={secondaryButton}
            disabled={!!busy}
            onClick={() => run("refresh", "/api/memory/refresh", { method: "POST" }, "整理好了")}
          >
            {busy === "refresh" ? "整理中…" : empty ? "现在整理" : "重新整理"}
          </button>
        </div>
      </section>

      <section className={`${card} space-y-4`}>
        <label className="block text-sm">
          <span className="font-medium">账号定位</span>
          <span className="ml-2 text-xs text-zinc-500">一两句话：这个账号是谁、一贯在说什么</span>
          <textarea
            className={`${inputClass} mt-1`}
            rows={2}
            value={draft.persona}
            onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
          />
        </label>
        {MEMORY_FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="font-medium">{f.label}</span>
            <span className="ml-2 text-xs text-zinc-500">{HINT[f.key]}</span>
            <textarea
              className={`${inputClass} mt-1`}
              rows={Math.max(2, Math.min(8, draft[f.key].split("\n").length + 1))}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <div className="flex items-center gap-3">
          <button
            className={primaryButton}
            disabled={!dirty || !!busy}
            onClick={() => run("save", "/api/memory", { method: "PUT", body: JSON.stringify({ memory: fromDraft(draft) }) }, "已保存")}
          >
            {busy === "save" ? "保存中…" : "保存"}
          </button>
          {dirty && (
            <button className={secondaryButton} onClick={() => setDraft(toDraft(data.memory))}>
              撤销修改
            </button>
          )}
          {notice && <span className="text-sm text-green-700">{notice}</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </section>

      {data.recent.length > 0 && data.enabled && (
        <section className={card}>
          <h2 className="font-medium">最近发过的</h2>
          <p className="mt-1 text-sm text-zinc-500">生成时会带上这几条，新内容会承接它们，但不会重复同样的观点和说法。</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.recent.map((t, i) => (
              <li key={i} className="whitespace-pre-wrap rounded-md bg-zinc-50 p-2 dark:bg-zinc-900">
                {t}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
