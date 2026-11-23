"use client";

import { useEffect, useState } from "react";
import { card, secondaryButton } from "./ui";

interface Settings {
  enabled: boolean;
  minSources: number;
  dailyCap: number;
}

/** 自动发帖页上的「热点提醒」设置 */
export default function HotTopicsCard() {
  const [s, setS] = useState<Settings | null>(null);
  const [choices, setChoices] = useState<{ minSourceChoices: number[]; capChoices: number[] }>({ minSourceChoices: [], capChoices: [] });
  useEffect(() => {
    fetch("/api/hot-topics")
      .then((r) => r.json())
      .then((d) => {
        setS(d.settings);
        setChoices({ minSourceChoices: d.minSourceChoices, capChoices: d.capChoices });
      })
      .catch(() => {});
  }, []);
  const save = async (patch: Partial<Settings>) => {
    const r = await fetch("/api/hot-topics", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (r.ok) setS((await r.json()).settings);
  };
  if (!s) return null;
  const pick = (on: boolean) => `${secondaryButton} ${on ? "border-zinc-900 dark:border-zinc-100" : ""}`;
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">🔥 热点提醒</h2>
        <button className={secondaryButton} onClick={() => save({ enabled: !s.enabled })}>
          {s.enabled ? "开着，点击关掉" : "关着，点击打开"}
        </button>
      </div>
      <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        你的信息源里有 {s.minSources} 个以上同时在说同一件事时，推到 TG，点一下就能趁热写一条。不额外收费，写的时候按正常扣。需要先绑定 TG。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500">几个源算热点</span>
        {choices.minSourceChoices.map((n) => (
          <button key={n} className={pick(n === s.minSources)} onClick={() => save({ minSources: n })}>
            {n} 个
          </button>
        ))}
        <span className="ml-3 text-zinc-500">每天最多</span>
        {choices.capChoices.map((n) => (
          <button key={n} className={pick(n === s.dailyCap)} onClick={() => save({ dailyCap: n })}>
            {n} 条
          </button>
        ))}
      </div>
    </section>
  );
}
