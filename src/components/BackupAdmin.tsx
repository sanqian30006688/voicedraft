"use client";

import { useCallback, useEffect, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "./ui";

interface Status {
  config: {
    enabled: boolean;
    bucket: string;
    region: string;
    prefix: string;
    endpoint: string;
    hasAccessKey: boolean;
    hasPassphrase: boolean;
  } | null;
  complete: boolean;
  state: { lastAttemptAt?: string; lastOkAt?: string; lastKey?: string; lastBytes?: number; lastError?: string | null };
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");

/** 随机生成一个好抄的备份密码：6 组 4 位，去掉容易看错的字符 */
function randomPassphrase(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join("");
  return s.match(/.{4}/g)!.join("-");
}

/** 后台：每日数据库备份到 S3 */
export function BackupAdmin() {
  const [st, setSt] = useState<Status | null>(null);
  const [form, setForm] = useState({ bucket: "", region: "", prefix: "tuiter-backup/", endpoint: "", accessKeyId: "", secretAccessKey: "", passphrase: "" });
  const [shownPass, setShownPass] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/backup")
      .then((r) => r.json())
      .then((d: Status) => {
        setSt(d);
        if (d.config) setForm((f) => ({ ...f, bucket: d.config!.bucket, region: d.config!.region, prefix: d.config!.prefix, endpoint: d.config!.endpoint }));
      })
      .catch(() => setMsg({ ok: false, text: "加载失败" }));
  }, []);
  useEffect(load, [load]);

  async function post(body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await res.json().catch(() => ({}))) as { error?: string; status?: Status };
      if (d.status) setSt(d.status);
      if (!res.ok) throw new Error(d.error || "失败了");
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!st) return <p className="text-zinc-500">加载中…</p>;
  const s = st.state;
  return (
    <div className="space-y-4">
      <p className="text-zinc-500">
        每天自动把整个数据库导出一份，用下面的「备份密码」加密后传到 S3。不含登录状态和 X / TG / AI 密钥。
        万一服务器出事，在本页下方「导入数据」上传备份文件并填备份密码就能恢复（顾客需要重新连一次 X）。
      </p>

      <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
        {!st.complete ? (
          <p>还没设置完整，现在不会备份。</p>
        ) : !st.config?.enabled ? (
          <p>已暂停。</p>
        ) : s.lastOkAt ? (
          <p>
            正常 ✓ 最近一份：{when(s.lastOkAt)}（{Math.max(1, Math.round((s.lastBytes ?? 0) / 1024))} KB，<code>{s.lastKey}</code>）
          </p>
        ) : (
          <p>设置好了，还没成功备份过。可以点「现在备份一次」试一下。</p>
        )}
        {s.lastError ? <p className="mt-1 text-red-600">上次失败（{when(s.lastAttemptAt)}）：{s.lastError}</p> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">桶名（Bucket）</span>
          <input className={inputClass} value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} placeholder="my-backup-bucket" />
        </label>
        <label className="space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">区域（Region）</span>
          <input className={inputClass} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="eu-west-2" />
        </label>
        <label className="space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">目录（前缀）</span>
          <input className={inputClass} value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">自定义地址（用 AWS 就留空）</span>
          <input className={inputClass} value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://…" />
        </label>
        <label className="space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">Access Key ID{st.config?.hasAccessKey ? "（已填，换才需要再填）" : ""}</span>
          <input className={inputClass} autoComplete="off" value={form.accessKeyId} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">Secret Access Key{st.config?.hasAccessKey ? "（已填）" : ""}</span>
          <input className={inputClass} type="password" autoComplete="off" value={form.secretAccessKey} onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })} />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-zinc-600 dark:text-zinc-400">
          备份密码{st.config?.hasPassphrase ? "（已设置。换密码只影响以后的备份，旧备份还要用旧密码打开）" : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} max-w-md`}
            type="password"
            autoComplete="new-password"
            placeholder="至少 12 位"
            value={form.passphrase}
            onChange={(e) => {
              setForm({ ...form, passphrase: e.target.value });
              setShownPass("");
            }}
          />
          <button
            className={secondaryButton}
            type="button"
            onClick={() => {
              const p = randomPassphrase();
              setForm({ ...form, passphrase: p });
              setShownPass(p);
            }}
          >
            随机生成
          </button>
        </div>
        {shownPass ? (
          <p className="rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            请现在把这个密码抄下来，存在服务器以外的地方（例如密码管理器）：<code className="select-all">{shownPass}</code>
            <br />
            保存后这里不会再显示。丢了它，备份就打不开。
          </p>
        ) : (
          <p className="text-zinc-500">恢复备份时要用它。请存在服务器以外的地方，丢了备份就打不开。</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={st.config?.enabled ?? true}
            disabled={busy || !st.config}
            onChange={(e) => void post({ enabled: e.target.checked }, e.target.checked ? "已开启每日备份 ✓" : "已暂停")}
          />
          每天自动备份
        </label>
        <button
          className={primaryButton}
          disabled={busy}
          onClick={async () => {
            const body: Record<string, unknown> = { bucket: form.bucket, region: form.region, prefix: form.prefix, endpoint: form.endpoint };
            if (form.accessKeyId) body.accessKeyId = form.accessKeyId;
            if (form.secretAccessKey) body.secretAccessKey = form.secretAccessKey;
            if (form.passphrase) body.passphrase = form.passphrase;
            if (await post(body, "已保存 ✓")) {
              setForm((f) => ({ ...f, accessKeyId: "", secretAccessKey: "", passphrase: "" }));
              setShownPass("");
            }
          }}
        >
          保存
        </button>
        <button className={secondaryButton} disabled={busy || !st.complete} onClick={() => void post({ action: "run" }, "备份成功 ✓")}>
          现在备份一次
        </button>
      </div>
      {msg ? <p className={msg.ok ? "text-green-700" : "text-red-600"}>{msg.text}</p> : null}
    </div>
  );
}
