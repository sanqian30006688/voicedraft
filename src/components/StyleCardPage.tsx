"use client";

import { useCallback, useEffect, useState } from "react";
import type { StyleMetrics } from "@/lib/metrics";
import type { StyleTraits } from "@/lib/style-card";
import { useMe } from "./AppShell";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface CardData {
  card: { id: string; version: number; lang: string; traits: StyleTraits; source: string } | null;
  lang: string;
  metrics: StyleMetrics;
  learning: {
    newEdits: number;
    threshold: number;
    min: number;
    pending: ({ id: string; baseVersion: number; editCount: number; observations: string[] } & { traits: StyleTraits }) | null;
  };
  history: { id: string; version: number; lang: string; source: string; isActive: boolean; createdAt: string }[];
}

const SOURCE_LABEL: Record<string, string> = {
  generated: "AI 生成",
  edited: "手动编辑",
  learned: "学习更新",
  rollback: "回滚",
};

type DraftTraits = Record<keyof StyleTraits, string>;

const FIELDS: { key: keyof StyleTraits; label: string; hint?: string }[] = [
  { key: "catchphrases", label: "常用词 / 口头禅", hint: "用「、」隔开" },
  { key: "bannedWords", label: "从不使用的词", hint: "用「、」隔开" },
  { key: "openings", label: "开头方式" },
  { key: "stance", label: "观点表达" },
  { key: "humor", label: "幽默类型" },
  { key: "topics", label: "话题领域", hint: "用「、」隔开" },
  { key: "notes", label: "其他习惯" },
];

const toDraft = (t: StyleTraits): DraftTraits => ({
  catchphrases: t.catchphrases.join("、"),
  bannedWords: t.bannedWords.join("、"),
  openings: t.openings,
  stance: t.stance,
  humor: t.humor,
  topics: t.topics.join("、"),
  notes: t.notes,
});

const splitList = (s: string) =>
  s
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const fromDraft = (d: DraftTraits): StyleTraits => ({
  catchphrases: splitList(d.catchphrases),
  bannedWords: splitList(d.bannedWords),
  openings: d.openings.trim(),
  stance: d.stance.trim(),
  humor: d.humor.trim(),
  topics: splitList(d.topics),
  notes: d.notes.trim(),
});

export default function StyleCardPage() {
  const { me, refresh: refreshMe } = useMe();
  const [data, setData] = useState<CardData | null>(null);
  const [draft, setDraft] = useState<DraftTraits | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/style-card")
      .then((r) => r.json())
      .then((d: CardData) => {
        setData(d);
        setDraft(d.card ? toDraft(d.card.traits) : null);
      })
      .catch(() => setError("加载风格卡失败"));
  }, []);

  useEffect(load, [load]);

  async function call(label: string, url: string, init: RequestInit, done: (d: Record<string, number>) => string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
      const d = (await res.json()) as Record<string, number> & { error?: string };
      if (!res.ok) throw new Error(d.error || "操作失败");
      setNotice(done(d));
      load();
      refreshMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const generate = () =>
    call("generate", "/api/style-card/generate", { method: "POST" }, (d) => `已根据 ${d.analyzed} 条素材生成第 ${d.version} 版风格卡。`);
  const save = () =>
    draft &&
    call("save", "/api/style-card", { method: "PATCH", body: JSON.stringify(fromDraft(draft)) }, (d) => `已保存为第 ${d.version} 版。`);
  const learn = () =>
    call("learn", "/api/style-card/learn", { method: "POST" }, () => "总结好了，看看下面的建议。");
  const decide = (id: string, action: "accept" | "dismiss") =>
    call("decide", "/api/style-card/learn", { method: "PATCH", body: JSON.stringify({ id, action }) }, (d) =>
      action === "accept" ? `已采纳，风格卡更新为第 ${d.version} 版。` : "已忽略这条建议。",
    );
  const rollback = (id: string, version: number) =>
    call("rollback", "/api/style-card/rollback", { method: "POST", body: JSON.stringify({ id }) }, (d) => `已恢复第 ${version} 版的内容，保存为第 ${d.version} 版。`);

  if (!data) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;
  const m = data.metrics;
  const dirty = !!(draft && data.card && JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(toDraft(data.card.traits))));

  return (
    <div className="space-y-8">
      <section className={card}>
        <h2 className="font-medium">统计指标</h2>
        <p className="mt-1 text-sm text-zinc-500">由程序从你的{data.lang === "en" ? "英文" : "中文"}素材里直接算出，每次生成都会带上。</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="参与学习的素材" value={`${m.sampleCount} 条`} />
          <Stat label="平均句长" value={`${m.avgSentenceChars} 字`} />
          <Stat label="80% 的句子不超过" value={`${m.p80SentenceChars} 字`} />
          <Stat label="平均加权字数" value={`${m.avgWeightedLength} / 280`} />
          <Stat label="感叹号" value={`${m.exclamationPerPost} 个/条`} />
          <Stat label="问号" value={`${m.questionPerPost} 个/条`} />
          <Stat label="含 emoji" value={`${Math.round(m.emojiRate * 100)}%`} />
          <Stat label="含话题标签" value={`${Math.round(m.hashtagRate * 100)}%`} />
        </dl>
        {m.sampleCount > 0 && m.sampleCount < 30 && (
          <p className="mt-3 text-sm text-amber-700">样本较少，风格卡准确度有限，建议导入 30 条以上。</p>
        )}
      </section>

      <section className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">{data.card ? `风格卡 · 第 ${data.card.version} 版` : "还没有风格卡"}</h2>
          <button className={data.card ? secondaryButton : primaryButton} onClick={generate} disabled={!!busy || me.samples === 0}>
            {busy === "generate" ? "AI 正在分析，约需几十秒…" : data.card ? "根据素材重新生成" : "生成风格卡"}
          </button>
        </div>
        {!data.card && (
          <p className="text-sm text-zinc-500">
            {me.samples === 0 ? "请先到「素材」导入你写过的推文。" : "AI 会读你的素材，总结出口头禅、禁用词、开头方式等，你可以再手动修改。"}
          </p>
        )}
        {draft && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <label key={f.key} className={`block text-sm ${f.key === "notes" ? "sm:col-span-2" : ""}`}>
                  <span className="mb-1 block font-medium">
                    {f.label}
                    {f.hint && <span className="ml-1 font-normal text-zinc-400">{f.hint}</span>}
                  </span>
                  {f.key !== "notes" ? (
                    <input
                      className={inputClass}
                      value={draft[f.key]}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                  ) : (
                    <textarea
                      className={inputClass}
                      rows={2}
                      value={draft[f.key]}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button className={primaryButton} onClick={save} disabled={!dirty || !!busy}>
                {busy === "save" ? "保存中…" : "保存修改"}
              </button>
              {dirty && (
                <button className={secondaryButton} onClick={() => data.card && setDraft(toDraft(data.card.traits))}>
                  放弃修改
                </button>
              )}
            </div>
          </>
        )}
        {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      {data.card && (
        <section className={`${card} space-y-3 text-sm`}>
          <h2 className="text-base font-medium">从你的修改中学习</h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            你在起草时改过的句子都会记下来。上次总结之后又改了 {data.learning.newEdits} 次
            {data.learning.newEdits < data.learning.threshold
              ? `，满 ${data.learning.threshold} 次时会提醒你来这里总结。`
              : "，可以总结一下了。"}
          </p>
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full bg-zinc-900 dark:bg-zinc-100"
              style={{ width: `${Math.min(100, (data.learning.newEdits / data.learning.threshold) * 100)}%` }}
            />
          </div>
          {!data.learning.pending && (
            <button
              className={secondaryButton}
              onClick={learn}
              disabled={!!busy || data.learning.newEdits < data.learning.min}
            >
              {busy === "learn"
                ? "AI 正在总结…"
                : data.learning.newEdits < data.learning.min
                  ? `至少改 ${data.learning.min} 次才能总结`
                  : "现在总结"}
            </button>
          )}
          {data.learning.pending && (
            <div className="space-y-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium">根据 {data.learning.pending.editCount} 次修改，AI 发现：</p>
              <ul className="list-disc space-y-1 pl-5">
                {data.learning.pending.observations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
              <TraitDiff before={data.card.traits} after={data.learning.pending.traits} />
              {data.learning.pending.baseVersion !== data.card.version && (
                <p className="text-amber-700">
                  这条建议基于第 {data.learning.pending.baseVersion} 版，之后风格卡又改过，采纳会覆盖之后的改动。
                </p>
              )}
              <div className="flex gap-2">
                <button className={primaryButton} onClick={() => decide(data.learning.pending!.id, "accept")} disabled={!!busy}>
                  采纳，更新风格卡
                </button>
                <button className={secondaryButton} onClick={() => decide(data.learning.pending!.id, "dismiss")} disabled={!!busy}>
                  忽略
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {data.history.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">历史版本</h2>
          <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {data.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between py-2">
                <span>
                  第 {h.version} 版 · {SOURCE_LABEL[h.source] ?? h.source}
                  <span className="ml-2 text-zinc-400">{new Date(h.createdAt).toLocaleString("zh-CN")}</span>
                </span>
                {h.isActive ? (
                  <span className="text-xs text-zinc-500">当前使用</span>
                ) : (
                  <button className={`${secondaryButton} text-xs`} onClick={() => rollback(h.id, h.version)} disabled={!!busy}>
                    恢复这一版
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function TraitDiff({ before, after }: { before: StyleTraits; after: StyleTraits }) {
  const show = (v: string | string[]) => (Array.isArray(v) ? v.join("、") : v) || "（空）";
  const changed = FIELDS.filter((f) => show(before[f.key]) !== show(after[f.key]));
  if (!changed.length) return <p className="text-zinc-500">风格卡内容没有变化。</p>;
  return (
    <div className="space-y-2">
      <p className="font-medium">风格卡会这样改：</p>
      {changed.map((f) => (
        <div key={f.key}>
          <span className="text-xs text-zinc-500">{f.label}</span>
          <p className="text-zinc-400 line-through">{show(before[f.key])}</p>
          <p>{show(after[f.key])}</p>
        </div>
      ))}
    </div>
  );
}
