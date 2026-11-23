import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError, UsageLimitError } from "@/lib/billing";
import { RenderError, THEMES } from "@/lib/image-render";
import { attachToDraft, ImageError, isImageAiConfigured, listImages, makeAi, makeCard, saveUpload } from "@/lib/images";
import { GenerationError } from "@/lib/llm";

const Ref = z.object({ mime: z.string().max(40), base64: z.string().max(8_000_000) });
const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["card", "cover", "ai", "ai_pro"]),
    text: z.string().max(30_000).default(""),
    draftId: z.string().uuid().nullish(),
    ref: Ref.nullish(),
    aspect: z.enum(["16:9", "5:2"]).optional(),
    theme: z.enum(THEMES).optional(),
  }),
  z.object({ action: z.literal("upload"), draftId: z.string().uuid().nullish(), ref: Ref }),
  z.object({ action: z.literal("attach"), draftId: z.string().uuid(), imageId: z.string().uuid().nullable() }),
]);

export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const draftId = new URL(request.url).searchParams.get("draftId");
  const items = await listImages(user.id, draftId && /^[0-9a-f-]{36}$/i.test(draftId) ? draftId : null);
  return Response.json({ items, aiReady: isImageAiConfigured() });
}

/** 做一张配图：信息卡 / 封面 / AI 画图 / 用自己的图；或者给草稿选定配图 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const b = parsed.data;
  try {
    if (b.action === "attach") {
      await attachToDraft(user.id, b.draftId, b.imageId);
      return Response.json({ ok: true });
    }
    if (b.action === "upload") return Response.json({ image: await saveUpload(user.id, { ref: b.ref, draftId: b.draftId }) });
    if (b.action === "card" || b.action === "cover") {
      const image = await makeCard(user.id, { ...b, layout: b.action });
      return Response.json({ image });
    }
    const r = await makeAi(user.id, { ...b, pro: b.action === "ai_pro" });
    return Response.json(r);
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof UsageLimitError) return Response.json({ error: e.message }, { status: 429 });
    if (e instanceof ImageError || e instanceof RenderError || e instanceof GenerationError) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return Response.json({ error: "配图失败了，请再试一次" }, { status: 500 });
  }
}
