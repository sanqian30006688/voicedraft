import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { CAP_CHOICES, MIN_SOURCE_CHOICES, getHotSettings, saveHotSettings } from "@/lib/hot-topics";

/** 热点提醒设置（推到 TG） */
export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json({ settings: await getHotSettings(user.id), minSourceChoices: MIN_SOURCE_CHOICES, capChoices: CAP_CHOICES });
}

const Body = z.object({
  enabled: z.boolean().optional(),
  minSources: z.number().int().optional(),
  dailyCap: z.number().int().optional(),
});

export async function PUT(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数不对" }, { status: 400 });
  return Response.json({ settings: await saveHotSettings(user.id, parsed.data) });
}
