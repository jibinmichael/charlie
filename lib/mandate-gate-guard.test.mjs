// mandate-gate-guard.test.mjs — the structural guard on mandate eligibility blocks.
//
// It cannot read a mandate brief, so it cannot know that a must-have was omitted. What it CAN enforce
// is that no mandate silently has no gate, that every gate entry points at a fact we really collect,
// and that every gated fact carries the board column a client has to be able to see.
import { describe, it, expect } from "vitest";
import { MANDATES } from "./mandates.mjs";

/**
 * Mandates deliberately without a gate, each with the reason. Same idiom as FORMS_WITHOUT_MANDATE:
 * acknowledging one is the act of saying "seen, decided", and deleting a line makes the test ask again.
 */
const NO_GATE_YET = {
  globex: "This example brief lists skills to be shown through work, none of them yes-or-no, so everything is scored and nothing is gated. Revisit if the client adds a hard requirement.",
  umbrella: "This example brief names a seniority band but no hard minimum, and its tooling list is described as flexible. Nothing in it is binary enough to gate on without asking the client first.",
};

describe("every mandate has a gate or a stated reason it does not", () => {
  for (const [key, m] of Object.entries(MANDATES)) {
    it(`${key}`, () => {
      const gated = Array.isArray(m.eligibility) && m.eligibility.length > 0;
      if (!gated) {
        expect(NO_GATE_YET[key], `${key} has no eligibility block and no entry in NO_GATE_YET`).toBeTruthy();
        expect(NO_GATE_YET[key].length).toBeGreaterThan(40); // a reason, not a shrug
      } else {
        expect(NO_GATE_YET[key], `${key} has a gate AND an exemption; delete the exemption`).toBeUndefined();
      }
    });
  }
});

describe("every gate entry is answerable and visible", () => {
  const gated = Object.entries(MANDATES).filter(([, m]) => m.eligibility?.length);

  for (const [key, m] of gated) {
    const factKeys = new Set((m.facts || []).map((f) => f.key));
    const factCol = new Map((m.facts || []).map((f) => [f.key, f.column]));

    it(`${key}: every rule names the client's criterion`, () => {
      for (const r of m.eligibility) {
        expect(r.key, `${key} rule missing key`).toBeTruthy();
        expect(typeof r.criterion, `${key}/${r.key} criterion must be the client's wording`).toBe("string");
        expect(r.criterion.length, `${key}/${r.key} criterion too short to be a real must-have`).toBeGreaterThan(15);
        expect(typeof r.test).toBe("function");
      }
    });

    it(`${key}: a rule that reads a fact reads one we actually collect`, () => {
      for (const r of m.eligibility.filter((x) => x.fact)) {
        expect(factKeys.has(r.fact), `${key}/${r.key} reads fact "${r.fact}" which ${key} does not collect`).toBe(true);
      }
    });

    // THE VIEW GUARD. A gated fact needs a board column, or it exists on the data source but never
    // appears in the view the client reads.
    it(`${key}: every gated fact carries the board column a client must see`, () => {
      for (const r of m.eligibility.filter((x) => x.fact)) {
        expect(r.column, `${key}/${r.key} has no board column`).toBeTruthy();
        expect(r.column, `${key}/${r.key} column disagrees with the fact's own column`).toBe(factCol.get(r.fact));
      }
    });

    it(`${key}: a rule with no fact declares why it cannot be answered`, () => {
      for (const r of m.eligibility.filter((x) => !x.fact)) {
        const out = r.test(undefined);
        expect(out.state, `${key}/${r.key} has no fact but does not report itself uncollectable`).toBe("uncollectable");
        expect(out.why.length, `${key}/${r.key} must say what we would have to ask instead`).toBeGreaterThan(40);
      }
    });

    it(`${key}: rule keys are unique`, () => {
      const keys = m.eligibility.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }
});
