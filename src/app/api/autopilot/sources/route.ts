import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { fmtWait, hit } from "@/lib/rate-limit";
import { addAnySource, sourceErrorText } from "@/lib/sources";
import { listSources } from "@/lib/tg-feed";

const MAX_SOURCES = 50;

/** 加一个信息源：网址 / RSS / 论坛版块 / 单篇链接 / X 主页 / 公开 TG 频道 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = z
    .object({ input: z.string().min(1).max(500), mode: z.enum(["follow", "once"]).default("follow") })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请填网址、x.com/用户名 或 t.me/频道名" }, { status: 400 });
  // 加信息源要去读别人的网站：每人每小时最多试 30 次
  const r = hit(`src:add:${user.id}`, 30, 3600_000);
  if (!r.ok) return Response.json({ error: `加得太频繁了，请 ${fmtWait(r.retryAfterMs)}后再试` }, { status: 429 });
  if ((await listSources(user.id)).length >= MAX_SOURCES) {
    return Response.json({ error: `最多 ${MAX_SOURCES} 个信息源，请先删掉一些` }, { status: 400 });
  }
  try {
    return Response.json(await addAnySource(user.id, parsed.data.input, parsed.data.mode));
  } catch (e) {
    const msg = sourceErrorText(e);
    if (msg) return Response.json({ error: msg }, { status: 400 });
    console.error(e);
    return Response.json({ error: "读取失败，请稍后重试" }, { status: 502 });
  }
}
