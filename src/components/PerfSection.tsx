"use client";

import { useEffect, useState } from "react";
import { card } from "./ui";

interface Data {
  count: number;
  lines: string[];
}

/** 「数据」页上的「发帖效果」：和机器人里 /perf 一样的内容 */
export default function PerfSection() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    fetch("/api/post-metrics")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);
  if (!data) return null;
  return (
    <section className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">发帖效果</h2>
        <span className="text-xs text-zinc-500">帖子发出 1 天、7 天后各读一次</span>
      </div>
      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-700 dark:text-zinc-300">{data.lines.join("\n").trim()}</p>
    </section>
  );
}
