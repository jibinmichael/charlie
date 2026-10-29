// lib/schemas/vv-evidence.mjs — the shape of the extractor's output and of a validated evidence item.
// The model's reply is safeParse'd in voice/extract.mjs; voice/evidence-validate.mjs then turns it
// into EvidenceItem rows, adding what only code may add (provenance, reliability, probe depth).
//
// THE MODEL ASSIGNS ATTRIBUTES TO A QUOTE. It does not assign a status, a band, or a verdict, and
// there is no field for one. The quote must be verbatim from a candidate turn or the validator
// drops it, so the worst an extractor can do is misattribute a real quote, which the human review
// (vv_reviews) is built to catch.
import { z } from "zod";
import { ELEMENTS } from "./vv-plan.mjs";

export const EVIDENCE_TYPES = ["claim", "account", "mechanism", "ownership", "tradeoff", "number", "scenario_reasoning", "answer", "refusal", "meta"];
export const OWNERSHIP = ["self", "shared", "team", "unclear"];
export const RELIABILITY = ["usable", "low_confidence", "unusable"];
export const FACT_SOURCES = ["candidate_turn", "cv"];

/** One typed fact, for contradiction checks only. Structured so an ownership change is precise. */
export const TypedFact = z.object({
  claim: z.string().trim().min(2).max(200),
  subject: z.string().trim().min(2).max(120),      // what the fact is about: an employer, a list, a deal
  scope: z.string().trim().max(120).default(""),   // the part or period it applies to
  time: z.string().trim().max(60).nullable().default(null),   // a date, year, or duration, as stated
  ownership: z.enum(OWNERSHIP).default("unclear"),
  source: z.enum(FACT_SOURCES).default("candidate_turn"),
});

/** What the model returns for one plan item. No ids, no provenance, no reliability: code adds those. */
export const ExtractedItem = z.object({
  contract_element: z.enum(ELEMENTS),
  type: z.enum(EVIDENCE_TYPES),
  quote: z.string().trim().min(3).max(1200),
  turn_seqs: z.array(z.number().int().min(0)).min(1).max(4),
  specificity: z.number().int().min(0).max(2),
  ownership: z.enum(OWNERSHIP),
  typed_facts: z.array(TypedFact).max(6).default([]),
});

export const ExtractOutput = z.object({
  items: z.array(ExtractedItem).max(24),
});

/** A validated, storable evidence item (vv_evidence). */
export const EvidenceItem = ExtractedItem.omit({ turn_seqs: true }).extend({
  id: z.uuid(),
  session_id: z.uuid(),
  plan_item_id: z.uuid(),
  requirement_id: z.uuid().nullable(),
  provenance: z.object({
    conversation_id: z.uuid(),
    turn_ids: z.array(z.uuid()).min(1),
    audio_start_secs: z.number().nullable(),
    audio_end_secs: z.number().nullable(),
  }),
  reliability: z.enum(RELIABILITY),
  probe_depth: z.number().int().min(0).max(2),
  extractor_version: z.string().min(1),
});
