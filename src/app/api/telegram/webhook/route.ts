import { timingSafeEqual } from "node:crypto";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { firstTimeSeen } from "@/lib/tg-guard";

const MAX_BODY = 256 * 1024;

/**
 * 线上部署时的 TG 消息入口（本机运行用长轮询，不走这里）。
 * 设置 TELEGRAM_WEBHOOK=1 和 TELEGRAM_WEBHOOK_SECRET（至少 16 位随机字符），并用 setWebhook 把 secret_token 设成同一个值。
 */
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  // 密钥太短等于没设：至少 16 位，防止被猜中后伪造消息
  if (!secret || secret.length < 16 || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
    return new Response("forbidden", { status: 403 });
  }
  // 正常的 TG 更新只有几 KB；超大的请求直接丢掉
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response("too large", { status: 413 });
  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });
  let update: TgUpdate | null = null;
  try {
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    update = null;
  }
  // 同一条更新（Telegram 重发或被重放）只处理一次，避免重复调 AI、重复扣费
  if (update && typeof update.update_id === "number" && firstTimeSeen(update.update_id)) {
    try {
      await handleUpdate(update);
    } catch (e) {
      console.error("[telegram webhook]", e);
    }
  }
  return Response.json({ ok: true });
}
