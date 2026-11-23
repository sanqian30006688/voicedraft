import { requireAdmin } from "@/lib/admin";
import { importExport, ImportError, platformEnvToImport } from "@/lib/data-import";
import { savePlatformEnv } from "@/lib/platform-config";
import { BackupDecryptError, decryptBackup, isBackupFile } from "@/lib/backup-core";

/**
 * 管理员上传数据文件，导入到服务器数据库：
 * - 本机导出的 voicedraft-export.json
 * - 每日备份的 .vdbak（加密的），同时填备份密码
 */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "请选择导出的数据文件" }, { status: 400 });
  if (file.size > 200 * 1024 * 1024) return Response.json({ error: "文件太大" }, { status: 400 });
  let data: unknown;
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    if (isBackupFile(buf)) {
      const pass = form?.get("passphrase");
      if (typeof pass !== "string" || !pass) return Response.json({ error: "这是加密的备份文件，请同时填写备份密码" }, { status: 400 });
      data = JSON.parse(decryptBackup(buf, pass));
    } else {
      data = JSON.parse(buf.toString("utf8"));
    }
  } catch (e) {
    if (e instanceof BackupDecryptError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: "文件格式不对" }, { status: 400 });
  }
  try {
    const result = await importExport(data);
    const keys = platformEnvToImport(data);
    if (Object.keys(keys).length) await savePlatformEnv(request, keys);
    return Response.json({ ok: true, result, platformKeys: Object.keys(keys) });
  } catch (e) {
    if (e instanceof ImportError) return Response.json({ error: e.message }, { status: 400 });
    console.error("[import]", e);
    return Response.json({ error: "导入失败，数据没有改动" }, { status: 500 });
  }
}
