// lib/schemas/__tests__/edge-verdict.test.mjs — the Edge Engine verifier's boundary must fail CLOSED.
//
// edge-verify.mjs drops the edge unless the verdict is grounded. parseEdgeVerdict is what turns the raw
// model reply into that decision, so any shape it cannot understand must resolve to NOT grounded / low —
// never to a trusted edge. These tests pin that, mirroring grounding-verdict.test.mjs's discipline.

import { describe, it, expect } from "vitest";
import { normalizeGrounded, normalizeConfidence, parseEdgeVerdict, EdgeVerdict } from "../edge-verdict.mjs";
import { EDGE_VERIFY_SYSTEM } from "../../../prompts/edge-verify.mjs";

describe("normalizeGrounded — only an explicit true is grounded", () => {
  it("accepts real true", () => {
    expect(normalizeGrounded(true)).toBe(true);
    expect(normalizeGrounded("true")).toBe(true);
    expect(normalizeGrounded("TRUE")).toBe(true);
    expect(normalizeGrounded(" True ")).toBe(true);
  });
  it.each([
    [false, "boolean false"],
    ["false", "string false"],
    [undefined, "absent"],
    [null, "null"],
    ["yes", "a truthy-looking non-true"],
    [1, "a number"],
    ["", "empty"],
  ])("fails closed for %s (%s)", (raw) => {
    expect(normalizeGrounded(raw)).toBe(false);
  });
});

describe("normalizeConfidence — unrecognized drifts to low (never over-trusts)", () => {
  it("accepts the three values", () => {
    expect(normalizeConfidence("high")).toBe("high");
    expect(normalizeConfidence("medium")).toBe("medium");
    expect(normalizeConfidence("low")).toBe("low");
    expect(normalizeConfidence("HIGH")).toBe("high");
  });
  it.each([["very high"], ["strong"], [""], [undefined], [null], [42]])("drifts %s to low", (raw) => {
    expect(normalizeConfidence(raw)).toBe("low");
  });
});

describe("parseEdgeVerdict — schema boundary", () => {
  it("parses a well-formed grounded verdict", () => {
    const r = parseEdgeVerdict({ grounded: true, confidence: "high", reason: "both halves cited; rare pairing" });
    expect(r).toMatchObject({ grounded: true, confidence: "high", malformed: false });
  });
  it("a not-grounded verdict is respected", () => {
    expect(parseEdgeVerdict({ grounded: false, confidence: "low" })).toMatchObject({ grounded: false, malformed: false });
  });
  it.each([
    [null, "null payload"],
    ["a string", "a bare string"],
    [42, "a number"],
    [[], "an array"],
  ])("a malformed payload (%s) fails CLOSED (not grounded)", (raw) => {
    const r = parseEdgeVerdict(raw);
    expect(r.malformed).toBe(true);
    expect(r.grounded).toBe(false);
    expect(r.confidence).toBe("low");
  });
  it("tolerates extra keys the model adds", () => {
    const r = parseEdgeVerdict({ grounded: true, confidence: "medium", chain_of_thought: "…" });
    expect(r).toMatchObject({ grounded: true, confidence: "medium", malformed: false });
  });
  it("EdgeVerdict accepts the canonical shape", () => {
    expect(EdgeVerdict.safeParse({ grounded: true, confidence: "high" }).success).toBe(true);
  });
});

describe("the edge-verify prompt states its output contract", () => {
  it("documents the exact JSON keys the schema parses", () => {
    expect(EDGE_VERIFY_SYSTEM).toContain('{"grounded":true|false,"confidence":"high"|"medium"|"low"');
  });
});
