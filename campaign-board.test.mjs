// campaign-board.test.mjs — the reject explainer is the role's own ranking (not a deficiency board)
// and marks shown skills warmly, never as gaps.
import { describe, it, expect } from "vitest";
import { boardFromCoverage, ROLE_SKILLS } from "./campaign-board.mjs";

describe("boardFromCoverage — 'what this seat leans on most', ranked, no gap labeling", () => {
  it("returns all role skills ranked by weight (most-leaned-on first)", () => {
    const b = boardFromCoverage([]);
    expect(b.rows.map((r) => r.label)).toEqual([...ROLE_SKILLS].sort((a, b2) => b2.weight - a.weight).map((s) => s.name));
    expect(b.rows).toHaveLength(ROLE_SKILLS.length);
  });

  it("marks strong/partial as shown (a warm acknowledgment), never as a gap", () => {
    const b = boardFromCoverage([
      { name: "Customer discovery", coverage: "strong" },
      { name: "Writing and narrative", coverage: "partial" },
      { name: "GTM automation and tooling", coverage: "none" },
    ]);
    const shown = Object.fromEntries(b.rows.map((r) => [r.label, r.shown]));
    expect(shown["Customer discovery"]).toBe(true);
    expect(shown["Writing and narrative"]).toBe(true);
    expect(shown["GTM automation and tooling"]).toBe(false); // not shown, but there is no "gap" flag/column
    // the shape carries only label/weight/shown — nothing named "gap" can leak into the render
    for (const r of b.rows) expect(Object.keys(r).sort()).toEqual(["label", "shown", "weight"]);
  });

  it("with no coverage (scorer miss), still returns the ranked role shape with nothing marked", () => {
    const b = boardFromCoverage();
    expect(b.rows).toHaveLength(ROLE_SKILLS.length);
    expect(b.rows.every((r) => r.shown === false)).toBe(true); // fail-safe: role shape explains the fit, no marks
  });
});
