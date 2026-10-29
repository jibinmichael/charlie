// prompts/__tests__/composer-edge.test.mjs — the Edge Engine's compose seam. No live API.
//
// The composer writes the rare-find opening line (edge_frame) ONLY when the caller hands it a RARE-FIND
// EDGE block. These assert the request carries that block exactly when an edge is passed, and that the
// rubric documents the field + its grounding contract.

import { describe, it, expect } from "vitest";
import { buildComposerUserContent, loadComposerPrompt } from "../composer.mjs";
import { stripEdgeMarketJudgments } from "../../composer.mjs";

const base = { dossierText: "{...dossier...}", jobText: "{...job...}", today: "2026-07-17" };
const EDGE = { combo: "architecture + UX design", evidence: ["resume: B.Arch, licensed architect"], strong_in: ["indoor wayfinding"], generic_in: ["fintech"], confidence: "high" };

describe("buildComposerUserContent — the RARE-FIND EDGE block", () => {
  it("adds the edge block only when an edge is passed", () => {
    expect(buildComposerUserContent({ ...base, edge: EDGE })).toContain("## RARE-FIND EDGE");
  });
  it("omits the block (edge_frame stays null) when no edge is passed", () => {
    expect(buildComposerUserContent(base)).not.toContain("RARE-FIND EDGE");
  });
  it("ignores a malformed edge with no combo (no block, no crash)", () => {
    expect(buildComposerUserContent({ ...base, edge: { strong_in: ["x"] } })).not.toContain("RARE-FIND EDGE");
  });
  it("passes the grounded halves (combo + evidence) but NEVER the market judgments", () => {
    const c = buildComposerUserContent({ ...base, edge: EDGE });
    expect(c).toContain("architecture + UX design"); // combo
    expect(c).toContain("B.Arch, licensed architect"); // evidence
    expect(c).not.toContain("indoor wayfinding"); // strong_in must not reach the composer
    expect(c).not.toContain("fintech"); // generic_in must not reach the composer
  });
});

describe("stripEdgeMarketJudgments — the composer never sees strong_in/generic_in", () => {
  it("removes both market arrays from the dossier's edge, keeps the grounded halves", () => {
    const out = stripEdgeMarketJudgments(JSON.stringify({ headline: "x", edge: EDGE }));
    expect(out).toContain("architecture + UX design");
    expect(out).toContain("B.Arch, licensed architect");
    expect(out).not.toContain("indoor wayfinding");
    expect(out).not.toContain("fintech");
  });
  it("passes through a dossier with no edge unchanged", () => {
    const d = JSON.stringify({ headline: "x", strengths: ["a"] });
    expect(JSON.parse(stripEdgeMarketJudgments(d))).toEqual({ headline: "x", strengths: ["a"] });
  });
  it("returns non-JSON input unchanged (defensive, never throws)", () => {
    expect(stripEdgeMarketJudgments("not json")).toBe("not json");
  });
});

describe("composer.md documents edge_frame + its grounding contract", () => {
  const rubric = loadComposerPrompt();
  it("declares edge_frame in the output schema", () => {
    expect(rubric).toContain('"edge_frame"');
  });
  it("says it is null without a RARE-FIND EDGE block", () => {
    expect(rubric).toMatch(/edge_frame is null|is null, always/i);
  });
  it("forbids inventing/upgrading in the opening and never exposes the mechanism", () => {
    expect(rubric).toMatch(/never expose the mechanism|no "edge", "combo"/i);
    expect(rubric).toMatch(/add NO new fact|never invent a third strength/i);
  });
});
