import { vi } from "vitest";

process.env.VD_DB = "memory";
process.env.X_MOCK = "1";
process.env.MOCK_LLM = "1";
process.env.DISABLE_SCHEDULER = "1";
process.env.TELEGRAM_BOT_TOKEN = "123456789:TEST_TOKEN_TEST_TOKEN_TEST_TOKEN_TEST";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
// 配图：不下载字体、不真的渲染
process.env.IMAGE_RENDER_MOCK = "1";
delete process.env.ADMIN_EMAILS;
delete process.env.DATABASE_URL;

// TEST_PG_URL=postgres://…/postgres：每个测试文件建一个新的空库，用真的 Postgres 跑（和线上一样走 postgres-js），
// 能发现内存库（PGlite）发现不了的问题，例如 SQL 里直接传日期对象
if (process.env.TEST_PG_URL) {
  const postgres = (await import("postgres")).default;
  const name = `vd_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(process.env.TEST_PG_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = new URL(process.env.TEST_PG_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}

// 模拟浏览器 cookie：测试里切换「当前登录的人」
const jar = new Map<string, string>();
(globalThis as { __testJar?: Map<string, string> }).__testJar = jar;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

// 不真的连 Telegram：记录机器人发出的每条消息
const sent: { method: string; params: Record<string, unknown> }[] = [];
(globalThis as { __tgSent?: typeof sent }).__tgSent = sent;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  // 机器人下载用户发来的图片：给一张 1×1 的 PNG
  if (/api\.telegram\.org\/file\/bot/.test(url)) {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    return new Response(png, { headers: { "content-type": "image/png" } });
  }
  const m = url.match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
  if (m) {
    const params =
      init?.body instanceof FormData
        ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "[file]"]))
        : init?.body
          ? JSON.parse(String(init.body))
          : {};
    sent.push({ method: m[1], params });
    // 测试里模拟某个聊天发送失败（例如 403 用户停用了机器人、429 限速）
    const fail = (globalThis as { __tgFail?: Map<string, { status: number; description: string }> }).__tgFail?.get(String(params.chat_id ?? ""));
    if (fail && m[1] === "sendMessage")
      return new Response(JSON.stringify({ ok: false, error_code: fail.status, description: fail.description }), { status: fail.status, headers: { "content-type": "application/json" } });
    const result =
      m[1] === "getMe" ? { username: "test_bot" } : m[1] === "getFile" ? { file_path: "photos/x.jpg", file_size: 100 } : { message_id: sent.length };
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }
  if (/api\.x\.com|x\.com\//.test(url)) throw new Error(`测试里不应该真的请求 X：${url}`);
  return realFetch(input, init);
}) as typeof fetch;
