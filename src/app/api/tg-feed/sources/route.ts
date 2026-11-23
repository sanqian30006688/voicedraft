import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { addChannel, listSources } from "@/lib/tg-feed";
import { ChannelError, parseChannelHandle } from "@/lib/tg-channel";

const MAX_SOURCES = 50;

/** 订阅一个公开 TG 频道 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = z.object({ channel: z.string().max(200) }).safeParse(await request.json().catch(() => null));
  const handle = parsed.success ? parseChannelHandle(parsed.data.channel) : null;
  if (!handle) {
    return Response.json({ error: "请填公开频道的用户名或链接，例如 @durov 或 https://t.me/durov" }, { status: 400 });
  }
  if ((await listSources(user.id)).length >= MAX_SOURCES) {
    return Response.json({ error: `最多订阅 ${MAX_SOURCES} 个频道` }, { status: 400 });
  }
  try {
    const r = await addChannel(user.id, handle);
    return Response.json(r);
  } catch (e) {
    if (e instanceof ChannelError) return Response.json({ error: e.message }, { status: 400 });
    console.error(e);
    return Response.json({ error: "订阅失败，请稍后重试" }, { status: 502 });
  }
}
