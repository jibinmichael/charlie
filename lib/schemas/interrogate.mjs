// lib/schemas/interrogate.mjs — Zod schema for the interrogation question-generation output.
// External boundary: the JSON the interrogate prompt (prompts/interrogate.mjs, Haiku) is expected to
// return each turn — the next 1-3 grounded questions plus a `ready` signal that enough has been
// gathered to start matching. safeParse'd in email-onboard.mjs (`generateQuestions`); on failure the
// caller falls back to the deterministic `nextGap` ask (log + degrade, never crash, never silence).
// This is the SCORING/matching output's sibling for onboarding: a different object, its own boundary.
import { z } from "zod";

export const Interrogate = z
  .object({
    // 1-3 grounded, non-judgmental questions for THIS turn (one batch at a time). A weak/empty batch
    // is rejected by safeParse so the deterministic fallback fires instead of a silent no-question turn.
    questions: z.array(z.string().trim().min(1)).min(1).max(3),
    // true once the model judges enough has been gathered to start matching. Advisory only: the
    // deterministic completion rule in email-onboard.mjs decides (this AND a role floor, or a hard cap).
    ready: z.boolean(),
  })
  .strict(); // the prompt emits exactly these two fields; reject drift so a stray key can't ride in

/** @typedef {import("zod").infer<typeof Interrogate>} InterrogateType */
