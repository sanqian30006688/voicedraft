"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/inspiration", label: "X 书签 / 推文" },
  { href: "/inspiration/tg", label: "TG" },
];

/** 灵感页的来源切换：X 和 TG */
export default function InspirationTabs() {
  const pathname = usePathname();
  return (
    <div className="mb-6 inline-flex rounded-lg border border-zinc-300 p-0.5 text-sm dark:border-zinc-700">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`rounded-md px-3 py-1.5 ${
            pathname === t.href ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
