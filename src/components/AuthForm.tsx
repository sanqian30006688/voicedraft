"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { inputClass, primaryButton } from "./ui";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 朋友的邀请链接 /signup?ref=邀请码
        body: JSON.stringify({ email, password, ...(isSignup ? { ref: new URLSearchParams(window.location.search).get("ref") ?? undefined } : {}) }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "出错了，请重试");
      router.replace(isSignup ? "/samples" : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">VoiceDraft</h1>
      <p className="mb-8 mt-1 text-sm text-zinc-500">像你自己写的推文</p>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">邮箱</span>
          <input
            className={inputClass}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">密码{isSignup && "（至少 8 位）"}</span>
          <input
            className={inputClass}
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={isSignup ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className={`${primaryButton} w-full`} disabled={busy}>
          {busy ? "请稍候…" : isSignup ? "注册" : "登录"}
        </button>
      </form>
      <p className="mt-6 text-sm text-zinc-500">
        {isSignup ? "已有账号？" : "还没有账号？"}
        <Link className="ml-1 underline underline-offset-4" href={isSignup ? "/login" : "/signup"}>
          {isSignup ? "登录" : "注册"}
        </Link>
      </p>
    </main>
  );
}
