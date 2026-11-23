/**
 * 不靠服务器，把每日备份（.vdbak）解成普通的 voicedraft-export.json：
 *
 *   node scripts/decrypt-backup.mjs <备份文件.vdbak> <输出.json>
 *
 * 运行后会提示输入备份密码（不会显示在屏幕上）；也可以用环境变量 BACKUP_PASSPHRASE 传入。
 * 解出来的文件含顾客数据，用完请删掉。格式见 src/lib/backup-core.ts。
 */
import { createDecipheriv, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("用法：node scripts/decrypt-backup.mjs <备份文件.vdbak> <输出.json>");
  process.exit(1);
}

async function askPassphrase() {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes("备份密码")) process.stdout.write(s);
  };
  const p = await new Promise((resolve) => rl.question("备份密码：", resolve));
  rl.close();
  process.stdout.write("\n");
  return p;
}

const buf = readFileSync(src);
if (buf.subarray(0, 5).toString() !== "VDBK1") {
  console.error("不是推特助手的备份文件");
  process.exit(1);
}
const pass = await askPassphrase();
try {
  const key = scryptSync(pass, buf.subarray(5, 21), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(21, 33));
  d.setAuthTag(buf.subarray(33, 49));
  writeFileSync(out, gunzipSync(Buffer.concat([d.update(buf.subarray(49)), d.final()])), { mode: 0o600 });
  console.log(`已解出：${out}`);
} catch {
  console.error("备份密码不对，或者文件坏了");
  process.exit(1);
}
