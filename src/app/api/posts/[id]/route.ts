import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { InsufficientBalanceError } from "@/lib/billing";
import { deleteFromX, MAX_THREAD, PublishError, retryJob, updateScheduled } from "@/lib/publish";
import { XApiError } from "@/lib/x";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("delete_x") }),
  z.object({
    action: z.literal("edit"),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    tweets: z.array(z.string().max(2000)).min(1).max(MAX_THREAD).optional(),
  }),
]);

export async function POST(request: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  const b = parsed.data;
  try {
    const item =
      b.action === "retry"
        ? await retryJob(user.id, id)
        : b.action === "cancel"
          ? await updateScheduled(user.id, id, { cancel: true })
          : b.action === "delete_x"
            ? await deleteFromX(user.id, id)
            : await updateScheduled(user.id, id, {
                scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined,
                tweets: b.tweets,
              });
    return Response.json({ item });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof PublishError || e instanceof XApiError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
