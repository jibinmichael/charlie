// wedge.test.mjs — the wedge drip's fail-closed gates.
import { describe, it, expect } from "vitest";
import { wedgeEligible, modelCopyClean, honestyVoiceOk } from "./wedge.mjs";

describe("wedgeEligible — a wedge sends ONLY for a high-confidence grounded edge", () => {
  const combo = "An architecture degree and three years designing maps.";
  it("true only when the verified edge is high-confidence with a real combo", () => {
    expect(wedgeEligible({ edge: { combo, confidence: "high" } })).toBe(true);
  });
  it("false when there is no edge (the common, honest case — most people)", () => {
    expect(wedgeEligible({})).toBe(false);
    expect(wedgeEligible({ edge: null })).toBe(false);
    expect(wedgeEligible(null)).toBe(false);
    expect(wedgeEligible(undefined)).toBe(false);
  });
  it("false for a medium/low/unstamped edge (not rare enough to claim it)", () => {
    expect(wedgeEligible({ edge: { combo, confidence: "medium" } })).toBe(false);
    expect(wedgeEligible({ edge: { combo, confidence: "low" } })).toBe(false);
    expect(wedgeEligible({ edge: { combo } })).toBe(false);
  });
  it("false when the combo is empty even at high confidence (nothing to name)", () => {
    expect(wedgeEligible({ edge: { combo: "   ", confidence: "high" } })).toBe(false);
    expect(wedgeEligible({ edge: { confidence: "high" } })).toBe(false);
  });
});

describe("modelCopyClean — discards composed copy that invents (facts are code-rendered)", () => {
  const good = {
    subject: "I think I found your edge",
    opening: "One thing kept standing out.",
    edge_line: "It is the most valuable thing you bring.",
    advantage_line: "It is an edge in the rooms built for it.",
    honest_line: "Some rooms will not see it, and I will not send you those.",
    close_line: "That is the job.",
  };
  it("passes clean grounded prose", () => expect(modelCopyClean(good)).toBe(true));
  it("rejects any digit — numbers are the template's, never the model's", () => {
    expect(modelCopyClean({ ...good, opening: "3 things stood out." })).toBe(false);
  });
  it("rejects an odds / outcome claim", () => {
    expect(modelCopyClean({ ...good, honest_line: "you'll land it, almost guaranteed" })).toBe(false);
  });
});

describe("honestyVoiceOk — the voice/honesty lint gate", () => {
  it("blocks an em dash (voice rule)", () => {
    expect(honestyVoiceOk({ subject: "x", text: "this — that" }).ok).toBe(false);
  });
});
