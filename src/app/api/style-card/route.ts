import { z } from "zod";
import { requireUser } from "@/lib/auth";
import {
  cardHistory,
  editsSinceLastLearning,
  getActiveCard,
  LEARN_MIN,
  LEARN_THRESHOLD,
  majorityLang,
  pendingLearning,
  saveCardVersion,
  usableSamples,
} from "@/lib/data";
import { computeMetrics } from "@/lib/metrics";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const card = await getActiveCard(user.id);
  const lang = card?.lang ?? (await majorityLang(user.id));
  const [samples, history, newEdits, pending] = await Promise.all([
    usableSamples(user.id, lang),
    cardHistory(user.id),
    editsSinceLastLearning(user.id),
    pendingLearning(user.id),
  ]);
  return Response.json({
    card: card ? { id: card.id, version: card.version, lang: card.lang, traits: card.traits, source: card.source } : null,
    lang,
    metrics: computeMetrics(samples.map((s) => s.content)),
    learning: {
      newEdits: newEdits.length,
      threshold: LEARN_THRESHOLD,
      min: LEARN_MIN,
      pending: pending
        ? { id: pending.id, baseVersion: pending.baseVersion, editCount: pending.editCount, ...pending.suggestion }
        : null,
    },
    history: history.map((h) => ({
      id: h.id,
      version: h.version,
      lang: h.lang,
      source: h.source,
      isActive: h.isActive,
      createdAt: h.createdAt,
    })),
  });
}

const Traits = z.object({
  catchphrases: z.array(z.string().max(50)).max(30),
  bannedWords: z.array(z.string().max(50)).max(50),
  openings: z.string().max(300),
  stance: z.string().max(300),
  humor: z.string().max(300),
  topics: z.array(z.string().max(50)).max(20),
  notes: z.string().max(1000),
});

/** 用户手动编辑：保存为新版本 */
export async function PATCH(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Traits.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "风格卡格式不对" }, { status: 400 });
  const current = await getActiveCard(user.id);
  if (!current) return Response.json({ error: "还没有风格卡，请先生成" }, { status: 404 });
  const row = await saveCardVersion(user.id, current.lang, parsed.data, "edited");
  return Response.json({ version: row.version });
}
