// voice/evaluate.mjs — status, coverage, contradictions: rules over validated evidence and the
// item's contract. PURE, no model, no transcript in.
//
// INVARIANT 4 (docs/ARCHITECTURE.md, "Voice verification invariants"). Nothing probabilistic runs here. A status is a function of typed evidence
// attributes and the contract the human approved; the same inputs give the same status forever,
// and a reviewer can recompute it by hand from the coverage_inputs shown beside it.
//
// INVARIANTS 6 AND 7. No path through this file produces anything below `insufficient`, and
// `insufficient` and `not_assessed` always carry a reason that is about the session. An evaluator
// failure (a rule throwing, a missing contract) does not produce a status at all: evaluateSession
// returns { blocked: true } and the package is held for review.
//
// A REFUSAL IS not_assessed (declined).
import { STATUSES, COVERAGE_BANDS } from "./statuses.mjs";
import { norm } from "../lib/mandate-parse.mjs";

export const EVALUATOR_VERSION = "2026-09-22.1";

const LIMITATIONS = Object.freeze({
  common: [
    "No external corroboration: nothing outside this conversation was checked.",
    "A fluent account is not proof of the work.",
  ],
  capability: ["A poor line or a non-native speaker can lower specificity for reasons unrelated to skill."],
  intent: ["Sincerity is not observable from a conversation; this reports what was stated and how specific it was."],
  hr_fact: ["A verbatim answer, not a verified fact."],
});

const reliable = (e) => e.reliability === "usable" || e.reliability === "low_confidence";
const solid = (e) => e.reliability === "usable";

// ── contradictions ───────────────────────────────────────────────────────────

const CORRECTION_RE = /\b(actually|sorry|correction|i mean|let me correct|to be precise|no wait|i misspoke)\b/i;
const key = (f) => `${norm(f.subject)}|${norm(f.scope || "")}`;

/**
 * Typed-fact contradictions across a session's reliable evidence and, if given, CV facts. Same
 * subject and scope, different value on one field. A later statement containing a correction
 * marker resolves an earlier one. Free-text disagreement is never a contradiction.
 * @param {Array} evidence   validated evidence items (all items of the session)
 * @param {Array<{subject:string, scope?:string, time?:string|null, ownership?:string, claim?:string, line:string}>} [cvFacts]
 */
export function findContradictions(evidence, cvFacts = []) {
  const out = [];
  const facts = [];
  for (const e of evidence) {
    if (!solid(e)) continue; // an unusable or low-confidence turn cannot found a contradiction
    for (const f of e.typed_facts || []) facts.push({ f, e });
  }
  const seen = new Set();
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i], b = facts[j];
      if (key(a.f) !== key(b.f) || a.e.id === b.e.id) continue;
      for (const field of ["time", "ownership"]) {
        const va = a.f[field], vb = b.f[field];
        if (va == null || vb == null || va === "unclear" || vb === "unclear") continue;
        if (norm(String(va)) === norm(String(vb))) continue;
        const id = `${a.e.id}|${b.e.id}|${field}`;
        if (seen.has(id)) continue; seen.add(id);
        const later = b.e.provenance.audio_start_secs != null && a.e.provenance.audio_start_secs != null && b.e.provenance.audio_start_secs < a.e.provenance.audio_start_secs ? a : b;
        const resolved = CORRECTION_RE.test(later.e.quote);
        out.push({ plan_item_id: a.e.plan_item_id, requirement_id: a.e.requirement_id, field, evidence_a: a.e.id, evidence_b: b.e.id, cv_line: null, resolved, resolution_evidence: resolved ? later.e.id : null });
      }
    }
    for (const cv of cvFacts) {
      const a = facts[i];
      if (key(a.f) !== key(cv)) continue;
      for (const field of ["time", "ownership"]) {
        const va = a.f[field], vb = cv[field];
        if (va == null || vb == null || va === "unclear" || vb === "unclear") continue;
        if (norm(String(va)) === norm(String(vb))) continue;
        out.push({ plan_item_id: a.e.plan_item_id, requirement_id: a.e.requirement_id, field, evidence_a: a.e.id, evidence_b: null, cv_line: cv.line, resolved: false, resolution_evidence: null });
      }
    }
  }
  return out;
}

// ── one item ─────────────────────────────────────────────────────────────────

function coverageFor({ contract, evidence, cursorState, conditions }) {
  const rel = evidence.filter(reliable);
  const covered = new Set(rel.filter((e) => e.specificity >= 1 || e.type === "answer").map((e) => e.contract_element));
  const required = contract.elements.filter((e) => e.required).map((e) => e.name);
  const deepest = rel.reduce((m, e) => Math.max(m, e.probe_depth), 0);
  const inputs = {
    elements_covered: [...covered],
    elements_required: required,
    elements_total: contract.elements.length,
    deepest_probe: deepest,
    scenario_run: Boolean(cursorState?.scenarioAsked),
    reliable_items: rel.length,
    unreliable_items: evidence.length - rel.length,
    resumed: Boolean(conditions?.resumed_in_item),
    audio_band: conditions?.audio_band ?? null,
  };
  let band;
  if (rel.length === 0) band = "no_usable_evidence";
  else if (covered.size <= 1 || inputs.resumed || rel.length < 2) band = covered.size >= 1 && rel.length >= 2 && !inputs.resumed ? "partial_coverage" : "limited_coverage";
  else if (required.every((r) => covered.has(r)) && deepest >= 1 && contract.elements.every((el) => covered.has(el.name) || !el.required)) band = "strong_coverage";
  else band = "partial_coverage";
  if (band === "strong_coverage" && rel.length < 2) band = "partial_coverage"; // never strong on one item
  if (!COVERAGE_BANDS.includes(band)) throw new Error(`coverage band "${band}" is not one of the four`);
  return { band, inputs };
}

/**
 * @param {{item:object, evidence:Array, contradictions:Array, cursorState:object|null, conditions?:object, extractionFailed?:boolean, capHit?:boolean, cvGiven?:boolean}} p
 * @returns {object} a vv_signals row shape (without id/session)
 */
export function evaluateItem({ item, evidence = [], contradictions = [], cursorState = null, conditions = {}, extractionFailed = false, capHit = false, cvGiven = false }) {
  const contract = item.evidence_contract;
  if (!contract?.elements?.length) throw new Error(`item ${item.ref || item.id} has no evidence contract`);
  const category = item.kind === "communication_context" ? "communication" : item.kind;
  const basis = cvGiven ? "conversation_and_cv" : "conversation_only";
  const limitations = [...LIMITATIONS.common, ...(LIMITATIONS[item.kind === "hr_capability" ? "capability" : item.kind] || [])];
  const mine = evidence.filter((e) => e.plan_item_id === item.id);
  const { band, inputs } = coverageFor({ contract, evidence: mine, cursorState, conditions });
  const base = { plan_item_id: item.id, requirement_id: item.requirement_id ?? null, category, basis, coverage_band: band, coverage_inputs: inputs, evaluator_version: EVALUATOR_VERSION, limitations };
  const none = (status, reason) => ({ ...base, status, evidence_ids: [], reason });

  if (!cursorState) return none("not_assessed", "not_reached");
  if (cursorState.status === "declined") return none("not_assessed", "declined");
  if (capHit) return none("insufficient", "cap");
  if (extractionFailed && mine.length === 0) return none("insufficient", "extraction");

  const rel = mine.filter(reliable);
  if (rel.length === 0) {
    const reason = cursorState.status === "insufficient_audio" ? "audio" : cursorState.status === "insufficient_irrelevant" ? "irrelevant" : mine.length ? "audio" : "none";
    return none("insufficient", reason);
  }

  const open = contradictions.filter((c) => c.plan_item_id === item.id && !c.resolved);
  const ids = rel.map((e) => e.id);
  if (open.length) return { ...base, status: "contradicted", evidence_ids: ids, reason: null };

  const core = contract.elements.find((e) => e.core)?.name;
  const required = contract.elements.filter((e) => e.required).map((e) => e.name);
  const has = (el, min = 1) => rel.some((e) => e.contract_element === el && (e.specificity >= min || (e.type === "answer" && min <= 1)));
  const coreSolid = rel.some((e) => e.contract_element === core && solid(e) && (e.specificity >= 2 || e.type === "answer"));
  const everyRequired = required.every((r) => rel.some((e) => e.contract_element === r && solid(e) && (e.specificity >= 1 || e.type === "answer")));
  const ownershipOk = !required.includes("ownership") || rel.some((e) => e.contract_element === "ownership" && e.ownership === "self" && solid(e));
  const probed = rel.some((e) => e.probe_depth >= 1 && solid(e));

  let status;
  if (everyRequired && coreSolid && ownershipOk && probed) status = "strongly_supported";
  else if (has(core, 1)) status = "supported";
  else status = "stated_only";
  if (!STATUSES.includes(status)) throw new Error(`status "${status}" is not one of the six`);
  return { ...base, status, evidence_ids: ids, reason: null };
}

// ── the session ──────────────────────────────────────────────────────────────

/**
 * Evaluate every item. Any thrown rule blocks the whole package (never a partial or negative
 * status); every other outcome is a signal per item plus the contradictions found.
 * @returns {{blocked:false, signals:Array, contradictions:Array} | {blocked:true, error:string}}
 */
export function evaluateSession({ plan, cursor, evidence = [], cvFacts = [], extractionFailures = new Set(), capHitItems = new Set(), conditionsByItem = {} }) {
  try {
    const contradictions = findContradictions(evidence, cvFacts);
    const signals = plan.items.map((item) =>
      evaluateItem({
        item,
        evidence,
        contradictions,
        cursorState: cursor?.items?.[item.id] ?? null,
        conditions: conditionsByItem[item.id] || {},
        extractionFailed: extractionFailures.has(item.id),
        capHit: capHitItems.has(item.id),
        cvGiven: cvFacts.length > 0,
      }));
    for (const s of signals) if (!s.evidence_ids.length && !s.reason) throw new Error(`signal for ${s.plan_item_id} has neither evidence nor a reason`);
    return { blocked: false, signals, contradictions };
  } catch (e) {
    return { blocked: true, error: String(e?.message || e) };
  }
}
