// lib/schemas/vv-report.mjs — the HR evidence package AS DATA (vv_reports.package). Validated at the
// boundary, and there is no score, rank, recommendation, rating, grade, or verdict field;
// voice/report-schema.test.mjs asserts the key set stays that way. The email is rendered from this
// and may not add a field.
import { z } from "zod";
import { STATUSES, COVERAGE_BANDS, INSUFFICIENT_REASONS, NOT_ASSESSED_REASONS } from "../../voice/statuses.mjs";
import { ELEMENTS } from "./vv-plan.mjs";

const Quote = z.object({
  evidence_id: z.uuid(),
  quote: z.string().min(1),
  contract_element: z.enum(ELEMENTS),
  type: z.string(),
  specificity: z.number().int().min(0).max(2),
  ownership: z.string(),
  probe_depth: z.number().int().min(0).max(2),
  reliability: z.string(),
  audio_start_secs: z.number().nullable(),
  audio_end_secs: z.number().nullable(),
  turn_ids: z.array(z.uuid()).min(1),
});

const Signal = z.object({
  plan_item_id: z.uuid(),
  ref: z.string(),
  kind: z.string(),
  establishes: z.string(),
  mandate_quote: z.string(),
  why_it_matters: z.string(),
  status: z.enum(STATUSES),
  status_text: z.string(),
  reason: z.enum([...INSUFFICIENT_REASONS, ...NOT_ASSESSED_REASONS]).nullable(),
  coverage_band: z.enum(COVERAGE_BANDS),
  coverage_text: z.string(),
  coverage_inputs: z.record(z.string(), z.unknown()),
  basis: z.string(),
  evidence: z.array(Quote),
  probes_asked: z.number().int().min(0),
  missing_elements: z.array(z.enum(ELEMENTS)),   // "what would have raised this"
  limitations: z.array(z.string()),
});

export const ReportPackage = z.object({
  header: z.object({
    session_id: z.uuid(),
    kind: z.enum(["candidate", "test"]),
    candidate_name_as_given: z.string().nullable(),
    role: z.string(),
    session_date: z.string(),
    session_status: z.string(),
    items_reached: z.number().int(),
    items_total: z.number().int(),
    duration_seconds: z.number().nullable(),
    plan_version: z.number().int(),
    extractor_version: z.string(),
    evaluator_version: z.string(),
  }),
  identity_consent: z.object({
    identity_basis: z.literal("holder of the invited mailbox"),
    consents: z.array(z.object({ scope: z.string(), granted: z.boolean(), text_version: z.string(), recorded_at: z.string() })),
  }),
  must_have_gate: z.array(z.object({
    ref: z.string(),
    establishes: z.string(),
    mandate_quote: z.string(),
    // "answered" with the verbatim quote, or "unknown". Whether an answer MEETS the bar is a rule
    // per requirement (lib/eligibility.mjs pattern); until one is wired it is null, never a guess.
    verdict: z.enum(["answered", "unknown"]),
    bar: z.enum(["met", "not_met"]).nullable(),
    answer_quote: z.string().nullable(),
  })),
  capability_grid: z.array(Signal),
  intent: Signal.nullable(),
  hr_answers: z.array(z.object({ ref: z.string(), question: z.string(), answer_quote: z.string().nullable(), status: z.enum(STATUSES) })),
  communication: z.object({
    // conditions on assessability are recorded here
    markers: z.array(z.object({ marker: z.string(), quote: z.string() })),
    conditions: z.record(z.string(), z.unknown()),
    note: z.string(),
  }),
  contradictions: z.array(z.object({
    field: z.string(),
    quote_a: z.string(),
    quote_b: z.string().nullable(),
    cv_line: z.string().nullable(),
    resolved: z.boolean(),
    ref: z.string().nullable(),
  })),
  gaps: z.array(z.object({ ref: z.string(), establishes: z.string(), status: z.enum(["insufficient", "not_assessed"]), reason: z.string() })),
  transcript: z.object({ conversations: z.number().int(), turns: z.number().int(), transcript_hash: z.string().nullable(), audio_available: z.boolean() }),
  limitations: z.array(z.string()),
  versions: z.object({ plan: z.number().int(), extractor: z.string(), evaluator: z.string(), controller: z.string().nullable() }),
});

/** Field names that must never appear anywhere in a package, at any depth. */
export const FORBIDDEN_KEYS = ["score", "rank", "ranking", "recommendation", "recommend", "rating", "grade", "verdict_overall", "hire", "fit_score", "percentile", "confidence"];
