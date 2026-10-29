// lib/schemas/__tests__/grounding-verdict.test.mjs — the grounding auditor's verdict boundary.
//
// grounding-verify.mjs decides whether to HOLD an ungrounded email from the model's severity. An exact
// string compare would let an auditor correctly catch an invented claim, report it as "HIGH", and the
// email would SEND ("HIGH" !== "high" falls through to "low", which does not hold). These tests pin
// the drift cases: each one must resolve to "high".

import { describe, it, expect } from "vitest";
import { normalizeSeverity, parseGroundingVerdict, GroundingVerdict, GroundingVerdictFormat } from "../grounding-verdict.mjs";
import { GROUNDING_VERIFY_SYSTEM } from "../../../prompts/grounding-verify.mjs";

describe("normalizeSeverity — the exact-match leak", () => {
  it("accepts the canonical values", () => {
    expect(normalizeSeverity("high", 1)).toBe("high");
    expect(normalizeSeverity("low", 1)).toBe("low");
    expect(normalizeSeverity("none", 0)).toBe("none");
  });

  // Each of these must hold, never resolve to "low" and send an ungrounded claim.
  it.each([
    ["HIGH", "uppercase"],
    ["High", "title case"],
    ["high ", "trailing space"],
    [" high", "leading space"],
    ["  HiGh  ", "mixed case + padding"],
  ])("drift: %s (%s) holds", (raw) => {
    expect(normalizeSeverity(raw, 1)).toBe("high");
  });

  it.each([
    ["critical", "a severity the prompt never defined"],
    ["severe", "another one"],
    ["major", "another one"],
    ["", "empty string with violations named"],
    [undefined, "absent severity with violations named"],
    [null, "null severity with violations named"],
    [42, "a non-string"],
  ])("drift: unrecognized severity %s (%s) + violations → holds", (raw) => {
    expect(normalizeSeverity(raw, 2)).toBe("high");
  });

  it("a verdict that says 'none' while naming violations is a contradiction → holds", () => {
    // The auditor cannot both find nothing and list something. Uncertainty about an invented claim
    // holds, it does not send.
    expect(normalizeSeverity("none", 3)).toBe("high");
  });

  it("genuinely clean stays clean (no false holds — this must not become a hold-everything gate)", () => {
    expect(normalizeSeverity("none", 0)).toBe("none");
    expect(normalizeSeverity("", 0)).toBe("none");
    expect(normalizeSeverity(undefined, 0)).toBe("none");
    expect(normalizeSeverity("NONE", 0)).toBe("none");
  });

  it("'low' with violations stays low (a borderline phrasing is not a hold)", () => {
    expect(normalizeSeverity("LOW", 1)).toBe("low");
    expect(normalizeSeverity("low", 5)).toBe("low");
  });
});

describe("parseGroundingVerdict — schema boundary", () => {
  it("parses a well-formed verdict with object violations", () => {
    const r = parseGroundingVerdict({ severity: "high", violations: [{ claim: "led payments", why: "source says 'contributed to'" }] });
    expect(r).toMatchObject({ severity: "high", malformed: false });
    expect(r.violations).toHaveLength(1);
  });

  it("accepts string violations (older prompt shape)", () => {
    const r = parseGroundingVerdict({ severity: "low", violations: ["borderline phrasing"] });
    expect(r.severity).toBe("low");
    expect(r.malformed).toBe(false);
  });

  it("a clean verdict passes without holding", () => {
    expect(parseGroundingVerdict({ severity: "none", violations: [] })).toMatchObject({ severity: "none", malformed: false });
  });

  it.each([
    [null, "null payload"],
    ["a string", "a bare string"],
    [42, "a number"],
    [[], "an array"],
  ])("a malformed payload (%s) fails CLOSED, never as a clean pass", (raw) => {
    const r = parseGroundingVerdict(raw);
    expect(r.malformed).toBe(true);
    expect(r.severity).toBe("high"); // uncertainty holds
  });

  it("tolerates extra keys the model adds", () => {
    const r = parseGroundingVerdict({ severity: "high", violations: [], reasoning: "chain of thought", confidence: 0.9 });
    expect(r.malformed).toBe(false);
    expect(r.severity).toBe("high");
  });

  it("missing violations key is treated as none reported", () => {
    expect(parseGroundingVerdict({ severity: "none" })).toMatchObject({ severity: "none", malformed: false });
  });

  it("GroundingVerdict itself accepts the canonical shape", () => {
    expect(GroundingVerdict.safeParse({ severity: "high", violations: [] }).success).toBe(true);
  });
});

// ── Constrained decoding (output_config.format) ─────────────────────────────
// A malformed-JSON verdict is held (correctly), so a syntax flake would cost a person their role for
// the day. GroundingVerdictFormat removes the flake, but only while three things agree: the constrained schema, the Zod schema, and the prompt's
// OUTPUT block. This fences that triad. If they drift, constrained decoding either rejects good output
// (holding every send) or lets bad output through (grounding leaks), both silent without this test.
describe("GroundingVerdictFormat — a legal, faithful mirror of GroundingVerdict + the prompt", () => {
  // Recursively walk the JSON schema, collecting every object node and every keyword used.
  const objects = [];
  const keywords = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) keywords.add(k);
    if (node.type === "object") objects.push(node);
    if (node.properties) for (const v of Object.values(node.properties)) walk(v);
    if (node.items) walk(node.items);
  })(GroundingVerdictFormat.schema);

  it("is a json_schema format wrapper", () => {
    expect(GroundingVerdictFormat.type).toBe("json_schema");
    expect(GroundingVerdictFormat.schema.type).toBe("object");
  });

  it("sets additionalProperties:false on every object node (structured-outputs requirement)", () => {
    expect(objects.length).toBeGreaterThanOrEqual(2); // root + violations item
    for (const o of objects) expect(o.additionalProperties).toBe(false);
  });

  // A schema the API rejects would 400 EVERY verifier call → errored → every role held → nobody gets
  // an email. That is the one way this fix could be worse than the bug, so it is pinned here.
  it("uses no unsupported JSON-schema keywords (would 400 the request and hold every send)", () => {
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "pattern", "multipleOf", "minItems", "maxItems"]) {
      expect(keywords.has(bad), `unsupported keyword "${bad}" present`).toBe(false);
    }
  });

  it("requires exactly the two fields the prompt always emits", () => {
    expect([...GroundingVerdictFormat.schema.required].sort()).toEqual(["severity", "violations"]);
  });

  it("constrains severity to the prompt's three values, and each is understood by normalizeSeverity", () => {
    const sev = GroundingVerdictFormat.schema.properties.severity;
    expect(sev.enum).toEqual(["none", "low", "high"]);
    // Faithfulness: every value the model is ALLOWED to emit must survive the Zod + normalize gate
    // unchanged. If the constrained enum ever gained a value normalizeSeverity doesn't know, that
    // value would fail closed to "high" and silently hold clean sends.
    for (const s of sev.enum) {
      expect(normalizeSeverity(s, 0), `severity "${s}" should normalize to itself`).toBe(s === "low" ? "low" : s);
      expect(GroundingVerdict.safeParse({ severity: s, violations: [] }).success).toBe(true);
    }
  });

  it("violation items mirror the prompt's {claim, issue} objects", () => {
    const item = GroundingVerdictFormat.schema.properties.violations.items;
    expect([...item.required].sort()).toEqual(["claim", "issue"]);
    expect(Object.keys(item.properties).sort()).toEqual(["claim", "issue"]);
  });

  it("a maximally-constrained output still passes the full parse gate (format ⊆ Zod)", () => {
    const constrained = { severity: "high", violations: [{ claim: "led payments", issue: "source says 'contributed to'" }] };
    const r = parseGroundingVerdict(constrained);
    expect(r).toMatchObject({ severity: "high", malformed: false });
    expect(r.violations).toHaveLength(1);
  });

  // The third leg of the triad: the prompt is the contract the format mirrors. A prompt edit that
  // changes the OUTPUT block without updating the format (or vice versa) fails here.
  it("matches the prompt's OUTPUT block (the contract the schema mirrors)", () => {
    expect(GROUNDING_VERIFY_SYSTEM).toContain('{"severity":"none"|"low"|"high","violations":[{"claim":"<exact phrase from ARTIFACT>","issue":"<why it is ungrounded>"}]}');
    for (const s of GroundingVerdictFormat.schema.properties.severity.enum) {
      expect(GROUNDING_VERIFY_SYSTEM, `prompt must document severity "${s}"`).toContain(`"${s}"`);
    }
  });
});
