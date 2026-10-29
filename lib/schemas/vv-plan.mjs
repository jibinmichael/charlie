// lib/schemas/vv-plan.mjs — the shape of a verification plan and of the plan generator's output,
// validated where the model's output enters the system (voice/plan.mjs generatePlan).
//
// THE EVIDENCE CONTRACT IS REQUIREMENT-SPECIFIC. It names which evidence elements would establish
// THIS requirement, which of them are required, and which one is the core. A factual requirement
// contracts for context, dates and a specific experience; a capability contracts for an instance,
// mechanism, ownership and (where the domain has them) a tradeoff or a scenario. The vocabulary of
// elements is fixed (so the extractor and the evaluator can name them); the selection is per item.
//
// mandate_quote IS NEVER WRITTEN BY THE MODEL. voice/plan.mjs fills it from the requirement matrix
// (already quote-checked against the JD by lib/mandate-parse.mjs verifyQuotes) or from the HR
// question verbatim. The generator's output schema (PlanGenItem) omits it on purpose.
//
// fallback_text HAS EVERY MOVE: every candidate-facing failure has a
// scripted line. A plan item without all four cannot exist, so the live path can never be silent.
import { z } from "zod";

/** Kinds of plan item. `communication_context` is observed across items, never asked. */
export const ITEM_KINDS = ["capability", "hard_requirement", "hr_fact", "hr_capability", "intent", "communication_context"];

/** The fixed vocabulary of evidence elements. A contract picks from these; it does not invent. */
export const ELEMENTS = [
  // capability
  "instance", "mechanism", "ownership", "tradeoff", "scenario_reasoning",
  // factual / hard requirement
  "context", "dates", "specific_experience",
  // intent
  "motivation", "role_understanding", "constraints", "availability",
  // an HR question answered in the candidate's own words
  "answer",
];

/** The moves a plan item must carry scripted text for. */
export const FALLBACK_MOVES = ["anchor", "probe", "move_on", "clarify"];

export const PLAN_STATUSES = ["draft", "awaiting_approval", "approved", "rejected", "superseded"];

/** Where an item came from: a matrix bucket and index, an HR question index, or the one intent item. */
export const REF_RE = /^(hard|preferred|capabilities|question|intent):\d+$/;

const Line = (max = 400) => z.string().trim().min(8).max(max);

const Element = z.object({
  name: z.enum(ELEMENTS),
  required: z.boolean(),
  core: z.boolean().default(false),
});

const Probe = z.object({
  text: Line(),
  targets: z.enum(ELEMENTS),
});

const FallbackText = z.object({
  anchor: Line(),
  probe: Line(),
  move_on: Line(),
  clarify: Line(),
});

export const EvidenceContract = z.object({
  establishes: z.string().trim().min(3).max(300),
  // Verbatim source: the JD quote for a requirement, the HR question for an HR item, the role for intent.
  mandate_quote: z.string().trim().min(3).max(600),
  why_it_matters: z.string().trim().min(3).max(400),
  elements: z.array(Element).min(1).max(8),
  anchor_question: Line(),
  depth_probes: z.array(Probe).min(1).max(3),
  ownership_probe: Line().nullable(),
  scenario: Line(600).nullable(),
  contradiction_hooks: z.array(z.string().trim().min(3).max(200)).max(8),
  expected_evidence: Line(),
  fallback_text: FallbackText,
});

const Flag = z.object({
  ref: z.string().regex(REF_RE),
  reason: z.string().trim().min(3).max(300),
});

export const PlanItem = z.object({
  id: z.uuid(),
  requirement_id: z.uuid().nullable(),
  ref: z.string().regex(REF_RE),
  kind: z.enum(ITEM_KINDS),
  priority: z.number().int().min(1),
  budget_seconds: z.number().int().min(30).max(1800),
  evidence_contract: EvidenceContract,
});

export const VerificationPlan = z.object({
  id: z.uuid(),
  mandate_id: z.uuid().nullable(),
  version: z.number().int().min(1),
  status: z.enum(PLAN_STATUSES),
  session_budget_seconds: z.number().int().min(60).max(7200),
  // Set at approval from voice/consent.mjs (migration 2); null on a draft.
  consent_text_version: z.string().min(1).nullable(),
  flagged: z.array(Flag).max(20),
  override_reason: z.string().trim().min(3).max(300).nullable(),
  approved_by: z.string().email().nullable(),
  approved_at: z.string().nullable(),
  items: z.array(PlanItem).min(1).max(30),
});

/** What the model returns. No ids, no mandate_quote: code assigns both. */
export const PlanGenItem = z.object({
  ref: z.string().regex(REF_RE),
  kind: z.enum(ITEM_KINDS),
  priority: z.number().int().min(1),
  budget_seconds: z.number().int().min(30).max(1800),
  contract: EvidenceContract.omit({ mandate_quote: true }),
});

export const PlanGenOutput = z.object({
  items: z.array(PlanGenItem).min(1).max(30),
  flagged: z.array(Flag).max(20),
});
