"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PerfSection from "./PerfSection";
import { card, inputClass, secondaryButton } from "./ui";

interface Stat {
  followers: number;
  following: number;
  tweets: number;
  weeklyGrowth: number | null;
  postsPerDay: number | null;
}
interface Cmp {
  scope: "industry" | "all";
  size: number;
  medianPostsPerDay: number;
  medianWeeklyGrowth: number;
  medianFollowers: number;
  rank: number | null;
  beatPct: number | null;
}
interface Row {
  handle: string;
  industry: string | null;
  followers: number;
  weeklyGrowth: number | null;
  postsPerDay: number | null;
  mine: boolean;
}
interface Data {
  connected: boolean;
  handle: string | null;
  stat: Stat | null;
  cmp: Cmp | null;
  viaApp: number;
  profile: { industry: string | null; industrySource: string; publicRank: boolean; weeklyReport: boolean };
  industries: { code: string; label: string }[];
  board: Row[];
}

const fmt = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10} 万` : n.toLocaleString("en-US"));
const growth = (n: number | null) => (n === null ? "—" : n >= 0 ? `+${fmt(n)}` : `-${fmt(-n)}`);
const MIN_GROUP = 5;

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export default function StatsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<"growth" | "followers">("growth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPublic, setConfirmPublic] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/benchmark${mine ? "?scope=mine" : ""}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("加载失败"));
  }, [mine]);
  useEffect(load, [load]);

  async function save(patch: Partial<Data["profile"]>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/benchmark", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "保存失败");
      setConfirmPublic(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;
  const label = (code: string | null) => data.industries.find((i) => i.code === code)?.label ?? "未分类";

  if (!data.connected) {
    return (
      <section className={card}>
        <h2 className="font-medium">数据和排行</h2>
        <p className="mt-2 text-sm text-zinc-500">
          先<Link href="/publish" className="underline">连接你的 X 账号</Link>。之后每天帮你记一次粉丝、关注和发帖数，再和同类账号比一比。
        </p>
      </section>
    );
  }

  const s = data.stat;
  const c = data.cmp;
  const rows = [...data.board].sort((a, b) =>
    sort === "growth" ? (b.weeklyGrowth ?? -Infinity) - (a.weeklyGrowth ?? -Infinity) || b.followers - a.followers : b.followers - a.followers,
  );

  return (
    <div className="space-y-6">
      <PerfSection />
      <section className={card}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">我的数据 · @{data.handle}</h2>
          <span className="text-xs text-zinc-500">每天自动更新一次</span>
        </div>
        {s ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="粉丝" value={fmt(s.followers)} sub={s.weeklyGrowth !== null ? `本周 ${growth(s.weeklyGrowth)}` : undefined} />
              <Tile label="关注" value={fmt(s.following)} />
              <Tile label="每天发帖（含回复）" value={s.postsPerDay === null ? "—" : String(s.postsPerDay)} />
              <Tile label="这 7 天通过我发的" value={String(data.viaApp)} />
            </div>
            {s.weeklyGrowth === null && <p className="mt-3 text-sm text-zinc-500">数据从今天开始记录，明天起就能看到涨粉和发帖频率。</p>}
          </>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">暂时读不到 X 上的数据，明天会自动再试。</p>
        )}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">同类对比</h2>
          <label className="flex items-center gap-2 text-sm">
            行业
            <select
              className={`${inputClass} w-auto py-1`}
              value={data.profile.industry ?? ""}
              disabled={busy}
              onChange={(e) => e.target.value && save({ industry: e.target.value })}
            >
              {!data.profile.industry && <option value="">未分类</option>}
              {data.industries.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {data.profile.industrySource === "auto" && data.profile.industry && <p className="mt-1 text-xs text-zinc-500">行业是按你的账号记忆自动判断的，不对可以改。</p>}
        {c ? (
          <>
            <p className="mt-3 text-sm text-zinc-500">
              {c.scope === "industry" ? `${label(data.profile.industry)} 的 ${c.size} 个账号` : `全站 ${c.size} 个账号（同类还不满 ${MIN_GROUP} 个，先和全站比）`}的中间水平：
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="每天发帖" value={String(c.medianPostsPerDay)} />
              <Tile label="周涨粉" value={growth(c.medianWeeklyGrowth)} />
              <Tile label="粉丝" value={fmt(c.medianFollowers)} />
              <Tile label="你的本周涨粉名次" value={c.rank === null ? "—" : `${c.rank} / ${c.size}`} sub={c.beatPct ? `超过 ${c.beatPct}% 的账号` : undefined} />
            </div>
            <p className="mt-2 text-xs text-zinc-500">只显示中间水平和你自己的名次，看不到别人是谁。</p>
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">同类账号满 {MIN_GROUP} 个后，这里会显示同类对比和你的名次。</p>
        )}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">排行榜</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <button className={secondaryButton} disabled={sort === "growth"} onClick={() => setSort("growth")}>
              按本周涨粉
            </button>
            <button className={secondaryButton} disabled={sort === "followers"} onClick={() => setSort("followers")}>
              按粉丝
            </button>
            {data.profile.industry && (
              <button className={secondaryButton} onClick={() => setMine((m) => !m)}>
                {mine ? "看全部行业" : `只看${label(data.profile.industry)}`}
              </button>
            )}
          </div>
        </div>
        {rows.length ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">账号</th>
                <th className="py-1 pr-2">行业</th>
                <th className="py-1 pr-2 text-right">粉丝</th>
                <th className="py-1 pr-2 text-right">本周涨粉</th>
                <th className="py-1 text-right">每天发帖</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.slice(0, 50).map((r, i) => (
                <tr key={r.handle} className={`border-t border-zinc-100 dark:border-zinc-800 ${r.mine ? "font-medium" : ""}`}>
                  <td className="py-1.5 pr-2">{i + 1}</td>
                  <td className="py-1.5 pr-2">
                    <a href={`https://x.com/${r.handle}`} target="_blank" rel="noreferrer" className="hover:underline">
                      @{r.handle}
                    </a>
                    {r.mine && "（你）"}
                  </td>
                  <td className="py-1.5 pr-2 text-zinc-500">{label(r.industry)}</td>
                  <td className="py-1.5 pr-2 text-right">{fmt(r.followers)}</td>
                  <td className="py-1.5 pr-2 text-right">{growth(r.weeklyGrowth)}</td>
                  <td className="py-1.5 text-right">{r.postsPerDay ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">还没有人公开上榜。打开下面的「公开上榜」，你就是第一个。</p>
        )}
        <p className="mt-2 text-xs text-zinc-500">只列出本人开启了「公开上榜」的账号。</p>
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">设置</h2>
        <div className="text-sm">
          {data.profile.publicRank ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>✅ 你已公开上榜</span>
              <button className={secondaryButton} disabled={busy} onClick={() => save({ publicRank: false })}>
                取消公开
              </button>
            </div>
          ) : confirmPublic ? (
            <div className="space-y-2">
              <p className="text-zinc-600 dark:text-zinc-400">开启后，你的 @用户名、行业、粉丝数、本周涨粉会出现在排行榜上，所有用户都能看到。随时可以关。</p>
              <div className="flex gap-2">
                <button className={secondaryButton} disabled={busy} onClick={() => save({ publicRank: true })}>
                  确定公开
                </button>
                <button className={secondaryButton} onClick={() => setConfirmPublic(false)}>
                  先不了
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-zinc-500">没有公开上榜（照样能看同类对比和自己的名次）</span>
              <button className={secondaryButton} onClick={() => setConfirmPublic(true)}>
                公开上榜
              </button>
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={data.profile.weeklyReport} disabled={busy} onChange={(e) => save({ weeklyReport: e.target.checked })} />
          每周一在 TG 机器人里收数据周报
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>
    </div>
  );
}
