// voice/report-schema.test.mjs — no score, rank, or recommendation anywhere in the package, by key
// and by word; and the chain resolves for every signal.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPackage, systemStrings, chainResolves, ASSESSMENT_WORDS_RE, FIXED_LIMITATIONS } from "./render-package.mjs";
import { evaluateSession } from "./evaluate.mjs";
import { validateEvidence } from "./evidence-validate.mjs";
import { FORBIDDEN_KEYS, ReportPackage } from "../lib/schemas/vv-report.mjs";
import { STATUS_LANGUAGE, COVERAGE_LANGUAGE } from "./statuses.mjs";
import { MECHANISM_RE } from "./plan.mjs";
import { VerificationPlan } from "../lib/schemas/vv-plan.mjs";

const plan = VerificationPlan.parse(JSON.parse(readFileSync("evals/vv/test-plan.json", "utf8")));
const SESSION = "5a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function build(name, overrides = {}) {
  const fx = JSON.parse(readFileSync(`evals/vv/evidence/${name}.json`, "utf8"));
  const turns = fx.turns.map((t) => ({ ...t, conversation_id: fx.conversation_id }));
  const evidence = [];
  for (const [itemId, raw] of Object.entries(fx.extractor_output)) {
    const item = plan.items.find((i) => i.id === itemId);
    evidence.push(...validateEvidence(raw, { item, sessionId: SESSION, turns: turns.filter((t) => t.plan_item_id === itemId), extractorVersion: "x.1" }).items);
  }
  const cursor = { metaCount: 1, items: Object.fromEntries(plan.items.slice(0, 2).map((i) => [i.id, { status: "sufficient", probesAsked: 2, scenarioAsked: false }])) };
  const r = evaluateSession({ plan, cursor, evidence });
  expect(r.blocked).toBe(false);
  const session = { id: SESSION, kind: "candidate", state: "evaluated", started_at: "2026-09-22T10:00:00Z", completed_at: "2026-09-22T10:09:30Z", created_at: "2026-09-22T09:00:00Z", conditions: { fallback_rate: 0.1 }, ...overrides };
  return buildPackage({
    session, plan, mandate: { role: "Field Service Technician" }, candidate: { name_as_given: "Priya" },
    signals: r.signals.map((s, i) => ({ ...s, id: `00000000-0000-4000-8000-00000000000${i}` })), evidence, contradictions: r.contradictions, turns,
    conversations: [{ id: fx.conversation_id, transcript_hash: "abc", audio_ref: "audio/x.mp3" }],
    consents: [{ scope: "recording", granted: true, text_version: "2026-09-22.draft", recorded_at: "2026-09-22T09:59:00Z" }],
    cursor, extractorVersion: "x.1", controllerVersion: "c.1",
  });
}

describe("the package", () => {
  it("builds, validates, and has no forbidden key at any depth", () => {
    const pkg = build("strong_specific");
    expect(ReportPackage.safeParse(pkg).success).toBe(true);
    const json = JSON.stringify(pkg);
    for (const k of FORBIDDEN_KEYS) expect(json).not.toMatch(new RegExp(`"${k}"\\s*:`, "i"));
    expect(Object.keys(pkg).sort()).toEqual(["capability_grid", "communication", "contradictions", "gaps", "header", "hr_answers", "identity_consent", "intent", "limitations", "must_have_gate", "transcript", "versions"]);
  });

  it("a package with a score-like key is refused by the builder", () => {
    expect(FORBIDDEN_KEYS).toContain("score");
    expect(FORBIDDEN_KEYS).toContain("recommendation");
    const shape = ReportPackage.safeParse({ ...build("strong_specific"), score: 82 });
    // the schema is strict about its own keys; the builder's key scan is the second wall
    expect(shape.success).toBe(true); // zod objects strip unknown keys, so
    expect(Object.keys(shape.data)).not.toContain("score"); // an added score does not survive parsing
  });

  it("every system-authored string is clean of assessment words and em dashes", () => {
    // The package is for HR and says "evidence" on purpose; the candidate-facing mechanism wall
    // (MECHANISM_RE) applies to speech, not here. What may never appear is a verdict word.
    const pkg = build("strong_specific");
    for (const s of [...systemStrings(pkg), ...Object.values(STATUS_LANGUAGE), ...Object.values(COVERAGE_LANGUAGE), ...FIXED_LIMITATIONS]) {
      expect({ s, hit: ASSESSMENT_WORDS_RE.exec(s)?.[0] ?? null }).toEqual({ s, hit: null });
      expect(s).not.toMatch(/—/);
    }
    expect(MECHANISM_RE.test("probe")).toBe(true); // the wall still exists, for the writer
  });

  it("the must-have gate says answered or unknown with the verbatim quote, and never guesses the bar", () => {
    const pkg = build("strong_specific");
    const gate = pkg.must_have_gate.find((g) => g.ref === "hard:0");
    expect(gate.verdict).toBe("answered");
    expect(gate.answer_quote).toMatch(/^At Acme I repair rooftop HVAC/);
    expect(gate.bar).toBeNull();
    const weak = build("weak_generic");
    expect(weak.must_have_gate.find((g) => g.ref === "hard:0").verdict).toBe("answered"); // a stated_only quote is still an answer
    expect(weak.capability_grid.find((s) => s.ref === "hard:0").status).toBe("stated_only");
  });

  it("gaps list every insufficient and not_assessed item with a reason, and missing_elements say what would have raised it", () => {
    const pkg = build("weak_generic");
    expect(pkg.gaps.map((g) => g.ref)).toEqual(["intent:0"]);
    expect(pkg.gaps[0]).toMatchObject({ status: "not_assessed", reason: "not_reached" });
    const cap = pkg.capability_grid.find((s) => s.ref === "capabilities:0");
    expect(cap.missing_elements).toEqual(["instance", "mechanism", "ownership"]);
    expect(cap.status_text).toBe(STATUS_LANGUAGE.stated_only);
  });

  it("a test session's package carries kind = test in the header", () => {
    expect(build("strong_specific", { kind: "test" }).header.kind).toBe("test");
  });

  it("the chain resolves for every signal, and a broken one is named (invariant 11)", () => {
    const pkg = build("strong_specific");
    expect(chainResolves(pkg)).toEqual({ ok: true, failures: [] });
    const broken = structuredClone(pkg);
    broken.capability_grid[0].evidence = [];
    broken.capability_grid[0].reason = null;
    expect(chainResolves(broken).failures[0]).toMatch(/no evidence and no reason/);
  });
});
