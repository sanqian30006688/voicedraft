"use client";

import { useCallback, useEffect, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "./ui";

type Mode = "review" | "auto" | "off";
interface Item {
  id: string;
  source: "auto" | "manual";
  body: string;
  status: "draft" | "sending" | "sent" | "cancelled";
  urgent: boolean;
  createdAt: string;
  sendStartedAt: string | null;
  finishedAt: string | null;
  stats: { sent: number; blocked: number; failed: number };
}
interface State {
  config: { mode: Mode; delayMin: number };
  recipients: number;
  items: Item[];
}

const STATUS: Record<Item["status"], string> = { draft: "草稿", sending: "发送中", sent: "已发完", cancelled: "没发 / 已停止" };
const FOOTER = "\n\n——\n不想收到这类通知，点下面「🔕 不再接收」。";

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(d.error || "操作失败");
  return d;
}

/** 后台：功能更新和公告 */
export function AnnounceAdmin() {
  const [s, setS] = useState<State | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [delay, setDelay] = useState(30);
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/announcements")
      .then((r) => r.json())
      .then((d: State) => {
        setS(d);
        setMode(d.config.mode);
        setDelay(d.config.delayMin);
      })
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <p className="text-sm text-zinc-500">加载中…</p>;
  const drafts = s.items.filter((i) => i.status === "draft");
  const history = s.items.filter((i) => i.status !== "draft");

  return (
    <div className="space-y-5 text-sm">
      <p className="text-zinc-500">
        通过机器人给所有绑定了 TG 的用户发消息（现在 {s.recipients} 人会收到）。只在用户当地时间 9 点到 22 点送达，晚上的第二天早上再收到；勾了「紧急」才马上发。每条下面都有「🔕 不再接收」，用户也能在机器人「☰ 更多 → 🔔 更新通知」里关掉。
      </p>

      <div className="space-y-2">
        <h3 className="font-medium">新功能上线时</h3>
        <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="review">自动写好公告，先发到我的 TG，我点一下才发给用户（推荐）</option>
          <option value="auto">自动写好，过一段时间自动发给用户（期间可以在 TG 里点「不发」）</option>
          <option value="off">不自动写，我自己手动发</option>
        </select>
        {mode === "auto" && (
          <label className="flex items-center gap-2">
            上线后等
            <input className={`${inputClass} w-20`} inputMode="numeric" value={delay} onChange={(e) => setDelay(Number(e.target.value) || 0)} />
            分钟再发（这期间上线的更新合并成一条）
          </label>
        )}
        <button className={secondaryButton} disabled={busy} onClick={() => run(() => call("/api/admin/announcements", "PUT", { mode, delayMin: delay }), "已保存")}>
          保存
        </button>
      </div>

      {drafts.map((d) => {
        const body = edits[d.id] ?? d.body;
        return (
          <div key={d.id} className="space-y-2 rounded-lg border border-amber-300 p-3 dark:border-amber-700">
            <p className="font-medium">{d.source === "auto" ? "📝 自动写好的更新公告（还没发）" : "📝 公告草稿"}</p>
            <textarea className={`${inputClass} min-h-40`} value={body} onChange={(e) => setEdits({ ...edits, [d.id]: e.target.value })} />
            <div className="flex flex-wrap gap-2">
              <button
                className={primaryButton}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (body !== d.body) await call(`/api/admin/announcements/${d.id}`, "PATCH", { body });
                    await call(`/api/admin/announcements/${d.id}`, "POST", { action: "send" });
                  }, "开始发了，发完会在 TG 告诉你")
                }
              >
                发给所有用户
              </button>
              <button className={secondaryButton} disabled={busy || body === d.body} onClick={() => run(() => call(`/api/admin/announcements/${d.id}`, "PATCH", { body }), "已保存")}>
                保存修改
              </button>
              <button className={secondaryButton} disabled={busy} onClick={() => run(() => call(`/api/admin/announcements/${d.id}`, "POST", { action: "test" }), "已发到你自己的 TG")}>
                先发给我看看
              </button>
              <button className={secondaryButton} disabled={busy} onClick={() => run(() => call(`/api/admin/announcements/${d.id}`, "POST", { action: "cancel" }), "这条不发了")}>
                不发
              </button>
            </div>
          </div>
        );
      })}

      <div className="space-y-2">
        <h3 className="font-medium">手动发一条</h3>
        <textarea
          className={`${inputClass} min-h-32`}
          value={text}
          placeholder="例如：今晚 23 点到 23:30 服务器维护，期间定时帖会顺延。"
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-xs text-zinc-500">开头会自动加「📢 平台公告」，末尾自动加一句怎么关通知。在机器人里给自己发 /notice 也能写。</p>
        {text.trim() && (
          <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {(text.trim().startsWith("📢") ? text.trim() : `📢 平台公告\n\n${text.trim()}`) + FOOTER}
          </pre>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
          紧急：不等白天，现在就发给所有人
        </label>
        <div className="flex gap-2">
          <button
            className={primaryButton}
            disabled={busy || !text.trim()}
            onClick={() =>
              confirm(`确定发给 ${s.recipients} 位用户吗？发出去就收不回了。`) &&
              run(async () => {
                await call("/api/admin/announcements", "POST", { body: text, urgent, send: true });
                setText("");
                setUrgent(false);
              }, "开始发了，发完会在 TG 告诉你")
            }
          >
            发给所有用户
          </button>
          <button
            className={secondaryButton}
            disabled={busy || !text.trim()}
            onClick={() =>
              run(async () => {
                await call("/api/admin/announcements", "POST", { body: text, urgent, send: false });
                setText("");
              }, "已存成草稿，在上面可以先发给自己看看")
            }
          >
            存草稿
          </button>
        </div>
      </div>

      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}

      {history.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium">发送记录</h3>
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.id} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                  <span>
                    {new Date(h.sendStartedAt ?? h.createdAt).toLocaleString()} · {h.source === "auto" ? "自动" : "手动"}
                    {h.urgent ? " · 紧急" : ""} · {STATUS[h.status]} · 送达 {h.stats.sent}
                    {h.stats.blocked ? ` · 停用机器人 ${h.stats.blocked}` : ""}
                    {h.stats.failed ? ` · 失败 ${h.stats.failed}` : ""}
                  </span>
                  {h.status === "sending" && (
                    <button className={secondaryButton} disabled={busy} onClick={() => run(() => call(`/api/admin/announcements/${h.id}`, "POST", { action: "cancel" }), "已停止")}>
                      停止
                    </button>
                  )}
                </div>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{h.body}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
