import { timingSafeEqual } from "node:crypto";
import { tick } from "@/lib/scheduler";

/**
 * 给 Vercel Cron 等外部定时器用：发出到点的定时帖子、拉取新提及。
 * 需要请求头 Authorization: Bearer <CRON_SECRET>。本地运行时由内置定时器处理，不需要调用。
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret ?? ""}`);
  // 等时比较，防止靠响应时间猜密钥
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await tick());
}

export const GET = handle;
export const POST = handle;
