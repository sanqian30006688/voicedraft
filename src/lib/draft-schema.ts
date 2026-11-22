import { z } from "zod";

// 长文的段落可能较长，上限放宽到 3000 字、60 段
export const SentenceSchema = z.object({
  text: z.string().max(3000),
  original: z.string().max(3000),
  locked: z.boolean(),
});

export const MetaSchema = z.object({
  title: z.string().max(300).optional(),
  notes: z.string().max(4000).optional(),
  length: z.enum(["short", "medium", "long"]).optional(),
  outline: z.array(z.string().max(500)).max(20).optional(),
  numbered: z.boolean().optional(),
});
