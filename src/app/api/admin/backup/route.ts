import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { backupStatus, runBackupNow, saveBackupConfig } from "@/lib/backup";

/** 后台「数据库备份」：看状态 */
export async function GET() {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  return Response.json(await backupStatus());
}

const Config = z.object({
  enabled: z.boolean().optional(),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "桶名格式不对")
    .optional(),
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$|^auto$/, "区域格式不对，例如 eu-west-2")
    .optional(),
  prefix: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9._\-/]*$/, "目录名只能用字母、数字和 . _ - /")
    .optional(),
  endpoint: z.union([z.literal(""), z.string().trim().url().startsWith("https://")]).optional(),
  accessKeyId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/, "Access Key ID 格式不对")
    .optional()
    .or(z.literal("")),
  secretAccessKey: z.string().trim().min(20).max(200).optional().or(z.literal("")),
  passphrase: z.string().min(12, "备份密码至少 12 位").max(200).optional().or(z.literal("")),
});

/** 保存设置，或 {action:"run"} 立刻备份一次（用来试设置对不对） */
export async function POST(request: Request) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.action === "run") {
    try {
      const r = await runBackupNow();
      return Response.json({ ok: true, ...r, status: await backupStatus() });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "备份失败", status: await backupStatus() }, { status: 400 });
    }
  }
  const parsed = Config.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "格式不对" }, { status: 400 });
  await saveBackupConfig(parsed.data);
  return Response.json({ ok: true, status: await backupStatus() });
}
