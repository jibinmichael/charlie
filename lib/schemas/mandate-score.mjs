// lib/schemas/mandate-score.mjs — the boundary between a model's reply and a client's board.
//
// Every field a candidate is described by passes through here first. `key` is checked against the
// criteria actually given to the model, so an invented twelfth criterion fails validation instead of
// quietly appearing on a real person's row. On failure the caller logs and retries, then records the
// applicant as unscored — never drops them.

import { z } from "zod";

export const LEVELS = ["strong", "some", "weak", "none"];

export function mandateScoreSchema(criteriaKeys) {
  const Key = z.enum(criteriaKeys);
  return z.object({
    criteria: z.array(z.object({
      key: Key,
      level: z.enum(LEVELS),
      evidence: z.string().min(1),
      source: z.enum(["application", "cv", "both", "none"]),
      confidence: z.enum(["high", "medium", "low"]),
    })).min(1),
    discrepancies: z.array(z.object({
      topic: z.string().min(1),
      application_says: z.string(),
      cv_says: z.string(),
    })).default([]),
    strongest_evidence: z.string().min(1),
    evidence_gaps: z.string().min(1),
    why: z.string().min(1),
  }).superRefine((v, ctx) => {
    // A missing criterion is not a smaller answer, it is an unscored dimension that the rollup would
    // silently count as zero. Reject it so the retry happens here rather than on somebody's board.
    const got = new Set(v.criteria.map((c) => c.key));
    for (const k of criteriaKeys) {
      if (!got.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `missing criterion: ${k}` });
    }
  });
}
