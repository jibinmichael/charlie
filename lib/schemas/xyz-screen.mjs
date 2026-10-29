// lib/schemas/xyz-screen.mjs — the model boundary for the applicant screen.
//
// A screen decides whether a real person is put in front of a client, so an unreadable or
// half-shaped reply is not something to work around: the applicant drops to manual review and a human
// looks at them. Never a default score, never a silent skip.

import { z } from "zod";

export const XyzScore = z.object({
  requirement: z.string(),
  score: z.number().int().min(0).max(3),
  // "" is valid and meaningful: it is what a 0 must carry. A non-empty quote is checked verbatim
  // against the applicant's own answers by the caller, because a quote is the only thing standing
  // between a score and an invention.
  quote: z.string().default(""),
  why: z.string().default(""),
}).passthrough();

export const XyzScreen = z.object({
  scores: z.array(XyzScore).min(1),
  years_total: z.number().nullable().default(null),
  years_evidence: z.string().default(""),
  prior_employer_match: z.boolean().default(false),
  standout: z.string().default(""),
  gap: z.string().default(""),
  flags: z.array(z.string()).default([]),
}).passthrough();
