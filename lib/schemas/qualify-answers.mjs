// lib/schemas/qualify-answers.mjs — the answer filer's output (prompts/hire-mandate-answers.mjs), used by Qualify & Submit to file
// a person's reply against the questions it asked. safeParse'd before anything reads it.
import { z } from "zod";

/** One entry per question, the verbatim answer or null. */
export const MandateAnswersOutput = z.object({
  answers: z.array(z.object({ n: z.number().int().min(1).max(30), answer: z.string().max(4000).nullable() }).strict()).max(30),
}).strict();
