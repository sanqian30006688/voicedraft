"use client";

import { useCallback, useEffect, useState } from "react";
import { SetupGuide } from "./PublishPage";
import { BotSetup } from "./TgFeedPage";
import { RewardsAdmin } from "./RewardsAdmin";
import { ReportAdmin } from "./ReportAdmin";
import { TgGateSetup } from "./TgGateSetup";
import { BenchChannelAdmin } from "./BenchChannelAdmin";
import { AnnounceAdmin } from "./AnnounceAdmin";
import { BackupAdmin } from "./BackupAdmin";
import { card, inputClass, primaryButton, secondaryButton } from "./ui";

interface AdminState {
  platform: { xConfigured: boolean; xMock: boolean; redirectUri: string; tgConfigured: boolean; aiConfigured: boolean; imageAiConfigured: boolean };
}

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; balance?: string };
  if (!res.ok) throw new Error(data.error || "保存失败");
  return data;
}

export default function AdminPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiKey, setAiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [restorePass, setRestorePass] = useState("");

  const load = useCallback(() => {
    fetch("/api/admin/platform")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "加载失败");
        return d as AdminState;
      })
      .then((s) => {
        setState(s);
      })
      .catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }));
  }, []);
  useEffect(load, [load]);

  async function run<T>(fn: () => Promise<T>, ok: string | ((r: T) => string)) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: true, text: typeof ok === "function" ? ok(r) : ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p className="text-sm text-zinc-500">{msg?.text ?? "加载中…"}</p>;

  return (
    <div className="space-y-8 text-sm">
      <p className="text-zinc-500">
        平台的参数都在这一页改：AI 密钥、X 应用密钥、TG 机器人。只有管理员能看到这一页，改完立即生效。找某个用户、给他发消息，去{" "}
        <a className="underline" href="/admin/users">
          用户
        </a>{" "}
        页。
      </p>
      {msg && <p className={msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{msg.text}</p>}

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">AI 密钥（Anthropic）</h2>
        <p className="text-zinc-500">
          {state.platform.aiConfigured
            ? "已配置 ✓ 起草、长文、回复都用它。要换密钥再填一次即可。"
            : "还没配置，现在是演示模式：生成的内容都是固定示例。"}
          {" "}在{" "}
          <a className="underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            Anthropic 控制台
          </a>{" "}
          新建一个 Key（sk-ant- 开头），粘贴到下面保存。
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} max-w-md`}
            type="password"
            autoComplete="off"
            placeholder="sk-ant-…"
            value={aiKey}
            onChange={(e) => setAiKey(e.target.value)}
          />
          <button
            className={secondaryButton}
            disabled={busy || !aiKey.trim()}
            onClick={() =>
              run(async () => {
                const r = await send("/api/admin/ai-key", "POST", { key: aiKey });
                setAiKey("");
                return r;
              }, "AI 密钥已保存 ✓")
            }
          >
            保存
          </button>
        </div>
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">AI 配图密钥（Google Gemini）</h2>
        <p className="text-zinc-500">
          {state.platform.imageAiConfigured
            ? "已配置 ✓ 用户可以用「AI 配图」和「AI 精品图」。要换密钥再填一次即可。"
            : "还没配置：用户现在只能做信息卡（程序排版，不需要这个密钥），看不到 AI 配图按钮。"}
          {" "}在{" "}
          <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            Google AI Studio
          </a>{" "}
          点「Create API key」新建一个（通常 AIza 开头），并在 Google 那边开通付费，粘贴到下面保存。
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} max-w-md`}
            type="password"
            autoComplete="off"
            placeholder="AIza…"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
          />
          <button
            className={secondaryButton}
            disabled={busy || !geminiKey.trim()}
            onClick={() =>
              run(async () => {
                const r = await send("/api/admin/gemini-key", "POST", { key: geminiKey });
                setGeminiKey("");
                await load();
                return r;
              }, "Gemini 密钥已保存 ✓")
            }
          >
            保存
          </button>
        </div>
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">X 应用密钥</h2>
        <p className="text-zinc-500">
          {state.platform.xMock
            ? "现在是演示模式（不会真的发到 X）。"
            : state.platform.xConfigured
              ? "已配置 ✓ 所有用户都用这个 X 应用连接自己的账号。要换密钥再填一次即可。"
              : "还没配置。配置后用户才能在「发布」页连接自己的 X 账号。"}
        </p>
        <details>
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">{state.platform.xConfigured ? "更换 X 密钥" : "填写 X 密钥（附步骤）"}</summary>
          <div className="mt-3">
            <SetupGuide redirectUri={state.platform.redirectUri} onSaved={load} />
          </div>
        </details>
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">TG 机器人</h2>
        <p className="text-zinc-500">
          {state.platform.tgConfigured ? "已配置 ✓ 所有用户共用这一个机器人。" : "还没配置。配置后用户才能在「灵感」页绑定 TG。"}
        </p>
        <details>
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">{state.platform.tgConfigured ? "更换机器人" : "配置机器人（附步骤）"}</summary>
          <BotSetup onDone={load} />
        </details>
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">功能更新和公告</h2>
        <AnnounceAdmin />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">必须关注频道 / 进群才能用机器人</h2>
        <TgGateSetup />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">每周把涨粉榜发到频道</h2>
        <BenchChannelAdmin />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">签到和邀请奖励</h2>
        <RewardsAdmin />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">每日日报</h2>
        <ReportAdmin />
      </section>


      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">数据库备份</h2>
        <BackupAdmin />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">导入数据 / 从备份恢复</h2>
        <p className="text-zinc-500">
          从 Mac 上搬过来的数据文件（voicedraft-export.json），或每日备份的文件（.vdbak，要先在下面填备份密码），在这里上传。
          已经有的不会重复导入，可以放心多传几次。文件里带了 X、TG、AI 密钥的话会一并填好（这里已经填过的不会被覆盖）。
          导入后 X 账号需要在「发布」页重新连接一次。
        </p>
        <input
          className={`${inputClass} max-w-md`}
          type="password"
          autoComplete="off"
          placeholder="备份密码（只有 .vdbak 文件需要）"
          value={restorePass}
          onChange={(e) => setRestorePass(e.target.value)}
        />
        <input
          type="file"
          accept=".json,application/json,.vdbak"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append("file", f);
            if (restorePass) fd.append("passphrase", restorePass);
            void run(async () => {
              const res = await fetch("/api/admin/import", { method: "POST", body: fd });
              const d = (await res.json().catch(() => ({}))) as { error?: string; result?: { added: number }[]; platformKeys?: string[] };
              if (!res.ok) throw new Error(d.error || "导入失败");
              e.target.value = "";
              return d;
            }, (d) => {
              const added = (d.result ?? []).reduce((n, t) => n + t.added, 0);
              const keys = d.platformKeys?.length ? `，并填好了平台密钥（${d.platformKeys.join("、")}）` : "";
              return `导入完成 ✓ 新增 ${added} 条数据${keys}`;
            });
          }}
        />
      </section>

    </div>
  );
}
