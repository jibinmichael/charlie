// prompts/__tests__/match-scoring.test.mjs — versioning contract for the scoring prompt.
//
// Proves two things WITHOUT any live API call:
//   1. buildScoringMessages() assembles the request the way every caller expects
//      (cache-controlled matcher + dossier prefixes, the ## DOSSIER / ## TODAY / ## JOB
//      wrappers, the job serialized verbatim, TODAY omitted when null).
//   2. The MatchOutput schema (lib/schemas/match-output.mjs) that guards the reply at the
//      boundary accepts realistic model outputs and rejects malformed ones — so a drifted
//      prompt that returns garbage is skipped, never trusted.
//
// Three fixtures mirror the real spread: a STRONG match, a WEAK match, and a SPARSE-JD edge
// case (an under-specified posting the model can only "skip"). No ANTHROPIC_API_KEY is read.

import { describe, it, expect } from "vitest";
import { buildScoringMessages, buildScoringRequest, loadMatcherRubric } from "../match-scoring.mjs";
import { MatchOutput, MatchOutputFormat } from "../../lib/schemas/match-output.mjs";

const MATCHER = "## MATCHER RUBRIC\nscore 0-100, verdict, honest flag."; // stand-in rubric (real one is matcher.md)
const DOSSIER = JSON.stringify({ headline: "Staff PM, fintech", proof_points: [{ text: "shipped payments" }] });

// ── realistic model outputs, one per fixture ────────────────────────────────
const STRONG = {
  score: 88,
  verdict: "exceptional",
  chips: [{ text: "6y fintech PM", kind: "good" }, { text: "no crypto exp", kind: "warn" }],
  why_you: "you led payments at scale, which is the core of this role.",
  flag: "they want crypto-native; you are not.",
  dealbreaker_hit: false,
};
const WEAK = {
  score: 41,
  verdict: "worth a look",
  chips: [{ text: "adjacent domain", kind: "warn" }],
  flag: "your b2b background is a stretch for this consumer role.",
  dealbreaker_hit: false,
};
// SPARSE JD → the model can barely read requirements; it must skip, not invent a fit.
const SPARSE = {
  score: 0,
  verdict: "skip",
  flag: null,
  dealbreaker_hit: false,
};

const JOB_STRONG = { title: "Staff Product Manager, Payments", company: "Acme", location: "Remote (US)", description: "Own the payments roadmap. 6+ years PM." };
const JOB_SPARSE = { title: "Product Manager", company: "Stealthco", location: null, description: null };

describe("buildScoringMessages — request assembly", () => {
  it("caches the matcher + dossier prefixes and wraps the dossier", () => {
    const { system } = buildScoringMessages({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_STRONG, todayLine: null });
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({ type: "text", text: MATCHER, cache_control: { type: "ephemeral" } });
    expect(system[1].text).toBe(`## DOSSIER\n\n${DOSSIER}`);
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("serializes the job verbatim under ## JOB and omits ## TODAY when todayLine is null", () => {
    const { messages } = buildScoringMessages({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_STRONG, todayLine: null });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe(`## JOB\n\n${JSON.stringify(JOB_STRONG, null, 2)}`);
    expect(messages[0].content).not.toContain("## TODAY");
  });

  it("prepends the ## TODAY block when a todayLine is supplied", () => {
    const today = `2026-07-12 (a past date is not "future")`;
    const { messages } = buildScoringMessages({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_SPARSE, todayLine: today });
    expect(messages[0].content).toBe(`## TODAY\n\n${today}\n\n## JOB\n\n${JSON.stringify(JOB_SPARSE, null, 2)}`);
  });

  it("buildScoringRequest adds model + max_tokens around the same messages", () => {
    const req = buildScoringRequest({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_STRONG, model: "claude-haiku-4-5", maxTokens: 600, todayLine: null });
    expect(req.model).toBe("claude-haiku-4-5");
    expect(req.max_tokens).toBe(600);
    expect(req.system).toHaveLength(2);
    expect(req.messages[0].content).toContain("## JOB");
  });

  it("loads the real matcher.md rubric from disk (the single human-edited source)", () => {
    const rubric = loadMatcherRubric();
    expect(typeof rubric).toBe("string");
    expect(rubric.length).toBeGreaterThan(100);
  });
});

describe("MatchOutput — the boundary schema the callers enforce", () => {
  it("accepts a STRONG match", () => {
    expect(MatchOutput.safeParse(STRONG).success).toBe(true);
  });
  it("accepts a WEAK match", () => {
    expect(MatchOutput.safeParse(WEAK).success).toBe(true);
  });
  it("accepts a SPARSE-JD skip (null flag, score 0)", () => {
    expect(MatchOutput.safeParse(SPARSE).success).toBe(true);
  });

  it("rejects an out-of-range score (caller logs + skips instead of trusting it)", () => {
    const r = MatchOutput.safeParse({ ...STRONG, score: 140 });
    expect(r.success).toBe(false);
  });
  it("rejects an unknown verdict", () => {
    const r = MatchOutput.safeParse({ ...WEAK, verdict: "great" });
    expect(r.success).toBe(false);
  });
  it("rejects a missing score", () => {
    const { score, ...noScore } = STRONG;
    expect(MatchOutput.safeParse(noScore).success).toBe(false);
  });
});

// ── constrained decoding (output_config.format) ─────────────────────────────
// Two guards: (1) the builder attaches output_config only when asked, so the flag is inert by
// default; (2) MatchOutputFormat is a LEGAL, FAITHFUL mirror of MatchOutput — legal so the API
// won't 400 (additionalProperties:false everywhere, no unsupported keywords), faithful so a valid
// constrained output also passes the Zod safeParse. If these drift, constrained decoding either
// rejects good output or lets bad output through — the exact failure the mirror must prevent.
describe("constrained decoding — buildScoringMessages wiring", () => {
  it("omits output_config by default (flag inert = today's behavior)", () => {
    const r = buildScoringMessages({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_STRONG });
    expect(r.output_config).toBeUndefined();
  });
  it("attaches output_config.format = MatchOutputFormat when constrained", () => {
    const r = buildScoringMessages({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_STRONG, constrained: true });
    expect(r.output_config).toEqual({ format: MatchOutputFormat });
  });
  it("buildScoringRequest threads constrained through", () => {
    const req = buildScoringRequest({ matcherText: MATCHER, dossierText: DOSSIER, job: JOB_STRONG, model: "claude-haiku-4-5", maxTokens: 600, constrained: true });
    expect(req.output_config).toEqual({ format: MatchOutputFormat });
  });
});

describe("MatchOutputFormat — a legal, faithful mirror of MatchOutput", () => {
  // Recursively walk the JSON schema, collecting every object node and every keyword used.
  const objects = [];
  const keywords = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) keywords.add(k);
    if (node.type === "object") objects.push(node);
    if (node.properties) for (const v of Object.values(node.properties)) walk(v);
    if (node.items) walk(node.items);
  })(MatchOutputFormat.schema);

  it("is a json_schema format wrapper", () => {
    expect(MatchOutputFormat.type).toBe("json_schema");
    expect(MatchOutputFormat.schema.type).toBe("object");
  });

  it("sets additionalProperties:false on every object node (structured-outputs requirement)", () => {
    expect(objects.length).toBeGreaterThanOrEqual(2); // root + chips item
    for (const o of objects) expect(o.additionalProperties).toBe(false);
  });

  it("uses no unsupported JSON-schema keywords (would 400 on the raw Batch request)", () => {
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "pattern", "multipleOf", "minItems", "maxItems"]) {
      expect(keywords.has(bad), `unsupported keyword "${bad}" present`).toBe(false);
    }
  });

  it("requires exactly the six fields matcher.md emits", () => {
    expect([...MatchOutputFormat.schema.required].sort()).toEqual(
      ["chips", "dealbreaker_hit", "flag", "score", "verdict", "why_you"].sort(),
    );
  });

  it("mirrors the enums, and every constrained-allowed value is accepted by the Zod gate", () => {
    const props = MatchOutputFormat.schema.properties;
    expect(props.verdict.enum).toEqual(["exceptional", "strong", "worth a look", "skip"]);
    expect(props.chips.items.properties.kind.enum).toEqual(["good", "warn"]);
    expect(props.flag.type).toEqual(["string", "null"]); // nullable, matching Zod .nullable()
    // Faithfulness: an object using each allowed enum value must pass MatchOutput.safeParse.
    for (const verdict of props.verdict.enum) {
      const obj = { score: 50, verdict, chips: [{ text: "x", kind: "good" }], why_you: "y", flag: null, dealbreaker_hit: false };
      expect(MatchOutput.safeParse(obj).success, `verdict "${verdict}" should pass Zod`).toBe(true);
    }
  });
});
