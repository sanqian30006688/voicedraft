"use client";

import { useCallback, useEffect, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface RewardsConfig {
  enabled: boolean;
  checkin: number;
  streakDays: number;
  streakBonus: number;
  piggyCap: number;
  expireDays: number;
  invitePct: number;
  inviteMax: number;
  inviteeBonus: number;
  inviteMonthly: number;
}

interface Funnel {
  days: number | null;
  signups: number;
  boundTg: number;
  used: number;
  usedUp: number;
  firstTopup: number;
  repeat: number;
  checkinsToday: number;
  invited: number;
  invitedPaid: number;
  rewardsMicro: number;
}

interface Referral {
  invitee: string;
  inviteeEmail: string;
  inviterEmail: string;
  status: string;
  reason: string | null;
  topup: number | null;
  inviterReward: number | null;
  inviteeReward: number | null;
  at: string;
}

const STATUS: Record<string, string> = { pending: "等首充", rewarded: "已发奖励", review: "待审核", rejected: "不发" };
const usdt = (m: number | null) => (m == null ? "-" : (m / 1e6).toFixed(2));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");

const FIELDS: { key: keyof RewardsConfig; label: string; unit: string; money?: boolean }[] = [
  { key: "checkin", label: "每天签到送", unit: "USDT", money: true },
  { key: "streakDays", label: "连签满几天额外送", unit: "天" },
  { key: "streakBonus", label: "连签额外送", unit: "USDT", money: true },
  { key: "piggyCap", label: "没充过值的人存钱罐最多存", unit: "USDT", money: true },
  { key: "expireDays", label: "赠送额度多少天没用完过期", unit: "天" },
  { key: "invitePct", label: "邀请人拿好友首充的", unit: "%" },
  { key: "inviteMax", label: "每个好友最多给邀请人", unit: "USDT", money: true },
  { key: "inviteeBonus", label: "好友首充后额外送他", unit: "USDT", money: true },
  { key: "inviteMonthly", label: "每人 30 天内自动发的邀请奖励上限（超出人工审核）", unit: "个" },
];

/** 后台：签到和邀请奖励 */
export function RewardsAdmin() {
  const [cfg, setCfg] = useState<RewardsConfig | null>(null);
  const [unit, setUnit] = useState(0);
  const [funnel, setFunnel] = useState<Funnel[]>([]);
  const [refs, setRefs] = useState<Referral[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/rewards")
      .then((r) => r.json())
      .then((d: { config: RewardsConfig; postUnitMicro: number; funnel: Funnel[]; referrals: Referral[] }) => {
        setCfg(d.config);
        setUnit(d.postUnitMicro);
        setFunnel(d.funnel);
        setRefs(d.referrals);
      })
      .catch(() => setMsg({ ok: false, text: "加载失败" }));
  }, []);
  useEffect(load, [load]);

  async function call(url: string, method: string, body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error || "保存失败");
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) return <p className="text-zinc-500">加载中…</p>;
  const posts = (u: number) => (unit > 0 ? `≈ ${Math.round(((u * 1e6) / unit) * 10) / 10} 条` : "");

  return (
    <div className="space-y-4">
      <p className="text-zinc-500">
        送的都是「赠送额度」：用的时候先扣，到期没用完的作废。用户看不到金额，只看到「≈ 多发几条」。没充过值的人签到奖励先存进存钱罐，第一次充值后才到账；
        邀请奖励要等好友第一次充值到账才发，同一个 TG / X 账号自己邀自己不发，付款钱包和邀请人一样的进下面「待审核」。
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        开启签到和邀请奖励
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex items-center gap-2">
            <span className="w-56 shrink-0 text-zinc-600 dark:text-zinc-400">{f.label}</span>
            <input
              className={`${inputClass} w-24`}
              type="number"
              step="any"
              min={0}
              value={String(cfg[f.key])}
              onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value === "" ? 0 : Number(e.target.value) })}
            />
            <span className="text-zinc-500">
              {f.unit} {f.money ? posts(Number(cfg[f.key])) : ""}
            </span>
          </label>
        ))}
      </div>
      <button className={primaryButton} disabled={busy} onClick={() => call("/api/admin/rewards", "PUT", cfg, "已保存，立即生效")}>
        保存奖励设置
      </button>
      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}

      <h3 className="pt-2 font-medium">转化漏斗（不算管理员）</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1 pr-3">这段时间注册的人</th>
              <th className="pr-3">注册</th>
              <th className="pr-3">绑定 TG</th>
              <th className="pr-3">用过</th>
              <th className="pr-3">用完了</th>
              <th className="pr-3">首充</th>
              <th className="pr-3">充 2 次以上</th>
              <th className="pr-3">被邀请来的 / 其中首充</th>
              <th className="pr-3">送出的奖励</th>
            </tr>
          </thead>
          <tbody>
            {funnel.map((f) => (
              <tr key={String(f.days)} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-3">{f.days ? `最近 ${f.days} 天` : "全部"}</td>
                <td className="pr-3">{f.signups}</td>
                <td className="pr-3">{f.boundTg}</td>
                <td className="pr-3">{f.used}</td>
                <td className="pr-3">{f.usedUp}</td>
                <td className="pr-3">
                  {f.firstTopup} <span className="text-zinc-500">({pct(f.firstTopup, f.signups)})</span>
                </td>
                <td className="pr-3">
                  {f.repeat} <span className="text-zinc-500">({pct(f.repeat, f.firstTopup)})</span>
                </td>
                <td className="pr-3">
                  {f.invited} / {f.invitedPaid}
                </td>
                <td className="pr-3">{usdt(f.rewardsMicro)} USDT</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-zinc-500">
        今天签到 {funnel[0]?.checkinsToday ?? 0} 人。「用完了」= 用过收费功能、剩下的已经不够发一条；首充百分比按注册人数算，复购百分比按首充人数算。送出的奖励不含新人赠送。
      </p>

      <h3 className="pt-2 font-medium">邀请记录（最近 100 条）</h3>
      {refs.length ? (
        <div className="space-y-2">
          {refs.map((r) => (
            <div key={r.invitee} className="space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <p>
                {r.inviterEmail} 邀请了 {r.inviteeEmail} · <b>{STATUS[r.status] ?? r.status}</b> · {new Date(r.at).toLocaleString("zh-CN")}
              </p>
              {r.topup != null && (
                <p className="text-zinc-500">
                  首充 {usdt(r.topup)} USDT · 邀请人奖励 {usdt(r.inviterReward)} · 好友奖励 {usdt(r.inviteeReward)}
                </p>
              )}
              {r.reason && <p className="text-zinc-500">{r.reason}</p>}
              {r.status === "review" && (
                <div className="flex gap-2">
                  <button className={secondaryButton} disabled={busy} onClick={() => call("/api/admin/rewards/referrals", "POST", { invitee: r.invitee, approve: true }, "已通过，奖励已发")}>
                    通过，发奖励
                  </button>
                  <button className={secondaryButton} disabled={busy} onClick={() => call("/api/admin/rewards/referrals", "POST", { invitee: r.invitee, approve: false }, "已标为不发")}>
                    不发
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-zinc-500">还没有人通过邀请链接注册。</p>
      )}
    </div>
  );
}
