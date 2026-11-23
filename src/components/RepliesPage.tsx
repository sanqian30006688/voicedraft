"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { weightedLength } from "@/lib/text";
import { fallbackPromoLine, hasPromo, type PromoLink } from "@/lib/promo";
import { useMe } from "./AppShell";
import { PromoPicker, usePromo } from "./PromoPicker";
import { postUrl } from "./PublishBox";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface Settings {
  handle: string;
  authError: string | null;
  autoReplyEnabled: boolean;
  autoReplyIntervalMin: number;
  skipKeywords: string[];
  skipHandles: string[];
  maxRounds: number;
  lastCheckedAt: string | null;
  pausedUntil: string | null;
  pausedReason: string | null;
  timelineEnabled: boolean;
  timelineIntervalMin: number;
  timelineKeywords: string[];
  timelineHandles: string[];
  timelineDailyCap: number;
  timelineReadLimit: number;
  timelineCheckedAt: string | null;
  timelinePausedReason: string | null;
}

interface ReplyItem {
  id: string;
  tweetId: string;
  source: "mention" | "timeline";
  matchReason: string | null;
  authorHandle: string;
  authorName: string | null;
  text: string;
  inReplyToText: string | null;
  tweetedAt: string | null;
  candidates: string[];
  status: "pending" | "sending" | "sent" | "skipped" | "failed" | "deleted";
  skipReason: string | null;
  replyText: string | null;
  replyPostId: string | null;
  error: string | null;
}

const splitList = (s: string) =>
  s
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export default function RepliesPage() {
  const { me } = useMe();
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);
  const [view, setView] = useState<"todo" | "done">("todo");
  const [items, setItems] = useState<ReplyItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 回复里的推广只在手动选择时带，自动生成的候选不带
  const promo = usePromo({ followMode: false });

  const loadSettings = useCallback(() => {
    fetch("/api/x/account")
      .then((r) => r.json())
      .then((d: { account: Settings | null }) => setSettings(d.account));
  }, []);
  const loadItems = useCallback(() => {
    fetch(`/api/replies?view=${view}`)
      .then((r) => r.json())
      .then((d: { items: ReplyItem[] }) => setItems(d.items));
  }, [view]);
  useEffect(loadSettings, [loadSettings]);
  useEffect(loadItems, [loadItems]);

  // 开启自动拉取时，页面每分钟刷新一次队列
  useEffect(() => {
    if (!(settings?.autoReplyEnabled || settings?.timelineEnabled) || view !== "todo") return;
    const t = setInterval(loadItems, 60_000);
    return () => clearInterval(t);
  }, [settings?.autoReplyEnabled, settings?.timelineEnabled, view, loadItems]);

  async function check() {
    setChecking(true);
    setNotice(null);
    const res = await fetch("/api/replies/check", { method: "POST" });
    const d = (await res.json()) as { added?: number; message?: string; error?: string };
    setNotice(d.error ?? d.message ?? (d.added ? `拉到 ${d.added} 条新的提及 / 评论` : "没有新的提及"));
    setChecking(false);
    loadItems();
    loadSettings();
  }

  async function save(patch: Partial<Settings>) {
    const res = await fetch("/api/x/account", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) setNotice(((await res.json()) as { error?: string }).error ?? "保存失败");
    loadSettings();
  }

  if (settings === undefined) return <p className="text-sm text-zinc-500">加载中…</p>;
  if (!settings) {
    return (
      <p className="text-sm text-zinc-500">
        先到{" "}
        <Link className="underline underline-offset-4" href="/publish">
          发布页
        </Link>{" "}
        连接 X 账号，才能处理别人的 @ 和评论。
      </p>
    );
  }

  return (
    <div className="space-y-6 text-sm">
      <section className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">自动回复 · @{settings.handle}</h2>
          <button className={primaryButton} onClick={check} disabled={checking || !!settings.authError}>
            {checking ? "检查中…" : "检查新提及"}
          </button>
        </div>
        <p className="text-zinc-600 dark:text-zinc-400">
          拉取 @你的推文和你推文下的评论，用你的风格卡写好回复候选。<b>每条回复都要你在下面确认后才会发出</b>，不会自动发送。
        </p>
        {!me.card && (
          <p className="text-amber-700 dark:text-amber-400">
            还没有风格卡，回复候选生成不了。先去{" "}
            <Link className="underline underline-offset-4" href="/samples">
              导入素材
            </Link>
            。
          </p>
        )}
        <SettingsForm s={settings} save={save} />
        <p className="text-xs text-zinc-500">
          {settings.lastCheckedAt ? `上次检查：${new Date(settings.lastCheckedAt).toLocaleString("zh-CN")}` : "还没有检查过"}
          {settings.pausedReason && <span className="text-red-600"> · {settings.pausedReason}</span>}
        </p>
        {notice && <p>{notice}</p>}
      </section>

      <FollowSection
        s={settings}
        save={save}
        onChecked={() => {
          loadItems();
          loadSettings();
        }}
      />

      <div className="flex gap-1">
        {(["todo", "done"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 ${
              view === v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {v === "todo" ? "待回复" : "已处理"}
          </button>
        ))}
      </div>

      {view === "todo" && (
        <div className="space-y-1">
          <PromoPicker promo={promo} />
          {promo.selected && (
            <p className="text-xs text-zinc-500">选了推广后，「换一批」生成的回复会在结尾带上它；也可以点「加推广链接」直接加在你写的回复后面。每条都带容易被当成广告，建议只在对方问起时用。</p>
          )}
        </div>
      )}

      {!items ? (
        <p className="text-zinc-500">加载中…</p>
      ) : items.length === 0 ? (
        <p className="text-zinc-500">{view === "todo" ? "没有待回复的提及。点「检查新提及」拉取最新的。" : "还没有处理过的提及。"}</p>
      ) : (
        <ul className="space-y-4">
          {items.map((it) => (
            <ReplyCard
              key={it.id}
              item={it}
              promo={promo.selected}
              onChange={(next) => setItems((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null)}
              onRemove={() => setItems((list) => list?.filter((x) => x.id !== it.id) ?? null)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FollowSection({ s, save, onChecked }: { s: Settings; save: (p: Partial<Settings>) => Promise<void>; onChecked: () => void }) {
  const [keywords, setKeywords] = useState(s.timelineKeywords.join("，"));
  const [handles, setHandles] = useState(s.timelineHandles.join("，"));
  const [cap, setCap] = useState(String(s.timelineDailyCap));
  const [readLimit, setReadLimit] = useState(String(s.timelineReadLimit));
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setNotice(null);
    const res = await fetch("/api/replies/follow-check", { method: "POST" });
    const d = (await res.json()) as { read?: number; added?: number; message?: string; error?: string };
    setNotice(d.error ?? d.message ?? `读了 ${d.read ?? 0} 条，挑出 ${d.added ?? 0} 条写好了回复候选`);
    setChecking(false);
    onChecked();
  }

  return (
    <section className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">给关注的人写回复</h2>
        <button className={secondaryButton} onClick={check} disabled={checking || !!s.authError}>
          {checking ? "检查中…" : "现在检查"}
        </button>
      </div>
      <p className="text-zinc-600 dark:text-zinc-400">
        读你「正在关注」里的新帖子，按下面的规则挑出值得回的，用你的口吻写好回复候选，推到 TG 和下面的待回复里。
        <b>对方没有 @你，所以绝不会自动发出</b>，每条都要你点「发送」。不私信、不关注、不点赞、不转推。X 的「为你推荐」没有开放接口，读不到。
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <input type="checkbox" checked={s.timelineEnabled} onChange={(e) => save({ timelineEnabled: e.target.checked })} />
        自动检查，每
        <select
          className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
          value={s.timelineIntervalMin}
          onChange={(e) => save({ timelineIntervalMin: Number(e.target.value) })}
        >
          {[30, 60, 180, 360].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
            </option>
          ))}
        </select>
        一次
      </label>
      <div className="grid gap-2 rounded-lg bg-zinc-50 p-3 sm:grid-cols-2 dark:bg-zinc-900">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">只挑这些账号（逗号分隔，不用写 @；留空 = 关注的所有人）</span>
          <input className={inputClass} value={handles} onChange={(e) => setHandles(e.target.value)} placeholder="例如：elonmusk，paulg" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">只挑含这些关键词的（逗号分隔；留空 = 不限）</span>
          <input className={inputClass} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="例如：AI，写作，独立开发" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">每天最多写几条回复候选</span>
          <input className={`${inputClass} max-w-24`} type="number" min={1} max={50} value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">每次最多读几条帖子（按条计费）</span>
          <input className={`${inputClass} max-w-24`} type="number" min={5} max={100} value={readLimit} onChange={(e) => setReadLimit(e.target.value)} />
        </label>
        <div className="sm:col-span-2">
          <button
            className={secondaryButton}
            onClick={() =>
              save({
                timelineHandles: splitList(handles).map((h) => h.replace(/^@/, "")),
                timelineKeywords: splitList(keywords),
                timelineDailyCap: Math.max(1, Math.min(50, Number(cap) || 10)),
                timelineReadLimit: Math.max(5, Math.min(100, Number(readLimit) || 20)),
              })
            }
          >
            保存规则
          </button>
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        账号和关键词都设了时，命中任何一个就会挑。同一个人一天最多挑一条；上面「跳过规则」里的账号和关键词这里也不回。读帖子、写候选、发出回复都按次从余额扣。
      </p>
      <p className="text-xs text-zinc-500">
        {s.timelineCheckedAt ? `上次检查：${new Date(s.timelineCheckedAt).toLocaleString("zh-CN")}` : "还没有检查过"}
        {s.timelinePausedReason && <span className="text-red-600"> · {s.timelinePausedReason}</span>}
      </p>
      {notice && <p>{notice}</p>}
    </section>
  );
}

function SettingsForm({ s, save }: { s: Settings; save: (p: Partial<Settings>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [keywords, setKeywords] = useState(s.skipKeywords.join("，"));
  const [handles, setHandles] = useState(s.skipHandles.join("，"));
  const [rounds, setRounds] = useState(String(s.maxRounds));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.autoReplyEnabled} onChange={(e) => save({ autoReplyEnabled: e.target.checked })} />
          自动拉取，每
          <select
            className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
            value={s.autoReplyIntervalMin}
            onChange={(e) => save({ autoReplyIntervalMin: Number(e.target.value) })}
          >
            {[5, 15, 30, 60, 180].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
              </option>
            ))}
          </select>
          一次
        </label>
        <button className="text-xs underline underline-offset-4" onClick={() => setOpen(!open)}>
          {open ? "收起规则" : "跳过规则"}
        </button>
      </div>
      {s.autoReplyEnabled && <p className="text-xs text-zinc-500">X 读取提及按次计费，间隔越短费用越高。应用开着时才会拉取。</p>}
      {open && (
        <div className="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">含这些关键词的不回（逗号分隔）</span>
            <input className={inputClass} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="例如：福利，私信我，加群" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">这些账号不回（逗号分隔，不用写 @）</span>
            <input className={inputClass} value={handles} onChange={(e) => setHandles(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">同一对话最多回复几轮（0 表示不限）</span>
            <input className={`${inputClass} max-w-24`} type="number" min={0} max={50} value={rounds} onChange={(e) => setRounds(e.target.value)} />
          </label>
          <p className="text-xs text-zinc-500">广告、引流、人身攻击等内容，AI 也会自动标为跳过，你可以在「已处理」里恢复。</p>
          <button
            className={secondaryButton}
            onClick={() =>
              save({
                skipKeywords: splitList(keywords),
                skipHandles: splitList(handles).map((h) => h.replace(/^@/, "")),
                maxRounds: Math.max(0, Math.min(50, Number(rounds) || 0)),
              })
            }
          >
            保存规则
          </button>
        </div>
      )}
    </div>
  );
}

function ReplyCard(props: {
  item: ReplyItem;
  promo: PromoLink | null;
  onChange: (i: ReplyItem) => void;
  onRemove: () => void;
}) {
  const it = props.item;
  const [chosen, setChosen] = useState<number | null>(it.candidates.length ? 0 : null);
  const [text, setText] = useState(it.replyText ?? it.candidates[0] ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(it.error);
  const count = weightedLength(text);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/replies/${it.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const d = (await res.json()) as { item?: ReplyItem; error?: string };
      if (!res.ok || !d.item) throw new Error(d.error ?? "操作失败");
      return d.item;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return null;
    } finally {
      setBusy(null);
    }
  }

  function pick(i: number) {
    setChosen(i);
    setText(it.candidates[i]);
  }

  const isTodo = it.status === "pending" || it.status === "failed" || it.status === "sending";

  return (
    <li className={`${card} space-y-3`}>
      <div>
        <div className="text-xs text-zinc-500">
          <a className="font-medium text-zinc-800 hover:underline dark:text-zinc-200" href={`https://x.com/${it.authorHandle}/status/${it.tweetId}`} target="_blank" rel="noreferrer">
            {it.authorName ?? it.authorHandle} @{it.authorHandle}
          </a>
          {it.tweetedAt && <span> · {new Date(it.tweetedAt).toLocaleString("zh-CN")}</span>}
        </div>
        {it.source === "timeline" && (
          <p className="mt-1 text-xs text-sky-700 dark:text-sky-400">
            关注的人 · {it.matchReason ?? "你关注的人"} · 对方没有 @你，发出前请确认合适
          </p>
        )}
        {it.inReplyToText && (
          <p className="mt-1 border-l-2 border-zinc-200 pl-2 text-xs text-zinc-500 dark:border-zinc-700">回复你的：{it.inReplyToText}</p>
        )}
        <p className="mt-1 whitespace-pre-wrap leading-6">{it.text}</p>
      </div>

      {isTodo && (
        <>
          {it.candidates.length > 0 ? (
            <div className="space-y-1">
              {it.candidates.map((c, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <input type="radio" className="mt-1.5" checked={chosen === i} onChange={() => pick(i)} />
                  <span className="leading-6">{c}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-500">还没有回复候选。点「生成候选」，或直接在下面写。</p>
          )}
          <textarea className={`${inputClass} min-h-20`} value={text} onChange={(e) => setText(e.target.value)} placeholder="回复内容，可以直接改" />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={primaryButton}
              disabled={!!busy || !text.trim() || !count.valid || it.status === "sending"}
              onClick={async () => {
                const original = chosen !== null ? it.candidates[chosen] : undefined;
                const next = await act("send", { text, original });
                if (next) props.onRemove();
              }}
            >
              {busy === "send" ? "发送中…" : "确认发送"}
            </button>
            <button
              className={secondaryButton}
              disabled={!!busy}
              onClick={async () => {
                const next = await act("regenerate", props.promo ? { promoId: props.promo.id } : {});
                if (!next) return;
                if (next.status === "skipped") {
                  setError(`AI 建议不回：${next.skipReason ?? ""}。仍想回复可以直接写。`);
                  return;
                }
                props.onChange(next);
                setChosen(next.candidates.length ? 0 : null);
                setText(next.candidates[0] ?? "");
              }}
            >
              {busy === "regenerate" ? "生成中…" : it.candidates.length ? "换一批" : "生成候选"}
            </button>
            <button
              className={secondaryButton}
              disabled={!!busy}
              onClick={async () => {
                if (await act("skip")) props.onRemove();
              }}
            >
              跳过
            </button>
            {props.promo && !hasPromo(text, props.promo) && (
              <button
                className={secondaryButton}
                disabled={!!busy}
                onClick={() => setText((t) => (t.trim() ? `${t.trimEnd()}\n${fallbackPromoLine(props.promo!)}` : fallbackPromoLine(props.promo!)))}
              >
                加推广链接
              </button>
            )}
            <span className={`text-xs ${count.valid ? "text-zinc-400" : "text-red-600"}`}>{count.weighted}/280</span>
          </div>
        </>
      )}

      {it.status === "sent" && (
        <div className="space-y-2">
          <p className="border-l-2 border-green-500 pl-2 leading-6">{it.replyText}</p>
          <div className="flex gap-1">
            {it.replyPostId && (
              <a className={`${secondaryButton} text-xs`} href={postUrl(null, it.replyPostId)} target="_blank" rel="noreferrer">
                在 X 上查看
              </a>
            )}
            <button
              className={`${secondaryButton} text-xs`}
              disabled={!!busy}
              onClick={async () => {
                if (!confirm("从 X 上删除这条回复？不能恢复。")) return;
                const next = await act("delete_x");
                if (next) props.onChange(next);
              }}
            >
              从 X 删除
            </button>
          </div>
        </div>
      )}
      {it.status === "deleted" && <p className="text-xs text-zinc-500">已回复（已从 X 删除）：{it.replyText}</p>}
      {it.status === "skipped" && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>已跳过{it.skipReason ? `：${it.skipReason}` : ""}</span>
          <button
            className="underline underline-offset-4"
            onClick={async () => {
              if (await act("restore")) props.onRemove();
            }}
          >
            恢复到待回复
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </li>
  );
}
