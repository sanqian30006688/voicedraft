"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ImagePicker from "./ImagePicker";
import PublishBox from "./PublishBox";
import { joinSentences, splitSentences, trigramSimilarity, weightedLength } from "@/lib/text";
import type { Task } from "@/lib/prompts";
import { fallbackPromoLine, hasPromo } from "@/lib/promo";
import { useMe } from "./AppShell";
import { PromoPicker, usePromo } from "./PromoPicker";
import { QUALITY_LABEL, type Quality } from "@/lib/quality";

type Mode = "quick" | "sentence";

interface Sentence {
  id: string;
  text: string;
  /** 模型给出的原文，用来对比用户改写 */
  original: string;
  locked: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const toSentence = (text: string): Sentence => ({ id: uid(), text, original: text, locked: false });

async function requestCandidates(task: Task, promoId?: string) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, promoId: promoId || undefined }),
  });
  const data = (await res.json()) as { candidates?: string[]; quality?: Quality[]; mock?: boolean; error?: string };
  if (!res.ok || !data.candidates) throw new Error(data.error || "生成失败");
  return { candidates: data.candidates, quality: data.quality, mock: !!data.mock };
}

export interface LoadedDraft {
  id: string;
  topic: string;
  mode: Mode;
  sentences: { text: string; original: string; locked: boolean }[];
  sourceItemId?: string | null;
  meta?: { imageId?: string } | null;
}

/** 从灵感池起草时的来源内容 */
interface SourceItem {
  id: string;
  text: string;
  url: string | null;
  author: string | null;
  points: string[] | null;
}

/** 与来源的文本重合度达到这个比例时提醒加入自己的观点 */
const SIMILARITY_WARN = 0.67;

export default function Workbench({ initial, initialTopic }: { initial?: LoadedDraft; initialTopic?: string }) {
  const { me, refresh } = useMe();
  if (!me.card) {
    return (
      <div className="rounded-xl border border-zinc-200 p-6 text-sm leading-7 dark:border-zinc-800">
        <h2 className="mb-2 text-base font-medium">先让我认识一下你的文风</h2>
        <ol className="list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
          <li>
            到 <Link className="underline underline-offset-4" href="/samples">素材</Link> 导入你写过的推文，最方便的是上传 X 官方存档里的 tweets.js，粘贴也可以。建议 30 条以上。
          </li>
          <li>
            到 <Link className="underline underline-offset-4" href="/style-card">风格卡</Link> 点「生成风格卡」。
          </li>
          <li>回到这里开始起草。</li>
        </ol>
        <p className="mt-3 text-zinc-500">目前已导入 {me.samples} 条素材。</p>
      </div>
    );
  }
  return (
    <>
      {me.learnReady && (
        <p className="mb-6 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
          你已经改过不少句子了，可以去 <Link className="underline underline-offset-4" href="/style-card">风格卡</Link> 让 AI 总结一下你的修改习惯。
        </p>
      )}
      <WorkbenchInner key={initial?.id ?? "new"} initial={initial} initialTopic={initialTopic} onEdit={refresh} />
    </>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

function WorkbenchInner({
  initial,
  initialTopic,
  onEdit,
}: {
  initial?: LoadedDraft;
  /** 从「灵感」页带过来的选题 */
  initialTopic?: string;
  onEdit: () => void;
}) {
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "quick");
  const [topic, setTopic] = useState(initial?.topic ?? initialTopic ?? "");
  const sourceId = initial ? initial.sourceItemId : params.get("tg");
  const [source, setSource] = useState<SourceItem | null>(null);
  const [showSource, setShowSource] = useState(!initial);
  const sourceRef = useRef<string | null>(sourceId ?? null);

  // 从灵感池点进来：读取来源内容；带了要点时把要点填进主题
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    fetch(`/api/tg-feed/${sourceId}`)
      .then((r) => (r.ok ? (r.json() as Promise<SourceItem>) : null))
      .then((item) => {
        if (cancelled || !item) return;
        setSource(item);
        const p = params.get("point");
        const point = p !== null ? item.points?.[Number(p)] : undefined;
        if (!initial && point) setTopic((t) => t || point);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // 只在打开页面时读取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);
  const [fullCandidates, setFullCandidates] = useState<string[]>([]);
  const [fullQuality, setFullQuality] = useState<Quality[] | undefined>();
  const [nextCandidates, setNextCandidates] = useState<string[]>([]);
  const [sentences, setSentences] = useState<Sentence[]>(
    () => initial?.sentences.map((x) => ({ ...x, id: uid() })) ?? [],
  );
  const [saveState, setSaveState] = useState<SaveState>(initial ? "saved" : "idle");
  const [imageId, setImageId] = useState<string | null>(null);
  // 草稿 id 用 ref 保存，避免自动保存时重复创建
  const draftId = useRef<string | null>(initial?.id ?? null);
  const creating = useRef<Promise<string> | null>(null);
  const [altFor, setAltFor] = useState<{ id: string; options: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [promoCandidates, setPromoCandidates] = useState<string[]>([]);
  const promo = usePromo();
  const promoId = promo.selected?.id;

  const text = joinSentences(sentences.map((s) => s.text));
  const count = weightedLength(text);
  const similarity = source && text ? trigramSimilarity(text, source.text) : 0;
  const texts = sentences.map((s) => s.text);

  /** 确保草稿已创建，返回草稿 id */
  async function ensureDraft(): Promise<string> {
    if (draftId.current) return draftId.current;
    creating.current ??= fetch("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: topic.trim() || "未命名",
        mode,
        sentences: [],
        sourceItemId: sourceRef.current ?? undefined,
      }),
    })
      .then((r) => r.json())
      .then((d: { id: string }) => {
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

  // 有内容后自动保存（停止输入 0.8 秒后）
  const payload = JSON.stringify({
    topic: topic.trim() || "未命名",
    mode,
    sentences: sentences.map(({ text, original, locked }) => ({ text, original, locked })),
  });
  const lastSaved = useRef<string | null>(initial ? payload : null);
  useEffect(() => {
    if (sentences.length === 0 || payload === lastSaved.current) return;
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
  }, [payload, sentences.length]);

  async function run<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    // 开始一篇新草稿；之前的草稿已自动保存在草稿箱里
    draftId.current = null;
    lastSaved.current = null;
    setSaveState("idle");
    setFullCandidates([]);
    setNextCandidates([]);
    setPromoCandidates([]);
    setSentences([]);
    setAltFor(null);
    setCopied(false);
  }

  function generateFull() {
    reset();
    return run("full", async () => {
      const r = await requestCandidates({ kind: "full", topic, count: 3 }, promoId);
            setFullCandidates(r.candidates);
            setFullQuality(r.quality);
    });
  }

  function startSentenceMode() {
    reset();
    return generateNextFrom([]);
  }

  function generateNextFrom(current: string[]) {
    return run("next", async () => {
      const r = await requestCandidates({ kind: "next", topic, sentences: current, count: 3 }, promoId);
            setNextCandidates(r.candidates);
    });
  }

  /** 逐句模式最后一步：让 AI 写一句带推广的收尾 */
  function generatePromoClosing() {
    setNextCandidates([]);
    return run("promo", async () => {
      const r = await requestCandidates({ kind: "promo", topic, sentences: texts, count: 3 }, promoId);
      setPromoCandidates(r.candidates);
    });
  }

  /** 不用 AI，直接把引导语 + 链接加在末尾 */
  function appendPromoLine() {
    if (!promo.selected) return;
    setSentences((list) => [...list, toSentence(fallbackPromoLine(promo.selected!))]);
    setPromoCandidates([]);
  }

  function pickPromo(candidate: string) {
    setSentences((list) => [...list, ...splitSentences(candidate).map(toSentence)]);
    setPromoCandidates([]);
  }

  const missingPromo = !!promo.selected && sentences.length > 0 && !hasPromo(text, promo.selected);

  function pickFull(candidate: string) {
    setSentences(splitSentences(candidate).map(toSentence));
    setFullCandidates([]);
  }

  function pickNext(candidate: string) {
    const added = splitSentences(candidate).map(toSentence);
    const next = [...sentences, ...added];
    setSentences(next);
    setNextCandidates([]);
  }

  function requestAlternatives(s: Sentence) {
    const position = sentences.findIndex((x) => x.id === s.id);
    return run(`alt:${s.id}`, async () => {
      const r = await requestCandidates({ kind: "alternatives", topic, sentences: texts, position, count: 3 }, promoId);
            setAltFor({ id: s.id, options: r.candidates });
    });
  }

  function replaceSentence(id: string, text: string) {
    setSentences((list) => list.map((s) => (s.id === id ? { ...s, text, original: text } : s)));
    setAltFor(null);
  }

  function editSentence(id: string, text: string) {
    setSentences((list) => list.map((s) => (s.id === id ? { ...s, text } : s)));
  }

  /** 失焦时记录「候选原文 → 用户改写」，下次生成立即带上 */
  function commitEdit(s: Sentence) {
    const edited = s.text.trim();
    if (!edited) {
      setSentences((list) => list.filter((x) => x.id !== s.id));
      return;
    }
    if (edited !== s.original) {
      void fetch("/api/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ original: s.original, edited, draftId: draftId.current ?? undefined }),
      }).then(onEdit);
      setSentences((list) => list.map((x) => (x.id === s.id ? { ...x, text: edited, original: edited } : x)));
    }
  }

  function toggleLock(id: string) {
    setSentences((list) => list.map((s) => (s.id === id ? { ...s, locked: !s.locked } : s)));
  }

  function removeSentence(id: string) {
    setSentences((list) => list.filter((s) => s.id !== id));
  }

  function undoLast() {
    setSentences((list) => {
      const idx = [...list].reverse().findIndex((s) => !s.locked);
      if (idx === -1) return list;
      const realIdx = list.length - 1 - idx;
      return list.filter((_, i) => i !== realIdx);
    });
    setNextCandidates([]);
  }

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    void ensureDraft().then((id) =>
      fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "copied" }),
      }),
    );
    setTimeout(() => setCopied(false), 1500);
  }

  const canStart = topic.trim().length > 0 && !busy;

  return (
    <div>
      <section className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="topic">
          想写什么？
        </label>
        <textarea
          id="topic"
          className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-base outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
          rows={2}
          placeholder="主题或想表达的观点，例如：为什么小团队不该一开始就做多语言"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-300 p-0.5 text-sm dark:border-zinc-700" role="tablist">
            {(["quick", "sentence"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`rounded-md px-3 py-1.5 ${mode === m ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400"}`}
                onClick={() => setMode(m)}
              >
                {m === "quick" ? "快速模式" : "逐句模式"}
              </button>
            ))}
          </div>
          <button
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            disabled={!canStart}
            onClick={mode === "quick" ? generateFull : startSentenceMode}
          >
            {busy === "full" || (busy === "next" && sentences.length === 0) ? "生成中…" : mode === "quick" ? "生成 3 条候选" : "生成开头句"}
          </button>
          {(sentences.length > 0 || fullCandidates.length > 0) && (
            <button className="text-sm text-zinc-500 hover:text-zinc-800" onClick={reset} disabled={!!busy}>
              写新的一篇
            </button>
          )}
        </div>
        {source && (
          <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">
                参考素材{source.author ? `：${source.author}` : ""}
                {source.url && (
                  <a className="ml-2 underline underline-offset-4" href={source.url} target="_blank" rel="noreferrer">
                    原文
                  </a>
                )}
              </span>
              <span className="flex shrink-0 gap-2 text-xs">
                <button className="text-zinc-500 hover:text-zinc-800" onClick={() => setShowSource((v) => !v)}>
                  {showSource ? "收起" : "展开"}
                </button>
                {!draftId.current && (
                  <button
                    className="text-zinc-500 hover:text-zinc-800"
                    onClick={() => {
                      setSource(null);
                      sourceRef.current = null;
                    }}
                  >
                    不用这条
                  </button>
                )}
              </span>
            </div>
            {showSource && (
              <>
                <p className="mt-2 line-clamp-6 whitespace-pre-wrap leading-6 text-zinc-600 dark:text-zinc-400">{source.text}</p>
                {!!source.points?.length && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {source.points.map((p, i) => (
                      <button
                        key={i}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        onClick={() => setTopic(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-xs text-zinc-500">先在上面写下你自己的看法或角度，再生成，写出来会更像你。</p>
              </>
            )}
          </div>
        )}
        <PromoPicker promo={promo} disabled={!!busy} />
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      {fullCandidates.length > 0 && (
        <CandidateList title="选一条作为起点" items={fullCandidates} quality={fullQuality} onPick={pickFull} />
      )}

      {sentences.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-zinc-500">草稿（可直接改字；改过的句子会被记住）</h2>
          <ol className="space-y-2">
            {sentences.map((s) => (
              <li key={s.id} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <textarea
                    aria-label="句子"
                    className={`field-sizing-content min-h-[2.5rem] flex-1 resize-none rounded-md bg-transparent p-1.5 outline-none focus:bg-zinc-50 dark:focus:bg-zinc-900 ${s.locked ? "text-zinc-500" : ""}`}
                    rows={1}
                    value={s.text}
                    readOnly={s.locked}
                    onChange={(e) => editSentence(s.id, e.target.value)}
                    onBlur={() => commitEdit(s)}
                  />
                  <div className="flex shrink-0 justify-end gap-1 text-xs">
                    <SmallButton onClick={() => requestAlternatives(s)} disabled={s.locked || !!busy}>
                      {busy === `alt:${s.id}` ? "…" : "换这句"}
                    </SmallButton>
                    <SmallButton onClick={() => toggleLock(s.id)}>{s.locked ? "解锁" : "锁定"}</SmallButton>
                    <SmallButton onClick={() => removeSentence(s.id)} disabled={s.locked}>
                      删除
                    </SmallButton>
                  </div>
                </div>
                {altFor?.id === s.id && (
                  <div className="mt-2 space-y-1 border-t border-dashed border-zinc-200 pt-2 dark:border-zinc-800">
                    {altFor.options.map((o, i) => (
                      <button
                        key={i}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        onClick={() => replaceSentence(s.id, o)}
                      >
                        {o}
                      </button>
                    ))}
                    <button className="px-2 text-xs text-zinc-500" onClick={() => setAltFor(null)}>
                      保持原句
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <SmallButton onClick={() => generateNextFrom(texts)} disabled={!!busy}>
              {busy === "next" ? "生成中…" : "再加一句"}
            </SmallButton>
            <SmallButton onClick={undoLast} disabled={!!busy}>
              回退最后一句
            </SmallButton>
            {missingPromo && (
              <>
                <SmallButton onClick={generatePromoClosing} disabled={!!busy}>
                  {busy === "promo" ? "生成中…" : "加推广收尾句"}
                </SmallButton>
                <SmallButton onClick={appendPromoLine} disabled={!!busy}>
                  直接加推广链接
                </SmallButton>
              </>
            )}
          </div>
        </section>
      )}

      {promoCandidates.length > 0 && (
        <CandidateList
          title="选一句带推广的收尾"
          items={promoCandidates}
          onPick={pickPromo}
          onMore={generatePromoClosing}
          busy={busy === "promo"}
        />
      )}

      {nextCandidates.length > 0 && (
        <CandidateList
          title={sentences.length === 0 ? "选一个开头" : "选下一句"}
          items={nextCandidates}
          onPick={pickNext}
          onMore={() => generateNextFrom(texts)}
          busy={busy === "next"}
        />
      )}

      {sentences.length > 0 && (
        <section className="mt-8 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">
              预览
              <span className="ml-2 text-xs font-normal text-zinc-400">
                {{ idle: "", saving: "保存中…", saved: "已自动保存到草稿", error: "保存失败，会自动重试" }[saveState]}
              </span>
            </span>
            <span className={count.weighted > count.max ? "text-red-600" : "text-zinc-500"}>
              {count.weighted} / {count.max}
              {count.weighted > count.max && "，超出了，建议删一句或拆成线程"}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-[15px] leading-7">{text}</p>
          <PreviewQuality text={text} />
          {source && similarity >= SIMILARITY_WARN && (
            <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              和参考素材的文字重合度 {Math.round(similarity * 100)}%，建议加入你自己的观点，别直接照搬。
              {source.url && (
                <a className="ml-1 underline underline-offset-4" href={source.url} target="_blank" rel="noreferrer">
                  查看原文
                </a>
              )}
            </p>
          )}
          <button
            className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            onClick={copy}
            disabled={!text}
          >
            {copied ? "已复制" : "复制成品"}
          </button>
          <ImagePicker text={text} format="tweet" getDraftId={ensureDraft} initialImageId={initial?.meta?.imageId} onChange={setImageId} />
          <PublishBox tweets={[text]} getDraftId={ensureDraft} imageId={imageId} />
        </section>
      )}
    </div>
  );
}

function SmallButton(props: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      className="rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

function CandidateList(props: {
  title: string;
  items: string[];
  quality?: Quality[];
  onPick: (s: string) => void;
  onMore?: () => void;
  busy?: boolean;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-medium text-zinc-500">{props.title}</h2>
      <div className="space-y-2">
        {props.items.map((c, i) => (
          <button
            key={i}
            className="block w-full rounded-lg border border-zinc-200 p-3 text-left leading-7 hover:border-zinc-500 dark:border-zinc-800"
            onClick={() => props.onPick(c)}
          >
            {c}
            {props.quality?.[i] && <QualityBadge q={props.quality[i]} />}
          </button>
        ))}
      </div>
      {props.onMore && (
        <button className="mt-2 text-sm text-zinc-500 hover:text-zinc-800" onClick={props.onMore} disabled={props.busy}>
          {props.busy ? "生成中…" : "换一批"}
        </button>
      )}
    </section>
  );
}

function QualityBadge({ q }: { q: Quality }) {
  const color = q.level === "good" ? "text-green-700 dark:text-green-400" : q.level === "ok" ? "text-zinc-500" : "text-amber-700 dark:text-amber-400";
  return (
    <span className={`mt-1 block text-xs ${color}`}>
      质量 {q.score}（{QUALITY_LABEL[q.level]}）{q.notes.length > 0 && `：${q.notes.join("；")}`}
    </span>
  );
}

/** 预览下方的质量分：停止输入半秒后算一次（不调 AI、不收费） */
function PreviewQuality({ text }: { text: string }) {
  const [q, setQ] = useState<Quality | null>(null);
  useEffect(() => {
    if (!text.trim()) return;
    const t = setTimeout(() => {
      fetch("/api/quality", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { quality?: Quality } | null) => setQ(d?.quality ?? null))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [text]);
  return q && text.trim() ? <QualityBadge q={q} /> : null;
}
