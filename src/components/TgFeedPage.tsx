"use client";

import Link from "next/link";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "./AppShell";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface Item {
  id: string;
  kind: "tg_forward" | "tg_channel" | "tg_group" | "web" | "x_user" | "manual";
  text: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  points: string[] | null;
  status: "new" | "saved" | "dismissed" | "used";
  sourceId: string | null;
  createdAt: string;
}

interface Source {
  id: string;
  handle: string;
  title: string | null;
  enabled: boolean;
  lastFetchedAt: string | null;
  error: string | null;
}

interface State {
  items: Item[];
  sources: Source[];
  intervalMin: number;
  telegram: { configured: boolean; username: string | null; botError: string | null; bound: boolean; boundAt: string | null };
}

const KIND_LABEL: Record<Item["kind"], string> = { tg_forward: "TG 转发", tg_channel: "频道", tg_group: "TG 群", web: "网页", x_user: "X 主页", manual: "手动添加" };

function fmt(d: string | null) {
  if (!d) return "";
  const date = new Date(d);
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

export default function TgFeedPage() {
  const [state, setState] = useState<State | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (filter === "saved" || filter === "dismissed") q.set("status", filter);
    else if (filter !== "all") q.set("source", filter);
    api<State>(`/api/tg-feed?${q}`)
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [filter]);
  useEffect(load, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;

  const filters: { key: string; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "saved", label: "收藏" },
    { key: "forward", label: "TG 转发 / 手动" },
    ...state.sources.map((s) => ({ key: s.id, label: s.title || `@${s.handle}` })),
    { key: "dismissed", label: "已忽略" },
  ];

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-1 text-lg font-semibold">TG 素材</h1>
        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          从 TG 收集写推文的选题：转发给机器人的消息、订阅的公开频道都会出现在这里。这些只当选题素材，不会当成你的文风样本。
          点「提炼要点」让 AI 找出几个可写的角度，再点一个要点带到起草页。
        </p>
      </section>

      <TelegramCard tg={state.telegram} onChange={load} />

      <ChannelsCard state={state} busy={busy} run={run} />

      <section>
        <div className="mb-3 flex flex-wrap gap-1 text-sm">
          {filters.map((f) => (
            <button
              key={f.key}
              className={`rounded-md px-2.5 py-1 ${
                filter === f.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        {state.items.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {filter === "all" ? "还没有内容。绑定 TG 后转发消息给机器人，或者在上面订阅一个公开频道。" : "这里还没有内容。"}
          </p>
        ) : (
          <ul className="space-y-3">
            {state.items.map((it) => (
              <ItemCard key={it.id} item={it} busy={busy} run={run} />
            ))}
          </ul>
        )}
        {filter === "dismissed" && state.items.length > 0 && (
          <p className="mt-3 text-xs text-zinc-500">已忽略的内容不会出现在「全部」里，可以恢复或删除。</p>
        )}
      </section>

      <ManualAdd run={run} busy={busy} />
    </div>
  );
}

function ItemCard({ item, busy, run }: { item: Item; busy: string | null; run: (l: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const long = item.text.length > 220;
  return (
    <li className={card}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{KIND_LABEL[item.kind]}</span>
        {item.author && <span>{item.author}</span>}
        <span>{fmt(item.publishedAt ?? item.createdAt)}</span>
        {item.status === "saved" && <span className="text-amber-600">★ 已收藏</span>}
        {item.status === "used" && <span className="text-sky-600">已用来起草</span>}
        {item.url && (
          <a className="underline underline-offset-4" href={item.url} target="_blank" rel="noreferrer">
            原文
          </a>
        )}
      </div>
      <p className={`whitespace-pre-wrap text-sm leading-6 ${!open && long ? "line-clamp-5" : ""}`}>{item.text}</p>
      {long && (
        <button className="mt-1 text-xs text-zinc-500 hover:text-zinc-800" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开全文"}
        </button>
      )}
      {!!item.points?.length && (
        <div className="mt-3 space-y-1">
          <p className="text-xs text-zinc-500">可以写的角度（点一个带去起草）：</p>
          {item.points.map((p, i) => (
            <Link
              key={i}
              href={`/?tg=${item.id}&point=${i}`}
              className="block rounded-md border border-zinc-200 px-2 py-1.5 text-sm hover:border-zinc-500 dark:border-zinc-800"
            >
              {p}
            </Link>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1 text-xs">
        <button
          className={secondaryButton}
          disabled={!!busy}
          onClick={() => run(`points:${item.id}`, () => api(`/api/tg-feed/${item.id}/points`, "POST"))}
        >
          {busy === `points:${item.id}` ? "提炼中…" : item.points?.length ? "重新提炼" : "提炼要点"}
        </button>
        <Link className={secondaryButton} href={`/?tg=${item.id}`}>
          用这条起草
        </Link>
        {item.status === "dismissed" ? (
          <>
            <button className={secondaryButton} disabled={!!busy} onClick={() => run("s", () => api(`/api/tg-feed/${item.id}`, "PATCH", { status: "new" }))}>
              恢复
            </button>
            <button className={secondaryButton} disabled={!!busy} onClick={() => run("s", () => api(`/api/tg-feed/${item.id}`, "DELETE"))}>
              删除
            </button>
          </>
        ) : (
          <>
            <button
              className={secondaryButton}
              disabled={!!busy}
              onClick={() => run("s", () => api(`/api/tg-feed/${item.id}`, "PATCH", { status: item.status === "saved" ? "new" : "saved" }))}
            >
              {item.status === "saved" ? "取消收藏" : "收藏"}
            </button>
            <button className={secondaryButton} disabled={!!busy} onClick={() => run("s", () => api(`/api/tg-feed/${item.id}`, "PATCH", { status: "dismissed" }))}>
              忽略
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function TelegramCard({ tg, onChange }: { tg: State["telegram"]; onChange: () => void }) {
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const { me } = useMe();

  // 等用户在 TG 里点「开始」：每 3 秒看一次是否已绑定
  useEffect(() => {
    if (!link || tg.bound) return;
    const timer = setInterval(onChange, 3000);
    const stop = setTimeout(() => setLink(null), 10 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [link, tg.bound, onChange]);

  async function bind() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>("/api/telegram/bind", "POST");
      const qr = await QRCode.toString(r.url, { type: "svg", margin: 1, width: 168 });
      setLink({ url: r.url, qr });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function unbindTg() {
    if (!confirm("解除绑定后，转发给机器人的消息不会再收进来。确定？")) return;
    setBusy(true);
    try {
      await api("/api/telegram/bind", "DELETE");
      setLink(null);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const botLink = tg.username ? `https://t.me/${tg.username}` : null;

  return (
    <section className={card}>
      <h2 className="mb-2 text-sm font-medium">绑定 Telegram</h2>
      {!tg.configured ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">TG 机器人还没有开通。平台方配置一次后，所有用户点一下就能绑定。</p>
      ) : tg.botError ? (
        <p className="text-sm text-red-600">机器人暂时连不上：{tg.botError}</p>
      ) : tg.bound ? (
        <div className="space-y-2 text-sm">
          <p>
            已绑定 ✓ 在 TG 里把消息转发给{" "}
            {botLink ? (
              <a className="underline underline-offset-4" href={botLink} target="_blank" rel="noreferrer">
                @{tg.username}
              </a>
            ) : (
              "机器人"
            )}
            ，就会出现在下面。
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            网页上的功能在机器人里基本都能用：导入素材、风格卡、起草并发布 / 定时、长推 / 串推 / X 长文、灵感和频道订阅、X 书签和引用推文、回复 @你 的人、推广链接、风格盲测。点输入框下方的菜单按钮就行。
          </p>
          <button className={secondaryButton} onClick={unbindTg} disabled={busy}>
            解除绑定
          </button>
        </div>
      ) : link ? (
        <div className="flex flex-col gap-4 text-sm sm:flex-row sm:items-center">
          <div className="h-[168px] w-[168px] shrink-0 rounded-md bg-white" dangerouslySetInnerHTML={{ __html: link.qr }} />
          <div className="space-y-2">
            <p>用手机扫码，或者点下面的按钮，Telegram 会打开机器人，点「开始 / Start」就绑定好了。</p>
            <a className={`${primaryButton} inline-block`} href={link.url} target="_blank" rel="noreferrer">
              在 Telegram 中打开
            </a>
            <p className="text-xs text-zinc-500">链接 10 分钟内有效，只能用一次。绑定成功后这里会自动刷新。</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            绑定后，在 TG 里看到好内容，转发给机器人就能收进来；也可以直接在机器人里起草、发布、回复。不需要登录你的 TG 账号，也不会读取你的群聊。
          </p>
          <button className={primaryButton} onClick={bind} disabled={busy}>
            {busy ? "生成中…" : "绑定 TG"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {me.admin && (
      <div className="mt-4 border-t border-dashed border-zinc-200 pt-3 dark:border-zinc-800">
        <button className="text-xs text-zinc-500 hover:text-zinc-800" onClick={() => setShowSetup((v) => !v)}>
          {showSetup ? "收起" : tg.configured ? "平台方：更换机器人" : "平台方：配置机器人（只需一次）"}
        </button>
        {showSetup && <BotSetup onDone={onChange} />}
      </div>
      )}
    </section>
  );
}

export function BotSetup({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ username: string }>("/api/telegram/setup", "POST", { token });
      setToken("");
      setMsg({ ok: true, text: `已保存，机器人 @${r.username} 开始工作` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 text-sm">
      <ol className="list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
        <li>
          在 Telegram 里打开{" "}
          <a className="underline underline-offset-4" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            @BotFather
          </a>
          ，发送 <code>/newbot</code>。
        </li>
        <li>按提示起一个名字，再起一个以 bot 结尾的用户名（例如 voicedraft_helper_bot）。</li>
        <li>BotFather 会回一串 Token（像 123456789:AAH…），复制粘贴到下面。</li>
      </ol>
      <div className="flex gap-2">
        <input
          className={inputClass}
          type="password"
          autoComplete="off"
          placeholder="粘贴机器人 Token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className={`${primaryButton} shrink-0 whitespace-nowrap`} onClick={save} disabled={busy || !token.trim()}>
          {busy ? "验证中…" : "保存"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">Token 只保存在这台电脑上，不会上传。</p>
      {msg && <p className={msg.ok ? "text-green-700" : "text-red-600"}>{msg.text}</p>}
    </div>
  );
}

function ChannelsCard({
  state,
  busy,
  run,
}: {
  state: State;
  busy: string | null;
  run: (l: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [channel, setChannel] = useState("");
  const [note, setNote] = useState<string | null>(null);

  return (
    <section className={card}>
      <h2 className="mb-1 text-sm font-medium">订阅公开频道</h2>
      <p className="mb-3 text-xs text-zinc-500">
        填公开频道的用户名或链接，每 {state.intervalMin} 分钟自动收一次新消息。只支持公开频道，不需要加入，也不需要机器人。
      </p>
      <div className="flex gap-2 text-sm">
        <input
          className={inputClass}
          placeholder="@频道名 或 https://t.me/频道名"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        />
        <button
          className={`${primaryButton} shrink-0 whitespace-nowrap`}
          disabled={!!busy || !channel.trim()}
          onClick={() =>
            run("add-channel", async () => {
              setNote(null);
              const r = await api<{ title: string; added: number }>("/api/tg-feed/sources", "POST", { channel });
              setChannel("");
              setNote(`已订阅「${r.title}」，先收进最近 ${r.added} 条`);
            })
          }
        >
          {busy === "add-channel" ? "读取中…" : "订阅"}
        </button>
      </div>
      {note && <p className="mt-2 text-sm text-green-700">{note}</p>}
      {state.sources.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {state.sources.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <a className="font-medium hover:underline" href={`https://t.me/s/${s.handle}`} target="_blank" rel="noreferrer">
                  {s.title || s.handle}
                </a>
                <span className="ml-2 text-xs text-zinc-500">@{s.handle}</span>
                <p className="text-xs text-zinc-500">
                  {!s.enabled ? "已暂停" : s.lastFetchedAt ? `上次检查 ${fmt(s.lastFetchedAt)}` : "等待检查"}
                  {s.error && <span className="ml-2 text-red-600">{s.error}</span>}
                </p>
              </div>
              <div className="flex shrink-0 gap-1 text-xs">
                <button
                  className={secondaryButton}
                  disabled={!!busy}
                  onClick={() =>
                    run(`refresh:${s.id}`, async () => {
                      const r = await api<{ added: number }>(`/api/tg-feed/sources/${s.id}`, "POST");
                      setNote(r.added ? `「${s.title || s.handle}」收进 ${r.added} 条新内容` : `「${s.title || s.handle}」暂时没有新内容`);
                    })
                  }
                >
                  {busy === `refresh:${s.id}` ? "检查中…" : "立即检查"}
                </button>
                <button
                  className={secondaryButton}
                  disabled={!!busy}
                  onClick={() => run("toggle", () => api(`/api/tg-feed/sources/${s.id}`, "PATCH", { enabled: !s.enabled }))}
                >
                  {s.enabled ? "暂停" : "恢复"}
                </button>
                <button
                  className={secondaryButton}
                  disabled={!!busy}
                  onClick={() => {
                    if (!confirm(`取消订阅「${s.title || s.handle}」？已收进来的内容会保留。`)) return;
                    void run("remove", () => api(`/api/tg-feed/sources/${s.id}?keep=1`, "DELETE"));
                  }}
                >
                  取消订阅
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ManualAdd({ run, busy }: { run: (l: string, fn: () => Promise<unknown>) => Promise<void>; busy: string | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  if (!open) {
    return (
      <button className="text-sm text-zinc-500 hover:text-zinc-800" onClick={() => setOpen(true)}>
        + 手动粘贴一段内容
      </button>
    );
  }
  return (
    <section className={card}>
      <h2 className="mb-2 text-sm font-medium">手动添加</h2>
      <div className="space-y-2 text-sm">
        <textarea className={inputClass} rows={4} placeholder="粘贴文章段落、别人的观点、新闻……" value={text} onChange={(e) => setText(e.target.value)} />
        <input className={inputClass} placeholder="来源链接（可选）" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="flex gap-2">
          <button
            className={primaryButton}
            disabled={!!busy || !text.trim()}
            onClick={() =>
              run("manual", async () => {
                await api("/api/tg-feed", "POST", { text, url });
                setText("");
                setUrl("");
                setOpen(false);
              })
            }
          >
            添加
          </button>
          <button className={secondaryButton} onClick={() => setOpen(false)}>
            取消
          </button>
        </div>
      </div>
    </section>
  );
}
