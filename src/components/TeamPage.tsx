"use client";

import { useCallback, useEffect, useState } from "react";
import { useMe } from "./AppShell";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

type Role = "owner" | "admin" | "member";

interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  daily: string | null;
  monthly: string | null;
  usedToday: string;
  usedMonth: string;
}

interface Overview {
  id: string;
  name: string;
  role: Role;
  ownerName: string;
  official: { handle: string | null; mine: boolean; holderName: string } | null;
  fallbackPersonal: boolean;
  defaultDaily: string | null;
  defaultMonthly: string | null;
  balance: string | null;
  me: { daily: string | null; monthly: string | null; usedToday: string; usedMonth: string; left: string | null };
  members: Member[] | null;
  pendingCount: number;
  paused: boolean;
  minBalance: number;
}

interface Sub {
  id: string;
  tweets: string[];
  note: string | null;
  status: string;
  statusLabel: string;
  author: string;
  reviewer: string | null;
  rejectReason: string | null;
  post: { status: string; scheduledAt: string | null; url: string | null; error: string | null } | null;
  createdAt: string;
}

interface State {
  minBalance?: number;
  team: Overview | null;
  invite: { teamName: string; ownerName: string } | null;
  joinCode: string | null;
  pending?: Sub[];
  mine?: Sub[];
  recent?: Sub[];
  ledger?: { id: string; at: string; who: string; text: string; amount: string }[];
}

const ROLE: Record<Role, string> = { owner: "所有者", admin: "管理员", member: "成员" };

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

async function act<T = Record<string, unknown>>(body: unknown): Promise<T> {
  const res = await fetch("/api/team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || "操作失败，请重试");
  return data;
}

/** 「每条之间单独一行写 ---」分成串推 */
const splitTweets = (text: string) =>
  text
    .split(/\n\s*-{3,}\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

const limitText = (d: string | null, m: string | null) => [d ? `每天 ${d}` : null, m ? `每月 ${m}` : null].filter(Boolean).join("、") || "不限";

export default function TeamPage() {
  const { me, refresh } = useMe();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [draft, setDraft] = useState("");
  const [invite, setInvite] = useState<{ code: string; tgUrl: string | null; expiresAt: string } | null>(null);

  const load = useCallback(() => {
    const join = new URLSearchParams(window.location.search).get("join");
    fetch(`/api/team${join ? `?join=${encodeURIComponent(join)}` : ""}`)
      .then((r) => r.json() as Promise<State>)
      .then((s) => {
        setState(s);
        if (s.joinCode) setCode(s.joinCode);
      })
      .catch(() => setError("加载失败，请刷新"));
  }, []);

  useEffect(load, [load]);

  const run = async (body: unknown, ok?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await act(body);
      if (ok) setNotice(ok);
      load();
      refresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;

  const msg = (
    <>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">{notice}</p>}
    </>
  );

  const t = state.team;
  if (!t) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">团队</h1>
        {msg}
        <section className={card}>
          <h2 className="font-medium">和同事、朋友共用余额</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>大家共用你的余额，你给每个人设每天 / 每月上限，随时看每人花了多少。</li>
            <li>把你连接的 X 设为官号：成员写好稿子投给官号，你在 TG 或这里点「通过」才会发出。</li>
            <li>每个人的素材、风格卡、草稿都还是各自的，你看不到别人写了什么，别人也看不到你的。</li>
          </ul>
        </section>
        {state.invite && (
          <section className={card}>
            <p className="text-sm">
              {state.invite.ownerName} 邀请你加入团队「{state.invite.teamName}」。加入后你用的功能会先从团队余额里扣（在所有者给你的额度内）。
            </p>
            <button className={`${primaryButton} mt-3`} disabled={busy} onClick={() => run({ action: "join", code }, "已加入团队 ✓")}>
              加入「{state.invite.teamName}」
            </button>
          </section>
        )}
        <section className={card}>
          <h2 className="font-medium">新建团队</h2>
          {state.minBalance != null && <p className="mt-1 text-sm text-zinc-500">建团队和邀请成员需要你的余额不低于 {state.minBalance} USDT。</p>}
          <div className="mt-2 flex gap-2">
            <input className={inputClass} placeholder="团队名字，例如公司或项目名" value={name} onChange={(e) => setName(e.target.value)} />
            <button className={primaryButton} disabled={busy || !name.trim()} onClick={() => run({ action: "create", name }, "团队建好了 ✓")}>
              新建
            </button>
          </div>
        </section>
        {!state.invite && (
          <section className={card}>
            <h2 className="font-medium">用邀请码加入</h2>
            <div className="mt-2 flex gap-2">
              <input className={inputClass} placeholder="邀请码" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className={secondaryButton} disabled={busy || !code.trim()} onClick={() => run({ action: "join", code: code.trim() }, "已加入团队 ✓")}>
                加入
              </button>
            </div>
            {state.joinCode && <p className="mt-2 text-sm text-red-600">这个邀请链接已过期或已作废，请找发链接的人重新发一个。</p>}
          </section>
        )}
      </div>
    );
  }

  const reviewer = t.role !== "member";
  const owner = t.role === "owner";
  const inviteUrl = invite && `${window.location.origin}/team?join=${invite.code}`;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{t.name}</h1>
        <span className="text-sm text-zinc-500">你是{ROLE[t.role]}</span>
      </div>
      {msg}

      <section className={card}>
        <h2 className="font-medium">团队钱包</h2>
        {t.balance != null && (
          <p className="mt-1 text-sm">
            团队余额 <b>{t.balance} USDT</b>（就是所有者 {t.ownerName} 的余额，{owner ? "你" : "所有者"}到「余额」页充值）
          </p>
        )}
        {!owner ? (
          <p className="mt-1 text-sm">
            你的额度：{limitText(t.me.daily, t.me.monthly)}。今天用了 {t.me.usedToday}，本月 {t.me.usedMonth} USDT
            {t.me.left != null && `，还剩 ${t.me.left}`}。{t.fallbackPersonal ? "用完后改扣你自己的余额。" : "用完就先停，找所有者加额度。"}
          </p>
        ) : (
          <p className="mt-1 text-sm text-zinc-500">成员用的功能从你的余额里扣，每笔都记着是谁用的。额度按北京时间每天 / 每月重算。</p>
        )}
        {t.paused && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {owner
              ? `你的余额低于 ${t.minBalance} USDT，成员暂时不能共用，也不能邀请新成员。充值后自动恢复。`
              : `团队余额低于 ${t.minBalance} USDT，共用已暂停${t.fallbackPersonal ? "，现在扣你自己的余额" : ""}。所有者充值后自动恢复。`}
          </p>
        )}
        {owner && (
          <TeamSettings t={t} busy={busy} onSave={(b) => run({ action: "settings", ...b }, "已保存 ✓")} />
        )}
      </section>

      <section className={card}>
        <h2 className="font-medium">官号</h2>
        {t.official ? (
          <p className="mt-1 text-sm">
            {t.official.handle ? `@${t.official.handle}` : "（X 授权失效了，请连接人重新连接）"}，由 {t.official.mine ? "你" : t.official.holderName} 连接。
            成员投的稿，所有者和管理员通过后用这个号发出。
          </p>
        ) : (
          <p className="mt-1 text-sm text-zinc-500">还没设置。所有者或管理员可以把自己连接的 X 设为官号（不能拿别人的 X 当官号）。</p>
        )}
        {reviewer && (
          <div className="mt-2 flex flex-wrap gap-2">
            {!t.official?.mine && (
              <button
                className={secondaryButton}
                disabled={busy || !me.x}
                onClick={() => run({ action: "official", on: true }, "已设为官号 ✓")}
                title={me.x ? "" : "先到「发布」页连接 X"}
              >
                {me.x ? `把我连接的 @${me.x.handle} 设为官号` : "先到「发布」页连接 X"}
              </button>
            )}
            {t.official && (t.official.mine || owner) && (
              <button className={secondaryButton} disabled={busy} onClick={() => run({ action: "clearOfficial" }, "已取消官号")}>
                取消官号
              </button>
            )}
          </div>
        )}
      </section>

      {t.official && (
        <section className={card}>
          <h2 className="font-medium">投稿给官号</h2>
          <textarea
            className={`${inputClass} mt-2 h-28`}
            placeholder="要发的内容。要投串推，在每条之间单独一行写 ---"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            className={`${primaryButton} mt-2`}
            disabled={busy || !draft.trim()}
            onClick={async () => {
              const r = await run({ action: "submit", tweets: splitTweets(draft) }, reviewer ? "已投稿，审批卡片已发到 TG" : "已投稿，通过后会通知你");
              if (r) setDraft("");
            }}
          >
            投稿
          </button>
          <p className="mt-2 text-xs text-zinc-500">在 TG 里也能投：草稿卡片上点「📮 投给官号」，或发 /submit。</p>
        </section>
      )}

      {reviewer && (
        <section className={card}>
          <h2 className="font-medium">待审批 {state.pending?.length ? `（${state.pending.length}）` : ""}</h2>
          {!state.pending?.length && <p className="mt-1 text-sm text-zinc-500">没有等审批的投稿。新投稿也会推到你的 TG，点按钮就能审批。</p>}
          <div className="mt-2 space-y-3">
            {state.pending?.map((s) => (
              <Review key={s.id} s={s} busy={busy} run={run} />
            ))}
          </div>
        </section>
      )}

      {reviewer && (
        <section className={card}>
          <h2 className="font-medium">邀请成员</h2>
          <p className="mt-1 text-sm text-zinc-500">链接 7 天有效，可以发给多个人；最多 20 人。对方需要有 VoiceDraft 账号。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className={primaryButton}
              disabled={busy}
              onClick={async () => {
                const r = await run({ action: "invite" });
                if (r) setInvite(r as unknown as { code: string; tgUrl: string | null; expiresAt: string });
              }}
            >
              生成邀请链接
            </button>
            <button className={secondaryButton} disabled={busy} onClick={() => run({ action: "revokeInvites" }, "之前发出的邀请链接都已作废")}>
              作废所有邀请链接
            </button>
          </div>
          {invite && (
            <div className="mt-3 space-y-1 text-sm">
              {invite.tgUrl && (
                <p>
                  TG 链接（点开就加入）：<code className="break-all">{invite.tgUrl}</code>
                </p>
              )}
              <p>
                网页链接：<code className="break-all">{inviteUrl}</code>
              </p>
              <p className="text-zinc-500">
                邀请码 {invite.code}，{fmt(invite.expiresAt)} 前有效
              </p>
            </div>
          )}
        </section>
      )}

      {t.members && (
        <section className={card}>
          <h2 className="font-medium">成员（{t.members.length}）</h2>
          <div className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
            {t.members.map((m) => (
              <MemberRow key={m.userId} m={m} owner={owner} myRole={t.role} busy={busy} run={run} />
            ))}
          </div>
        </section>
      )}

      {!!state.mine?.length && (
        <section className={card}>
          <h2 className="font-medium">我的投稿</h2>
          <div className="mt-2 space-y-2">
            {state.mine.map((s) => (
              <SubLine key={s.id} s={s}>
                {s.status === "pending" && (
                  <button className={secondaryButton} disabled={busy} onClick={() => run({ action: "withdraw", id: s.id }, "已撤回")}>
                    撤回
                  </button>
                )}
              </SubLine>
            ))}
          </div>
        </section>
      )}

      {reviewer && !!state.recent?.length && (
        <section className={card}>
          <h2 className="font-medium">最近处理过的投稿</h2>
          <div className="mt-2 space-y-2">
            {state.recent.map((s) => (
              <SubLine key={s.id} s={s} />
            ))}
          </div>
        </section>
      )}

      <section className={card}>
        <h2 className="font-medium">{owner ? "成员用量明细" : "我用团队余额的明细"}</h2>
        {!state.ledger?.length && <p className="mt-1 text-sm text-zinc-500">还没有记录。</p>}
        <table className="mt-2 w-full text-sm">
          <tbody>
            {state.ledger?.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-2 text-zinc-500">{fmt(r.at)}</td>
                {owner && <td className="py-1 pr-2">{r.who}</td>}
                <td className="py-1 pr-2">{r.text}</td>
                <td className="py-1 text-right tabular-nums">{r.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex gap-2">
        {owner ? (
          <button
            className={secondaryButton}
            disabled={busy}
            onClick={() => {
              if (window.confirm("确定解散团队？成员都会回到只用自己的余额，你的余额不变。")) run({ action: "dissolve" }, "团队已解散");
            }}
          >
            解散团队
          </button>
        ) : (
          <button
            className={secondaryButton}
            disabled={busy}
            onClick={() => {
              if (window.confirm("确定退出团队？之后只扣你自己的余额，还没审批的投稿会撤回。")) run({ action: "leave" }, "已退出团队");
            }}
          >
            退出团队
          </button>
        )}
      </section>
    </div>
  );
}

function TeamSettings({ t, busy, onSave }: { t: Overview; busy: boolean; onSave: (b: Record<string, unknown>) => void }) {
  const [daily, setDaily] = useState(t.defaultDaily ?? "");
  const [monthly, setMonthly] = useState(t.defaultMonthly ?? "");
  const [fallback, setFallback] = useState(t.fallbackPersonal);
  return (
    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span>新成员默认上限：每天</span>
        <input className={`${inputClass} w-20`} placeholder="不限" value={daily} onChange={(e) => setDaily(e.target.value)} />
        <span>每月</span>
        <input className={`${inputClass} w-20`} placeholder="不限" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        <span>USDT</span>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} />
        成员用完额度后，改扣他自己的余额（不勾就直接停）
      </label>
      <button className={secondaryButton} disabled={busy} onClick={() => onSave({ defaultDaily: daily || null, defaultMonthly: monthly || null, fallbackPersonal: fallback })}>
        保存设置
      </button>
    </div>
  );
}

function MemberRow({
  m,
  owner,
  myRole,
  busy,
  run,
}: {
  m: Member;
  owner: boolean;
  myRole: Role;
  busy: boolean;
  run: (b: unknown, ok?: string) => Promise<unknown>;
}) {
  const [daily, setDaily] = useState(m.daily ?? "");
  const [monthly, setMonthly] = useState(m.monthly ?? "");
  const canRemove = m.role !== "owner" && (owner || (myRole === "admin" && m.role === "member"));
  return (
    <div className="py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <b>{m.name}</b> <span className="text-zinc-500">{m.email}</span> · {ROLE[m.role]}
        </span>
        {m.role !== "owner" && (
          <span className="text-zinc-500">
            今天 {m.usedToday} / 本月 {m.usedMonth} USDT · 上限 {limitText(m.daily, m.monthly)}
          </span>
        )}
      </div>
      {(owner || canRemove) && m.role !== "owner" && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {owner && (
            <>
              <span>每天</span>
              <input className={`${inputClass} w-20`} placeholder="不限" value={daily} onChange={(e) => setDaily(e.target.value)} />
              <span>每月</span>
              <input className={`${inputClass} w-20`} placeholder="不限" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
              <button
                className={secondaryButton}
                disabled={busy}
                onClick={() => run({ action: "member", userId: m.userId, daily: daily || null, monthly: monthly || null }, "上限已保存 ✓")}
              >
                保存上限
              </button>
              <button
                className={secondaryButton}
                disabled={busy}
                onClick={() => run({ action: "member", userId: m.userId, role: m.role === "admin" ? "member" : "admin" }, "身份已修改 ✓")}
              >
                {m.role === "admin" ? "改为成员" : "设为管理员"}
              </button>
            </>
          )}
          {canRemove && (
            <button
              className={secondaryButton}
              disabled={busy}
              onClick={() => {
                if (window.confirm(`把 ${m.name} 移出团队？`)) run({ action: "remove", userId: m.userId }, "已移出");
              }}
            >
              移出
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SubLine({ s, children }: { s: Sub; children?: React.ReactNode }) {
  return (
    <div className="rounded-md bg-zinc-50 p-2 text-sm dark:bg-zinc-900">
      <div className="flex justify-between gap-2 text-xs text-zinc-500">
        <span>
          {fmt(s.createdAt)} · {s.author} · {s.statusLabel}
          {s.reviewer && ` · ${s.reviewer}`}
          {s.rejectReason && `：${s.rejectReason}`}
        </span>
        {s.post?.url ? (
          <a className="underline" href={s.post.url} target="_blank" rel="noreferrer">
            看帖子
          </a>
        ) : s.post?.status === "scheduled" && s.post.scheduledAt ? (
          <span>定时 {fmt(s.post.scheduledAt)}</span>
        ) : s.post?.status === "failed" ? (
          <span className="text-red-600">发布失败</span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap">{s.tweets.join("\n---\n")}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

function Review({ s, busy, run }: { s: Sub; busy: boolean; run: (b: unknown, ok?: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.tweets.join("\n---\n"));
  const [when, setWhen] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p className="text-xs text-zinc-500">
        {fmt(s.createdAt)} · {s.author} 投稿{s.tweets.length > 1 ? `（串推 ${s.tweets.length} 条）` : ""}
        {s.note && ` · 备注：${s.note}`}
      </p>
      {editing ? (
        <>
          <textarea className={`${inputClass} mt-1 h-28`} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="mt-1 flex gap-2">
            <button
              className={secondaryButton}
              disabled={busy}
              onClick={async () => {
                if (await run({ action: "edit", id: s.id, tweets: splitTweets(text) }, "已修改")) setEditing(false);
              }}
            >
              保存修改
            </button>
            <button className={secondaryButton} onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </>
      ) : (
        <p className="mt-1 whitespace-pre-wrap">{s.tweets.join("\n---\n")}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={primaryButton} disabled={busy || editing} onClick={() => run({ action: "approve", id: s.id }, "已通过并发出 ✓")}>
          通过，立即发
        </button>
        <input type="datetime-local" className={`${inputClass} w-auto`} value={when} onChange={(e) => setWhen(e.target.value)} />
        <button
          className={secondaryButton}
          disabled={busy || editing || !when}
          onClick={() => run({ action: "approve", id: s.id, scheduledAt: new Date(when).toISOString() }, "已通过，排进定时 ✓")}
        >
          通过，定时发
        </button>
        {!editing && (
          <button className={secondaryButton} disabled={busy} onClick={() => setEditing(true)}>
            改一下
          </button>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <input className={inputClass} placeholder="驳回理由（可不填，会告诉投稿人）" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className={secondaryButton} disabled={busy} onClick={() => run({ action: "reject", id: s.id, reason: reason || undefined }, "已驳回")}>
          驳回
        </button>
      </div>
    </div>
  );
}
