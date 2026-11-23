import { requireUser } from "@/lib/auth";
import { createBindLink, TelegramError, unbind } from "@/lib/telegram";

/** 生成绑定链接：用户在 TG 里打开它并点「开始」即完成绑定 */
export async function POST() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  try {
    const link = await createBindLink(user.id);
    return Response.json({ url: link.url, username: link.username, expiresAt: link.expiresAt });
  } catch (e) {
    const msg = e instanceof TelegramError && e.status === 401 ? "机器人 Token 无效，请重新填写" : e instanceof Error ? e.message : "生成失败";
    return Response.json({ error: msg }, { status: 502 });
  }
}

export async function DELETE() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  await unbind(user.id);
  return Response.json({ ok: true });
}
