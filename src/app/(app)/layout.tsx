import { Suspense } from "react";
import AppShell from "@/components/AppShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // 动态路由（如 /draft/[id]）里读取地址需要 Suspense 边界
    <Suspense fallback={<p className="mx-auto w-full max-w-3xl px-4 py-10 text-sm text-zinc-500">加载中…</p>}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
