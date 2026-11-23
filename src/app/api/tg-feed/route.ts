import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { addFeedItem, CHANNEL_INTERVAL_MIN, listItems, listSources } from "@/lib/tg-feed";
import { botToken, botUsername, getBinding } from "@/lib/telegram";

/** 灵感池：内容列表、订阅的频道、TG 绑定状态 */
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const q = new URL(request.url).searchParams;
  const [items, sources, binding] = await Promise.all([
    listItems(user.id, { status: q.get("status") ?? undefined, sourceId: q.get("source") ?? undefined }),
    listSources(user.id),
    getBinding(user.id),
  ]);
  let username: string | null = null;
  let botError: string | null = null;
  if (botToken()) {
    username = await botUsername().catch((e: Error) => {
      botError = e.message;
      return null;
    });
  }
  return Response.json({
    items,
    sources: sources.map((s) => ({
      id: s.id,
      handle: s.handle,
      title: s.title,
      enabled: s.enabled,
      lastFetchedAt: s.lastFetchedAt,
      error: s.error,
    })),
    intervalMin: CHANNEL_INTERVAL_MIN,
    telegram: {
      configured: !!botToken(),
      username,
      botError,
      bound: !!binding?.chatId,
      boundAt: binding?.boundAt ?? null,
    },
  });
}

const Manual = z.object({
  text: z.string().trim().min(1, "请填内容").max(8000),
  url: z.string().trim().url().max(500).optional().or(z.literal("")),
});

/** 手动粘贴一段内容进灵感池 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Manual.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "格式不对" }, { status: 400 });
  const ok = await addFeedItem(user.id, { kind: "manual", text: parsed.data.text, url: parsed.data.url || null });
  if (!ok) return Response.json({ error: "这条之前已经收过了" }, { status: 409 });
  return Response.json({ ok: true });
}
