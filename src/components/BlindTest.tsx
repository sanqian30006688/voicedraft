"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "./AppShell";
import { card, primaryButton, secondaryButton } from "./ui";

interface Test {
  id: string;
  items: string[];
  aiCount: number;
}

interface Result {
  misjudgeRate: number;
  wrong: number;
  total: number;
  answers: boolean[];
}

interface HistoryItem {
  id: string;
  styleCardVersion: number;
  misjudgeRate: number;
  completedAt: string;
}

export default function BlindTest() {
  const { me } = useMe();
  const [test, setTest] = useState<Test | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    fetch("/api/blind-test")
      .then((r) => r.json())
      .then((d: { items: HistoryItem[] }) => setHistory(d.items));
  }, []);
  useEffect(loadHistory, [loadHistory]);

  async function start() {
    setBusy(true);
    setError(null);
    setResult(null);
    setPicked(new Set());
    try {
      const res = await fetch("/api/blind-test", { method: "POST" });
      const d = (await res.json()) as Test & { error?: string };
      if (!res.ok) throw new Error(d.error || "生成失败");
      setTest(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!test) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/blind-test/${test.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guesses: [...picked] }),
      });
      const d = (await res.json()) as Result & { error?: string };
      if (!res.ok) throw new Error(d.error || "提交失败");
      setResult(d);
      loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(i: number) {
    if (result) return;
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  }

  if (!me.card) {
    return (
      <p className="text-sm text-zinc-500">
        先到 <Link className="underline underline-offset-4" href="/style-card">风格卡</Link> 生成风格卡，再来做盲测。
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className={`${card} space-y-3 text-sm`}>
        <h2 className="text-base font-medium">风格盲测：你能分出哪些是 AI 写的吗？</h2>
        <p className="text-zinc-600 dark:text-zinc-400">
          从你的素材里随机抽 5 条真推文，AI 照着同样的话题各写 1 条，打乱顺序放在一起。你把觉得是 AI 写的挑出来。
          挑错得越多，说明 AI 写得越像你。
        </p>
        <button className={primaryButton} onClick={start} disabled={busy}>
          {busy && !test ? "AI 正在写，约需十几秒…" : test ? "再测一次" : "开始盲测"}
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </section>

      {test && (
        <section className="space-y-3">
          <p className="text-sm text-zinc-500">
            {result ? "答案揭晓：" : `点选你认为是 AI 写的（共 ${test.aiCount} 条），已选 ${picked.size} 条。`}
          </p>
          <ol className="space-y-2">
            {test.items.map((t, i) => {
              const isPicked = picked.has(i);
              const isAi = result?.answers[i];
              const correct = result ? isAi === isPicked : undefined;
              return (
                <li key={i}>
                  <button
                    className={`block w-full rounded-lg border p-3 text-left text-sm leading-6 ${
                      isPicked ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900" : "border-zinc-200 dark:border-zinc-800"
                    }`}
                    onClick={() => toggle(i)}
                    aria-pressed={isPicked}
                  >
                    {t}
                    {result && (
                      <span className={`mt-1 block text-xs ${correct ? "text-emerald-600" : "text-red-600"}`}>
                        {isAi ? "AI 写的" : "你写的"} · {correct ? "判断正确" : "判断错了"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          {!result ? (
            <button className={primaryButton} onClick={submit} disabled={busy}>
              提交答案
            </button>
          ) : (
            <div className={`${card} text-sm`}>
              <p className="text-base font-medium">误判率 {result.misjudgeRate}%</p>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                10 条里判断错了 {result.wrong} 条。
                {result.misjudgeRate >= 30
                  ? "AI 写得已经挺像你了。"
                  : "还能分得出来。多在起草时改句子、再让风格卡学习一下，会越来越像。"}
              </p>
            </div>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">历次结果</h2>
          <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {history.map((h) => (
              <li key={h.id} className="flex justify-between py-2">
                <span>
                  风格卡第 {h.styleCardVersion} 版
                  <span className="ml-2 text-zinc-400">{new Date(h.completedAt).toLocaleString("zh-CN")}</span>
                </span>
                <span className="font-medium">误判率 {h.misjudgeRate}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {test && result && (
        <button className={secondaryButton} onClick={start} disabled={busy}>
          再测一次
        </button>
      )}
    </div>
  );
}
