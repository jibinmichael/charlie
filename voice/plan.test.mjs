// voice/plan.test.mjs — the chain check, ref resolution, approval, and the generator boundary.
// No live model, no database, no keys.
//
// Invariants protected: an LLM cannot create or modify verification requirements (a ref that does
// not resolve is dropped and reported); every item has fallback text for every move; and the
// "why this question" chain is data, not prose.
import { describe, it, expect } from "vitest";
import { buildPlan, resolveRef, checkChain, approvePlan, generatePlan, renderPlan, SESSION_RESERVE_SECONDS } from "./plan.mjs";
import { PlanGenOutput } from "../lib/schemas/vv-plan.mjs";

const JD = `Field Service Technician, Leeds. Must have 2+ years repairing commercial HVAC in your current role.
You will be diagnosing faults yourself on your own service route, not following a dispatched checklist.
A recognised refrigerant handling certificate required. Nice to have: experience servicing hospital plant rooms.`;

const MATRIX = {
  role: "Field Service Technician", company: null, location: "Leeds",
  hard: [
    { requirement: "2+ years commercial HVAC repair in current role", quote: "Must have 2+ years repairing commercial HVAC in your current role", evidence_needed: "dated account of HVAC repair work" },
    { requirement: "Refrigerant certificate", quote: "A recognised refrigerant handling certificate required", evidence_needed: "the certificate, stated" },
  ],
  preferred: [{ requirement: "serviced hospital plant", quote: "experience servicing hospital plant rooms", evidence_needed: "a named site" }],
  capabilities: [
    { requirement: "diagnoses own faults", quote: "diagnosing faults yourself on your own service route, not following a dispatched checklist", evidence_needed: "an account of tracing a fault from scratch", observable: ["a fault they traced", "a repair plan they made"] },
  ],
  ambiguous: [], contradictions: [], unknowns: ["pay"],
};
const QUESTIONS = ["What is your notice period?", "How old are you?"];

const fb = { anchor: "Could you walk me through that again, in your own words?", probe: "What did that look like day to day?", move_on: "Okay, thank you. Let's move to the next one.", clarify: "Let me put that another way." };

function gen() {
  return {
    items: [
      { ref: "hard:0", kind: "hard_requirement", priority: 1, budget_seconds: 120, contract: {
        establishes: "Two or more years of commercial HVAC repair in the current role",
        why_it_matters: "The mandate makes it a must-have: HVAC repair in the current role, not in the past.",
        elements: [{ name: "context", required: true, core: true }, { name: "dates", required: true, core: false }, { name: "specific_experience", required: false, core: false }],
        anchor_question: "Tell me about the HVAC repair work you do in your current role.",
        depth_probes: [{ text: "When did you start doing that, and is it still part of your week?", targets: "dates" }],
        ownership_probe: null, scenario: null, contradiction_hooks: ["current employer", "start date"],
        expected_evidence: "A named employer, a start date at least two years back, and what repair work looks like now.",
        fallback_text: fb,
      } },
      { ref: "capabilities:0", kind: "capability", priority: 2, budget_seconds: 240, contract: {
        establishes: "Diagnoses faults independently rather than following a dispatched checklist",
        why_it_matters: "The mandate asks for independent fault-finding, not a dispatched checklist.",
        elements: [{ name: "instance", required: true, core: true }, { name: "mechanism", required: true, core: false }, { name: "ownership", required: true, core: false }, { name: "tradeoff", required: false, core: false }],
        anchor_question: "Tell me about the last fault you traced from scratch and what came of it.",
        depth_probes: [{ text: "How did you decide where to start looking?", targets: "mechanism" }, { text: "Which parts of that were yours, and which came from someone else?", targets: "ownership" }],
        ownership_probe: "Was the repair plan yours to make, or did you inherit it?",
        scenario: "Say you joined a company with no service history and no supervisor on site. What would you do in the first two weeks?",
        contradiction_hooks: ["tools used", "employer"],
        expected_evidence: "A named tool, a number, a decision they made about where to look, and their own role in it.",
        fallback_text: fb,
      } },
      { ref: "question:0", kind: "hr_fact", priority: 3, budget_seconds: 60, contract: {
        establishes: "Their notice period, in their own words",
        why_it_matters: "The hiring team asked for it.",
        elements: [{ name: "answer", required: true, core: true }],
        anchor_question: "What is your notice period at the moment?",
        depth_probes: [{ text: "Is any of that negotiable, as far as you know?", targets: "answer" }],
        ownership_probe: null, scenario: null, contradiction_hooks: [],
        expected_evidence: "A number of days or weeks, and whether it can move.",
        fallback_text: fb,
      } },
      { ref: "intent:0", kind: "intent", priority: 4, budget_seconds: 120, contract: {
        establishes: "Why this role, in their own words, and what they understand about it",
        why_it_matters: "The mandate is for a role servicing hospital plant rooms on a commercial route.",
        elements: [{ name: "motivation", required: true, core: true }, { name: "role_understanding", required: false, core: false }, { name: "availability", required: false, core: false }],
        anchor_question: "What drew you to this particular role?",
        depth_probes: [{ text: "What do you understand the day to day of this role to be?", targets: "role_understanding" }],
        ownership_probe: null, scenario: null, contradiction_hooks: [],
        expected_evidence: "A reason that references this role or company specifically, not a generic one.",
        fallback_text: fb,
      } },
    ],
    flagged: [{ ref: "question:1", reason: "asks the candidate's age" }],
  };
}

const SESSION = 900;
function goodPlan() {
  const g = PlanGenOutput.parse(gen());
  return buildPlan(g, { matrix: MATRIX, questions: QUESTIONS, sessionBudgetSeconds: SESSION }).plan;
}

describe("resolveRef", () => {
  it("resolves matrix buckets, questions, and intent; refuses everything else", () => {
    expect(resolveRef("hard:1", { matrix: MATRIX, questions: QUESTIONS }).quote).toMatch(/refrigerant handling certificate/);
    expect(resolveRef("question:0", { matrix: MATRIX, questions: QUESTIONS }).quote).toBe(QUESTIONS[0]);
    expect(resolveRef("intent:0", { matrix: MATRIX, questions: QUESTIONS }).quote).toBe("Field Service Technician");
    expect(resolveRef("intent:1", { matrix: MATRIX, questions: QUESTIONS })).toBeNull();
    expect(resolveRef("hard:9", { matrix: MATRIX, questions: QUESTIONS })).toBeNull();
    expect(resolveRef("question:7", { matrix: MATRIX, questions: QUESTIONS })).toBeNull();
    expect(resolveRef("unknowns:0", { matrix: MATRIX, questions: QUESTIONS })).toBeNull();
  });
});

describe("buildPlan", () => {
  it("fills mandate_quote from the matrix and the question, never from the model", () => {
    const p = goodPlan();
    const byRef = Object.fromEntries(p.items.map((i) => [i.ref, i]));
    expect(byRef["hard:0"].evidence_contract.mandate_quote).toBe(MATRIX.hard[0].quote);
    expect(byRef["capabilities:0"].evidence_contract.mandate_quote).toBe(MATRIX.capabilities[0].quote);
    expect(byRef["question:0"].evidence_contract.mandate_quote).toBe(QUESTIONS[0]);
    expect(p.status).toBe("draft");
    expect(p.flagged).toHaveLength(1);
  });

  it("drops and reports an item whose ref does not resolve (invariant 2)", () => {
    const g = gen();
    g.items.push({ ...g.items[0], ref: "hard:5" });
    const { plan, dropped } = buildPlan(PlanGenOutput.parse(g), { matrix: MATRIX, questions: QUESTIONS, sessionBudgetSeconds: SESSION });
    expect(plan.items).toHaveLength(4);
    expect(dropped).toEqual([{ ref: "hard:5", reason: expect.stringMatching(/does not resolve/) }]);
  });
});

describe("checkChain", () => {
  it("holds on a complete plan", () => {
    const r = checkChain(goodPlan(), { jdText: JD, questions: QUESTIONS });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("names the item and the missing link: expected_evidence", () => {
    const p = goodPlan();
    p.items[1].evidence_contract.expected_evidence = "";
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    expect(r.ok).toBe(false);
    // the schema catches an empty line first; the failure still names the path
    expect(r.failures[0].link).toBe("schema");
    expect(r.failures[0].detail).toMatch(/items\.1\.evidence_contract\.expected_evidence/);
  });

  it("refuses a quote that is not in the job description", () => {
    const p = goodPlan();
    p.items[0].evidence_contract.mandate_quote = "Must have ten years of chiller maintenance";
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    expect(r.failures).toContainEqual(expect.objectContaining({ ref: "hard:0", link: "mandate_quote" }));
  });

  it("refuses a question quote that is not verbatim one of HR's questions", () => {
    const p = goodPlan();
    p.items[2].evidence_contract.mandate_quote = "What is your notice?";
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    expect(r.failures).toContainEqual(expect.objectContaining({ ref: "question:0", link: "mandate_quote" }));
  });

  it("refuses a probe that targets an element not in the item's contract", () => {
    const p = goodPlan();
    p.items[2].evidence_contract.depth_probes[0].targets = "mechanism";
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    expect(r.failures).toContainEqual(expect.objectContaining({ ref: "question:0", link: "depth_probes" }));
  });

  it("refuses a contract with no required element, or without exactly one core", () => {
    const p = goodPlan();
    p.items[0].evidence_contract.elements = [{ name: "context", required: false, core: true }];
    expect(checkChain(p, { jdText: JD, questions: QUESTIONS }).failures.map((f) => f.link)).toContain("evidence_contract");
    const q = goodPlan();
    q.items[0].evidence_contract.elements[1].core = true;
    expect(checkChain(q, { jdText: JD, questions: QUESTIONS }).failures.map((f) => f.detail)).toContain("expected exactly one core element, found 2");
  });

  it("refuses a missing fallback move (invariant 10)", () => {
    const p = goodPlan();
    delete p.items[3].evidence_contract.fallback_text.clarify;
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    expect(r.ok).toBe(false);
    expect(r.failures[0].detail).toMatch(/fallback_text\.clarify/);
  });

  it("refuses item budgets that exceed the session budget after the reserve", () => {
    const p = goodPlan();
    p.session_budget_seconds = SESSION_RESERVE_SECONDS + 300;
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    expect(r.failures).toContainEqual(expect.objectContaining({ link: "budget" }));
  });

  it("refuses an em dash and a mechanism word in candidate-facing text", () => {
    const p = goodPlan();
    p.items[1].evidence_contract.anchor_question = "Tell me about the last fault you traced — and what came of it.";
    p.items[1].evidence_contract.depth_probes[0].text = "I need to verify how you decided where to start looking.";
    const r = checkChain(p, { jdText: JD, questions: QUESTIONS });
    const voice = r.failures.filter((f) => f.link === "voice").map((f) => f.detail);
    expect(voice.some((d) => /em dash/.test(d))).toBe(true);
    expect(voice.some((d) => /"verify"/.test(d))).toBe(true);
  });

  it("requires exactly one intent item", () => {
    const p = goodPlan();
    p.items = p.items.filter((i) => i.kind !== "intent");
    expect(checkChain(p, { jdText: JD, questions: QUESTIONS }).failures).toContainEqual(expect.objectContaining({ link: "intent" }));
  });
});

describe("approvePlan", () => {
  const persisted = [];
  const persist = async (p) => { persisted.push(p); };

  it("refuses when the chain does not hold", async () => {
    const p = goodPlan();
    p.items[0].evidence_contract.mandate_quote = "not in the document at all";
    await expect(approvePlan(p, { by: "reviewer@example.com", jdText: JD, questions: QUESTIONS, persist })).rejects.toThrow(/chain does not hold/);
    expect(persisted).toHaveLength(0);
  });

  it("refuses a flagged plan without an override reason, and records the override when given", async () => {
    const p = goodPlan();
    await expect(approvePlan(p, { by: "reviewer@example.com", jdText: JD, questions: QUESTIONS, persist })).rejects.toThrow(/flagged/);
    const a = await approvePlan(p, { by: "reviewer@example.com", jdText: JD, questions: QUESTIONS, persist, override: "age question removed from the form; kept on record" });
    expect(a.status).toBe("approved");
    expect(a.override_reason).toMatch(/age question/);
    expect(persisted).toHaveLength(1);
  });

  it("returns a frozen version and leaves the caller's draft untouched", async () => {
    const p = goodPlan();
    p.flagged = [];
    const a = await approvePlan(p, { by: "reviewer@example.com", jdText: JD, questions: QUESTIONS, persist });
    expect(p.status).toBe("draft");
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.items[0].evidence_contract)).toBe(true);
    expect(() => { a.items[0].evidence_contract.anchor_question = "changed"; }).toThrow();
    // a second approval is a new version; the first is not mutated
    const v2 = await approvePlan({ ...p, version: 2 }, { by: "reviewer@example.com", jdText: JD, questions: QUESTIONS, persist });
    expect(v2.version).toBe(2);
    expect(a.version).toBe(1);
  });

  it("requires an approver email and a persist function", async () => {
    const p = goodPlan(); p.flagged = [];
    await expect(approvePlan(p, { by: "", jdText: JD, questions: QUESTIONS, persist })).rejects.toThrow(/approver/);
    await expect(approvePlan(p, { by: "x@y.z", jdText: JD, questions: QUESTIONS })).rejects.toThrow(/persist/);
  });
});

describe("generatePlan (model stubbed)", () => {
  const clientReturning = (text) => ({ messages: { create: async () => ({ content: [{ type: "text", text }] }) } });

  it("parses, resolves, and checks a valid reply", async () => {
    const { plan, dropped, chain } = await generatePlan({ client: clientReturning("```json\n" + JSON.stringify(gen()) + "\n```"), model: "stub", matrix: MATRIX, questions: QUESTIONS, sessionBudgetSeconds: SESSION, jdText: JD });
    expect(plan.items).toHaveLength(4);
    expect(dropped).toEqual([]);
    expect(chain.ok).toBe(true);
    expect(renderPlan(plan, { dropped, chain })).toMatch(/CHAIN: every link holds/);
  });

  it("refuses a reply that is not JSON, and one that does not match the schema", async () => {
    await expect(generatePlan({ client: clientReturning("here is your plan"), model: "stub", matrix: MATRIX, questions: QUESTIONS, sessionBudgetSeconds: SESSION })).rejects.toThrow(/did not return JSON/);
    const bad = gen(); bad.items[0].contract.elements[0].name = "charisma";
    await expect(generatePlan({ client: clientReturning(JSON.stringify(bad)), model: "stub", matrix: MATRIX, questions: QUESTIONS, sessionBudgetSeconds: SESSION })).rejects.toThrow(/did not match the schema/);
  });

  it("refuses to run without a model when VOICE_PLANNER_MODEL is unset", async () => {
    const prev = process.env.VOICE_PLANNER_MODEL;
    delete process.env.VOICE_PLANNER_MODEL;
    try {
      await expect(generatePlan({ client: clientReturning("{}"), matrix: MATRIX, questions: QUESTIONS, sessionBudgetSeconds: SESSION })).rejects.toThrow(/VOICE_PLANNER_MODEL/);
    } finally {
      if (prev !== undefined) process.env.VOICE_PLANNER_MODEL = prev;
    }
  });
});
