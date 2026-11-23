"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "./AppShell";
import { postUrl, toLocalInput } from "./PublishBox";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface AccountInfo {
  configured: boolean;
  mock: boolean;
  redirectUri: string;
  account: { handle: string; name: string | null; authError: string | null } | null;
}

interface PostItem {
  id: string;
  tweets: string[];
  status: "scheduled" | "paused" | "publishing" | "published" | "failed" | "canceled" | "deleted";
  scheduledAt: string | null;
  publishedAt: string | null;
  postIds: string[];
  handle: string | null;
  error: string | null;
  quoteTweetId: string | null;
  createdAt: string;
}

const STATUS_LABEL: Record<PostItem["status"], string> = {
  scheduled: "定时中",
  paused: "已暂停",
  publishing: "发布中",
  published: "已发布",
  failed: "失败",
  canceled: "已取消",
  deleted: "已从 X 删除",
};

export default function PublishPage() {
  const { me, refresh } = useMe();
  const params = useSearchParams();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [items, setItems] = useState<PostItem[] | null>(null);
  const [error, setError] = useState<string | null>(params.get("x_error"));
  const connected = params.get("connected") === "1";

  const load = useCallback(() => {
    fetch("/api/x/account")
      .then((r) => r.json())
      .then(setInfo);
    fetch("/api/posts")
      .then((r) => r.json())
      .then((d: { items: PostItem[] }) => setItems(d.items));
  }, []);
  useEffect(load, [load]);

  // 定时任务在后台发出，页面上每 30 秒刷新一次状态
  useEffect(() => {
    if (!items?.some((i) => i.status === "scheduled" || i.status === "publishing")) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [items, load]);

  async function disconnect() {
    if (!confirm("断开 X 账号？已排期的帖子到点时会发布失败，重新连接后可以重试。")) return;
    await fetch("/api/x/account", { method: "DELETE" });
    load();
    refresh();
  }

  async function act(id: string, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/posts/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { item?: PostItem; error?: string };
    if (!res.ok) setError(data.error ?? "操作失败");
    load();
  }

  const scheduled = items?.filter((i) => i.status === "scheduled" || i.status === "paused" || i.status === "publishing") ?? [];
  const failed = items?.filter((i) => i.status === "failed") ?? [];
  const history = items?.filter((i) => ["published", "canceled", "deleted"].includes(i.status)) ?? [];

  return (
    <div className="space-y-8 text-sm">
      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">X 账号</h2>
        {!info ? (
          <p className="text-zinc-500">加载中…</p>
        ) : !info.configured ? (
          me.admin ? (
            <SetupGuide redirectUri={info.redirectUri} onSaved={load} />
          ) : (
            <p className="text-zinc-500">平台还没有配置 X 应用，暂时不能连接 X。请联系管理员。</p>
          )
        ) : info.account ? (
          <>
            <p>
              已连接 <b>@{info.account.handle}</b>
              {info.account.name && <span className="text-zinc-500"> · {info.account.name}</span>}
              {info.mock && <span className="ml-2 text-amber-600">（演示模式，不会真的发到 X）</span>}
            </p>
            {info.account.authError && (
              <p className="text-red-600">授权已失效（{info.account.authError}），请重新连接。</p>
            )}
            {connected && !info.account.authError && <p className="text-green-700 dark:text-green-400">连接成功。</p>}
            <div className="flex gap-2">
              <a className={secondaryButton} href="/api/x/connect">
                {info.account.authError ? "重新连接" : "换一个账号 / 重新授权"}
              </a>
              <button className={secondaryButton} onClick={disconnect}>
                断开
              </button>
            </div>
            <p className="text-xs text-zinc-500">
              授权范围：读写推文、读取你的基本资料（用于显示用户名和拉取提及）。不会私信、关注、点赞或转推。令牌加密保存。
            </p>
          </>
        ) : (
          <>
            <p className="text-zinc-600 dark:text-zinc-400">
              连接后可以在起草和长文页面直接发布、定时发布，并在「回复」页处理别人的 @ 和评论。每一条都要你确认后才会发出。
            </p>
            <a className={`${primaryButton} inline-block`} href="/api/x/connect">
              连接 X 账号
            </a>
            {info.mock && <p className="text-xs text-amber-600">演示模式：会连接一个模拟账号，不会真的发到 X。</p>}
            {!info.mock && me.admin && (
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer">连接时报错？重新填写密钥</summary>
                <div className="mt-2">
                  <SetupGuide redirectUri={info.redirectUri} onSaved={load} />
                </div>
              </details>
            )}
          </>
        )}
        {error && <p className="text-red-600">{error}</p>}
      </section>

      {items && (
        <>
          {scheduled.length > 0 && <BulkBar items={scheduled} onDone={load} onError={setError} />}
          <PostSection title="定时队列" empty="没有排期中的帖子。在起草或长文页面点「定时发布」即可加入。" items={scheduled} act={act} />
          {failed.length > 0 && <PostSection title="发布失败" items={failed} act={act} />}
          <PostSection title="发布记录" empty="还没有发布过。" items={history} act={act} />
          <p className="text-xs text-zinc-500">
            定时发布由 VoiceDraft 在后台按时发出，不用一直开着这个页面。如果服务中途重启，恢复后会立即补发。
          </p>
        </>
      )}
    </div>
  );
}

/** 一键管理所有还没发的定时帖 */
function BulkBar(props: { items: PostItem[]; onDone: () => void; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [delay, setDelay] = useState(60);
  const waiting = props.items.filter((i) => i.status === "scheduled").length;
  const paused = props.items.filter((i) => i.status === "paused").length;
  async function run(body: Record<string, unknown>, ask?: string) {
    if (ask && !confirm(ask)) return;
    setBusy(true);
    props.onError(null);
    const res = await fetch("/api/posts/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json()) as { error?: string; autopilotPaused?: boolean };
    if (!res.ok) props.onError(data.error ?? "操作失败");
    else if (data.autopilotPaused) props.onError("自动发帖也一起暂停了，需要的话到「自动发帖」页重新开启。");
    setBusy(false);
    props.onDone();
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-zinc-500">全部定时帖：</span>
      {waiting > 0 && (
        <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => run({ action: "pause" })}>
          ⏸ 全部暂停
        </button>
      )}
      {paused > 0 && (
        <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => run({ action: "resume" })}>
          ▶️ 全部恢复
        </button>
      )}
      <select className="rounded border px-1 py-0.5 dark:bg-zinc-900" value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
        {[30, 60, 180, 360, 720, 1440, 4320].map((m) => (
          <option key={m} value={m}>
            {m < 60 ? `${m} 分钟` : m < 1440 ? `${m / 60} 小时` : `${m / 1440} 天`}
          </option>
        ))}
      </select>
      <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => run({ action: "delay", minutes: delay })}>
        ⏰ 全部延后
      </button>
      <button
        className={`${secondaryButton} text-xs`}
        disabled={busy}
        onClick={() => run({ action: "cancel" }, `删除全部 ${props.items.filter((i) => i.status !== "publishing").length} 条还没发的定时帖？删了不会发出，也没法恢复。`)}
      >
        🗑 全部删除
      </button>
    </div>
  );
}

function PostSection(props: {
  title: string;
  empty?: string;
  items: PostItem[];
  act: (id: string, body: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <section>
      <h2 className="mb-2 font-medium">
        {props.title}
        {props.items.length > 0 && <span className="ml-1 text-zinc-400">· {props.items.length}</span>}
      </h2>
      {props.items.length === 0 ? (
        <p className="text-zinc-500">{props.empty}</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {props.items.map((p) => (
            <PostRow key={p.id} p={p} act={props.act} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PostRow({ p, act }: { p: PostItem; act: (id: string, body: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(p.scheduledAt ? toLocalInput(new Date(p.scheduledAt)) : "");
  const [open, setOpen] = useState(false);

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    await act(p.id, body);
    setBusy(false);
    setEditing(false);
  };

  const time =
    p.status === "published" && p.publishedAt
      ? `发布于 ${new Date(p.publishedAt).toLocaleString("zh-CN")}`
      : p.scheduledAt
        ? `定于 ${new Date(p.scheduledAt).toLocaleString("zh-CN")}`
        : new Date(p.createdAt).toLocaleString("zh-CN");

  return (
    <li className="space-y-2 py-3">
      <div className="whitespace-pre-wrap leading-6">{open ? p.tweets.join("\n\n———\n\n") : p.tweets[0]}</div>
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
        <span className={p.status === "failed" ? "text-red-600" : ""}>{STATUS_LABEL[p.status]}</span>
        <span>· {time}</span>
        {p.handle && <span>· @{p.handle}</span>}
        {p.quoteTweetId && (
          <a className="underline underline-offset-4" href={`https://x.com/i/web/status/${p.quoteTweetId}`} target="_blank" rel="noreferrer">
            · 引用推文
          </a>
        )}
        {p.tweets.length > 1 && (
          <button className="underline underline-offset-4" onClick={() => setOpen(!open)}>
            串推 {p.tweets.length} 条{open ? "，收起" : "，展开"}
          </button>
        )}
      </div>
      {p.error && <p className="text-xs text-red-600">{p.error}</p>}
      {editing && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="datetime-local" className={`${inputClass} max-w-xs`} value={when} onChange={(e) => setWhen(e.target.value)} />
          <button
            className={secondaryButton}
            disabled={busy || !when}
            onClick={() => run({ action: "edit", scheduledAt: new Date(when).toISOString() })}
          >
            保存
          </button>
          <button className={secondaryButton} onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {p.status === "scheduled" && !editing && (
          <>
            <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => run({ action: "edit", scheduledAt: new Date().toISOString() })}>
              现在发
            </button>
            <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => setEditing(true)}>
              改时间
            </button>
            <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => confirm("取消这条定时发布？") && run({ action: "cancel" })}>
              取消定时
            </button>
          </>
        )}
        {p.status === "paused" && (
          <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => confirm("取消这条定时发布？") && run({ action: "cancel" })}>
            取消定时
          </button>
        )}
        {p.status === "failed" && (
          <>
            <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => run({ action: "retry" })}>
              {busy ? "发布中…" : p.postIds.length ? `从第 ${p.postIds.length + 1} 条继续` : "重试"}
            </button>
            <button className={`${secondaryButton} text-xs`} disabled={busy} onClick={() => run({ action: "cancel" })}>
              放弃
            </button>
          </>
        )}
        {p.postIds.length > 0 && p.status !== "deleted" && (
          <>
            <a className={`${secondaryButton} text-xs`} href={postUrl(p.handle, p.postIds[0])} target="_blank" rel="noreferrer">
              在 X 上查看
            </a>
            <button
              className={`${secondaryButton} text-xs`}
              disabled={busy}
              onClick={() =>
                confirm(p.postIds.length > 1 ? `从 X 上删除这 ${p.postIds.length} 条串推？不能恢复。` : "从 X 上删除这条推文？不能恢复。") &&
                run({ action: "delete_x" })
              }
            >
              从 X 删除
            </button>
          </>
        )}
      </div>
    </li>
  );
}

const PURPOSE_TEXT =
  "VoiceDraft is a personal writing assistant that I run on my own computer. It only accesses my own X account. " +
  "I use it to publish and schedule posts that I have written and approved myself, and to read mentions of my account " +
  "so I can draft replies, which I review and send manually one by one. It does not scrape X, does not share or sell any data, " +
  "and does not automate following, liking, reposting or direct messages. All data is stored locally on my computer.";

export function SetupGuide({ redirectUri, onSaved }: { redirectUri: string; onSaved: () => void }) {
  return (
    <div className="space-y-3 text-zinc-700 dark:text-zinc-300">
      <p>
        要发到 X，需要先在 X 开发者后台拿到两串密钥（Client ID 和 Client Secret），粘贴到本页最下面就行。只需要做一次，大约 5 分钟。
      </p>
      <ol className="list-decimal space-y-3 pl-5">
        <li>
          打开{" "}
          <a className="underline underline-offset-4" href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noreferrer">
            X 开发者后台
          </a>
          ，用你自己的 X 账号登录。
          <div className="mt-1 text-xs text-zinc-500">
            第一次进去会让你注册开发者账号，要填一段「用途说明」，可以直接用这段英文
            <CopyBtn text={PURPOSE_TEXT} />
            。然后勾选同意开发者协议。如果页面要你选套餐或充值（X API 按用量收费），按你自己的预算选，这一步要你自己决定。
          </div>
        </li>
        <li>
          找到 <b>Projects &amp; Apps</b>，点 <b>Add App</b> 或 <b>Create App</b> 新建一个 App，名字随便起，比如 VoiceDraft-你的名字。
          <div className="mt-1 text-xs text-zinc-500">
            建好后页面会显示 API Key、Bearer Token 等一堆密钥，<b>这些用不上</b>，直接关掉或点下一步。
          </div>
        </li>
        <li>
          在这个 App 的设置页里，找到 <b>User authentication settings</b>，点 <b>Set up</b>（或 Edit），按下面填：
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
            <li>
              App permissions：选 <b>Read and write</b>
            </li>
            <li>
              Type of App：选 <b>Web App, Automated App or Bot</b>
            </li>
            <li>
              Callback URI / Redirect URL：填 <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{redirectUri}</code>
              <CopyBtn text={redirectUri} />
            </li>
            <li>
              Website URL：填你的 X 主页地址，比如 https://x.com/你的用户名
            </li>
            <li>其他选项不用填，点最下面的 Save</li>
          </ul>
        </li>
        <li>
          保存后会弹出 <b>OAuth 2.0 Client ID and Client Secret</b>。马上把两串都复制下来，粘贴到下面的框里。
          <div className="mt-1 text-xs text-zinc-500">
            Client Secret 只显示这一次。没来得及复制的话，到 App 的 <b>Keys and tokens</b> 页，在 OAuth 2.0 Client ID and Client Secret 那里点 Regenerate 重新生成。
          </div>
        </li>
      </ol>
      <KeyForm onSaved={onSaved} />
      <p className="text-xs text-zinc-500">
        密钥只保存在你电脑上的项目文件夹里（.env.local），不会上传，也不要发给任何人。
      </p>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`${secondaryButton} ml-1 px-2 py-0.5 text-xs`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function KeyForm({ onSaved }: { onSaved: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/x/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const d = (await res.json()) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "保存失败");
    setClientId("");
    setClientSecret("");
    onSaved();
  }

  return (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
      <label className="block">
        <span className="mb-1 block text-xs text-zinc-500">Client ID</span>
        <input className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-zinc-500">Client Secret</span>
        <input
          className={inputClass}
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button className={primaryButton} disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={save}>
        {busy ? "保存中…" : "保存密钥"}
      </button>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
