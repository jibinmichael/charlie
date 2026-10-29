// lib/schemas/enrichment.mjs — the model boundary for talent-pool enrichment.
import { z } from "zod";

// NULL IS THE HONEST ANSWER AND IT MUST NOT COST SOMEBODY THEIR ROW.
//
// `.default("")` fires when a key is ABSENT, never when it is explicitly null. A resume listing an
// employer with no stated title makes the model return `title: null`, which is the grounded answer;
// rejecting it would discard the WHOLE PERSON rather than the one unknown field.
//
// A null here coerces to "", so an unknown title reads as unknown downstream instead of being
// invented and instead of erasing everything else we know about them.
const orBlank = z.string().nullable().default("").transform((v) => v ?? "");

export const EnrichedRole = z.object({
  company: orBlank,
  title: orBlank,
  start: z.string().nullable().default(null),
  end: z.string().nullable().default(null),
}).passthrough();

export const CandidateEnrichment = z.object({
  current_title: z.string().nullable().default(null),
  current_company: z.string().nullable().default(null),
  previous_title: z.string().nullable().default(null),
  previous_company: z.string().nullable().default(null),
  roles: z.array(EnrichedRole).default([]),
  total_years_stated: z.number().nullable().default(null),
  skills: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  comp_current_stated: z.string().nullable().default(null),
  comp_expected_stated: z.string().nullable().default(null),
  linkedin_url: z.string().nullable().default(null),
  portfolio_url: z.string().nullable().default(null),
  location_stated: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  notes: z.string().default(""),
}).passthrough();
