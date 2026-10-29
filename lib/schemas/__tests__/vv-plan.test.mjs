// lib/schemas/__tests__/vv-plan.test.mjs — boundary-schema contract for the verification plan.
// One valid fixture parses; malformed fixtures fail closed. No live API, no keys.
import { describe, it, expect } from "vitest";
import { EvidenceContract, PlanGenOutput, VerificationPlan, ELEMENTS, FALLBACK_MOVES } from "../vv-plan.mjs";

const fb = { anchor: "Could you say that again in your own words?", probe: "What did that look like day to day?", move_on: "Okay, thank you. Next one.", clarify: "Let me put that another way." };

const contract = () => ({
  establishes: "Diagnoses faults on their own route",
  mandate_quote: "diagnosing faults yourself on your own service route, not following a dispatched checklist",
  why_it_matters: "The mandate says so, in those words.",
  elements: [{ name: "instance", required: true, core: true }, { name: "mechanism", required: true }],
  anchor_question: "Tell me about the last fault you traced from scratch.",
  depth_probes: [{ text: "How did you decide where to look first?", targets: "mechanism" }],
  ownership_probe: null,
  scenario: null,
  contradiction_hooks: ["tools used"],
  expected_evidence: "A named tool, a number, and a decision they made.",
  fallback_text: { ...fb },
});

describe("EvidenceContract", () => {
  it("valid contract parses; core defaults to false", () => {
    const r = EvidenceContract.safeParse(contract());
    expect(r.success).toBe(true);
    expect(r.data.elements[1].core).toBe(false);
  });

  it("an element outside the fixed vocabulary fails closed", () => {
    const c = contract(); c.elements.push({ name: "charisma", required: true });
    expect(EvidenceContract.safeParse(c).success).toBe(false);
    expect(ELEMENTS).not.toContain("charisma");
  });

  it("a missing fallback move fails closed, for every move", () => {
    for (const mv of FALLBACK_MOVES) {
      const c = contract(); delete c.fallback_text[mv];
      expect(EvidenceContract.safeParse(c).success).toBe(false);
    }
  });

  it("zero probes fails closed; a probe must target a vocabulary element", () => {
    const c = contract(); c.depth_probes = [];
    expect(EvidenceContract.safeParse(c).success).toBe(false);
    const d = contract(); d.depth_probes[0].targets = "vibe";
    expect(EvidenceContract.safeParse(d).success).toBe(false);
  });
});

describe("PlanGenOutput (what the model returns)", () => {
  it("has no mandate_quote in the contract: code fills it", () => {
    const { mandate_quote, ...rest } = contract();
    const ok = PlanGenOutput.safeParse({ items: [{ ref: "capabilities:0", kind: "capability", priority: 1, budget_seconds: 120, contract: rest }], flagged: [] });
    expect(ok.success).toBe(true);
    expect(ok.data.items[0].contract.mandate_quote).toBeUndefined();
  });

  it("a ref outside the matrix / question / intent forms fails closed", () => {
    const { mandate_quote, ...rest } = contract();
    expect(PlanGenOutput.safeParse({ items: [{ ref: "unknowns:0", kind: "capability", priority: 1, budget_seconds: 120, contract: rest }], flagged: [] }).success).toBe(false);
    expect(PlanGenOutput.safeParse({ items: [], flagged: [] }).success).toBe(false);
  });
});

describe("VerificationPlan", () => {
  it("a stored plan parses; a status outside the five fails closed", () => {
    const plan = {
      id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", mandate_id: null, version: 1, status: "draft",
      session_budget_seconds: 900, consent_text_version: null, flagged: [], override_reason: null,
      approved_by: null, approved_at: null,
      items: [{ id: "1f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", requirement_id: null, ref: "capabilities:0", kind: "capability", priority: 1, budget_seconds: 120, evidence_contract: contract() }],
    };
    expect(VerificationPlan.safeParse(plan).success).toBe(true);
    expect(VerificationPlan.safeParse({ ...plan, status: "live" }).success).toBe(false);
    expect(VerificationPlan.safeParse({ ...plan, session_budget_seconds: 30 }).success).toBe(false);
  });
});
