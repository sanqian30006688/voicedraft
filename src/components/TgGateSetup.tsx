"use client";

import { useEffect, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface Chat {
  chat: string;
  title?: string;
  invite?: string;
}
interface Seen {
  id: string;
  title: string;
  type: string;
  username?: string;
}
interface Diag {
  chat: string;
  ok: boolean;
  title?: string;
  text: string;
}

const EMPTY: Chat = { chat: "", invite: "" };

/** 后台：必须关注频道 / 进群才能用机器人 */
export function TgGateSetup() {
  const [enabled, setEnabled] = useState(false);
  const [chats, setChats] = useState<Chat[]>([EMPTY]);
  const [bot, setBot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seen, setSeen] = useState<Seen[]>([]);
  const [diag, setDiag] = useState<Diag[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/tg-gate")
      .then((r) => r.json())
      .then((d: { gate: { enabled: boolean; chats: Chat[] }; errors: Record<string, string>; botUsername: string | null; adminChats?: Seen[] }) => {
        setSeen(d.adminChats ?? []);
        setEnabled(d.gate.enabled);
        setChats(d.gate.chats.length ? d.gate.chats : [EMPTY]);
        setBot(d.botUsername);
        setErrors(d.errors ?? {});
      })
      .catch(() => {});
  }, []);

  async function call(method: "PUT" | "POST") {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/tg-gate", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, chats }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; diag?: Diag[] };
      if (!res.ok) throw new Error(d.error || "保存失败");
      setDiag(d.diag ?? null);
      if (method === "PUT") {
        setMsg({ ok: true, text: "已保存，立即生效" });
        setErrors({});
        if (d.diag) setChats((cs) => cs.map((c, i) => ({ ...c, title: c.title || d.diag?.[i]?.title })));
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<Chat>) => setChats((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  /** 点选机器人是管理员的群：填进第一个空行（或只填了邀请链接的那行） */
  function pick(x: Seen) {
    setChats((cs) => {
      const chat = x.username ? `@${x.username}` : x.id;
      if (cs.some((c) => c.chat === chat)) return cs;
      const i = cs.findIndex((c) => !c.chat.trim() || /t\.me\/(\+|joinchat)/i.test(c.chat));
      const row = (c: Chat): Chat => {
        const pasted = /t\.me\/(\+|joinchat)/i.test(c.chat) ? c.chat : c.invite;
        return { chat, title: x.title, invite: x.username ? c.invite : pasted };
      };
      if (i >= 0) return cs.map((c, j) => (j === i ? row(c) : c));
      return cs.length < 3 ? [...cs, row(EMPTY)] : cs;
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-zinc-500">
        打开后，用户要先加入下面的频道或群，机器人才给他用；没加入的人会看到「加入」按钮和「我已加入」按钮。管理员自己不受限制。
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-zinc-500">
        <li>
          在 TG 里打开你的频道或群 → 管理员 → 添加管理员，搜 {bot ? <b>@{bot}</b> : "机器人的用户名"} 加进去。权限可以全部关掉，机器人只需要能看到谁加入了。
        </li>
        <li>回到这一页刷新，下面「机器人是管理员的群」里会出现它，点一下就填好了。</li>
        <li>私密群（链接是 t.me/+ 开头的）：把邀请链接贴到第二栏，用户点它就能进群。公开频道不用贴。</li>
        <li>点「检测」，显示「正常」后勾上开关，点保存。</li>
      </ol>
      <div className="space-y-1">
        <p className="font-medium">机器人是管理员的群 / 频道</p>
        {seen.length ? (
          <div className="flex flex-wrap gap-2">
            {seen.map((x) => (
              <button key={x.id} type="button" className={secondaryButton} onClick={() => pick(x)}>
                {x.type === "channel" ? "📢" : "👥"} {x.title}
                {x.username ? `（@${x.username}）` : "（私密）"}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-zinc-500">还没有。先做第 1 步，再刷新这一页。</p>
        )}
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        必须加入才能用机器人
      </label>
      {chats.map((c, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input className={inputClass} placeholder="频道/群：点上面的按钮自动填，或填 @频道名" value={c.chat} onChange={(e) => set(i, { chat: e.target.value })} />
          <input className={inputClass} placeholder="邀请链接（私密群才要，t.me/+ 开头）" value={c.invite ?? ""} onChange={(e) => set(i, { invite: e.target.value })} />
          <button type="button" className={secondaryButton} onClick={() => setChats((cs) => (cs.length > 1 ? cs.filter((_, j) => j !== i) : [EMPTY]))}>
            删除
          </button>
          {c.title && <p className="text-xs text-zinc-500 sm:col-span-3">用户看到的按钮：加入 {c.title}</p>}
          {errors[c.chat] && <p className="text-xs text-red-600 sm:col-span-3">最近检查失败（这期间先放行了）：{errors[c.chat]}</p>}
        </div>
      ))}
      {chats.length < 3 && (
        <button type="button" className="text-zinc-600 underline dark:text-zinc-400" onClick={() => setChats((cs) => [...cs, EMPTY])}>
          + 再加一个（用户要全部加入）
        </button>
      )}
      <div className="flex gap-2">
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => call("POST")}>
          检测
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => call("PUT")}>
          保存
        </button>
      </div>
      {diag?.map((d) => (
        <p key={d.chat} className={d.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>
          {d.chat}：{d.text}
        </p>
      ))}
      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}
    </div>
  );
}
