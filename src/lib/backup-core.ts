import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * 数据库备份的纯计算部分（加密、解密、S3 签名），不碰数据库，方便测试。
 *
 * 备份文件格式（.vdbak）：
 *   "VDBK1"(5) | salt(16) | iv(12) | tag(16) | AES-256-GCM( gzip(导出 JSON) )
 * 密钥 = scrypt(备份密码, salt)。备份密码只在平台方手里有一份就够解开，
 * 和服务器上的 secret.key 无关：服务器整个丢了，用密码也能把备份解出来。
 */

const MAGIC = Buffer.from("VDBK1");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class BackupDecryptError extends Error {}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encryptBackup(plain: string | Buffer, passphrase: string): Buffer {
  if (passphrase.length < 12) throw new Error("备份密码太短");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function isBackupFile(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptBackup(buf: Buffer, passphrase: string): string {
  if (!isBackupFile(buf) || buf.length < 49) throw new BackupDecryptError("不是推特助手的备份文件");
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(33, 49);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    return gunzipSync(Buffer.concat([decipher.update(buf.subarray(49)), decipher.final()])).toString("utf8");
  } catch {
    throw new BackupDecryptError("备份密码不对，或者文件坏了");
  }
}

// ---------- S3 上传（AWS Signature V4，只用 PutObject） ----------

export interface S3Target {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 自建 / 兼容 S3 的地址（例如 R2）；不填就是 AWS */
  endpoint?: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 编码，斜杠保留（S3 的路径规则） */
function encodePath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/** 生成 PutObject 请求（不发出去）：返回地址和要带的请求头 */
export function signPutObject(t: S3Target, key: string, body: Buffer, now = new Date(), contentType = "application/octet-stream") {
  let host: string;
  let pathPart: string;
  let scheme = "https";
  if (t.endpoint) {
    const u = new URL(t.endpoint);
    scheme = u.protocol.replace(":", "");
    host = u.host;
    pathPart = `/${t.bucket}/${key}`;
  } else if (t.bucket.includes(".")) {
    // 桶名带点时证书对不上虚拟主机名，改用路径形式
    host = `s3.${t.region}.amazonaws.com`;
    pathPart = `/${t.bucket}/${key}`;
  } else {
    host = `${t.bucket}.s3.${t.region}.amazonaws.com`;
    pathPart = `/${key}`;
  }
  const canonicalUri = encodePath(pathPart);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    "content-type": contentType,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = ["PUT", canonicalUri, "", names.map((n) => `${n}:${headers[n]}\n`).join(""), signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, day), t.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  return { url: `${scheme}://${host}${canonicalUri}`, headers: { ...sendHeaders, authorization } };
}

/** 备份文件在桶里的名字：前缀 + 日期，同一天重跑会覆盖当天那份 */
export function backupObjectKey(prefix: string, now = new Date()): string {
  const p = prefix.trim().replace(/^\/+/, "");
  return `${p && !p.endsWith("/") ? `${p}/` : p}vd-${now.toISOString().slice(0, 10)}.vdbak`;
}

/** 导出里不能带的：登录会话、OAuth 中间状态，以及平台密钥和备份设置本身 */
export const BACKUP_SKIP_TABLES = new Set(["sessions", "x_oauth_states"]);
export const BACKUP_SKIP_SETTINGS = new Set(["platform_env", "backup_config"]);
