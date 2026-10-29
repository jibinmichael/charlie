// voice/evaluate.test.mjs — the status rules against each item's contract, contradictions on typed
// facts, coverage, and the failure rules for extraction and evaluator failure (docs/ARCHITECTURE.md,
// "Voice verification invariants").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateItem, evaluateSession, findContradictions, EVALUATOR_VERSION } from "./evaluate.mjs";
import { validateEvidence } from "./evidence-validate.mjs";
import { STATUSES } from "./statuses.mjs";
import { VerificationPlan } from "../lib/schemas/vv-plan.mjs";

const plan = VerificationPlan.parse(JSON.parse(readFileSync("evals/vv/test-plan.json", "utf8")));
const byRef = Object.fromEntries(plan.items.map((i) => [i.ref, i]));
const SESSION = "5a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function load(name) {
  const fx = JSON.parse(readFileSync(`evals/vv/evidence/${name}.json`, "utf8"));
  const turns = fx.turns.map((t) => ({ ...t, conversation_id: fx.conversation_id }));
  const evidence = [];
  for (const [itemId, raw] of Object.entries(fx.extractor_output)) {
    const item = plan.items.find((i) => i.id === itemId);
    const { items, dropped } = validateEvidence(raw, { item, sessionId: SESSION, turns: turns.filter((t) => t.plan_item_id === itemId), extractorVersion: "test.1" });
    expect({ persona: name, item: item.ref, dropped }).toEqual({ persona: name, item: item.ref, dropped: [] });
    evidence.push(...items);
  }
  return { fx, turns, evidence };
}
const reached = (status = "sufficient", extra = {}) => ({ status, probesAsked: 1, scenarioAsked: false, ...extra });

describe("golden evidence fixtures", () => {
  for (const name of ["strong_specific", "weak_generic"]) {
    it(`${name}: reproduces the expected statuses`, () => {
      const { fx, evidence } = load(name);
      for (const [ref, expected] of Object.entries(fx.expect)) {
        const s = evaluateItem({ item: byRef[ref], evidence, contradictions: [], cursorState: reached() });
        expect({ ref, status: s.status }).toEqual({ ref, status: expected });
        expect(STATUSES).toContain(s.status);
        expect(s.evaluator_version).toBe(EVALUATOR_VERSION);
      }
    });
  }
});

describe("the rules", () => {
  const strong = () => load("strong_specific").evidence;
  const cap = byRef["capabilities:0"];

  it("strongly_supported is impossible without a probe-produced item", () => {
    const ev = strong().map((e) => ({ ...e, probe_depth: 0 }));
    const s = evaluateItem({ item: cap, evidence: ev, contradictions: [], cursorState: reached() });
    expect(s.status).toBe("supported");
  });

  it("strongly_supported needs every required element, ownership self where required, and the core at specificity 2", () => {
    const ev = strong();
    const noOwn = ev.filter((e) => e.contract_element !== "ownership");
    expect(evaluateItem({ item: cap, evidence: noOwn, contradictions: [], cursorState: reached() }).status).toBe("supported");
    const teamOwn = ev.map((e) => (e.contract_element === "ownership" ? { ...e, ownership: "team" } : e));
    expect(evaluateItem({ item: cap, evidence: teamOwn, contradictions: [], cursorState: reached() }).status).toBe("supported");
    const thinCore = ev.map((e) => (e.contract_element === "instance" ? { ...e, specificity: 1 } : e));
    expect(evaluateItem({ item: cap, evidence: thinCore, contradictions: [], cursorState: reached() }).status).toBe("supported");
  });

  it("unreliable evidence never founds a status: all-unusable is insufficient (audio), never a low reading", () => {
    const ev = strong().map((e) => ({ ...e, reliability: "unusable" }));
    const s = evaluateItem({ item: cap, evidence: ev, contradictions: [], cursorState: reached() });
    expect(s).toMatchObject({ status: "insufficient", reason: "audio", evidence_ids: [] });
    expect(s.coverage_band).toBe("no_usable_evidence");
  });

  it("low_confidence evidence can support but not strongly support", () => {
    const ev = strong().map((e) => ({ ...e, reliability: "low_confidence" }));
    expect(evaluateItem({ item: cap, evidence: ev, contradictions: [], cursorState: reached() }).status).toBe("supported");
  });

  it("a contradiction is impossible when either turn is not usable; a self-correction resolves", () => {
    const ev = strong();
    const a = ev.find((e) => e.contract_element === "dates" && e.quote.startsWith("I've been"));
    const b = { ...ev.find((e) => e.contract_element === "dates" && e.quote.startsWith("March")), typed_facts: [{ claim: "at Acme since 2021", subject: "Acme", scope: "current role", time: "2021", ownership: "self", source: "candidate_turn" }] };
    const withConflict = ev.map((e) => (e.id === b.id ? b : e));
    const found = findContradictions(withConflict);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: "time", resolved: false, evidence_a: a.id, evidence_b: b.id });
    expect(evaluateItem({ item: byRef["hard:0"], evidence: withConflict, contradictions: found, cursorState: reached() }).status).toBe("contradicted");
    const unusable = withConflict.map((e) => (e.id === b.id ? { ...e, reliability: "unusable" } : e));
    expect(findContradictions(unusable)).toEqual([]);
    const corrected = withConflict.map((e) => (e.id === b.id ? { ...e, quote: "Actually, sorry, 2021 is when I started." } : e));
    const resolved = findContradictions(corrected);
    expect(resolved[0].resolved).toBe(true);
    expect(resolved[0].resolution_evidence).toBe(b.id);
    expect(evaluateItem({ item: byRef["hard:0"], evidence: corrected, contradictions: resolved, cursorState: reached() }).status).not.toBe("contradicted");
  });

  it("a CV line that differs on a typed fact is a contradiction with the CV line attached", () => {
    const ev = strong();
    const found = findContradictions(ev, [{ subject: "Acme", scope: "current role", time: "2021", line: "Acme, HVAC Service Technician, 2021 to present" }]);
    expect(found.some((c) => c.evidence_b === null && c.cv_line?.includes("Acme"))).toBe(true);
  });

  it("free-text disagreement is not a contradiction", () => {
    const ev = strong().map((e) => ({ ...e, typed_facts: [] }));
    expect(findContradictions(ev)).toEqual([]);
  });

  it("not reached is not_assessed (not_reached); declined is not_assessed (declined); neither has evidence", () => {
    expect(evaluateItem({ item: cap, evidence: [], contradictions: [], cursorState: null })).toMatchObject({ status: "not_assessed", reason: "not_reached", evidence_ids: [] });
    expect(evaluateItem({ item: cap, evidence: strong(), contradictions: [], cursorState: reached("declined") })).toMatchObject({ status: "not_assessed", reason: "declined" });
  });

  it("an extraction failure on one item is insufficient (extraction) and the other items are unaffected", () => {
    const ev = strong();
    const r = evaluateSession({ plan, cursor: { items: { [cap.id]: reached(), [byRef["hard:0"].id]: reached() } }, evidence: ev.filter((e) => e.plan_item_id !== cap.id), extractionFailures: new Set([cap.id]) });
    expect(r.blocked).toBe(false);
    const s = Object.fromEntries(r.signals.map((x) => [x.plan_item_id, x]));
    expect(s[cap.id]).toMatchObject({ status: "insufficient", reason: "extraction" });
    expect(s[byRef["hard:0"].id].status).toBe("strongly_supported");
    expect(s[byRef["intent:0"].id]).toMatchObject({ status: "not_assessed", reason: "not_reached" });
  });

  it("the pipeline cost cap is insufficient (cap), never anything worse", () => {
    expect(evaluateItem({ item: cap, evidence: strong(), contradictions: [], cursorState: reached(), capHit: true })).toMatchObject({ status: "insufficient", reason: "cap" });
  });

  it("an evaluator failure blocks the whole package and produces no status", () => {
    const broken = { ...plan, items: [{ ...cap, evidence_contract: { ...cap.evidence_contract, elements: [] } }] };
    const r = evaluateSession({ plan: broken, cursor: { items: { [cap.id]: reached() } }, evidence: strong() });
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/no evidence contract/);
    expect(r.signals).toBeUndefined();
  });

  it("every signal has evidence ids or a reason", () => {
    const r = evaluateSession({ plan, cursor: { items: { [cap.id]: reached() } }, evidence: strong() });
    for (const s of r.signals) expect(s.evidence_ids.length > 0 || s.reason != null).toBe(true);
  });
});

describe("coverage", () => {
  const cap = byRef["capabilities:0"];
  it("strong needs every required element covered and a probe; one item is never strong; nothing usable is no_usable_evidence", () => {
    const ev = load("strong_specific").evidence;
    const full = evaluateItem({ item: cap, evidence: ev, contradictions: [], cursorState: reached() });
    expect(full.coverage_band).toBe("strong_coverage");
    expect(full.coverage_inputs).toMatchObject({ elements_required: ["instance", "mechanism", "ownership"], deepest_probe: 2, reliable_items: 3, unreliable_items: 0 });
    const one = evaluateItem({ item: cap, evidence: ev.filter((e) => e.contract_element === "instance"), contradictions: [], cursorState: reached() });
    expect(one.coverage_band).toBe("limited_coverage");
    const none = evaluateItem({ item: cap, evidence: [], contradictions: [], cursorState: reached("moved_on") });
    expect(none.coverage_band).toBe("no_usable_evidence");
    expect(none).toMatchObject({ status: "insufficient", reason: "none" });
  });

  it("a resumed item is at most limited coverage", () => {
    const ev = load("strong_specific").evidence;
    const r = evaluateItem({ item: cap, evidence: ev, contradictions: [], cursorState: reached(), conditions: { resumed_in_item: true } });
    expect(r.coverage_band).toBe("limited_coverage");
    expect(r.coverage_inputs.resumed).toBe(true);
  });
});
