"use client";

import { useCallback, useEffect, useState } from "react";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface UserRow {
  id: string;
  no: number;
  email: string;
  name: string | null;
  tgUsername: string | null;
  tgName: string | null;
  tgBound: boolean;
  xHandle: string | null;
  balance: string;
  topupTotal: string;
  createdAt: string;
  lastSeenAt: string | null;
}

interface Detail {
  user: { id: string; no: number; email: string; name: string | null; createdAt: string };
  tg: { bound: boolean; chatId: string | null; username: string | null; name: string | null; boundAt: string | null; lastSeenAt: string | null } | null;
  x: { handle: string; name: string | null; ok: boolean; connectedAt: string } | null;
  wallet: { balance: string; bonus: string; bonusExpiresAt: string | null };
  totals: { topup: string; topups: number; spent: string; spent30: string; adjust: string; bonus: string };
  usage30: { item: string; label: string; count: number; amount: string }[];
  ledger: { at: string; kind: string; text: string; amount: string; balanceAfter: string; note: string | null; by: string | null }[];
  topups: { at: string; chain: string; due: string; received: string | null; status: string; txid: string | null }[];
  team: { name: string; role: string; members: number; ownerNo: number | null } | null;
  invitedBy: { id: string; no: number; email: string; status: string } | null;
  invites: { id: string; no: number; email: string; status: string; at: string }[];
}

const t = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");
const ROLE: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };
const TOPUP_STATUS: Record<string, string> = { pending: "待付款", paid: "已到账", expired: "已过期", canceled: "已取消" };
const REF_STATUS: Record<string, string> = { pending: "等首充", rewarded: "已发奖励", review: "待审核", rejected: "不发" };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const d = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(d.error || "出错了");
  return d;
}

export default function UsersAdmin() {
  const [q, setQ] = useState("");
  const [list, setList] = useState<{ rows: UserRow[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const search = useCallback((query: string) => {
    call<{ rows: UserRow[]; total: number }>(`/api/admin/users?q=${encodeURIComponent(query)}`)
      .then((d) => {
        setErr(null);
        setList(d);
        if (query.trim() && d.rows.length === 1) setOpenId(d.rows[0].id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => search(""), [search]);

  return (
    <div className="space-y-6 text-sm">
      <p className="text-zinc-500">
        找用户：输入<b>用户编号</b>（用户在机器人「💰 余额」里能看到）、<b>TG @用户名</b>、<b>邮箱</b>或 <b>X 账号</b>都行。点一行看详情，可以手动充值、调整余额、通过机器人给他发消息。
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search(q);
        }}
      >
        <input className={`${inputClass} max-w-md`} placeholder="例如 10023、@abc、abc@gmail.com" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={primaryButton}>搜索</button>
        {q && (
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              setQ("");
              search("");
            }}
          >
            清空
          </button>
        )}
      </form>
      {err && <p className="text-red-600">{err}</p>}

      {openId && <UserDetail key={openId} id={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} onChanged={() => search(q)} />}

      {list && (
        <section className={`${card} space-y-2`}>
          <p className="text-zinc-500">
            {q.trim() ? `找到 ${list.rows.length} 个` : `共 ${list.total} 个用户，下面是最新注册的 ${list.rows.length} 个`}
          </p>
          {list.rows.length === 0 ? (
            <p className="text-zinc-500">没找到。编号是纯数字；TG 用户名要用户在机器人里发过消息后才记得到。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="py-1 pr-3 font-normal">编号</th>
                    <th className="py-1 pr-3 font-normal">TG</th>
                    <th className="py-1 pr-3 font-normal">邮箱</th>
                    <th className="py-1 pr-3 font-normal">X</th>
                    <th className="py-1 pr-3 text-right font-normal">余额</th>
                    <th className="py-1 pr-3 text-right font-normal">累计充值</th>
                    <th className="py-1 font-normal">最近在机器人</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr
                      key={r.id}
                      className={`cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 ${openId === r.id ? "bg-zinc-50 dark:bg-zinc-900" : ""}`}
                      onClick={() => setOpenId(r.id)}
                    >
                      <td className="py-1.5 pr-3 font-mono">{r.no}</td>
                      <td className="py-1.5 pr-3">{r.tgUsername ? `@${r.tgUsername}` : r.tgBound ? (r.tgName ?? "已绑定") : <span className="text-zinc-400">未绑定</span>}</td>
                      <td className="py-1.5 pr-3">{r.email}</td>
                      <td className="py-1.5 pr-3">{r.xHandle ? `@${r.xHandle}` : <span className="text-zinc-400">—</span>}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{r.balance}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{r.topupTotal}</td>
                      <td className="py-1.5 text-zinc-500">{t(r.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function UserDetail({ id, onOpen, onClose, onChanged }: { id: string; onOpen: (id: string) => void; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adj, setAdj] = useState({ kind: "topup" as "topup" | "adjust", amount: "", note: "", notify: true });
  const [text, setText] = useState("");

  const load = useCallback(() => {
    call<Detail>(`/api/admin/users/${id}`)
      .then(setD)
      .catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }));
  }, [id]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <section className={card}>{msg?.text ?? "加载中…"}</section>;
  const amount = Number(adj.amount);
  const amountOk = adj.amount !== "" && Number.isFinite(amount) && amount !== 0 && (adj.kind === "adjust" || amount > 0);
  const post = (url: string, body: unknown) => call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return (
    <section className={`${card} space-y-5`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-base font-medium">
            用户 <span className="font-mono">{d.user.no}</span>
            {d.user.name ? ` · ${d.user.name}` : ""}
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            {d.user.email} · 注册于 {t(d.user.createdAt)}
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            TG：
            {d.tg?.bound ? (
              <>
                {d.tg.username ? (
                  <a className="underline" href={`https://t.me/${d.tg.username}`} target="_blank" rel="noreferrer">
                    @{d.tg.username}
                  </a>
                ) : (
                  "没有设置 @用户名"
                )}
                {d.tg.name ? `（${d.tg.name}）` : ""} · ID {d.tg.chatId} · 最近在机器人 {t(d.tg.lastSeenAt)}
              </>
            ) : (
              "未绑定"
            )}
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            X：
            {d.x ? (
              <>
                <a className="underline" href={`https://x.com/${d.x.handle}`} target="_blank" rel="noreferrer">
                  @{d.x.handle}
                </a>
                {d.x.ok ? "" : "（授权已失效）"}
              </>
            ) : (
              "未连接"
            )}
          </p>
        </div>
        <button className={secondaryButton} onClick={onClose}>
          收起
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="当前余额" value={`${d.wallet.balance} U`} sub={Number(d.wallet.bonus) > 0 ? `其中赠送 ${d.wallet.bonus}，${t(d.wallet.bonusExpiresAt)} 到期` : undefined} />
        <Stat label="累计充值" value={`${d.totals.topup} U`} sub={`${d.totals.topups} 笔`} />
        <Stat label="累计用掉" value={`${d.totals.spent} U`} sub={`近 30 天 ${d.totals.spent30}`} />
        <Stat label="赠送 / 调整" value={`${d.totals.bonus} / ${d.totals.adjust}`} />
      </div>

      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}

      <div className="space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <h3 className="font-medium">通过机器人发消息</h3>
        {d.tg?.bound ? (
          <>
            <textarea
              className={`${inputClass} min-h-20`}
              placeholder="用户会在机器人里收到，开头带「📮 客服消息」"
              value={text}
              maxLength={3500}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              className={secondaryButton}
              disabled={busy || !text.trim()}
              onClick={() =>
                run(async () => {
                  await post(`/api/admin/users/${id}/message`, { text });
                  setText("");
                }, "已发送 ✓")
              }
            >
              发送
            </button>
          </>
        ) : (
          <p className="text-zinc-500">这个用户还没绑定 TG，只能发邮件联系：{d.user.email}</p>
        )}
      </div>

      <div className="grid gap-5 border-t border-zinc-100 pt-4 sm:grid-cols-2 dark:border-zinc-800">
        <div className="space-y-1">
          <h3 className="font-medium">团队</h3>
          {d.team ? (
            <p>
              「{d.team.name}」· {ROLE[d.team.role] ?? d.team.role} · {d.team.members} 人{d.team.role !== "owner" && d.team.ownerNo ? ` · 所有者 ${d.team.ownerNo}` : ""}
            </p>
          ) : (
            <p className="text-zinc-500">没有加入团队</p>
          )}
        </div>
        <div className="space-y-1">
          <h3 className="font-medium">邀请</h3>
          <p>
            {d.invitedBy ? (
              <>
                由{" "}
                <button className="underline" onClick={() => onOpen(d.invitedBy!.id)}>
                  {d.invitedBy.no}
                </button>{" "}
                邀请（{REF_STATUS[d.invitedBy.status] ?? d.invitedBy.status}）
              </>
            ) : (
              <span className="text-zinc-500">不是别人邀请来的</span>
            )}
          </p>
          <p>邀请了 {d.invites.length} 人{d.invites.length ? "：" : ""}</p>
          {d.invites.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {d.invites.map((r) => (
                <button key={r.id} className={secondaryButton} title={r.email} onClick={() => onOpen(r.id)}>
                  {r.no} · {REF_STATUS[r.status] ?? r.status}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <h3 className="font-medium">近 30 天用了什么</h3>
        {d.usage30.length ? (
          <table className="w-full max-w-md">
            <tbody>
              {d.usage30.map((u) => (
                <tr key={u.item}>
                  <td className="py-0.5 pr-3">{u.label}</td>
                  <td className="py-0.5 pr-3 text-right">{u.count} 次</td>
                  <td className="py-0.5 text-right font-mono">{u.amount} U</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-zinc-500">没有用过收费功能</p>
        )}
      </div>

      <div className="space-y-1 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <h3 className="font-medium">充值单（最近 20 张）</h3>
        {d.topups.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <tbody>
                {d.topups.map((o, i) => (
                  <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-3 text-zinc-500">{t(o.at)}</td>
                    <td className="py-1 pr-3">{o.chain}</td>
                    <td className="py-1 pr-3 text-right font-mono">{o.due}</td>
                    <td className="py-1 pr-3">{TOPUP_STATUS[o.status] ?? o.status}</td>
                    <td className="max-w-40 truncate py-1 font-mono text-xs text-zinc-500" title={o.txid ?? ""}>
                      {o.txid ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-zinc-500">没有下过充值单</p>
        )}
      </div>

      <div className="space-y-1 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <h3 className="font-medium">余额明细（最近 50 笔）</h3>
        {d.ledger.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <tbody>
                {d.ledger.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-3 whitespace-nowrap text-zinc-500">{t(r.at)}</td>
                    <td className="py-1 pr-3">
                      {r.text}
                      {r.by ? <span className="text-zinc-500">（管理员 {r.by}）</span> : null}
                    </td>
                    <td className={`py-1 pr-3 text-right font-mono ${r.amount.startsWith("-") ? "" : "text-green-700 dark:text-green-400"}`}>{r.amount}</td>
                    <td className="py-1 text-right font-mono text-zinc-500">{r.balanceAfter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-zinc-500">没有记录</p>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="font-mono text-base">{value}</p>
      {sub && <p className="text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}
