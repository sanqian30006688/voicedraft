import "server-only";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 在本机运行时，把配置写进项目里的 .env.local，并立即生效（同时写进 process.env，不用重启）。
 * 只改传入的几个变量，其余内容原样保留。
 */
export function writeEnvLocal(values: Record<string, string>) {
  const file = path.join(process.cwd(), ".env.local");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}=`).test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    process.env[key] = value;
  }
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 只允许本机访问时写配置文件（线上部署请在平台的环境变量里配置） */
export function isLocalRequest(request: Request): boolean {
  if (process.env.VERCEL) return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
