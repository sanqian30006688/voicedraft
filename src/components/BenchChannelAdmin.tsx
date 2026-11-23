"use client";

import { useEffect, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface Cfg {
  enabled: boolean;
  chat: string;
  target: string | null;
  lastPostedAt: string | null;
  lastError: string | null;
  publicCount: number;
  minEntries: number;
}

/** 后台：每周把涨粉榜发到 TG 频道 */
export function BenchChannelAdmin() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [chat, setChat] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (d: Cfg) => {
    setCfg(d);
    setEnabled(d.enabled);
    setChat(d.chat);
  };
  useEffect(() => {
    fetch("/api/admin/bench-channel")
      .then((r) => r.json())
      .then(apply)
      .catch(() => {});
  }, []);

  async function call(method: "PUT" | "POST") {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/bench-channel", {
        method,
        headers: { "content-type": "application/json" },
        body: method === "PUT" ? JSON.stringify({ enabled, chat }) : undefined,
      });
      const d = (await res.json().catch(() => ({}))) as Cfg & { error?: string; reason?: string; ok?: boolean; count?: number };
      if (!res.ok) throw new Error(d.error || d.reason || "操作失败");
      if (method === "PUT") {
        apply(d);
        setMsg({ ok: true, text: "已保存" });
      } else {
        setMsg({ ok: true, text: `已发到 ${d.chat}，列了 ${d.count} 个账号` });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) return <p className="text-sm text-zinc-500">加载中…</p>;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-500">
        每周一北京时间 10 点，把「本周推主涨粉榜」发到你的频道，末尾带上机器人链接，给频道和机器人都拉人。只列客户自愿公开上榜的账号；不满 {cfg.minEntries} 个那周不发。机器人要是频道管理员才能发。
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        每周自动发
      </label>
      <label className="block">
        <span className="text-zinc-500">频道（不填就用上面「必须关注频道」里的第一个）</span>
        <input className={`${inputClass} mt-1`} value={chat} placeholder="@你的频道 或 -100 开头的数字 ID" onChange={(e) => setChat(e.target.value)} />
      </label>
      <p className="text-xs text-zinc-500">
        现在会发到：{cfg.target ?? "（还没有频道）"} · 公开上榜的账号：{cfg.publicCount} 个
        {cfg.lastPostedAt ? ` · 上次：${new Date(cfg.lastPostedAt).toLocaleString()}` : ""}
      </p>
      {cfg.lastError && <p className="text-xs text-amber-700 dark:text-amber-400">上次没发成：{cfg.lastError}</p>}
      <div className="flex gap-2">
        <button className={primaryButton} disabled={busy} onClick={() => call("PUT")}>
          保存
        </button>
        <button className={secondaryButton} disabled={busy} onClick={() => call("POST")}>
          现在发一次
        </button>
      </div>
      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}
    </div>
  );
}
