import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  AnnounceError,
  cancelAnnouncement,
  deliveredText,
  getAnnouncement,
  OPT_OUT_BUTTONS,
  sendReviewCards,
  startSending,
  updateBody,
} from "@/lib/announce";
import { sendMessage } from "@/lib/tg-api";

type Ctx = { params: Promise<{ id: string }> };

function fail(e: unknown) {
  if (e instanceof AnnounceError) return Response.json({ error: e.message }, { status: 400 });
  throw e;
}

/** 改草稿的文字 */
export async function PATCH(request: Request, { params }: Ctx) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = z.object({ body: z.string() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "公告内容不对" }, { status: 400 });
  try {
    return Response.json({ ok: true, announcement: await updateBody(id, parsed.data.body) });
  } catch (e) {
    return fail(e);
  }
}

const Action = z.object({ action: z.enum(["send", "urgent", "cancel", "test", "review"]) });

/**
 * send 开始群发（按用户当地白天）；urgent 马上发给所有人；cancel 不发 / 停止；
 * test 先发一条给自己的 TG 看看效果；review 把审核卡片发到管理员 TG
 */
export async function POST(request: Request, { params }: Ctx) {
  const user = await requireAdmin();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "不认识的操作" }, { status: 400 });
  const ann = await getAnnouncement(id);
  if (!ann) return Response.json({ error: "找不到这条公告" }, { status: 404 });
  try {
    switch (parsed.data.action) {
      case "send":
        return Response.json({ ok: true, announcement: await startSending(id) });
      case "urgent":
        return Response.json({ ok: true, announcement: await startSending(id, true) });
      case "cancel":
        return Response.json({ ok: true, announcement: await cancelAnnouncement(id) });
      case "review":
        await sendReviewCards(ann);
        return Response.json({ ok: true });
      case "test": {
        const db = await getDb();
        const [b] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, user.id)).limit(1);
        if (!b?.chatId) return Response.json({ error: "你的账号还没绑定 TG，收不到" }, { status: 400 });
        try {
          await sendMessage(b.chatId, deliveredText(ann.body), { buttons: OPT_OUT_BUTTONS });
        } catch (e) {
          return Response.json({ error: `没发出去：${e instanceof Error ? e.message : e}` }, { status: 400 });
        }
        return Response.json({ ok: true });
      }
    }
  } catch (e) {
    return fail(e);
  }
}
