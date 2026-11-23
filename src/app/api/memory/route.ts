import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { cleanMemory, EMPTY_MEMORY, MEMORY_REFRESH_EVERY } from "@/lib/memory-core";
import { getMemoryRow, ownPostCount, recentOwn, saveMemory } from "@/lib/memory";

async function view(userId: string) {
  const [row, total, recent] = await Promise.all([getMemoryRow(userId), ownPostCount(userId), recentOwn(userId)]);
  return {
    memory: row ? cleanMemory(row.memory) : EMPTY_MEMORY,
    enabled: row?.enabled ?? true,
    edited: row?.source === "edited",
    builtAt: row?.builtAt && row.builtAt.getTime() > 0 ? row.builtAt : null,
    error: row?.error ?? null,
    posts: total,
    // 再多几条本人推文会自动重新整理
    nextIn: row?.builtAt ? Math.max(0, row.postsAtBuild + MEMORY_REFRESH_EVERY - total) : 0,
    recent,
  };
}

/** 账号记忆：当前内容、最近发过的几条 */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json(await view(user.id));
}

const List = z.array(z.string().max(200)).max(20);
const Body = z.object({
  memory: z
    .object({
      persona: z.string().max(400),
      topics: List,
      positions: List,
      opposes: List,
      phrasing: List,
      avoid: List,
    })
    .optional(),
  enabled: z.boolean().optional(),
});

/** 手动改记忆，或开关 */
export async function PUT(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  await saveMemory(user.id, parsed.data);
  return Response.json(await view(user.id));
}
