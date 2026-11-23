"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtCount } from "@/lib/follow-check-core";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

type Tab = "nofollow" | "lost" | "ignored";

interface Summary {
  scannedAt: string | null;
  following: number;
  followers: number;
  noFollowBack: number;
  lost: number;
  ignored: number;
  unfollowLeft: number;
  needsScope: boolean;
  connected: boolean;
}

interface Person {
  targetId: string;
  handle: string;
  name: string | null;
  verifiedType: string | null;
  followers: number;
  following: number;
  iFollow: boolean;
  lostAt: string | null;
}

interface Data {
  summary: Summary;
  rows: Person[];
  total: number;
  page: number;
  pages: number;
}

interface Estimate {
  following: number;
  followers: number;
  people: number;
  costMicro: number;
  balanceMicro: number;
  enough: boolean;
  tooBig: boolean;
}

const usdt = (m: number) => (m / 1_000_000).toFixed(m % 10_000 === 0 ? 2 : 3);
const TAB_NAME: Record<Tab, string> = { nofollow: "未回关", lost: "取关了我", ignored: "已忽略" };

export default function FollowCheckPage() {
  const [tab, setTab] = useState<Tab>("nofollow");
  const [blue, setBlue] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ tab, page: String(page), q, ...(blue ? { blue: "1" } : {}) });
    fetch(`/api/follow-check?${p}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("加载失败"));
  }, [tab, page, q, blue]);
  useEffect(load, [load]);

  async function post<T>(url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(d.error || "操作失败");
    return d;
  }

  async function act(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  const s = data?.summary;

  if (s && !s.connected) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">互关检测</h1>
        <p>
          先到<Link href="/publish" className="underline">「发布」页</Link>连接你的 X 账号。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">互关检测</h1>
        <p className="mt-1 text-sm text-zinc-500">
          读你的「关注」和「粉丝」名单，找出没回关你的人和最近取关你的人。取关要一个一个点，每天有上限，免得被 X 限制；不会自动取关，也没有一键全部取关。
        </p>
      </div>

      {s?.needsScope && (
        <div className={`${card} text-sm`}>
          要先重新连接一次 X，多授权一项「读取关注和粉丝」。到<Link href="/publish" className="underline">「发布」页</Link>点「重新连接」。
        </div>
      )}

      <div className={`${card} space-y-3`}>
        {s?.scannedAt ? (
          <p className="text-sm">
            上次扫描：{new Date(s.scannedAt).toLocaleString("zh-CN")}（关注 {s.following} · 粉丝 {s.followers}）· 今天还能取关 {s.unfollowLeft} 个
          </p>
        ) : (
          <p className="text-sm">还没扫描过。点「扫描」，先告诉你这次大约扣多少，确认了才开始。</p>
        )}
        {!est ? (
          <button
            className={primaryButton}
            disabled={!!busy || s?.needsScope}
            onClick={() => act("est", async () => setEst(await post<Estimate>("/api/follow-check/estimate")))}
          >
            {busy === "est" ? "读取中…" : s?.scannedAt ? "重新扫描" : "扫描"}
          </button>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              你关注 {est.following} 人、粉丝 {est.followers} 人，这次要读 {est.people} 人。
              {est.costMicro > 0 && ` 预计扣 ${usdt(est.costMicro)} USDT（当前余额 ${usdt(est.balanceMicro)} USDT），少读了会退回。`}
            </p>
            {est.tooBig ? (
              <p className="text-red-600">关注或粉丝超过 1.5 万人，暂时扫不了。</p>
            ) : !est.enough ? (
              <p className="text-red-600">
                余额不够这一次，<Link href="/billing" className="underline">先充值</Link>。
              </p>
            ) : (
              <div className="flex gap-2">
                <button
                  className={primaryButton}
                  disabled={!!busy}
                  onClick={() =>
                    act("scan", async () => {
                      const r = await post<{ noFollowBack: number; lost: number; newlyLost: number; first: boolean }>("/api/follow-check/scan");
                      setEst(null);
                      setPage(0);
                      load();
                      return r.first
                        ? `扫描完成：未回关 ${r.noFollowBack} 人。下次再扫就能看出谁取关了你。`
                        : `扫描完成：未回关 ${r.noFollowBack} 人，取关了我 ${r.lost} 人${r.newlyLost ? `（新发现 ${r.newlyLost} 人）` : ""}。`;
                    })
                  }
                >
                  {busy === "scan" ? "扫描中，人多的话要一两分钟…" : "开始扫描"}
                </button>
                <button className={secondaryButton} disabled={!!busy} onClick={() => setEst(null)}>
                  取消
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {notice && <p className="text-sm text-green-700">{notice}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {s?.scannedAt && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {(["nofollow", "lost", "ignored"] as Tab[]).map((t) => (
              <button
                key={t}
                className={t === tab ? primaryButton : secondaryButton}
                onClick={() => {
                  setTab(t);
                  setPage(0);
                }}
              >
                {TAB_NAME[t]}（{t === "nofollow" ? s.noFollowBack : t === "lost" ? s.lost : s.ignored}）
              </button>
            ))}
            <label className="ml-2 flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={blue}
                onChange={(e) => {
                  setBlue(e.target.checked);
                  setPage(0);
                }}
              />
              只看蓝V
            </label>
            <input
              className={`${inputClass} max-w-48`}
              placeholder="搜索用户名或名字"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
            />
            {/* 下载文件，不是页面跳转 */}
            <a className={secondaryButton} href="/api/follow-check/export" download>
              导出表格
            </a>
          </div>

          <div className={`${card} divide-y divide-zinc-200 p-0 dark:divide-zinc-800`}>
            {data?.rows.length ? (
              data.rows.map((p) => (
                <div key={p.targetId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <a href={`https://x.com/${p.handle}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {p.name || p.handle}
                    </a>{" "}
                    <span className="text-sm text-zinc-500">@{p.handle}</span>
                    {p.verifiedType && <span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-700">蓝V</span>}
                    <div className="text-xs text-zinc-500">
                      粉丝 {fmtCount(p.followers)} · 关注 {fmtCount(p.following)}
                      {tab === "lost" && p.lostAt && ` · ${new Date(p.lostAt).toLocaleString("zh-CN")} 发现`}
                      {tab === "lost" && (p.iFollow ? " · 你还关注着 TA" : " · 你没关注 TA")}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {tab !== "ignored" && p.iFollow && (
                      <button
                        className={secondaryButton}
                        disabled={!!busy}
                        onClick={() =>
                          act(`u${p.targetId}`, async () => {
                            await post(`/api/follow-check/${p.targetId}`, { action: "unfollow" });
                            load();
                            return `已取关 @${p.handle}`;
                          })
                        }
                      >
                        {busy === `u${p.targetId}` ? "取关中…" : "取关"}
                      </button>
                    )}
                    <button
                      className={secondaryButton}
                      disabled={!!busy}
                      onClick={() =>
                        act(`i${p.targetId}`, async () => {
                          await post(`/api/follow-check/${p.targetId}`, { action: tab === "ignored" ? "unignore" : "ignore" });
                          load();
                        })
                      }
                    >
                      {tab === "ignored" ? "恢复" : "忽略"}
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-center text-sm text-zinc-500">
                {tab === "nofollow" ? "没有了，你关注的人都回关你了" : tab === "lost" ? "最近没人取关你" : "没有忽略的人"}
              </p>
            )}
          </div>

          {data && data.pages > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <button className={secondaryButton} disabled={page <= 0} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              第 {data.page + 1} / {data.pages} 页（共 {data.total} 人）
              <button className={secondaryButton} disabled={page >= data.pages - 1} onClick={() => setPage(page + 1)}>
                下一页
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
