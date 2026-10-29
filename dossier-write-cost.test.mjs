// dossier-write-cost.test.mjs — the warning a dossier-writing script prints before it writes.
//
// A script that rewrites dossiers can predict its own model spend correctly and still be blind to the
// cost that matters: changing dossier text changes the match-cache keys, orphaning every cached
// verdict for those people, so the next match run re-scores them at full price.
//
// Both branches are pinned here, because "it always says $0" and "it always says a scary number" are
// each one line of damage away and neither would be noticed in review.

import { describe, it, expect } from "vitest";
import { willInvalidate, invalidationWarning, USD_PER_RESCORED_PAIR } from "./lib/dossier-write-cost.mjs";

const person = {
  headline: "Builds data tools",
  strengths: ["python"],
  preferences: { home_place: "Bengaluru" },
};

describe("willInvalidate — measured against the real scoring projection", () => {
  it("a field OUTSIDE the projection does not invalidate (this is the position case)", () => {
    expect(willInvalidate(person, { ...person, position: { statement: "You build tools" } })).toBe(false);
  });

  it("a field INSIDE the projection does", () => {
    expect(willInvalidate(person, { ...person, headline: "Builds payment systems" })).toBe(true);
    expect(willInvalidate(person, { ...person, strengths: ["go"] })).toBe(true);
  });

  it("an unrecognised NEW field invalidates, because the scorer would be shown it", () => {
    // The honest default. Anything not deliberately excluded reaches the model and moves the key, and
    // a script writing it should be told so rather than reassured.
    expect(willInvalidate(person, { ...person, some_future_field: "hello" })).toBe(true);
  });

  it("writing the same thing twice costs nothing", () => {
    expect(willInvalidate(person, { ...person })).toBe(false);
  });
});

describe("invalidationWarning — the line a human reads at 2am", () => {
  it("says $0 and says WHY, when nothing moves", () => {
    const line = invalidationWarning({ invalidates: false, people: 30, verdicts: 7500 });
    expect(line).toMatch(/\$0\b/);
    expect(line).toMatch(/blind-dossier/); // points at the thing that made it free
    expect(line).not.toMatch(/re-scored/);
  });

  it("quotes a real number when the write does orphan verdicts", () => {
    const line = invalidationWarning({ invalidates: true, people: 30, verdicts: 7500 });
    expect(line).toMatch(/7500/);
    expect(line).toMatch(/30/);
    // An invalidation of this size must be priced at the measured per-pair rate, to the cent.
    expect(line).toMatch(/\$19\.9[0-9]/);
    expect(line).toMatch(/ON TOP of/);
  });

  it("is derived from a measured price, not a guessed one", () => {
    expect(USD_PER_RESCORED_PAIR).toBeCloseTo(0.00266, 5);
    expect(10000 * USD_PER_RESCORED_PAIR).toBeCloseTo(26.644, 3);
  });

  it("does not crash or lie on an empty run", () => {
    expect(invalidationWarning({ invalidates: true })).toMatch(/\$0\.00/);
    expect(invalidationWarning({})).toMatch(/\$0\b/);
  });
});
