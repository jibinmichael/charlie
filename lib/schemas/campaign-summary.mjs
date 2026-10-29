// lib/schemas/campaign-summary.mjs — Zod boundary for the join@ answer summary (owner decision support).
// External boundary: the JSON prompts/campaign-score.mjs (Sonnet) returns — a factual, per-dimension
// summary of what the candidate said, for the HUMAN owner to judge. safeParse'd in the campaign loop;
// on failure the owner still gets the raw transcript (never a fabricated summary).
//
// THE POINT: there is deliberately NO recommendation / verdict / score / rank field. "The verdict is
// 100% human" is enforced here as much as in the prompt — even if the model tried to smuggle out
// "advance: true", .strict() rejects it, so no machine judgement can reach the owner's inbox dressed as
// the answer. The owner reads the facts and decides; Charlie only executes that decision.
import { z } from "zod";

const Dimension = z
  .object({
    name: z.string().trim().min(1),      // the evaluation dimension (GTM thinking, curiosity, ...)
    evidence: z.string().trim().min(1),  // plain facts from the transcript, or "not tested"
  })
  .strict();

export const CampaignSummary = z
  .object({
    dimensions: z.array(Dimension).min(1).max(8),
    standout_quote: z.string().trim().min(1), // the candidate's own words, good or bad
  })
  .strict(); // no verdict/score/recommendation field exists; drift is rejected

/** @typedef {import("zod").infer<typeof CampaignSummary>} CampaignSummaryType */
