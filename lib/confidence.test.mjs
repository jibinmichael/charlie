// confidence.test.mjs — confidence is a computed field (lib/confidence.mjs), so the test that matters
// is that the same inputs always produce the same label, in the same words.

import { describe, it, expect } from "vitest";
import { confidenceOf, confidenceLine } from "./confidence.mjs";

const base = { coverage: 100, writtenForMandate: true, verified: true, hardFailed: 0, hardUnknown: 0, scored: true };

describe("the label is determined by the inputs and nothing else", () => {
  it("is stable across repeated calls", () => {
    const a = confidenceOf(base), b = confidenceOf({ ...base });
    expect(a.label).toBe(b.label);
    expect(confidenceLine(a)).toBe(confidenceLine(b));
  });

  it("established needs all four: written for the role, verified, high coverage, nothing unasked", () => {
    expect(confidenceOf(base).label).toBe("established");
    expect(confidenceOf({ ...base, writtenForMandate: false }).label).toBe("indicative");
    expect(confidenceOf({ ...base, verified: false }).label).toBe("indicative");
    expect(confidenceOf({ ...base, coverage: 79 }).label).toBe("indicative");
    expect(confidenceOf({ ...base, hardUnknown: 1 }).label).toBe("indicative");
  });

  it("a failed hard requirement is insufficient however good the evidence", () => {
    const c = confidenceOf({ ...base, hardFailed: 1 });
    expect(c.label).toBe("insufficient");
    expect(c.why[0]).toMatch(/hard requirement/);
  });

  it("thin coverage is insufficient", () => {
    expect(confidenceOf({ ...base, coverage: 49 }).label).toBe("insufficient");
    expect(confidenceOf({ ...base, coverage: 50 }).label).not.toBe("insufficient");
  });

  it("an unscored candidate is insufficient, never a guess", () => {
    expect(confidenceOf({ ...base, scored: false }).label).toBe("insufficient");
  });
});

describe("the label always explains itself", () => {
  it("names why, every time", () => {
    for (const input of [base, { ...base, verified: false }, { ...base, hardFailed: 1 }, { ...base, coverage: 10 }])
      expect(confidenceOf(input).why.length).toBeGreaterThan(0);
  });

  it("says plainly when nothing is externally confirmed", () => {
    expect(confidenceLine(confidenceOf({ ...base, verified: false }))).toMatch(/nothing is confirmed outside their own account/);
  });

  it("says plainly when the answers were written for something else", () => {
    expect(confidenceLine(confidenceOf({ ...base, writtenForMandate: false }))).toMatch(/written for a different role/);
  });
});

describe("it describes our evidence, not the person", () => {
  it("never emits a judgement about the candidate", () => {
    for (const input of [base, { ...base, coverage: 10 }, { ...base, hardFailed: 2 }]) {
      const line = confidenceLine(confidenceOf(input));
      expect(line).not.toMatch(/weak|poor|unqualified|bad|strong candidate|good fit|reject/i);
    }
  });
});

// What a typical form-built pool can reach. If either of these ever becomes reachable, it is because
// somebody built the thing that makes it reachable, and this test should be updated then.
describe("what today's pool can actually reach", () => {
  it("cannot reach established, because nothing is externally verifiable", () => {
    // These forms collect LinkedIn, which cannot be fetched, so `verified` is false for everybody.
    const real = { coverage: 100, writtenForMandate: true, verified: false, hardFailed: 0, hardUnknown: 0, scored: true };
    expect(confidenceOf(real).label).toBe("indicative");
  });

  it("puts a pool candidate screened against another posting at indicative", () => {
    // Full coverage, answers written for a different posting, nothing verified, and one hard
    // constraint never asked.
    const c = confidenceOf({ coverage: 100, writtenForMandate: false, verified: false, hardFailed: 0, hardUnknown: 1, scored: true });
    expect(c.label).toBe("indicative");
    expect(confidenceLine(c)).toMatch(/written for a different role/);
  });
});
