import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { RenderError, THEMES } from "@/lib/image-render";
import { getImage, ImageError, restyle } from "@/lib/images";

type Ctx = { params: Promise<{ id: string }> };

/** 看图 / 下载原图（只有自己能看） */
export async function GET(request: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  try {
    const img = await getImage(user.id, id);
    const download = new URL(request.url).searchParams.has("download");
    const ext = img.mime === "image/jpeg" ? "jpg" : "png";
    return new Response(new Uint8Array(img.data), {
      headers: {
        "content-type": img.mime,
        "cache-control": "private, no-store",
        ...(download ? { "content-disposition": `attachment; filename="voicedraft-${id.slice(0, 8)}.${ext}"` } : {}),
      },
    });
  } catch (e) {
    if (e instanceof ImageError) return new Response("not found", { status: 404 });
    throw e;
  }
}

const Patch = z.object({
  theme: z.enum(THEMES).optional(),
  showTitle: z.boolean().optional(),
  title: z.string().max(60).optional(),
  points: z.array(z.string().max(60)).max(4).optional(),
  aspect: z.enum(["16:9", "5:2"]).optional(),
});

/** 换风格、改标题字、去掉标题：只重新排版，不收费 */
export async function PATCH(request: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    return Response.json({ image: await restyle(user.id, id, parsed.data) });
  } catch (e) {
    if (e instanceof ImageError || e instanceof RenderError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
