/** 每日数据库备份：加密、上传 S3、只有管理员能设置、能从备份恢复 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import * as backupRoute from "@/app/api/admin/backup/route";
import * as importRoute from "@/app/api/admin/import/route";
import { backupObjectKey, decryptBackup, encryptBackup, signPutObject } from "@/lib/backup-core";
import { backupReportLine, getBackupState, runBackupNow, runDailyBackup, saveBackupConfig } from "@/lib/backup";
import { setSetting } from "@/lib/billing";
import { adminReportText } from "@/lib/daily-report";
import { createUser, json, loginAs, type TestUser } from "./helpers";

const PASS = "abcd-efgh-jkmn-pqrs-tuvw-xyz2";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

let OWNER: TestUser;
let A: TestUser;

/** 假的 S3：记下每次 PUT */
function fakeS3(status = 200) {
  const puts: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    puts.push({ url, headers: init?.headers as Record<string, string>, body: Buffer.from(init?.body as Uint8Array) });
    return new Response(status === 200 ? "" : "<Error><Code>AccessDenied</Code></Error>", { status });
  }) as unknown as typeof fetch;
  return { puts, f };
}

beforeAll(async () => {
  OWNER = await createUser("owner@example.com"); // 第一个注册的 = 管理员
  A = await createUser("a@example.com");
  const db = await getDb();
  await db.insert(schema.drafts).values({ userId: A.id, topic: "顾客 A 的草稿", mode: "quick", sentences: [] });
  // 平台密钥不能进备份
  await setSetting("platform_env", { enc: "PLATFORM-SECRET-MARKER" });
});

describe("加密格式", () => {
  it("用对的密码能解开，错的密码解不开", () => {
    const enc = encryptBackup('{"hello":"世界"}', PASS);
    expect(enc.subarray(0, 5).toString()).toBe("VDBK1");
    expect(enc.includes(Buffer.from("hello"))).toBe(false);
    expect(decryptBackup(enc, PASS)).toBe('{"hello":"世界"}');
    expect(() => decryptBackup(enc, "wrong-password-123")).toThrow("备份密码不对");
  });

  it("太短的备份密码不让用", () => {
    expect(() => encryptBackup("x", "short")).toThrow();
  });

  it("文件名按日期，前缀斜杠自动补", () => {
    const d = new Date("2026-11-14T03:00:00Z");
    expect(backupObjectKey("tuiter-backup", d)).toBe("tuiter-backup/vd-2026-11-14.vdbak");
    expect(backupObjectKey("/tuiter-backup/", d)).toBe("tuiter-backup/vd-2026-11-14.vdbak");
    expect(backupObjectKey("", d)).toBe("vd-2026-11-14.vdbak");
  });

  it("S3 签名和 AWS 官方 SDK（botocore）算出来的一样", () => {
    const r = signPutObject(
      { bucket: "my-bucket", region: "eu-west-2", accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET },
      "tuiter-backup/vd-2026-11-14.vdbak",
      Buffer.from("hello backup"),
      new Date("2026-11-14T03:04:05Z"),
    );
    expect(r.url).toBe("https://my-bucket.s3.eu-west-2.amazonaws.com/tuiter-backup/vd-2026-11-14.vdbak");
    expect(r.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261114/eu-west-2/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=e18ea57d56db027162127c1f0e7a58252acbfea13864a55fecdc1ed75e9ac746",
    );
    const dotted = signPutObject(
      { bucket: "my.bucket", region: "eu-west-2", accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET },
      "a b/x(1).vdbak",
      Buffer.from("x"),
      new Date("2026-11-14T03:04:05Z"),
    );
    expect(dotted.url).toBe("https://s3.eu-west-2.amazonaws.com/my.bucket/a%20b/x%281%29.vdbak");
    expect(dotted.headers.authorization).toContain("Signature=db1130341220cbfaa26f963fc511fe1cc2acb6726b948aea020f224847ac1253");
  });
});

describe("后台设置", () => {
  it("顾客打不开备份设置", async () => {
    loginAs(A);
    expect((await backupRoute.GET()).status).toBe(403);
    expect((await backupRoute.POST(json({ bucket: "evil-bucket" }))).status).toBe(403);
    expect((await backupRoute.POST(json({ action: "run" }))).status).toBe(403);
  });

  it("管理员保存后，密钥和备份密码不会回显", async () => {
    loginAs(OWNER);
    const res = await backupRoute.POST(
      json({ bucket: "vd-backups", region: "eu-west-2", prefix: "tuiter-backup/", accessKeyId: "AKIAEXAMPLEKEY123456", secretAccessKey: SECRET, passphrase: PASS }),
    );
    expect(res.status).toBe(200);
    const text = await (await backupRoute.GET()).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PASS);
    expect(text).not.toContain("AKIAEXAMPLEKEY123456");
    const d = JSON.parse(text);
    expect(d.complete).toBe(true);
    expect(d.config).toMatchObject({ bucket: "vd-backups", region: "eu-west-2", hasAccessKey: true, hasPassphrase: true });
    // 数据库里也是加密存的
    const db = await getDb();
    const rows = await db.select().from(schema.appSettings);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("只改桶名时，之前填的密钥保留", async () => {
    loginAs(OWNER);
    await backupRoute.POST(json({ bucket: "vd-backups-2" }));
    const d = await (await backupRoute.GET()).json();
    expect(d.config.bucket).toBe("vd-backups-2");
    expect(d.complete).toBe(true);
    await backupRoute.POST(json({ bucket: "vd-backups" }));
  });

  it("格式不对的设置被拒绝", async () => {
    loginAs(OWNER);
    expect((await backupRoute.POST(json({ region: "london" }))).status).toBe(400);
    expect((await backupRoute.POST(json({ passphrase: "short" }))).status).toBe(400);
    expect((await backupRoute.POST(json({ endpoint: "http://insecure.example.com" }))).status).toBe(400);
  });
});

describe("备份内容", () => {
  let file: Buffer;

  it("上传到 S3 的是加密文件，解开后有顾客数据，没有平台密钥、登录会话和 S3 密钥", async () => {
    const s3 = fakeS3();
    const r = await runBackupNow(new Date("2026-11-14T03:00:00Z"), s3.f);
    expect(r.key).toBe("tuiter-backup/vd-2026-11-14.vdbak");
    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0].url).toBe("https://vd-backups.s3.eu-west-2.amazonaws.com/tuiter-backup/vd-2026-11-14.vdbak");
    expect(s3.puts[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY123456\//);
    file = s3.puts[0].body;
    expect(file.includes(Buffer.from("顾客 A 的草稿"))).toBe(false);

    const plain = decryptBackup(file, PASS);
    const data = JSON.parse(plain) as { format: string; tables: { name: string; rows: Record<string, unknown>[] }[] };
    expect(data.format).toBe("voicedraft-export");
    const names = data.tables.map((t) => t.name);
    expect(names).toContain("users");
    expect(names).not.toContain("sessions");
    expect(names.indexOf("users")).toBeLessThan(names.indexOf("drafts"));
    expect(data.tables.find((t) => t.name === "users")!.rows.map((u) => u.email)).toEqual(["owner@example.com", "a@example.com"]);
    expect(plain).toContain("顾客 A 的草稿");
    expect(plain).not.toContain("PLATFORM-SECRET-MARKER");
    expect(plain).not.toContain("backup_config");
    expect(plain).not.toContain(SECRET);
    expect(plain).not.toContain(PASS);

    const st = await getBackupState();
    expect(st.lastOkAt).toBe("2026-11-14T03:00:00.000Z");
    expect(st.lastError).toBeNull();
  });

  it("备份文件可以在后台用备份密码导入（恢复）；密码错了不动数据", async () => {
    loginAs(OWNER);
    const upload = (pass?: string) => {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array(file)], "vd-2026-11-14.vdbak"));
      if (pass) fd.append("passphrase", pass);
      return importRoute.POST(new Request("https://example.com/api/admin/import", { method: "POST", body: fd }));
    };
    expect((await upload()).status).toBe(400);
    const bad = await upload("wrong-password-123");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("备份密码不对");
    const ok = await upload(PASS);
    expect(ok.status).toBe(200);
    // 同一份数据库：都已经有了，不重复导入
    const d = (await ok.json()) as { result: { added: number }[] };
    expect(d.result.reduce((n, t) => n + t.added, 0)).toBe(0);

    // 模拟丢了数据：删掉顾客 A 的草稿，再从备份导入，草稿回来
    const db = await getDb();
    await db.delete(schema.drafts).where(eq(schema.drafts.userId, A.id));
    const again = await upload(PASS);
    expect(again.status).toBe(200);
    const back = await db.select().from(schema.drafts).where(eq(schema.drafts.userId, A.id));
    expect(back.map((x) => x.topic)).toEqual(["顾客 A 的草稿"]);

    loginAs(A);
    expect((await upload(PASS)).status).toBe(403);
  });
});

describe("每天自动跑", () => {
  it("一天只备份一次；S3 拒绝时记下原因，一小时后再试", async () => {
    const t0 = Date.parse("2026-11-14T03:00:00Z");
    const s3 = fakeS3();
    // 刚备份过：不再跑
    expect(await runDailyBackup(new Date(t0 + 6 * 3600_000), s3.f)).toBe(false);
    expect(s3.puts).toHaveLength(0);

    const denied = fakeS3(403);
    expect(await runDailyBackup(new Date(t0 + 24 * 3600_000), denied.f)).toBe(false);
    expect(denied.puts).toHaveLength(1);
    expect((await getBackupState()).lastError).toBe("S3 返回 403 AccessDenied");
    expect(await backupReportLine(new Date(t0 + 24 * 3600_000))).toContain("24 小时前");

    // 失败后半小时内不重试
    expect(await runDailyBackup(new Date(t0 + 24.5 * 3600_000), denied.f)).toBe(false);
    expect(denied.puts).toHaveLength(1);

    // 一小时后再试，成功
    expect(await runDailyBackup(new Date(t0 + 25.1 * 3600_000), s3.f)).toBe(true);
    expect(s3.puts).toHaveLength(1);
    expect((await getBackupState()).lastError).toBeNull();
  });

  it("太久没成功时经营日报里会提醒", async () => {
    const st = await getBackupState();
    const later = new Date(Date.parse(st.lastOkAt!) + 48 * 3600_000);
    expect(await backupReportLine(later)).toMatch(/^⚠️ 数据库备份：已经 48 小时没成功了/);
    expect(await adminReportText(new Date(Date.parse(st.lastOkAt!) + 3600_000))).toContain("🗄 数据库备份：正常");
  });

  it("暂停后不再备份", async () => {
    await saveBackupConfig({ enabled: false });
    const s3 = fakeS3();
    expect(await runDailyBackup(new Date("2026-11-20T03:00:00Z"), s3.f)).toBe(false);
    expect(s3.puts).toHaveLength(0);
    expect(await backupReportLine()).toBe("🗄 数据库备份：已暂停");
  });
});

