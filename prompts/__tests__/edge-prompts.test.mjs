// prompts/__tests__/edge-prompts.test.mjs — the Edge Engine prompts are importable and define the
// contract the code + schema depend on. No live API.

import { describe, it, expect } from "vitest";
import { EDGE_ADDENDUM } from "../dossier-build.mjs";
import { EDGE_VERIFY_SYSTEM } from "../edge-verify.mjs";

describe("EDGE_ADDENDUM defines the edge object the schema stores", () => {
  it("is a non-empty string", () => {
    expect(typeof EDGE_ADDENDUM).toBe("string");
    expect(EDGE_ADDENDUM.length).toBeGreaterThan(200);
  });
  it.each(["combo", "evidence", "strong_in", "generic_in", "source"])("names the %s field", (key) => {
    expect(EDGE_ADDENDUM).toContain(`"${key}"`);
  });
  it("instructs the model to add the edge alongside the dossier.md fields (not replace them)", () => {
    expect(EDGE_ADDENDUM).toMatch(/add this one field|alongside the fields/i);
  });
});

describe("EDGE_VERIFY_SYSTEM audits both grounding and rarity", () => {
  it("checks the combo is grounded in the source", () => {
    expect(EDGE_VERIFY_SYSTEM).toMatch(/grounded/i);
    expect(EDGE_VERIFY_SYSTEM).toMatch(/each half of the combo/i);
  });
  it("judges rarity/differentiator, not just grounding", () => {
    expect(EDGE_VERIFY_SYSTEM).toMatch(/rare|differentiator/i);
  });
  it("fails closed under uncertainty", () => {
    expect(EDGE_VERIFY_SYSTEM).toMatch(/fail closed|worse than none/i);
  });
  // Moat guard: the verifier must catch a NEW person-fact smuggled into
  // the free-text market fields, not wave them through. If this clause is ever softened, an invented
  // "8 years of FDA experience" inside strong_in could survive into a stored dossier.
  it("catches a new person-fact hidden in the market fields (strong_in/generic_in)", () => {
    expect(EDGE_VERIFY_SYSTEM).toMatch(/new fact about the person/i);
    expect(EDGE_VERIFY_SYSTEM).toMatch(/strong_in or generic_in/i);
  });
});
