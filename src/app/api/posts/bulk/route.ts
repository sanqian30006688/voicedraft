import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/autopilot";
import { bulkSchedule, queueSummary } from "@/lib/publish";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json(await queueSummary(user.id));
}

const Body = z.object({
  action: z.enum(["pause", "resume", "cancel", "delay"]),
  minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
});

/** 一键管理所有还没发的定时帖：全部暂停 / 恢复 / 延后 / 删除。暂停时自动发帖也一起停。 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (parsed.data.action === "delay" && !parsed.data.minutes)) {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  const count = await bulkSchedule(user.id, parsed.data.action, parsed.data.minutes);
  let autopilotPaused = false;
  if (parsed.data.action === "pause" && (await getSettings(user.id)).enabled) {
    await saveSettings(user.id, { enabled: false });
    autopilotPaused = true;
  }
  return Response.json({ count, autopilotPaused, ...(await queueSummary(user.id)) });
}
