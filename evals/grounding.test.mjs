// evals/grounding.test.mjs — the grounding regression fence (deterministic, no live API).
//
// The semantic grounded/ungrounded judgment is an API call (grounding-verify.mjs `verifyGrounding`,
// exercised separately by `node evals/live.mjs`). This suite fences the DETERMINISTIC enforcement:
// given a labelled corpus of composed emails + the violations a correct auditor returns, it proves
// `citeOrDrop` (grounding-enforce.mjs) drops every flagged claim and never touches a grounded one —
// so a change to the enforcer, the drop rules, or GROUNDING_MODE can't silently weaken grounding.

import { describe, it, expect } from "vitest";
import { citeOrDrop, groundingMode } from "../grounding-enforce.mjs";
import { shouldHold } from "../grounding-verify.mjs";
import { loadCorpus, composerProse, contains } from "./lib/load.mjs";

const composer = loadCorpus("composer");

describe("citeOrDrop fence — every composer fixture", () => {
  for (const fx of composer) {
    it(`${fx.file} (${fx.label}): ${fx.note || ""}`, () => {
      const { fields, cov } = fx.artifact;
      const res = citeOrDrop(fields, cov, fx.violations);

      if (fx.label === "clean") {
        // Nothing is flagged, so nothing is dropped and the grounded surfaces survive intact.
        expect(res.dropped).toHaveLength(0);
        expect(res.allFitDropped).toBe(false);
        expect(res.fields.why_you).toBe(fields.why_you);
        return;
      }

      // Adversarial: at least one surface was dropped, and — the load-bearing invariant —
      // NO flagged claim survives anywhere in the pruned prose.
      expect(res.dropped.length).toBeGreaterThan(0);
      const survivors = composerProse(res.fields, res.cov);
      for (const v of fx.violations) {
        for (const line of survivors) {
          expect(contains(line, v.claim), `flagged claim survived: "${v.claim}" in "${line}"`).toBe(false);
        }
      }
      if (typeof fx.expectAllFitDropped === "boolean") {
        expect(res.allFitDropped).toBe(fx.expectAllFitDropped);
      }
    });
  }
});

describe("enforcement wiring stays intact", () => {
  it("no violations => passthrough (grounded emails are never touched)", () => {
    const fields = { why_you: "grounded", resume_tips: ["a"], facts: [{ k: "x", v: "y" }] };
    const res = citeOrDrop(fields, null, []);
    expect(res.dropped).toHaveLength(0);
    expect(res.fields.why_you).toBe("grounded");
  });

  // Unknown and unset both resolve to the ENFORCING mode. Shadow holds only on HIGH severity, so a
  // default of shadow would let a low/medium violation ship.
  it("groundingMode fails SAFE (unset|unknown => drop; explicit opt-outs pass through)", () => {
    const prev = process.env.GROUNDING_MODE;
    delete process.env.GROUNDING_MODE;
    expect(groundingMode()).toBe("drop"); // enforcement must not depend on an env var being present
    process.env.GROUNDING_MODE = "drop";
    expect(groundingMode()).toBe("drop");
    process.env.GROUNDING_MODE = "hold";
    expect(groundingMode()).toBe("hold");
    process.env.GROUNDING_MODE = "shadow";
    expect(groundingMode()).toBe("shadow");
    process.env.GROUNDING_MODE = "banana";
    expect(groundingMode()).toBe("drop"); // an invalid value must never silently disable enforcement
    if (prev === undefined) delete process.env.GROUNDING_MODE;
    else process.env.GROUNDING_MODE = prev;
  });

  it("shouldHold holds on a high-severity or errored verdict, passes a clean one (enforce default)", () => {
    const prev = process.env.VERIFY_MODE;
    delete process.env.VERIFY_MODE; // unset => enforce
    expect(shouldHold({ ok: false, severity: "high", violations: [{ claim: "x", issue: "y" }] })).toBe(true);
    expect(shouldHold({ ok: false, errored: true, severity: "none", violations: [] })).toBe(true);
    expect(shouldHold({ ok: true, severity: "none", violations: [] })).toBe(false);
    if (prev === undefined) delete process.env.VERIFY_MODE;
    else process.env.VERIFY_MODE = prev;
  });
});
