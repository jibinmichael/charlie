// emails/no-unbacked-promises.test.mjs — no template may promise something the code cannot do.
//
// A template must never promise a cadence or outcome the code does not implement (e.g. "up to three
// roles a day": scheduler.mjs sends one top above-bar role per user per run). The product promises
// EFFORT, never RESULT, and never a number it cannot count.
//
// The HTML and plaintext of a template are written separately by hand, so fixing one can leave the
// other wrong. These tests read BOTH.

import { describe, it, expect } from "vitest";
import { renderFounderNote, renderWelcome, renderThesisNewsletter, renderCompletenessNudge, renderTrackAck, renderMarketGap } from "../email-kit.mjs";

const base = { email: "sam@example.com", name: "Sam" };

// Every rendered surface of a template: HTML and the hand-written plaintext both reach a human.
const surfaces = (m) => [m.html, m.text, m.subject].filter(Boolean);

const TEMPLATES = {
  "founder note": renderFounderNote({ ...base, linkedin: "https://www.linkedin.com/in/example/" }),
  welcome: renderWelcome({ ...base, ask: "remote, a city, or either?", strength: "shipped the checkout redesign" }),
  "welcome (thin)": renderWelcome({ ...base, thin: true }),
  "thesis newsletter": renderThesisNewsletter(base),
  "completeness nudge": renderCompletenessNudge({ ...base, last: false }),
  "track ack (offer)": renderTrackAck({ ...base, outcome: "offer", company: "Acme" }),
  // the market-gap drop's fail-closed DEFAULT copy (copy=null) — its whole point is honesty, so it must
  // clear the outcome-promise guard. Both closes exercised.
  "market-gap (share)": renderMarketGap({ ...base, gap: { gap: "product analytics", key: "product analytics" }, count: 3, total: 5, kind: "share", stalled: false, research: {}, copy: null }),
  "market-gap (pref, stalled)": renderMarketGap({ ...base, gap: { gap: "comp floor", key: "comp floor" }, count: 2, total: 4, kind: "pref", stalled: true, research: {}, copy: null }),
};

// A cadence we do not implement. scheduler.mjs sends at most one role per user per run.
const MULTI_ROLE_PROMISE = /\b(three|3|two|2|several|multiple)\s+(a|per)\s+day\b|\bup to (three|3|two|2)\b/i;

// Outcomes nobody can promise. The product may promise EFFORT, never RESULT.
const OUTCOME_PROMISE = /\b(I'?ll|I will|we'?ll|we will|you'?ll)\s+(get you|land you|guarantee|ensure)\s+(a |an )?(job|offer|interview|callback|role)\b|\bguarantee(d)?\b/i;

describe("no template promises a cadence the code cannot deliver", () => {
  for (const [name, m] of Object.entries(TEMPLATES)) {
    it(`${name}: never promises multiple roles a day`, () => {
      for (const s of surfaces(m)) expect(s).not.toMatch(MULTI_ROLE_PROMISE);
    });
  }

  it("the founder note says the true thing instead (one role, only when it clears the bar)", () => {
    const m = TEMPLATES["founder note"];
    // Both surfaces, because they are written separately and drift apart.
    expect(m.html).toMatch(/one role at a time, only when it genuinely clears your bar/i);
    expect(m.text).toMatch(/one role at a time, only when it genuinely clears your bar/i);
  });
});

describe("no template promises an outcome", () => {
  for (const [name, m] of Object.entries(TEMPLATES)) {
    it(`${name}: promises the effort, never the result`, () => {
      for (const s of surfaces(m)) expect(s).not.toMatch(OUTCOME_PROMISE);
    });
  }
});
