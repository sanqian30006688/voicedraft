"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fallbackPromoLine,
  PROMO_KINDS,
  PROMO_KIND_LABEL,
  type PromoLink,
  type PromoSettings,
} from "@/lib/promo";

export interface PromoState {
  links: PromoLink[];
  settings: PromoSettings;
}

/**
 * 读取推广链接和偏好，返回这一篇当前选中的推广（null 表示不带）。
 * 偏好是「每篇都带」时默认选中默认链接，其他情况默认不带。
 * followMode=false（回复用）：不管偏好，默认不带，每次自己选。
 */
export function usePromo({ followMode = true }: { followMode?: boolean } = {}) {
  const [state, setState] = useState<PromoState | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  useEffect(() => {
    let alive = true;
    fetch("/api/promo")
      .then((r) => (r.ok ? (r.json() as Promise<PromoState>) : null))
      .then((s) => {
        if (!alive || !s) return;
        if (!followMode) {
          setState({ ...s, settings: { ...s.settings, mode: "ask" } });
          return;
        }
        setState(s);
        if (s.settings.mode === "always") {
          const d = s.links.find((l) => l.id === s.settings.defaultId) ?? s.links[0];
          setSelectedId(d?.id ?? "");
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [followMode]);

  const selected = state?.links.find((l) => l.id === selectedId) ?? null;
  return { state, selected, selectedId, setSelectedId };
}

/** 生成前选这篇带哪个推广；偏好是「不带」且没选中时只显示一个小入口 */
export function PromoPicker({
  promo,
  disabled,
}: {
  promo: ReturnType<typeof usePromo>;
  disabled?: boolean;
}) {
  const { state, selected, selectedId, setSelectedId } = promo;
  const [expanded, setExpanded] = useState(false);
  if (!state) return null;

  if (!state.links.length) {
    return (
      <p className="text-xs text-zinc-500">
        想在内容里带上 TG 群、QQ 群链接？先到{" "}
        <Link className="underline underline-offset-4" href="/promo">
          推广
        </Link>{" "}
        里保存。
      </p>
    );
  }

  if (state.settings.mode === "off" && !selectedId && !expanded) {
    return (
      <button className="text-xs text-zinc-500 underline-offset-4 hover:underline" onClick={() => setExpanded(true)}>
        这篇带个推广链接
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="promo-pick" className="text-zinc-600 dark:text-zinc-400">
        推广
      </label>
      <select
        id="promo-pick"
        className="max-w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        value={selectedId}
        disabled={disabled}
        onChange={(e) => setSelectedId(e.target.value)}
      >
        <option value="">不带</option>
        {PROMO_KINDS.map((k) => {
          const items = state.links.filter((l) => l.kind === k);
          if (!items.length) return null;
          return (
            <optgroup key={k} label={PROMO_KIND_LABEL[k]}>
              {items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.id === state.settings.defaultId ? "（默认）" : ""}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {selected && (
        <span className="min-w-0 truncate text-xs text-zinc-500" title={fallbackPromoLine(selected)}>
          {selected.url}
        </span>
      )}
      <Link className="text-xs text-zinc-500 underline-offset-4 hover:underline" href="/promo">
        管理
      </Link>
    </div>
  );
}
