// voice/render-package.mjs — the HR evidence package as DATA, built from rows, validated against
// lib/schemas/vv-report.mjs. The email is rendered from this through email-kit.mjs and may not add a
// field.
//
// NO FREE PROSE ABOUT THE PERSON. Every sentence in the package is either a verbatim quote from the
// candidate, a fixed status or coverage sentence from voice/statuses.mjs, or a fixed limitation
// line. The one-line "why" and "establishes" come from the approved plan, not from a model reading
// the transcript.
import { ReportPackage, FORBIDDEN_KEYS } from "../lib/schemas/vv-report.mjs";
import { STATUS_LANGUAGE, COVERAGE_LANGUAGE } from "./statuses.mjs";

export const FIXED_LIMITATIONS = Object.freeze([
  "No external corroboration: nothing outside this conversation was checked.",
  "Identity is the holder of the invited mailbox; no identity check was performed.",
  "This is not an assessment of personality, fluency, confidence, or emotion, and accent is not a marker.",
  "This is not a recommendation. It reports what was said and what the evidence supports.",
]);

/** Words that may not appear in any system-authored string of a package (quotes are the candidate's). */
export const ASSESSMENT_WORDS_RE = /\b(strong candidate|weak candidate|impressive|excellent|talented|solid|promising|verified|demonstrated|proved|proven|lacks|failed|inconsistent|dishonest|hire|reject)\b/i;

function forbiddenKeysIn(obj, path = "") {
  const out = [];
  if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...forbiddenKeysIn(v, `${path}[${i}]`)));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) out.push(`${path}.${k}`);
      out.push(...forbiddenKeysIn(v, `${path}.${k}`));
    }
  }
  return out;
}

/**
 * @param {{session:object, plan:object, mandate:object, candidate?:object|null, signals:Array, evidence:Array, contradictions:Array, turns:Array, conversations:Array, consents:Array, cursor:object, extractorVersion:string, controllerVersion?:string|null}} p
 * @returns {object} a validated ReportPackage
 */
export function buildPackage({ session, plan, mandate, candidate = null, signals, evidence, contradictions = [], turns = [], conversations = [], consents = [], cursor, extractorVersion, controllerVersion = null }) {
  const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
  const evById = Object.fromEntries(evidence.map((e) => [e.id, e]));
  const evaluatorVersion = signals[0]?.evaluator_version || "none";

  const toQuote = (e) => ({
    evidence_id: e.id, quote: e.quote, contract_element: e.contract_element, type: e.type, specificity: e.specificity, ownership: e.ownership,
    probe_depth: e.probe_depth, reliability: e.reliability, audio_start_secs: e.provenance.audio_start_secs, audio_end_secs: e.provenance.audio_end_secs, turn_ids: e.provenance.turn_ids,
  });

  const toSignal = (s) => {
    const item = byId[s.plan_item_id];
    const c = item.evidence_contract;
    const covered = new Set(s.coverage_inputs.elements_covered || []);
    return {
      plan_item_id: s.plan_item_id, ref: item.ref, kind: item.kind, establishes: c.establishes, mandate_quote: c.mandate_quote, why_it_matters: c.why_it_matters,
      status: s.status, status_text: STATUS_LANGUAGE[s.status], reason: s.reason ?? null,
      coverage_band: s.coverage_band, coverage_text: COVERAGE_LANGUAGE[s.coverage_band], coverage_inputs: s.coverage_inputs, basis: s.basis,
      evidence: s.evidence_ids.map((id) => evById[id]).filter(Boolean).map(toQuote),
      probes_asked: cursor?.items?.[item.id]?.probesAsked ?? 0,
      missing_elements: c.elements.filter((e) => e.required && !covered.has(e.name)).map((e) => e.name),
      limitations: s.limitations,
    };
  };

  const itemSignals = signals.filter((s) => s.plan_item_id).map(toSignal);
  const firstQuote = (sig) => sig.evidence[0]?.quote ?? null;

  const pkg = {
    header: {
      session_id: session.id, kind: session.kind, candidate_name_as_given: candidate?.name_as_given ?? null, role: mandate.role,
      session_date: session.started_at || session.created_at, session_status: session.state,
      items_reached: Object.keys(cursor?.items || {}).length, items_total: plan.items.length,
      duration_seconds: session.started_at && session.completed_at ? Math.round((new Date(session.completed_at) - new Date(session.started_at)) / 1000) : null,
      plan_version: plan.version, extractor_version: extractorVersion, evaluator_version: evaluatorVersion,
    },
    identity_consent: {
      identity_basis: "holder of the invited mailbox",
      consents: consents.map((c) => ({ scope: c.scope, granted: c.granted, text_version: c.text_version, recorded_at: c.recorded_at })),
    },
    must_have_gate: itemSignals.filter((s) => s.kind === "hard_requirement" || s.kind === "hr_fact").map((s) => ({
      ref: s.ref, establishes: s.establishes, mandate_quote: s.mandate_quote,
      verdict: s.evidence.length ? "answered" : "unknown", bar: null, answer_quote: firstQuote(s),
    })),
    capability_grid: itemSignals.filter((s) => s.kind === "capability" || s.kind === "hr_capability" || s.kind === "hard_requirement"),
    intent: itemSignals.find((s) => s.kind === "intent") ?? null,
    hr_answers: itemSignals.filter((s) => s.kind === "hr_fact" || s.kind === "hr_capability").map((s) => ({ ref: s.ref, question: s.mandate_quote, answer_quote: firstQuote(s), status: s.status })),
    communication: {
      markers: [],
      conditions: {
        usable_turns: turns.filter((t) => t.speaker === "candidate" && t.usable !== false).length,
        unusable_turns: turns.filter((t) => t.speaker === "candidate" && t.usable === false).length,
        fallback_rate: session.conditions?.fallback_rate ?? null,
        judge_unavailable_rate: session.conditions?.judge_unavailable_rate ?? null,
        conversations: conversations.length,
        meta_questions: cursor?.metaCount ?? 0,
      },
      note: "Task-communication markers are not yet extracted; the conditions on assessability are recorded.",
    },
    contradictions: contradictions.map((c) => ({
      field: c.field, quote_a: evById[c.evidence_a]?.quote ?? "", quote_b: c.evidence_b ? (evById[c.evidence_b]?.quote ?? null) : null,
      cv_line: c.cv_line ?? null, resolved: Boolean(c.resolved), ref: c.plan_item_id ? (byId[c.plan_item_id]?.ref ?? null) : null,
    })),
    gaps: itemSignals.filter((s) => s.status === "insufficient" || s.status === "not_assessed").map((s) => ({ ref: s.ref, establishes: s.establishes, status: s.status, reason: s.reason || "none" })),
    transcript: {
      conversations: conversations.length, turns: turns.length,
      transcript_hash: conversations.find((c) => c.transcript_hash)?.transcript_hash ?? null,
      audio_available: conversations.some((c) => c.audio_ref),
    },
    limitations: [...FIXED_LIMITATIONS],
    versions: { plan: plan.version, extractor: extractorVersion, evaluator: evaluatorVersion, controller: controllerVersion },
  };

  const forbidden = forbiddenKeysIn(pkg);
  if (forbidden.length) throw new Error(`package carries a forbidden key: ${forbidden.join(", ")}`);
  const ok = ReportPackage.safeParse(pkg);
  if (!ok.success) throw new Error(`package does not match the schema: ${ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return ok.data;
}

/** Every system-authored string in a package (never the candidate's quotes). For the lint test. */
export function systemStrings(pkg) {
  const out = [...pkg.limitations, pkg.communication.note, pkg.identity_consent.identity_basis];
  for (const s of [...pkg.capability_grid, ...(pkg.intent ? [pkg.intent] : [])]) out.push(s.status_text, s.coverage_text, ...s.limitations);
  return out;
}

/** Every signal's chain resolves: evidence ids present with turn ids, or an explicit reason. */
export function chainResolves(pkg) {
  const failures = [];
  for (const s of [...pkg.capability_grid, ...(pkg.intent ? [pkg.intent] : [])]) {
    if (!s.evidence.length && !s.reason) failures.push(`${s.ref}: no evidence and no reason`);
    for (const q of s.evidence) if (!q.turn_ids.length) failures.push(`${s.ref}: evidence ${q.evidence_id} has no turn ids`);
  }
  return { ok: failures.length === 0, failures };
}
