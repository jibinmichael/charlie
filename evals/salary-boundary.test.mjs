// evals/salary-boundary.test.mjs — the pay-negotiation scope wall can't be silently removed.
//
// WHY: a scope wall that only routes away things "outside their own career" permits pay negotiation,
// which is INSIDE their career. The interrogation prompt therefore carries an explicit clause that
// names negotiation as out of scope even though it is about their career.
//
// This lint asserts the wall's PRESENCE by regex (reword freely, keep the instruction), and asserts the
// offer-stage email doesn't reopen the door it closes. It runs in CI with no API key. It proves the
// instruction is there, not that the model follows it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERROGATE_SYSTEM } from "../prompts/interrogate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// The wall's required clauses. Presence, not phrasing.
const WALL_CLAUSES = {
  "names pay negotiation as out of scope": /negotiation is not your corner/i,
  "refuses to coach a tactic": /do not coach it|never coach|not coach a tactic/i,
  "refuses to name or endorse a figure": /(never|not) (name|endorse)[^.]*figure/i,
  // "Talk only about their career" reads as permission, so the clause must explicitly say the
  // career-scope rule does not rescue negotiation.
  "survives even though negotiation is 'about their career'": /even though it is about their career/i,
};

// The interrogation prompt is the only place an LLM answers the person in free words, so the wall
// lives there.
describe("pay-negotiation scope wall — prompts/interrogate.mjs", () => {
  for (const [label, re] of Object.entries(WALL_CLAUSES)) {
    it(`carries the clause that ${label}`, () => {
      expect(INTERROGATE_SYSTEM).toMatch(re);
    });
  }

  it("keeps the pay-floor ASK (a filter) while refusing the ADVICE (a tactic)", () => {
    expect(INTERROGATE_SYSTEM).toMatch(/pay floor is fine|never send them anything below/i);
  });
});

describe("no surface reopens the door", () => {
  it("the offer-stage email celebrates without inviting Charlie to weigh the number", () => {
    const kit = read("email-kit.mjs");
    // "If you want a hand thinking it through, just reply." at the offer stage would be an open
    // invitation to coach a negotiation, from the one template that fires on an offer.
    expect(kit).not.toMatch(/a hand thinking it through/i);
    expect(kit).toMatch(/An offer\. Huge\./); // the celebration itself stays
  });
});
