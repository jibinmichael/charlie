// lib/schemas/experience-years.mjs — the model's read of how many PROFESSIONAL years a resume shows.
// Model-output boundary: prompts/experience-years.mjs produces this, safeParse guards it before any
// number reaches the dossier or the knockout gate (log + skip, never trust unvalidated).
//
// professional_years is NULLABLE on purpose, and null is the SAFE value: it means "we do not know",
// which leaves the experience knockout inert for that person. Exactly like RoleReqs.min_years, an
// unknown must never manufacture a block: a confident wrong number would quietly delete part of
// someone's shortlist.
//
// evidence is REQUIRED and non-empty: a years figure is a claim about a person, so it obeys the same
// rule as every other one: it traces to their own words or it does not ship. A number that
// cannot quote its source is rejected here rather than stored.
import { z } from "zod";

export const ExperienceYears = z
  .object({
    // Elapsed professional years. 0 is meaningful (a genuine entry-stage seeker); null = unknown.
    // Capped at 60 so a mis-parsed date can never produce an absurd figure that skews a comparison.
    professional_years: z.number().min(0).max(60).nullable(),
    // "YYYY-MM" of the first professional role, or null. Loose on shape; it is provenance, not a gate.
    career_start: z.string().nullable(),
    // The quoted resume line(s) the count came from. Non-empty: no evidence, no number.
    evidence: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof ExperienceYears>} ExperienceYearsType */
