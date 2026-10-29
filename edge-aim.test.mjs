// edge-aim.test.mjs — Edge Engine: the interrogation AIM-confirmation block (dark). No API.
//
// edgeAimBlock() decides whether the interrogation surfaces the person's rare combination so it can
// confirm the aim with them. It must be gated (flag on + high-confidence edge), name the grounded combo,
// and pass the market spaces only as something to ASK about — never assert them as experience.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { edgeAimBlock } from "./email-onboard.mjs";

const EDGE = { combo: "architecture degree + UX design for indoor navigation", strong_in: ["wayfinding UX", "venue mapping tools"], confidence: "high" };
const dossierWith = (edge) => ({ headline: "product designer", edge });

const ENV = process.env.EDGE_ENGINE;
beforeEach(() => { process.env.EDGE_ENGINE = "on"; });
afterEach(() => { if (ENV === undefined) delete process.env.EDGE_ENGINE; else process.env.EDGE_ENGINE = ENV; });

describe("edgeAimBlock", () => {
  it("surfaces the combo + the spaces-to-ask-about when flag on + high-confidence edge", () => {
    const b = edgeAimBlock(dossierWith(EDGE));
    expect(b).toContain("THEIR RARE COMBINATION");
    expect(b).toContain("architecture degree + UX design for indoor navigation"); // grounded combo, named
    expect(b).toContain("wayfinding UX; venue mapping tools"); // strong_in, framed as ask-not-assert
    expect(b).toMatch(/ask, do not assert/i);
  });

  it("is empty (dark) when EDGE_ENGINE is off, even with a high-confidence edge", () => {
    delete process.env.EDGE_ENGINE;
    expect(edgeAimBlock(dossierWith(EDGE))).toBe("");
  });

  it("is empty for a non-high-confidence edge", () => {
    expect(edgeAimBlock(dossierWith({ ...EDGE, confidence: "medium" }))).toBe("");
    expect(edgeAimBlock(dossierWith({ ...EDGE, confidence: "low" }))).toBe("");
  });

  it("is empty when there is no edge or no combo", () => {
    expect(edgeAimBlock({ headline: "x" })).toBe("");
    expect(edgeAimBlock(dossierWith(null))).toBe("");
    expect(edgeAimBlock(dossierWith({ strong_in: ["x"], confidence: "high" }))).toBe(""); // no combo
  });

  it("handles a combo with no strong_in (names the pairing, omits the spaces line)", () => {
    const b = edgeAimBlock(dossierWith({ combo: "a + b", confidence: "high" }));
    expect(b).toContain("a + b");
    expect(b).not.toContain("spaces where this pairing");
  });

  it("never throws on junk input", () => {
    expect(() => edgeAimBlock(null)).not.toThrow();
    expect(edgeAimBlock(null)).toBe("");
  });
});
