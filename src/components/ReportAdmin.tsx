"use client";

import { useCallback, useEffect, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface Config {
  enabled: boolean;
  hour: number;
  tz: string;
}
interface Costs {
  aiInput: number;
  aiOutput: number;
  aiCacheWrite: number;
  aiCacheRead: number;
  aiLightInput: number;
  aiLightOutput: number;
  aiLightCacheWrite: number;
  aiLightCacheRead: number;
  xPost: number;
  xRead: number;
}

const TZS = [
  ["Asia/Shanghai", "北京时间"],
  ["Asia/Singapore", "新加坡"],
  ["Asia/Tokyo", "东京"],
  ["Europe/London", "伦敦"],
  ["America/New_York", "纽约"],
];

const COST_FIELDS: { key: keyof Costs; label: string; unit: string }[] = [
  { key: "aiInput", label: "AI 输入", unit: "USDT / 百万 token" },
  { key: "aiOutput", label: "AI 输出", unit: "USDT / 百万 token" },
  { key: "aiCacheWrite", label: "AI 缓存写入", unit: "USDT / 百万 token" },
  { key: "aiCacheRead", label: "AI 缓存读取", unit: "USDT / 百万 token" },
  { key: "aiLightInput", label: "轻量 AI 输入", unit: "USDT / 百万 token" },
  { key: "aiLightOutput", label: "轻量 AI 输出", unit: "USDT / 百万 token" },
  { key: "aiLightCacheWrite", label: "轻量 AI 缓存写入", unit: "USDT / 百万 token" },
  { key: "aiLightCacheRead", label: "轻量 AI 缓存读取", unit: "USDT / 百万 token" },
  { key: "xPost", label: "X 每发一条", unit: "USDT" },
  { key: "xRead", label: "X 每读一条", unit: "USDT" },
];

/** 后台：经营日报 */
export function ReportAdmin() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [preview, setPreview] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/report")
      .then((r) => r.json())
      .then((d: { config: Config; costs: Costs; preview: string }) => {
        setCfg(d.config);
        setCosts(d.costs);
        setPreview(d.preview);
      })
      .catch(() => setMsg({ ok: false, text: "加载失败" }));
  }, []);
  useEffect(load, [load]);

  async function call(method: string, body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/report", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error || "失败了");
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg || !costs) return <p className="text-zinc-500">加载中…</p>;
  return (
    <div className="space-y-4">
      <p className="text-zinc-500">
        每天早上把昨天的新注册、首充、充值、用户用掉多少、AI 和 X 成本、毛利发到你绑定的 TG。顾客那份（昨天发了几条、待确认、预计还能发多少条）自动发，顾客可以在机器人「☰ 更多 → 📰 每日日报」里关掉。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          每天发经营日报
        </label>
        <label className="flex items-center gap-2">
          每天
          <input className={`${inputClass} w-20`} type="number" min={0} max={23} value={cfg.hour} onChange={(e) => setCfg({ ...cfg, hour: Number(e.target.value) })} />
          点
        </label>
        <select className={`${inputClass} w-36`} value={cfg.tz} onChange={(e) => setCfg({ ...cfg, tz: e.target.value })}>
          {TZS.map(([tz, label]) => (
            <option key={tz} value={tz}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <details>
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">成本单价（算毛利用）</summary>
        <p className="mt-2 text-zinc-500">AI 默认按 Claude Sonnet 5.5 官方价，评分、分类这类轻量任务按 Haiku 5.5 官方价。X 是估算，请按 X 开发者后台的账单核对后改。</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {COST_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-zinc-600 dark:text-zinc-400">{f.label}</span>
              <input
                className={`${inputClass} w-24`}
                type="number"
                step="any"
                min={0}
                value={String(costs[f.key])}
                onChange={(e) => setCosts({ ...costs, [f.key]: e.target.value === "" ? 0 : Number(e.target.value) })}
              />
              <span className="text-zinc-500">{f.unit}</span>
            </label>
          ))}
        </div>
      </details>
      <div className="flex gap-2">
        <button className={primaryButton} disabled={busy} onClick={() => call("PUT", { ...cfg, costs }, "已保存")}>
          保存
        </button>
        <button className={secondaryButton} disabled={busy} onClick={() => call("POST", null, "已发到你的 TG")}>
          现在发一份到 TG
        </button>
      </div>
      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}
      <h3 className="pt-2 font-medium">昨天的日报预览</h3>
      <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900">{preview}</pre>
    </div>
  );
}
