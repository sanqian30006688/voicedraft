"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface Me {
  user: { id: string; email: string; name: string | null; no: number | null };
  samples: number;
  edits: number;
  learnReady: boolean;
  card: { version: number; lang: string } | null;
  mock: boolean;
  xConfigured: boolean;
  x: { handle: string; authError: string | null } | null;
  balance: string;
  billing: boolean;
  lowBalance: boolean;
  admin: boolean;
  team: { role: "owner" | "admin" | "member" } | null;
}

const MeContext = createContext<{ me: Me; refresh: () => void } | null>(null);

export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe 必须在 AppShell 内使用");
  return ctx;
}

const NAV = [
  { href: "/", label: "起草" },
  { href: "/autopilot", label: "自动发帖" },
  { href: "/inspiration", label: "灵感" },
  { href: "/long", label: "长文" },
  { href: "/drafts", label: "草稿" },
  { href: "/publish", label: "发布" },
  { href: "/replies", label: "回复" },
  { href: "/follow-check", label: "互关" },
  { href: "/promo", label: "推广" },
  { href: "/samples", label: "素材" },
  { href: "/style-card", label: "风格卡" },
  { href: "/memory", label: "记忆" },
  { href: "/stats", label: "数据" },
  { href: "/blind-test", label: "盲测" },
  { href: "/team", label: "团队" },
  { href: "/account", label: "账号" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    fetch("/api/me")
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) throw new Error();
        setMe((await res.json()) as Me);
      })
      .catch(() => setFailed(true));
  }, [router]);

  useEffect(refresh, [refresh, pathname]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-xl font-semibold tracking-tight">
          VoiceDraft
        </Link>
        <nav className="flex flex-wrap gap-1 text-sm">
          {[...NAV, ...(me?.admin ? [{ href: "/admin/users", label: "用户" }, { href: "/admin", label: "后台" }] : [])].map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-md px-3 py-1.5 ${
                (n.href === "/" ? pathname === "/" || pathname.startsWith("/draft/") : n.href === "/admin" ? pathname === "/admin" : pathname === n.href || pathname.startsWith(`${n.href}/`))
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      {me?.mock && (
        <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          演示模式：还没有配置 AI 密钥（管理员在「后台」填写），生成的候选和风格卡都是固定的示例内容。
        </p>
      )}
      {failed ? (
        <p className="text-sm text-red-600">连接服务器失败，请刷新页面重试。</p>
      ) : me ? (
        <MeContext.Provider value={{ me, refresh }}>{children}</MeContext.Provider>
      ) : (
        <p className="text-sm text-zinc-500">加载中…</p>
      )}
    </div>
  );
}
