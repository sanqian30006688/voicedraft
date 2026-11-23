"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fallbackPromoLine,
  PROMO_KINDS,
  PROMO_KIND_LABEL,
  PROMO_MODES,
  PROMO_MODE_LABEL,
  type PromoKind,
  type PromoLink,
  type PromoMode,
} from "@/lib/promo";
import { weightedLength } from "@/lib/text";
import type { PromoState } from "./PromoPicker";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

type Form = { kind: PromoKind; name: string; url: string; blurb: string };
const emptyForm: Form = { kind: "tg", name: "", url: "", blurb: "" };

const URL_HINT: Record<PromoKind, string> = {
  tg: "https://t.me/你的群",
  qq: "QQ 群邀请链接，或直接填群号",
  discord: "https://discord.gg/邀请码",
  wechat: "公众号或可公开的链接（微信群二维码链接会过期）",
  other: "链接或联系方式",
};

export default function PromoPage() {
  const [state, setState] = useState<PromoState | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/promo")
      .then((r) => r.json() as Promise<PromoState>)
      .then(setState)
      .catch(() => setError("加载失败，请刷新重试"));
  }, []);
  useEffect(load, [load]);

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "保存失败");
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const ok = editingId ? await call(`/api/promo/${editingId}`, "PATCH", form) : await call("/api/promo", "POST", form);
    if (ok) {
      setForm(emptyForm);
      setEditingId(null);
    }
  }

  function startEdit(l: PromoLink) {
    setEditingId(l.id);
    setForm({ kind: l.kind, name: l.name, url: l.url, blurb: l.blurb });
  }

  function remove(l: PromoLink) {
    if (!confirm(`删除「${l.name}」？`)) return;
    if (editingId === l.id) {
      setEditingId(null);
      setForm(emptyForm);
    }
    void call(`/api/promo/${l.id}`, "DELETE");
  }

  const setMode = (mode: PromoMode) => call("/api/promo", "PATCH", { mode });
  const setDefault = (id: string) => call("/api/promo", "PATCH", { defaultId: id });

  if (!state) return <p className="text-sm text-zinc-500">{error ?? "加载中…"}</p>;

  const preview = form.name.trim() && form.url.trim() ? fallbackPromoLine({ id: "", ...form }) : "";
  const previewCount = preview ? weightedLength(preview).weighted : 0;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-1 text-lg font-semibold">推广链接</h1>
        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          存好你的 TG 群、QQ 群等链接。起草推文、写串推或长文时，可以选一个带上：AI 会按你的口吻在结尾写一句引导，链接原样保留，并算进 280 字数里。
        </p>
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-medium">默认怎么带</h2>
        <div className="space-y-2 text-sm">
          {PROMO_MODES.map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input
                type="radio"
                name="promo-mode"
                checked={state.settings.mode === m}
                disabled={busy}
                onChange={() => setMode(m)}
              />
              {PROMO_MODE_LABEL[m]}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">不管选哪种，每次生成前都还能在页面上改这一篇带不带、带哪个。</p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">已保存（{state.links.length}）</h2>
        {state.links.length === 0 ? (
          <p className="text-sm text-zinc-500">还没有，在下面添加第一条。</p>
        ) : (
          <ul className="space-y-2">
            {state.links.map((l) => (
              <li key={l.id} className={`${card} flex flex-col gap-2 sm:flex-row sm:items-start`}>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {PROMO_KIND_LABEL[l.kind]}
                    </span>
                    <span className="font-medium">{l.name}</span>
                    {l.id === state.settings.defaultId && <span className="text-xs text-sky-600">默认</span>}
                  </div>
                  <p className="mt-1 break-all text-zinc-500">{l.url}</p>
                  {l.blurb && <p className="mt-1 text-zinc-600 dark:text-zinc-400">引导语：{l.blurb}</p>}
                </div>
                <div className="flex shrink-0 gap-1 text-xs">
                  {l.id !== state.settings.defaultId && (
                    <button className={secondaryButton} onClick={() => setDefault(l.id)} disabled={busy}>
                      设为默认
                    </button>
                  )}
                  <button className={secondaryButton} onClick={() => startEdit(l)} disabled={busy}>
                    编辑
                  </button>
                  <button className={secondaryButton} onClick={() => remove(l)} disabled={busy}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-medium">{editingId ? "编辑推广链接" : "添加推广链接"}</h2>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="类型"
              className="rounded-md border border-zinc-300 bg-white px-2 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as PromoKind })}
            >
              {PROMO_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PROMO_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input
              aria-label="名称"
              className={`${inputClass} min-w-0 flex-1`}
              placeholder="名称，例如：独立开发交流群"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <input
            aria-label="链接或群号"
            className={inputClass}
            placeholder={URL_HINT[form.kind]}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
          <input
            aria-label="引导语"
            className={inputClass}
            placeholder="引导语（可选），例如：想一起聊的可以进群"
            value={form.blurb}
            onChange={(e) => setForm({ ...form, blurb: e.target.value })}
          />
          {preview && (
            <p className="text-xs text-zinc-500">
              AI 漏写时会兜底加上这句：<span className="text-zinc-700 dark:text-zinc-300">{preview}</span>（约占 {previewCount} / 280）
            </p>
          )}
          {error && <p className="text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button className={primaryButton} onClick={submit} disabled={busy || !form.name.trim() || !form.url.trim()}>
              {editingId ? "保存修改" : "添加"}
            </button>
            {editingId && (
              <button
                className={secondaryButton}
                onClick={() => {
                  setEditingId(null);
                  setForm(emptyForm);
                }}
              >
                取消
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
