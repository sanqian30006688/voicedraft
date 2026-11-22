import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * OAuth 令牌加密保存（AES-256-GCM）。
 * 密钥来自 TOKEN_ENCRYPTION_KEY；本地运行没配置时，自动生成一个存在 .data/secret.key。
 */
let key: Buffer | null = null;

function getKey(): Buffer {
  if (key) return key;
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY;
  if (fromEnv) {
    key = createHash("sha256").update(fromEnv).digest();
    return key;
  }
  // 没配置时密钥存在 .data/secret.key。服务器上 .data 必须挂成持久存储（Railway 的 Volume），
  // 否则每次更新后之前加密的令牌都读不出来；Vercel 没有持久存储，只能用环境变量。
  if (process.env.VERCEL) throw new Error("线上部署需要配置 TOKEN_ENCRYPTION_KEY");
  const dir = path.join(process.cwd(), ".data");
  const file = path.join(dir, "secret.key");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  key = createHash("sha256").update(readFileSync(file, "utf8").trim()).digest();
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decrypt(stored: string): string {
  const [v, ivB64, tagB64, bodyB64] = stored.split(".");
  if (v !== "v1" || !ivB64 || !tagB64 || !bodyB64) throw new Error("令牌格式不对");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64")), decipher.final()]).toString("utf8");
}
