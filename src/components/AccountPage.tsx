"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMe } from "./AppShell";
import { card, inputClass, secondaryButton } from "./ui";

export default function AccountPage() {
  const { me } = useMe();
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  async function deleteAccount() {
    setBusy(true);
    const res = await fetch("/api/me", { method: "DELETE" });
    if (res.ok) router.replace("/signup");
    else setBusy(false);
  }

  return (
    <div className="space-y-8 text-sm">
      <section className={`${card} space-y-2`}>
        <h2 className="font-medium">账号</h2>
        <p className="text-zinc-600 dark:text-zinc-400">{me.user.email}</p>
        {me.user.no != null && <p className="text-zinc-600 dark:text-zinc-400">用户编号：{me.user.no}（找客服时发这个号）</p>}
        <p className="text-zinc-500">
          素材 {me.samples} 条 · 风格卡 {me.card ? `第 ${me.card.version} 版` : "未生成"} · 已记住 {me.edits} 次修改
        </p>
        <button className={secondaryButton} onClick={logout}>
          退出登录
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-red-200 p-4 dark:border-red-900">
        <h2 className="font-medium text-red-700 dark:text-red-400">删除账号</h2>
        <p className="text-zinc-600 dark:text-zinc-400">
          会立即删除你的账号、全部素材、风格卡的所有版本和修改记录，不能恢复。
        </p>
        <label className="block">
          <span className="mb-1 block">请输入「删除」确认</span>
          <input className={`${inputClass} max-w-xs`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </label>
        <button
          className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-40"
          disabled={confirmText !== "删除" || busy}
          onClick={deleteAccount}
        >
          {busy ? "删除中…" : "永久删除账号和数据"}
        </button>
      </section>
    </div>
  );
}
