// evals/interrogate/interrogate.test.mjs — the interrogation onboarding flow, with the model mocked.
//
// LLM output is non-deterministic, so we mock the model and prove the CODE PATH deterministically:
//   1. the pure completion rule (never loops, never dead-ends, never completes before a batch)
//   2. generateQuestions boundary: schema clamp/reject/garbage all fall back to the deterministic ask
//   3. continueInterrogation orchestration: grounded writeback + transcript append + batch bump + done
//   4. journey legality: the interrogation walk is all legal AND needs_input->building is ILLEGAL
//   5. grounding: every conversation-tier claim written back traces to the source (corpus fixtures)
//
// The model + store are mocked so no API key / Supabase is needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One model mock serving all three onboarding prompts — branch on the system text.
const model = { prefs: {}, writeback: {}, interro: { questions: ["what's next for you?"], ready: false }, interroRaw: null };
const createMock = vi.fn(async ({ system }) => {
  let text;
  if (/next batch of questions/i.test(system)) text = model.interroRaw != null ? model.interroRaw : JSON.stringify(model.interro);
  else if (/BACKGROUND/.test(system)) text = JSON.stringify(model.writeback);
  else text = JSON.stringify(model.prefs); // job-preferences extraction
  return { content: [{ type: "text", text }] };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() { this.messages = { create: createMock }; }
  },
}));

// Store seam mocked so importing email-onboard never touches Supabase. getDossier returns the SAME
// mutable object the test inspects (applyEmailChange mutates it in place).
const store = { dossier: null, saved: [] };
vi.mock("../../charlie-store.mjs", () => ({
  saveDossier: vi.fn(async (email, d, status) => { store.saved.push({ email, status }); return d; }),
  getDossier: vi.fn(async () => store.dossier),
  // The writeback reads the candidate ROW to preserve status, because the dossier has no status
  // field and reading it there would promote every replier to `active`. The mock returns a
  // status so the tests exercise the preserving path rather than the no-row fallback.
  getCandidate: vi.fn(async (email) => ({ email, status: "active" })),
  getResume: vi.fn(async () => "resume text"),
  uploadResume: vi.fn(async () => {}),
  markOnboardingCohort: (d) => d,
}));
vi.mock("../../url-ingest.mjs", () => ({ ingestUrls: async () => [] }));

const {
  MAX_BATCHES, decideCompletion, userSaysDone, hasRoleFloor, appendTranscriptTurn,
  writebackIsGrounded, generateQuestions, continueInterrogation, applyEmailChange,
} = await import("../../email-onboard.mjs");
const { canTransition } = await import("../../journey.mjs");

beforeEach(() => {
  model.prefs = {};
  model.writeback = {};
  model.interro = { questions: ["what's next for you?"], ready: false };
  model.interroRaw = null;
  store.dossier = null;
  store.saved = [];
  createMock.mockClear();
});

// ── 1. the deterministic completion rule ─────────────────────────────────────
describe("decideCompletion — never loops, never dead-ends, never completes before a batch", () => {
  const withRole = { preferences: { role: "designer" } };
  const noRole = { preferences: {} };
  it("completes when the person says they're done", () => {
    expect(decideCompletion({ dossier: noRole, batches: 1, ready: false, body: "that's all, find me roles" })).toBe(true);
  });
  it("never completes on batch 0 (unless they said done)", () => {
    expect(decideCompletion({ dossier: withRole, batches: 0, ready: true, body: "hi" })).toBe(false);
  });
  it("model-ready only counts once a role/level is known", () => {
    expect(decideCompletion({ dossier: noRole, batches: 1, ready: true, body: "hi" })).toBe(false);
    expect(decideCompletion({ dossier: withRole, batches: 1, ready: true, body: "hi" })).toBe(true);
  });
  it("hard cap completes even with no role (honest thin welcome, never a loop)", () => {
    expect(decideCompletion({ dossier: noRole, batches: MAX_BATCHES, ready: false, body: "hi" })).toBe(true);
  });
  it("keeps going below the cap when not ready", () => {
    expect(decideCompletion({ dossier: withRole, batches: 1, ready: false, body: "hi" })).toBe(false);
  });
});

describe("small pure helpers", () => {
  it("userSaysDone matches explicit stop phrases, not normal answers", () => {
    expect(userSaysDone("that's it, go ahead")).toBe(true);
    expect(userSaysDone("i'm done")).toBe(true);
    expect(userSaysDone("i want a staff design role in Boston")).toBe(false);
  });
  it("hasRoleFloor reads role or headline", () => {
    expect(hasRoleFloor({ preferences: { role: "pm" } })).toBe(true);
    expect(hasRoleFloor({ headline: "Staff Engineer" })).toBe(true);
    expect(hasRoleFloor({ preferences: {} })).toBe(false);
  });
  it("appendTranscriptTurn grows meta.transcript by exactly one", () => {
    const d = {};
    appendTranscriptTurn(d, ["q?"], "my answer", "2026-07-15T00:00:00.000Z");
    expect(d.meta.transcript).toHaveLength(1);
    expect(d.meta.transcript[0]).toMatchObject({ questions: ["q?"], answer: "my answer" });
  });
});

// ── 2. generateQuestions boundary ────────────────────────────────────────────
describe("generateQuestions — safeParse gate, deterministic fallback on any failure", () => {
  const dossier = { preferences: {}, proof_points: [] }; // empty prefs -> nextGap = the role ask
  it("passes a valid 1-3 batch through", async () => {
    model.interro = { questions: ["staff or lead?", "remote or a city?"], ready: true };
    const r = await generateQuestions({ resumeText: "r", dossier, transcript: [] });
    expect(r.questions).toEqual(["staff or lead?", "remote or a city?"]);
    expect(r.ready).toBe(true);
  });
  it("rejects >3 questions and falls back to the deterministic ask", async () => {
    model.interro = { questions: ["a", "b", "c", "d"], ready: false };
    const r = await generateQuestions({ resumeText: "r", dossier, transcript: [] });
    expect(r.questions.length).toBeLessThanOrEqual(3);
    expect(r.questions).not.toContain("d");
  });
  it("rejects an empty batch and falls back", async () => {
    model.interro = { questions: [], ready: true };
    const r = await generateQuestions({ resumeText: "r", dossier, transcript: [] });
    expect(r.questions.length).toBeGreaterThanOrEqual(1);
  });
  it("survives non-JSON model output (falls back, never throws)", async () => {
    model.interroRaw = "sorry, I cannot do that";
    const r = await generateQuestions({ resumeText: "r", dossier, transcript: [] });
    expect(Array.isArray(r.questions)).toBe(true);
  });
});

// ── 3. continueInterrogation orchestration ───────────────────────────────────
const baseDossier = () => ({
  name: "Maya",
  headline: "Product designer",
  preferences: { role: "product designer" },
  proof_points: [],
  meta: { onboarding: "v2", interro: { batches: 1, pending: ["what have you shipped?"], active: true }, journey: { state: "interrogating", journey_id: "j_x", entered_at: "2026-07-15T00:00:00.000Z", history: [] } },
});

describe("continueInterrogation — writeback + transcript + next batch / completion", () => {
  it("folds a grounded answer in, records the turn, and asks the next question", async () => {
    store.dossier = baseDossier();
    model.writeback = { add_proofs: [{ claim: "shipped the payments flow", evidence: "shipped the payments flow", source: "conversation" }] };
    model.interro = { questions: ["remote, a city, or either?"], ready: false };

    const res = await continueInterrogation("maya@x.com", "I shipped the payments flow at Acme");
    expect(res.done).toBe(false);
    expect(res.question).toBe("remote, a city, or either?");
    // transcript pairs the ASKED question with the answer
    expect(store.dossier.meta.transcript).toHaveLength(1);
    expect(store.dossier.meta.transcript[0].questions).toEqual(["what have you shipped?"]);
    // batch bumped; new pending is the single next question
    expect(store.dossier.meta.interro.batches).toBe(2);
    expect(store.dossier.meta.interro.pending).toEqual(["remote, a city, or either?"]);
    // the grounded writeback landed as conversation-tier
    expect(store.dossier.proof_points.some((p) => p.source === "conversation" && /payments flow/.test(p.claim))).toBe(true);
  });

  it("completes when the person says they're done (no more questions, interro closed)", async () => {
    store.dossier = baseDossier();
    const res = await continueInterrogation("maya@x.com", "that's everything, go ahead");
    expect(res.done).toBe(true);
    expect(res.question).toBe("");
    expect(store.dossier.meta.interro.active).toBe(false);
    expect(store.dossier.meta.interro.completed).toBe(true);
  });

  it("completes at the hard batch cap even if the model wants more", async () => {
    store.dossier = baseDossier();
    store.dossier.meta.interro.batches = MAX_BATCHES;
    model.interro = { questions: ["one more thing?"], ready: false };
    const res = await continueInterrogation("maya@x.com", "here is another detail");
    expect(res.done).toBe(true);
    expect(store.dossier.meta.interro.active).toBe(false);
  });
});

// ── 3b. applyEmailChange grounding gate: a reply's invented metric never lands ──
describe("applyEmailChange — drops an ungrounded (invented-metric) proof before it lands", () => {
  it("lands a grounded proof but drops an invented-metric proof from the same reply", async () => {
    store.dossier = { name: "Sam", preferences: {}, proof_points: [], gaps: [] };
    // The model over-reads the reply: one proof traces to their words, one invents a 10M-users metric
    // the person never stated. The invented one must be dropped; the grounded one must land.
    model.writeback = { add_proofs: [
      { claim: "led the billing migration at Acme", evidence: "led the billing migration at Acme", source: "conversation" },
      { claim: "scaled billing to 10M users", evidence: "scaled the platform to 10M users", source: "conversation" },
    ] };

    const res = await applyEmailChange("sam@x.com", "I led the billing migration at Acme.");
    const claims = res.dossier.proof_points.map((p) => p.claim);
    expect(claims).toContain("led the billing migration at Acme"); // grounded -> lands
    expect(claims).not.toContain("scaled billing to 10M users");   // invented "10M" -> dropped
    expect(res.dossier.proof_points).toHaveLength(1);
  });

  it("drops ALL proofs when none trace, and then adds no 'what you shared' note", async () => {
    store.dossier = { name: "Sam", preferences: {}, proof_points: [], gaps: [] };
    model.writeback = { add_proofs: [
      { claim: "grew revenue 300%", evidence: "grew revenue 300% year over year", source: "conversation" },
    ] };
    const res = await applyEmailChange("sam@x.com", "just a quick note, nothing new.");
    expect(res.dossier.proof_points).toHaveLength(0);
    expect(res.changed).not.toContain("what you shared about your work");
  });
});

// ── 4. journey legality ──────────────────────────────────────────────────────
describe("journey transitions the interrogation loop relies on", () => {
  it("the signup walk is legal: null -> received -> ack -> interrogating", () => {
    expect(canTransition(null, "received")).toBe(true);
    expect(canTransition("received", "ack")).toBe(true);
    expect(canTransition("ack", "interrogating")).toBe(true);
  });
  it("the reply alternation is legal both ways (H2 timer reset)", () => {
    expect(canTransition("interrogating", "needs_input")).toBe(true);
    expect(canTransition("needs_input", "interrogating")).toBe(true);
    expect(canTransition("parked", "interrogating")).toBe(true);
  });
  it("needs_input -> building is ILLEGAL, so completion MUST double-hop through interrogating (H1)", () => {
    expect(canTransition("needs_input", "building")).toBe(false);
    expect(canTransition("interrogating", "building")).toBe(true);
    expect(canTransition("building", "delivered")).toBe(true);
  });
});

// ── 5. grounding corpus ──────────────────────────────────────────────────────
describe("writebackIsGrounded — every written claim traces to the source", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "interrogate");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("has both a clean and an adversarial specimen", () => {
    const labels = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).label);
    expect(labels).toContain("clean");
    expect(labels).toContain("adversarial");
  });
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(dir, f), "utf8"));
    it(`${f} (${fx.label}) -> grounded=${fx.expectGrounded}`, () => {
      const r = writebackIsGrounded(fx.dossier, fx.source);
      expect(r.grounded, JSON.stringify(r.offenders)).toBe(fx.expectGrounded);
    });
  }
});
