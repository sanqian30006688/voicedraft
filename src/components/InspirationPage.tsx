"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fallbackPromoLine, hasPromo, type PromoLink } from "@/lib/promo";
import { trigramSimilarity, weightedLength } from "@/lib/text";
import { useMe } from "./AppShell";
import { PromoPicker, usePromo } from "./PromoPicker";
import PublishBox from "./PublishBox";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface Item {
  id: string;
  source: "x_bookmark" | "x_link";
  tweetId: string;
  authorHandle: string;
  authorName: string | null;
  text: string;
  tweetedAt: string | null;
  quoteCandidates: string[];
  status: "new" | "used" | "dismissed";
}

interface AccountState {
  handle: string;
  authError: string | null;
  canReadBookmarks: boolean;
}

/** 和原推文的字符重合度达到这个比例就提醒（PRD：67%） */
const SIMILARITY_WARN = 0.67;

const RECONNECT_URL = "/api/x/connect?next=/inspiration";

function draftTopic(it: Item) {
  return `看到 @${it.authorHandle} 说：「${it.text}」\n我的看法：`.slice(0, 480);
}

export default function InspirationPage() {
  const { me } = useMe();
  const params = useSearchParams();
  const [view, setView] = useState<"new" | "done">("new");
  const [items, setItems] = useState<Item[] | null>(null);
  const [account, setAccount] = useState<AccountState | null | undefined>(undefined);
  const [busy, setBusy] = useState<"sync" | "add" | null>(null);
  const [notice, setNotice] = useState<string | null>(params.get("x_error"));
  const [link, setLink] = useState("");
  const promo = usePromo({ followMode: false });
  const connected = params.get("connected") === "1";

  const load = useCallback(() => {
    fetch(`/api/inspiration?view=${view}`)
      .then((r) => r.json())
      .then((d: { items: Item[]; account: AccountState | null }) => {
        setItems(d.items);
        setAccount(d.account);
      });
  }, [view]);
  useEffect(load, [load]);

  async function post(body: unknown) {
    const res = await fetch("/api/inspiration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, data: (await res.json()) as { added?: number; item?: Item; error?: string } };
  }

  async function sync() {
    setBusy("sync");
    setNotice(null);
    const { ok, data } = await post({ action: "sync" });
    setNotice(ok ? (data.added ? `新收进 ${data.added} 条书签` : "没有新的书签") : (data.error ?? "同步失败"));
    setBusy(null);
    if (view === "new") load();
    else setView("new");
  }

  async function add() {
    setBusy("add");
    setNotice(null);
    const { ok, data } = await post({ action: "add", url: link });
    if (ok && data.item) {
      setLink("");
      setNotice(data.item.status === "new" ? "已加入" : "这条之前加过，在「已处理」里");
      if (view === "new") load();
    } else {
      setNotice(data.error ?? "添加失败");
    }
    setBusy(null);
  }

  if (account === undefined) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="space-y-6 text-sm">
      <section className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">灵感 · X 书签{account ? ` · @${account.handle}` : ""}</h2>
          {account?.canReadBookmarks && !account.authError && (
            <button className={primaryButton} onClick={sync} disabled={!!busy}>
              {busy === "sync" ? "同步中…" : "同步书签"}
            </button>
          )}
        </div>
        <p className="text-zinc-600 dark:text-zinc-400">
          在 X 上收藏（书签）的推文会收进这里，拿来找选题，或者用你的风格写一条<b>引用推文</b>。引用推文要你确认后才会发出。
          这些是别人的推文，只当灵感用，不会混进「素材」影响你的风格卡。
        </p>

        {!account ? (
          <p>
            先到{" "}
            <Link className="underline underline-offset-4" href="/publish">
              发布页
            </Link>{" "}
            连接 X 账号。
          </p>
        ) : account.authError ? (
          <p className="text-red-600">
            X 授权已失效，
            <a className="underline underline-offset-4" href={RECONNECT_URL}>
              重新连接 X
            </a>
            。
          </p>
        ) : !account.canReadBookmarks ? (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <p>读取书签需要多授权一项「读取书签」权限。点下面的按钮，在 X 的页面上点「授权」就行，回来后就能同步。</p>
            <a className={`${primaryButton} inline-block`} href={RECONNECT_URL}>
              重新连接 X
            </a>
          </div>
        ) : (
          connected && <p className="text-green-700 dark:text-green-400">已授权，可以同步书签了。</p>
        )}

        {account && !account.authError && (
          <div className="flex flex-wrap gap-2">
            <input
              className={`${inputClass} min-w-0 flex-1`}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="或者贴一条推文链接，例如 https://x.com/someone/status/123…"
              onKeyDown={(e) => e.key === "Enter" && link.trim() && !busy && add()}
            />
            <button className={secondaryButton} onClick={add} disabled={!!busy || !link.trim()}>
              {busy === "add" ? "读取中…" : "加入"}
            </button>
          </div>
        )}
        <p className="text-xs text-zinc-500">
          同步书签和读取链接都走 X 官方接口，按读取量计费。只读新收藏的部分，首次最多读 200 条。X API 余额不足时会在这里提示。
        </p>
        {notice && <p className={/失败|不足|失效|没认出|找不到|拒绝|限制|连不上|错误/.test(notice) ? "text-red-600" : ""}>{notice}</p>}
      </section>

      <div className="flex gap-1">
        {(["new", "done"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 ${
              view === v
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {v === "new" ? "待处理" : "已处理"}
          </button>
        ))}
      </div>

      {view === "new" && <PromoPicker promo={promo} />}

      {!items ? (
        <p className="text-zinc-500">加载中…</p>
      ) : items.length === 0 ? (
        <p className="text-zinc-500">
          {view === "new" ? "还没有灵感。点「同步书签」，或贴一条推文链接。" : "还没有处理过的灵感。"}
        </p>
      ) : (
        <ul className="space-y-4">
          {items.map((it) => (
            <InspirationCard
              key={it.id}
              item={it}
              hasCard={!!me.card}
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

function InspirationCard(props: {
  item: Item;
  hasCard: boolean;
  promo: PromoLink | null;
  onChange: (i: Item) => void;
  onRemove: () => void;
}) {
  const it = props.item;
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"published" | "scheduled" | null>(null);
  const count = weightedLength(text);
  const similar = text.trim() ? trigramSimilarity(text, it.text) : 0;

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/inspiration/${it.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const d = (await res.json()) as { item?: Item; ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "操作失败");
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    setOpen(true);
    const d = await act("quote", { promoId: props.promo?.id });
    if (d?.item) {
      props.onChange(d.item);
      if (d.item.quoteCandidates.length) {
        setChosen(0);
        setText(d.item.quoteCandidates[0]);
      }
    }
  }

  function pick(i: number) {
    setChosen(i);
    setText(it.quoteCandidates[i]);
  }

  function startQuote() {
    setOpen(true);
    if (!it.quoteCandidates.length) {
      if (props.hasCard) void generate();
      return;
    }
    if (chosen === null) pick(0);
  }

  function onPublished(status: "published" | "scheduled") {
    setDone(status);
    // 用户改写了 AI 候选时记下来，下次生成会朝这个方向写
    const original = chosen !== null ? it.quoteCandidates[chosen] : null;
    if (original && original.trim() !== text.trim()) {
      void fetch("/api/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ original: original.trim(), edited: text.trim() }),
      }).catch(() => {});
    }
  }

  const tweetUrl = `https://x.com/${it.authorHandle}/status/${it.tweetId}`;

  return (
    <li className={`${card} space-y-3`}>
      <div>
        <div className="text-xs text-zinc-500">
          <a className="font-medium text-zinc-800 hover:underline dark:text-zinc-200" href={tweetUrl} target="_blank" rel="noreferrer">
            {it.authorName ?? it.authorHandle} @{it.authorHandle}
          </a>
          {it.tweetedAt && <span> · {new Date(it.tweetedAt).toLocaleString("zh-CN")}</span>}
          <span> · {it.source === "x_bookmark" ? "书签" : "链接"}</span>
          {it.status === "used" && <span className="text-green-700 dark:text-green-400"> · 已引用</span>}
          {it.status === "dismissed" && <span> · 不感兴趣</span>}
        </div>
        <p className="mt-1 whitespace-pre-wrap leading-6">{it.text}</p>
      </div>

      {!open && !done && (
        <div className="flex flex-wrap gap-2">
          <button className={primaryButton} onClick={startQuote} disabled={!!busy}>
            写引用推文
          </button>
          <Link className={secondaryButton} href={`/?topic=${encodeURIComponent(draftTopic(it))}`}>
            拿来起草
          </Link>
          {it.status === "new" ? (
            <button
              className={secondaryButton}
              disabled={!!busy}
              onClick={async () => (await act("dismiss")) && props.onRemove()}
            >
              不感兴趣
            </button>
          ) : (
            <button
              className={secondaryButton}
              disabled={!!busy}
              onClick={async () => (await act("restore")) && props.onRemove()}
            >
              放回待处理
            </button>
          )}
          <button
            className="px-2 text-xs text-zinc-500 hover:text-red-600"
            disabled={!!busy}
            onClick={async () => {
              if (!confirm("从灵感里删除这条？（不影响 X 上的书签）")) return;
              if (await act("delete")) props.onRemove();
            }}
          >
            删除
          </button>
        </div>
      )}

      {open && !done && (
        <div className="space-y-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
          {!props.hasCard && (
            <p className="text-amber-700 dark:text-amber-400">
              还没有风格卡，AI 候选生成不了，可以自己写。先去{" "}
              <Link className="underline underline-offset-4" href="/samples">
                导入素材
              </Link>{" "}
              就能用了。
            </p>
          )}
          {busy === "quote" ? (
            <p className="text-zinc-500">正在按你的风格写…</p>
          ) : it.quoteCandidates.length > 0 ? (
            <div className="space-y-1">
              {it.quoteCandidates.map((c, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-white dark:hover:bg-zinc-800">
                  <input type="radio" className="mt-1.5" checked={chosen === i} onChange={() => pick(i)} />
                  <span className="leading-6">{c}</span>
                </label>
              ))}
            </div>
          ) : null}
          <textarea
            className={`${inputClass} min-h-20`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="引用时附上的话，可以直接改。原推文会以卡片形式显示在下面。"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <span className={count.valid || !text ? "" : "text-red-600"}>
              {count.weighted} / {count.max}
            </span>
            {props.hasCard && (
              <button className="underline underline-offset-4" onClick={generate} disabled={!!busy}>
                {it.quoteCandidates.length ? "换一批" : "生成候选"}
              </button>
            )}
            {props.promo && !hasPromo(text, props.promo) && text.trim() && (
              <button className="underline underline-offset-4" onClick={() => setText(`${text.trim()}\n${fallbackPromoLine(props.promo!)}`)}>
                加推广链接
              </button>
            )}
            <button className="underline underline-offset-4" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          {similar >= SIMILARITY_WARN && (
            <p className="text-amber-700 dark:text-amber-400">
              这段话和原推文有 {Math.round(similar * 100)}% 的字重合，读起来像在复述。原文读者已经能看到，建议多写你自己的看法。
            </p>
          )}
          <PublishBox tweets={[text]} quoteTweetId={it.tweetId} onDone={onPublished} />
        </div>
      )}

      {done && (
        <p className="text-green-700 dark:text-green-400">
          {done === "published" ? "引用推文已发布。" : "引用推文已加入定时队列。"}
          <Link className="ml-1 underline underline-offset-4" href="/publish">
            查看发布记录
          </Link>
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </li>
  );
}
