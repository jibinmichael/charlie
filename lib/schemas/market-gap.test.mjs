// lib/schemas/market-gap.test.mjs — boundary tests for the market-gap drop's two model-output schemas.
import { describe, it, expect } from "vitest";
import { MarketGapCopy, MarketResearchOutput } from "./market-gap.mjs";

describe("MarketGapCopy", () => {
  const valid = { subject: "s", opening: "o", gap_framing: "g", close_line: "c", honest_line: "h" };
  it("accepts a full copy object and tolerates extra keys", () => {
    expect(MarketGapCopy.safeParse({ ...valid, extra: 1 }).success).toBe(true);
  });
  it("rejects a missing required field (so the sweep falls back to grounded default copy)", () => {
    expect(MarketGapCopy.safeParse({ ...valid, honest_line: undefined }).success).toBe(false);
  });
  it("rejects an empty required string", () => {
    expect(MarketGapCopy.safeParse({ ...valid, subject: "" }).success).toBe(false);
  });
});

describe("MarketResearchOutput", () => {
  it("defaults lines to [] when absent (empty is a valid, correct result)", () => {
    const r = MarketResearchOutput.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data.lines).toEqual([]);
  });
  it("accepts up to 3 sourced lines and rejects a 4th", () => {
    const line = { claim: "x", source: "https://a.b" };
    expect(MarketResearchOutput.safeParse({ lines: [line, line, line] }).success).toBe(true);
    expect(MarketResearchOutput.safeParse({ lines: [line, line, line, line] }).success).toBe(false);
  });
  it("rejects a line missing its source (an unsourced market claim is never trusted)", () => {
    expect(MarketResearchOutput.safeParse({ lines: [{ claim: "x" }] }).success).toBe(false);
  });
});
