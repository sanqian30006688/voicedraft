"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ImagePicker from "./ImagePicker";
import PublishBox from "./PublishBox";
import type { DraftMeta } from "@/db/schema";
import {
  articleText as toArticleText,
  isHeading,
  isImage,
  stripHeading,
  stripImage,
  threadTweets as toThreadTweets,
} from "@/lib/draft-text";
import type { LongFormat, LongLength, LongTask } from "@/lib/longform";
import { weightedLength } from "@/lib/text";
import { useMe } from "./AppShell";
import { PromoPicker, usePromo } from "./PromoPicker";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface Part {
  id: string;
  text: string;
  /** 模型给出的原文，用来对比用户改写 */
  original: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const toPart = (text: string): Part => ({ id: uid(), text, original: text });

const FORMAT_LABEL: Record<LongFormat, string> = { single: "单条长推", thread: "串推（线程）", article: "X 长文" };
const FORMAT_HINT: Record<LongFormat, string> = {
  single:
    "一条推文写一两百字。注意：普通账号一条最多 280 加权字数（约 140 个汉字），超过就要 X Premium（蓝标会员）才能一条发完。",
  thread: "一条接一条发出的多条推文，每条不超过 280 加权字数，普通账号也能发。",
  article: "带标题、小标题和配图的整篇文章（X Premium 的 Articles 功能），不受 280 字限制。会标出建议插图的位置。",
};
const LENGTH_LABEL: Record<LongFormat, Record<LongLength, string>> = {
  single: { short: "短 · 约 100 字（普通账号能发）", medium: "中 · 约 200 字", long: "长 · 约 300 字" },
  thread: { short: "短 · 4–6 条", medium: "中 · 7–10 条", long: "长 · 11–15 条" },
  article: { short: "短 · 约 800 字", medium: "中 · 约 1500 字", long: "长 · 约 3000 字" },
};

/** /api/edits 单条上限 1000 字，太长的段落改写就不记录了 */
const EDIT_LOG_MAX = 1000;

async function requestLong(task: LongTask, promoId?: string) {
  const res = await fetch("/api/longform", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, promoId: promoId || undefined }),
  });
  const data = (await res.json()) as { title?: string; items?: string[]; error?: string };
  if (!res.ok || !data.items) throw new Error(data.error || "生成失败");
  return { title: data.title ?? "", items: data.items };
}

/** 单条长推按空行 / 换行拆成段，方便逐段换写 */
const splitParagraphs = (s: string) =>
  s
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** 草稿箱里打开的长文草稿 */
export interface LoadedLongDraft {
  id: string;
  topic: string;
  mode: LongFormat;
  sentences: { text: string; original: string; locked: boolean }[];
  meta: DraftMeta | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";
const SAVE_LABEL: Record<SaveState, string> = { idle: "", saving: "保存中…", saved: "已自动保存到草稿箱", error: "保存失败，稍后会重试" };

export default function LongformPage({ initial }: { initial?: LoadedLongDraft }) {
  const { me, refresh } = useMe();
  if (!me.card) {
    return (
      <div className="rounded-xl border border-zinc-200 p-6 text-sm leading-7 dark:border-zinc-800">
        <h2 className="mb-2 text-base font-medium">写长文之前，先让我认识一下你的文风</h2>
        <p className="text-zinc-600 dark:text-zinc-400">
          到 <Link className="underline underline-offset-4" href="/samples">素材</Link> 导入你写过的推文，再到{" "}
          <Link className="underline underline-offset-4" href="/style-card">风格卡</Link> 点「生成风格卡」，然后回到这里。
        </p>
      </div>
    );
  }
  return <LongformInner key={initial?.id ?? "new"} initial={initial} onEdit={refresh} />;
}

function LongformInner({ initial, onEdit }: { initial?: LoadedLongDraft; onEdit: () => void }) {
  const meta = initial?.meta ?? {};
  const [format, setFormat] = useState<LongFormat>(initial?.mode ?? "single");
  const [length, setLength] = useState<LongLength>(meta.length ?? "medium");
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [notes, setNotes] = useState(meta.notes ?? "");

  const [title, setTitle] = useState(meta.title ?? "");
  const [outline, setOutline] = useState<Part[]>(() => (meta.outline ?? []).map(toPart));
  const [parts, setParts] = useState<Part[]>(
    () => initial?.sentences.map((x) => ({ id: uid(), text: x.text, original: x.original })) ?? [],
  );
  const [candidates, setCandidates] = useState<string[]>([]);
  const [altFor, setAltFor] = useState<{ id: string; options: string[] } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [numbered, setNumbered] = useState(meta.numbered ?? true);
  const [imageId, setImageId] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // 推广：串推放在最后一条，长文放在最后一段
  const promo = usePromo();

  // ---- 草稿箱：正文出来后自动保存（停止输入 0.8 秒后） ----
  const draftId = useRef<string | null>(initial?.id ?? null);
  const creating = useRef<Promise<string> | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(initial ? "saved" : "idle");

  const payload = JSON.stringify({
    topic: topic.trim() || "未命名",
    mode: format,
    sentences: parts.map(({ text, original }) => ({ text, original, locked: false })),
    meta: {
      title,
      notes,
      length,
      numbered,
      outline: outline.map((p) => p.text.trim()).filter(Boolean),
    } satisfies DraftMeta,
  });
  const lastSaved = useRef<string | null>(initial ? payload : null);

  /** 确保草稿已创建，返回草稿 id */
  async function ensureDraft(): Promise<string> {
    if (draftId.current) return draftId.current;
    creating.current ??= fetch("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: topic.trim() || "未命名", mode: format, sentences: [] }),
    })
      .then(async (r) => {
        const d = (await r.json()) as { id?: string; error?: string };
        if (!r.ok || !d.id) throw new Error(d.error || "保存失败");
        draftId.current = d.id;
        // 地址栏换成草稿地址，刷新后还能回来（不触发页面跳转）
        window.history.replaceState(null, "", `/draft/${d.id}`);
        return d.id;
      })
      .finally(() => {
        creating.current = null;
      });
    return creating.current;
  }

  useEffect(() => {
    if (parts.length === 0 || payload === lastSaved.current) return;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        const id = await ensureDraft();
        const res = await fetch(`/api/drafts/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        if (!res.ok) throw new Error();
        lastSaved.current = payload;
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => clearTimeout(timer);
    // ensureDraft 只读 ref 和当前输入，不需要作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, parts.length]);

  function markCopied() {
    if (!parts.length) return;
    void ensureDraft().then((id) =>
      fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "copied" }),
      }),
    );
  }

  const unit = format === "thread" ? "条" : "段";
  const outlined = format !== "single";

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    // 开始一篇新草稿；之前的已自动保存在草稿箱里
    if (draftId.current) window.history.replaceState(null, "", "/long");
    draftId.current = null;
    lastSaved.current = null;
    setSaveState("idle");
    setTitle("");
    setOutline([]);
    setParts([]);
    setCandidates([]);
    setAltFor(null);
  }

  function changeFormat(f: LongFormat) {
    if (f === format) return;
    setFormat(f);
    reset();
  }

  function makeOutline() {
    return run("outline", async () => {
      const r = await requestLong({ kind: "outline", format, length, topic, notes });
      setTitle(r.title);
      setOutline(r.items.map(toPart));
      setParts([]);
      setAltFor(null);
    });
  }

  function makeCandidates() {
    return run("candidates", async () => {
      const r = await requestLong(
        { kind: "candidates", format: "single", length, topic, notes, count: 3 },
        promo.selected?.id,
      );
      setCandidates(r.items);
      setParts([]);
      setAltFor(null);
    });
  }

  function pickCandidate(c: string) {
    setParts(splitParagraphs(c).map(toPart));
    setCandidates([]);
  }

  function writeAll() {
    if (format === "single") return;
    const points = outline.map((p) => p.text.trim()).filter(Boolean);
    if (!points.length) return;
    return run("write", async () => {
      const r = await requestLong({ kind: "write", format, length, topic, notes, title, outline: points }, promo.selected?.id);
      if (r.title) setTitle(r.title);
      setParts(r.items.map(toPart));
      setAltFor(null);
    });
  }

  function requestRewrite(p: Part) {
    const position = parts.findIndex((x) => x.id === p.id);
    return run(`alt:${p.id}`, async () => {
      const r = await requestLong({
        kind: "rewrite",
        format,
        topic,
        notes,
        title,
        parts: parts.map((x) => x.text),
        position,
        instruction: altFor?.id === p.id ? instruction : "",
        count: 3,
      }, promo.selected?.id);
      setAltFor({ id: p.id, options: r.items });
    });
  }

  function openRewrite(p: Part) {
    if (altFor?.id !== p.id) setInstruction("");
    void requestRewrite(p);
  }

  function replacePart(id: string, text: string) {
    setParts((list) => list.map((p) => (p.id === id ? { ...p, text, original: text } : p)));
    setAltFor(null);
  }

  /** 失焦时记录「候选原文 → 用户改写」，下次生成立即带上 */
  function commitEdit(p: Part) {
    const edited = p.text.trim();
    if (!edited) {
      setParts((list) => list.filter((x) => x.id !== p.id));
      return;
    }
    if (edited === p.original) return;
    const loggable = !isHeading(p.original) && !isImage(p.original);
    if (loggable && edited.length <= EDIT_LOG_MAX && p.original.length <= EDIT_LOG_MAX) {
      void fetch("/api/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ original: p.original, edited, draftId: draftId.current ?? undefined }),
      }).then(onEdit);
    }
    setParts((list) => list.map((x) => (x.id === p.id ? { ...x, text: edited, original: edited } : x)));
  }

  function move<T>(list: T[], i: number, d: number): T[] {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }

  // ---- 成品 ----
  const total = parts.length;
  const threadTweets = toThreadTweets(
    parts.map((p) => p.text),
    numbered,
  );
  const articleText = toArticleText(
    title,
    parts.map((p) => p.text),
  );
  const articleChars = parts.reduce(
    (n, p) => n + (isImage(p.text) ? 0 : stripHeading(p.text).replace(/\s/g, "").length),
    0,
  );
  const singleText = parts.map((p) => p.text).join("\n\n");
  const singleCount = weightedLength(singleText);
  const singleChars = singleText.replace(/\s/g, "").length;
  const overLimit = format === "thread" ? threadTweets.filter((t) => !weightedLength(t).valid).length : 0;

  async function copy(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    markCopied();
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }

  const canStart = topic.trim().length > 0 && !busy;

  return (
    <div>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-300 p-0.5 text-sm dark:border-zinc-700" role="tablist">
            {(["single", "thread", "article"] as const).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={format === f}
                className={`rounded-md px-3 py-1.5 ${format === f ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400"}`}
                onClick={() => changeFormat(f)}
                disabled={!!busy}
              >
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
          <select
            aria-label="篇幅"
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            value={length}
            onChange={(e) => setLength(e.target.value as LongLength)}
          >
            {(["short", "medium", "long"] as const).map((l) => (
              <option key={l} value={l}>
                {LENGTH_LABEL[format][l]}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-zinc-500">
          {FORMAT_HINT[format]}
        </p>

        <label className="block text-sm font-medium" htmlFor="long-topic">
          想写什么？
        </label>
        <textarea
          id="long-topic"
          className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-base outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
          rows={2}
          placeholder="主题或核心观点，例如：独立开发第一年，我最后悔的三个决定"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <PromoPicker promo={promo} disabled={!!busy} />
        <label className="block text-sm font-medium" htmlFor="long-notes">
          要点和材料 <span className="font-normal text-zinc-500">（可选：想讲的经历、数字、例子，越具体越像你）</span>
        </label>
        <textarea
          id="long-notes"
          className={`${inputClass} text-sm`}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {outlined ? (
            <button className={primaryButton} disabled={!canStart} onClick={makeOutline}>
              {busy === "outline" ? "生成中…" : outline.length ? "重新列提纲" : "先列提纲"}
            </button>
          ) : (
            <button className={primaryButton} disabled={!canStart} onClick={makeCandidates}>
              {busy === "candidates" ? "生成中…" : candidates.length || parts.length ? "再来 3 条" : "生成 3 条候选"}
            </button>
          )}
          {(outline.length > 0 || parts.length > 0 || candidates.length > 0) && (
            <button className="text-sm text-zinc-500 hover:text-zinc-800" onClick={reset} disabled={!!busy}>
              清空重来
            </button>
          )}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      {candidates.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-zinc-500">选一条作为起点，之后可以逐段换写、直接改字</h2>
          <div className="space-y-2">
            {candidates.map((c, i) => {
              const n = weightedLength(c);
              return (
                <button
                  key={i}
                  className="block w-full rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-500 dark:border-zinc-800"
                  onClick={() => pickCandidate(c)}
                >
                  <span className="block whitespace-pre-wrap leading-7">{c}</span>
                  <span className={`mt-1 block text-xs ${n.valid ? "text-zinc-400" : "text-amber-600"}`}>
                    {c.replace(/\s/g, "").length} 字 · 加权 {n.weighted}/280{!n.valid && " · 需要 Premium"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {outline.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-zinc-500">提纲（可以改字、调顺序、增删，满意了再写全文）</h2>
          <input
            aria-label={format === "thread" ? "核心观点" : "标题"}
            className={`${inputClass} mb-2 font-medium`}
            placeholder={format === "thread" ? "核心观点" : "标题"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <ol className="space-y-1.5">
            {outline.map((p, i) => (
              <li key={p.id} className="flex items-start gap-2">
                <span className="w-6 shrink-0 pt-2 text-right text-sm text-zinc-400">{i + 1}.</span>
                <textarea
                  aria-label={`要点 ${i + 1}`}
                  className="field-sizing-content min-h-[2.5rem] flex-1 resize-none rounded-md border border-zinc-200 bg-transparent p-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-800"
                  rows={1}
                  value={p.text}
                  onChange={(e) => setOutline((l) => l.map((x) => (x.id === p.id ? { ...x, text: e.target.value } : x)))}
                />
                <div className="flex shrink-0 gap-1 pt-1 text-xs">
                  <SmallButton onClick={() => setOutline((l) => move(l, i, -1))} disabled={i === 0} label="上移">
                    ↑
                  </SmallButton>
                  <SmallButton onClick={() => setOutline((l) => move(l, i, 1))} disabled={i === outline.length - 1} label="下移">
                    ↓
                  </SmallButton>
                  <SmallButton onClick={() => setOutline((l) => l.filter((x) => x.id !== p.id))} label="删除">
                    ✕
                  </SmallButton>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className={secondaryButton} onClick={() => setOutline((l) => [...l, toPart("")])} disabled={!!busy}>
              加一个要点
            </button>
            <button className={primaryButton} onClick={writeAll} disabled={!!busy || !outline.some((p) => p.text.trim())}>
              {busy === "write" ? "正在写，长文可能要一两分钟…" : parts.length ? "按提纲重写全文" : "按提纲写全文"}
            </button>
          </div>
        </section>
      )}

      {parts.length > 0 && (
        <section className="mt-8">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-zinc-500">
              正文（可直接改字；改过的句子会被记住）
              {saveState !== "idle" && (
                <span className={`ml-2 text-xs font-normal ${saveState === "error" ? "text-red-600" : "text-zinc-400"}`}>
                  {saveState === "saved" ? (
                    <>
                      已自动保存到
                      <Link className="ml-0.5 underline underline-offset-2" href="/drafts">
                        草稿箱
                      </Link>
                    </>
                  ) : (
                    SAVE_LABEL[saveState]
                  )}
                </span>
              )}
            </h2>
            {format === "thread" && (
              <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={numbered} onChange={(e) => setNumbered(e.target.checked)} />
                每条末尾加 1/{total} 编号
              </label>
            )}
          </div>
          {format === "article" && (
            <input
              aria-label="文章标题"
              className={`${inputClass} mb-2 text-lg font-semibold`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
          <ol className="space-y-2">
            {parts.map((p, i) => {
              const count = format === "thread" ? weightedLength(threadTweets[i]) : null;
              const heading = isHeading(p.text);
              const image = isImage(p.text);
              return (
                <li
                  key={p.id}
                  className={`rounded-lg border p-2 ${image ? "border-dashed border-sky-300 bg-sky-50/50 dark:border-sky-800 dark:bg-sky-950/30" : "border-zinc-200 dark:border-zinc-800"}`}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    {format === "thread" && <span className="w-6 shrink-0 pt-1.5 text-right text-sm text-zinc-400">{i + 1}</span>}
                    <textarea
                      aria-label={`第 ${i + 1} ${unit}`}
                      className={`field-sizing-content min-h-[2.5rem] flex-1 resize-none rounded-md bg-transparent p-1.5 leading-7 outline-none focus:bg-zinc-50 dark:focus:bg-zinc-900 ${heading ? "font-semibold" : ""}`}
                      rows={1}
                      value={p.text}
                      onChange={(e) => setParts((l) => l.map((x) => (x.id === p.id ? { ...x, text: e.target.value } : x)))}
                      onBlur={() => commitEdit(p)}
                    />
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-xs">
                      {count && (
                        <span className={`mr-1 ${count.valid ? "text-zinc-400" : "text-red-600"}`}>
                          {count.weighted}/{count.max}
                        </span>
                      )}
                      <SmallButton onClick={() => openRewrite(p)} disabled={!!busy}>
                        {busy === `alt:${p.id}` ? "…" : image ? "换配图建议" : `换这${heading ? "个标题" : unit}`}
                      </SmallButton>
                      {format === "thread" && (
                        <SmallButton onClick={() => copy(`t:${p.id}`, threadTweets[i])}>
                          {copied === `t:${p.id}` ? "已复制" : "复制"}
                        </SmallButton>
                      )}
                      <SmallButton onClick={() => setParts((l) => move(l, i, -1))} disabled={i === 0} label="上移">
                        ↑
                      </SmallButton>
                      <SmallButton onClick={() => setParts((l) => move(l, i, 1))} disabled={i === parts.length - 1} label="下移">
                        ↓
                      </SmallButton>
                      <SmallButton onClick={() => setParts((l) => l.filter((x) => x.id !== p.id))} label="删除">
                        ✕
                      </SmallButton>
                    </div>
                  </div>
                  {altFor?.id === p.id && (
                    <div className="mt-2 space-y-1 border-t border-dashed border-zinc-200 pt-2 dark:border-zinc-800">
                      {altFor.options.map((o, k) => (
                        <button
                          key={k}
                          className="block w-full whitespace-pre-wrap rounded-md px-2 py-1.5 text-left text-sm leading-6 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          onClick={() => replacePart(p.id, o)}
                        >
                          {o}
                        </button>
                      ))}
                      <div className="flex flex-wrap items-center gap-2 px-2 pt-1">
                        <input
                          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-900"
                          placeholder="想怎么改？例如：更短、加个例子、语气更冲（可不填）"
                          value={instruction}
                          onChange={(e) => setInstruction(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && !busy && requestRewrite(p)}
                        />
                        <button className="text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400" onClick={() => requestRewrite(p)} disabled={!!busy}>
                          {busy === `alt:${p.id}` ? "生成中…" : "再换一批"}
                        </button>
                        <button className="text-xs text-zinc-500" onClick={() => setAltFor(null)}>
                          保持原文
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <button
            className={`${secondaryButton} mt-3`}
            onClick={() => setParts((l) => [...l, toPart("")])}
            disabled={!!busy}
          >
            加一{unit}
          </button>
        </section>
      )}

      {parts.length > 0 && (
        <section className="mt-8 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">预览</span>
            <span className={overLimit || (format === "single" && !singleCount.valid) ? "text-amber-600" : "text-zinc-500"}>
              {format === "single"
                ? `${singleChars} 字 · 加权 ${singleCount.weighted}/280${singleCount.valid ? " · 普通账号可以发" : " · 超过 280，需要 X Premium 才能一条发完"}`
                : format === "thread"
                ? overLimit
                  ? `共 ${total} 条，其中 ${overLimit} 条超过 280，建议删短或换这条`
                  : `共 ${total} 条`
                : `约 ${articleChars} 字`}
            </span>
          </div>
          {format === "single" ? (
            <p className="whitespace-pre-wrap text-[15px] leading-7">{singleText}</p>
          ) : format === "thread" ? (
            <ol className="space-y-3">
              {threadTweets.map((t, i) => (
                <li key={parts[i].id} className="whitespace-pre-wrap border-l-2 border-zinc-200 pl-3 text-[15px] leading-7 dark:border-zinc-700">
                  {t}
                </li>
              ))}
            </ol>
          ) : (
            <article className="space-y-3 text-[15px] leading-7">
              {title.trim() && <h3 className="text-xl font-semibold">{title}</h3>}
              {parts.map((p) =>
                isImage(p.text) ? (
                  <div
                    key={p.id}
                    className="flex aspect-[16/5] items-center justify-center rounded-lg border border-dashed border-zinc-300 px-4 text-center text-sm text-zinc-500 dark:border-zinc-700"
                  >
                    此处插图：{stripImage(p.text)}
                  </div>
                ) : isHeading(p.text) ? (
                  <h4 key={p.id} className="pt-2 text-base font-semibold">
                    {stripHeading(p.text)}
                  </h4>
                ) : (
                  <p key={p.id} className="whitespace-pre-wrap">
                    {p.text}
                  </p>
                ),
              )}
            </article>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              className={primaryButton}
              onClick={() =>
                copy(
                  "all",
                  format === "single" ? singleText : format === "thread" ? threadTweets.join("\n\n---\n\n") : articleText,
                )
              }
            >
              {copied === "all" ? "已复制" : "复制全文"}
            </button>
            <span className="text-xs text-zinc-500">
              {format === "single"
                ? "段落之间保留空行，直接粘贴到 X 发帖框即可。"
                : format === "thread"
                ? "可以直接发布成串推；手动发时用每条旁边的「复制」逐条粘贴，复制全文会用 --- 分隔各条。"
                : "粘贴到 X 长文编辑器后，把小标题设成标题格式，在【此处插图】的位置插入图片并删掉提示文字。X 暂时没有发布长文的官方接口，只能复制粘贴。"}
            </span>
          </div>
          <ImagePicker
            text={format === "single" ? singleText : format === "thread" ? threadTweets.join("\n\n") : articleText}
            format={format === "article" ? "article" : "tweet"}
            getDraftId={ensureDraft}
            initialImageId={meta.imageId}
            onChange={setImageId}
          />
          {format === "thread" && <PublishBox tweets={threadTweets} getDraftId={ensureDraft} imageId={imageId} />}
          {format === "single" && (
            <>
              <PublishBox tweets={[singleText]} getDraftId={ensureDraft} imageId={imageId} />
              {!singleCount.valid && (
                <p className="mt-1 text-xs text-zinc-500">
                  超过 280 的长推目前不能从这里直接发布，可以复制后在 X 里用 Premium 账号发，或删短到 280 以内。
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function SmallButton(props: { onClick: () => void; disabled?: boolean; label?: string; children: React.ReactNode }) {
  return (
    <button
      className="rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
    >
      {props.children}
    </button>
  );
}
