import { Suspense } from "react";
import { botUsername } from "@/lib/telegram";

/**
 * 在 TG 机器人里点「连接 X」、授权完成后落到这里（不用登录网页）。
 * 只告诉结果，并给一个回 Telegram 的按钮；机器人那边同时会收到一条消息。
 */
export default function XConnectedPage({ searchParams }: PageProps<"/x-connected">) {
  return (
    <Suspense>
      <Result searchParams={searchParams} />
    </Suspense>
  );
}

async function Result({ searchParams }: { searchParams: PageProps<"/x-connected">["searchParams"] }) {
  const q = await searchParams;
  const ok = q.connected === "1";
  const error = typeof q.x_error === "string" ? q.x_error : null;
  const bot = await botUsername().catch(() => null);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16 text-center">
      <div className="text-5xl">{ok ? "✅" : "⚠️"}</div>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{ok ? "X 账号连接成功" : "这次没连上"}</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600">
        {ok
          ? "可以关掉这个页面，回到 Telegram 继续用机器人了。"
          : `${error ?? "授权没有完成"}。回到 Telegram，在机器人里再点一次「🔑 连接 X」就行。`}
      </p>
      {bot && (
        <a
          href={`https://t.me/${bot}`}
          className="mt-8 inline-block rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-700"
        >
          回到 Telegram 机器人
        </a>
      )}
    </main>
  );
}
