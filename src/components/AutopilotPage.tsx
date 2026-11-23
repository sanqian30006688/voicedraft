"use client";

import HotTopicsCard from "./HotTopicsCard";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface Settings {
  enabled: boolean;
  mode: "review" | "auto";
  dailyCap: number;
  minGapMin: number;
  maxGapMin: number;
  startHour: number;
  endHour: number;
  tz: string;
  attachLink: boolean;
  withPromo: boolean;
  withImage: boolean;
  linkReply: boolean;
  longForm: boolean;
  instruction: string;
  maxAgeHours: number;
  perSourceDaily: number;
}

interface Source {
  id: string;
  type: string;
  handle: string;
  title: string | null;
  enabled: boolean;
  autopilot: boolean;
  intervalMin: number;
  lastFetchedAt: string | null;
  error: string | null;
}

interface Item {
  id: string;
  text: string;
  status: string;
  similarity: number | null;
  quality?: number | null;
  note: string | null;
  createdAt: string;
  sourceText: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceType: string | null;
  postStatus: string | null;
  postError: string | null;
  scheduledAt: string | null;
  postIds: string[] | null;
  handle: string | null;
}

interface State {
  settings: Settings;
  items: Item[];
  sources: Source[];
  x: { handle: string; ok: boolean } | null;
  limits: { xOverlap: number; webOverlap: number; capMax: number; gapMin: number; owner: boolean };
}

const SOURCE_LABEL: Record<string, string> = {
  tg_channel: "TG 频道",
  tg_group: "TG 群",
  x_user: "X 主页",
  rss: "RSS",
  web: "网页 / 论坛",
  link: "单篇链接",
};

const TZS = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];

function fmt(d: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function api<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || "操作失败");
  return data;
}

export default function AutopilotPage() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<State>("/api/autopilot")
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;
  const s = state.settings;
  const save = (patch: Partial<Settings>, done?: string) => run("settings", () => api("/api/autopilot", "PATCH", patch), done);
  const pending = state.items.filter((i) => i.status === "review");
  const others = state.items.filter((i) => i.status !== "review");

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-1 text-lg font-semibold">自动发帖</h1>
        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          加上你关注的网站、论坛、X 主页、TG 频道或群，有新内容时按你的文风写成推文，通过 X 官方接口发出。
          可以全自动发，也可以先推到 TG 让你点一下再发。和原文重合太多的不会发：X 用户的推文上限 {state.limits.xOverlap}%，其他来源上限{" "}
          {state.limits.webOverlap}%。
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          费用：写、发、读 X 主页都按次从余额扣，没写成的退回；还能发多少条在「余额」页看。
        </p>
      </section>
      <HotTopicsCard />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>}

      <section className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">{s.enabled ? "已开启 ✅" : "已暂停 ⏸"}</div>
            <div className="text-sm text-zinc-500">
              {state.x ? (state.x.ok ? `发到 @${state.x.handle}` : `X 授权已失效，请到「发布」页重新连接`) : (
                <>
                  还没连接 X，<Link href="/publish" className="underline">去连接</Link>
                </>
              )}
            </div>
          </div>
          <button className={primaryButton} disabled={busy !== null} onClick={() => save({ enabled: !s.enabled }, s.enabled ? "已暂停" : "已开启")}>
            {s.enabled ? "暂停" : "开启自动发帖"}
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">模式</div>
            <select className={inputClass} value={s.mode} onChange={(e) => save({ mode: e.target.value as Settings["mode"] })}>
              <option value="review">先确认再发（推到 TG / 这里，点了才发）</option>
              <option value="auto">全自动（写好直接排进定时）</option>
            </select>
          </label>
          <div className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">每天最多（过去 24 小时，最多 {state.limits.capMax} 条）</div>
            <div className="flex items-center gap-2">
              <NumberField key={`cap${s.dailyCap}`} value={s.dailyCap} min={1} max={state.limits.capMax} onSave={(n) => save({ dailyCap: n })} />
              <span>条</span>
            </div>
          </div>
          <div className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">两条间隔（在这个范围里随机，最短 {state.limits.gapMin} 分钟）</div>
            <div className="flex items-center gap-2">
              <NumberField key={`gl${s.minGapMin}`} value={s.minGapMin} min={state.limits.gapMin} max={1440} onSave={(n) => save({ minGapMin: n, maxGapMin: Math.max(n, s.maxGapMin) })} />
              <span>到</span>
              <NumberField
                key={`gh${s.maxGapMin}`}
                value={Math.max(s.minGapMin, s.maxGapMin)}
                min={state.limits.gapMin}
                max={1440}
                onSave={(n) => save({ maxGapMin: n, minGapMin: Math.min(n, s.minGapMin) })}
              />
              <span>分钟</span>
            </div>
          </div>
          <div className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">发帖时段</div>
            <div className="flex items-center gap-2">
              <select className={inputClass} value={s.startHour} onChange={(e) => save({ startHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
              <span>到</span>
              <select className={inputClass} value={s.endHour} onChange={(e) => save({ endHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">只用多新的内容（按原文发布时间）</div>
            <select className={inputClass} value={s.maxAgeHours} onChange={(e) => save({ maxAgeHours: Number(e.target.value) })}>
              {[6, 12, 24, 48, 72, 168].map((n) => (
                <option key={n} value={n}>
                  {n < 24 ? `${n} 小时内` : `${n / 24} 天内`}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">同一个信息源每天最多用</div>
            <div className="flex items-center gap-2">
              <NumberField key={`ps${s.perSourceDaily}`} value={s.perSourceDaily} min={1} max={state.limits.capMax} onSave={(n) => save({ perSourceDaily: n })} />
              <span>条</span>
            </div>
          </label>
          <label className="text-sm">
            <div className="mb-1 text-zinc-600 dark:text-zinc-400">时区</div>
            <select className={inputClass} value={s.tz} onChange={(e) => save({ tz: e.target.value })}>
              {(TZS.includes(s.tz) ? TZS : [s.tz, ...TZS]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.attachLink} onChange={(e) => save({ attachLink: e.target.checked })} />
              附上原文链接（按带链接的帖子计费）
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.longForm} onChange={(e) => save({ longForm: e.target.checked })} />
              长原文写长、不压缩：X 会员写成一条长推，不是会员写成串推（串推按串推计费）
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.linkReply} onChange={(e) => save({ linkReply: e.target.checked })} />
              原文有链接（教程、文章）时，正文不放链接，发出后在评论区回复一条带链接的（那一条按带链接的帖子计费）
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.withPromo} onChange={(e) => save({ withPromo: e.target.checked })} />
              带上默认推广链接（在「推广」页设置）
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.withImage} onChange={(e) => save({ withImage: e.target.checked })} />
              自动配图：原帖有能用的图（截图、图表、产品图等）就用原图，没有就做一张信息卡（每张另计费）
            </label>
          </div>
        </div>
        <Instruction key={s.instruction} value={s.instruction} onSave={(v) => save({ instruction: v }, "已保存")} busy={busy !== null} />
      </section>

      <SourcesCard state={state} busy={busy} run={run} />

      {pending.length > 0 && (
        <section>
          <h2 className="mb-3 font-medium">等你确认（{pending.length}）</h2>
          <ul className="space-y-3">
            {pending.map((it) => (
              <ReviewCard key={`${it.id}:${it.text}`} item={it} busy={busy} run={run} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-3 font-medium">最近的自动帖</h2>
        {others.length === 0 ? (
          <p className="text-sm text-zinc-500">还没有。开启后，信息源有新内容时这里会出现。</p>
        ) : (
          <ul className="space-y-2">
            {others.map((it) => (
              <li key={it.id} className={`${card} text-sm`}>
                <div className="mb-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                  <span>{statusLabel(it)}</span>
                  {it.similarity !== null && <span>重合 {it.similarity}%</span>}
                  {it.quality != null && <span>质量 {it.quality}</span>}
                  <span>{it.sourceTitle}</span>
                  <span>{fmt(it.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap">{it.text || <span className="text-zinc-400">（没写成）</span>}</p>
                {it.note && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{it.note}</p>}
                {it.postError && it.postStatus === "failed" && <p className="mt-1 text-xs text-red-600">{it.postError}</p>}
                {it.status === "scheduled" && it.postStatus === "scheduled" && (
                  <button className={`${secondaryButton} mt-2`} disabled={busy !== null} onClick={() => run(it.id, () => api(`/api/autopilot/items/${it.id}`, "POST", { action: "skip" }))}>
                    取消这条
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function statusLabel(it: Item) {
  if (it.postStatus === "published") return "✅ 已发出";
  if (it.postStatus === "scheduled") return `⏰ 定时 ${fmt(it.scheduledAt)}`;
  if (it.postStatus === "publishing") return "发布中";
  if (it.postStatus === "failed") return "❌ 发布失败";
  if (it.postStatus === "canceled" || it.status === "skipped") return "⏭ 没发";
  return it.status;
}

/** 数字输入框：离开输入框或按回车时保存 */
function NumberField({ value, min, max, onSave }: { value: number; min: number; max: number; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  const commit = () => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n === value) return setV(String(value));
    const clamped = Math.max(min, Math.min(max, n));
    setV(String(clamped));
    onSave(clamped);
  };
  return (
    <input
      type="number"
      className={`${inputClass} w-28`}
      min={min}
      max={max}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function Instruction({ value, onSave, busy }: { value: string; onSave: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState(value);
  return (
    <div className="text-sm">
      <div className="mb-1 text-zinc-600 dark:text-zinc-400">给 AI 的额外要求（可不填）</div>
      <textarea
        className={inputClass}
        rows={2}
        maxLength={500}
        placeholder="例如：多点评、少复述；结尾抛一个问题；不碰政治话题"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      {v !== value && (
        <button className={`${secondaryButton} mt-2`} disabled={busy} onClick={() => onSave(v)}>
          保存
        </button>
      )}
    </div>
  );
}

function SourcesCard({ state, busy, run }: { state: State; busy: string | null; run: (l: string, fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"follow" | "once">("follow");
  return (
    <section className={`${card} space-y-4`}>
      <div>
        <h2 className="font-medium">信息源</h2>
        <p className="text-sm text-zinc-500">
          可以填：网站或新闻栏目、论坛版块列表页（有 RSS 会自动用 RSS）、单篇文章、x.com/用户名、t.me/公开频道。TG 群：把机器人拉进群并设为管理员，会自动出现在这里。
          只读公开内容，网站在 robots.txt 里不让程序读的不读。只用最近发布的内容（时间在上面设），更早的只收进灵感。
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          void run(
            "add",
            async () => {
              const r = await api<{ title: string; added: number }>("/api/autopilot/sources", "POST", { input, mode });
              setInput("");
              return r;
            },
            "已加入信息源",
          );
        }}
      >
        <input className={`${inputClass} min-w-64 flex-1`} placeholder="https://… / x.com/用户名 / t.me/频道名" value={input} onChange={(e) => setInput(e.target.value)} />
        <select className={`${inputClass} w-auto`} value={mode} onChange={(e) => setMode(e.target.value as "follow" | "once")}>
          <option value="follow">订阅：定时看新内容</option>
          <option value="once">只用这一篇</option>
        </select>
        <button className={primaryButton} disabled={busy !== null || !input.trim()}>
          {busy === "add" ? "读取中…" : "添加"}
        </button>
      </form>
      {state.sources.length === 0 ? (
        <p className="text-sm text-zinc-500">还没有信息源。</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {state.sources.map((src) => (
            <li key={src.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{SOURCE_LABEL[src.type] ?? src.type}</span>
                  {src.title ?? src.handle}
                </div>
                <div className="text-xs text-zinc-500">
                  {src.type === "link" ? "只读一次" : src.type === "tg_group" ? "群里有新消息时实时收" : `每 ${src.intervalMin} 分钟检查`}
                  {src.lastFetchedAt && ` · 上次 ${fmt(src.lastFetchedAt)}`}
                  {!src.enabled && src.type !== "link" && " · 已暂停"}
                </div>
                {src.error && <div className="text-xs text-red-600">{src.error}</div>}
              </div>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={src.autopilot}
                  onChange={(e) => run(src.id, () => api(`/api/autopilot/sources/${src.id}`, "PATCH", { autopilot: e.target.checked }))}
                />
                自动发
              </label>
              {!["link", "tg_group"].includes(src.type) && (
                <button className={secondaryButton} disabled={busy !== null} onClick={() => run(src.id, () => api(`/api/autopilot/sources/${src.id}`, "POST"), "检查完了")}>
                  现在检查
                </button>
              )}
              <button
                className={secondaryButton}
                disabled={busy !== null}
                onClick={() => {
                  if (confirm("删除这个信息源？已收进灵感的内容会保留。")) void run(src.id, () => api(`/api/autopilot/sources/${src.id}`, "DELETE"));
                }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewCard({ item, busy, run }: { item: Item; busy: string | null; run: (l: string, fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [text, setText] = useState(item.text);
  const act = (action: string, done?: string) =>
    run(item.id, () => api(`/api/autopilot/items/${item.id}`, "POST", { action, ...(text !== item.text && action !== "rewrite" && action !== "skip" ? { text } : {}) }), done);
  return (
    <li className={`${card} space-y-2`}>
      <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
        <span>来源：{item.sourceTitle}</span>
        <span>和原文重合 {item.similarity ?? 0}%</span>
        {item.quality != null && <span>质量 {item.quality}</span>}
        <span>{fmt(item.createdAt)}</span>
      </div>
      <textarea className={inputClass} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      {item.note && <p className="text-xs text-amber-700 dark:text-amber-400">{item.note}</p>}
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">看原文</summary>
        <p className="mt-1 whitespace-pre-wrap">{item.sourceText}</p>
        {item.sourceUrl && (
          <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="underline">
            {item.sourceUrl}
          </a>
        )}
      </details>
      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} disabled={busy !== null} onClick={() => act("approve", "已排进定时")}>
          排进定时
        </button>
        <button className={secondaryButton} disabled={busy !== null} onClick={() => act("now", "已发出")}>
          现在就发
        </button>
        <button className={secondaryButton} disabled={busy !== null} onClick={() => act("rewrite")}>
          换个写法
        </button>
        <button className={secondaryButton} disabled={busy !== null} onClick={() => act("skip")}>
          跳过
        </button>
      </div>
    </li>
  );
}
