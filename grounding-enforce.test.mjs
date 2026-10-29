// grounding-enforce.test.mjs — cite-or-drop must remove EXACTLY the flagged claims and
// nothing grounded, and must flag the all-dropped fallback. This is the moat's enforcement, so the
// arithmetic of what survives has to be exact.
import { describe, it, expect } from "vitest";
import { citeOrDrop, groundingMode, groundingDecision, hasFitContent } from "./grounding-enforce.mjs";
import { shouldHold } from "./grounding-verify.mjs"; // the REAL gate, so drift in it fails this suite

const V = (claim) => ({ claim, issue: "ungrounded" });

describe("citeOrDrop", () => {
  it("no violations → returns the input untouched", () => {
    const fields = { why_you: "You own a real design system", resume_tips: ["Lead with tokens"] };
    const r = citeOrDrop(fields, { thin: true }, []);
    expect(r.dropped).toEqual([]);
    expect(r.fields.why_you).toBe("You own a real design system");
    expect(r.allFitDropped).toBe(false);
  });

  it("drops a flagged prose field, keeps grounded ones", () => {
    const fields = { why_you: "You scaled the team to 200 engineers", flag: "Not 100%: light on AI workflows" };
    const cov = { thin: false, reason: "Strong systems background", coverage: [{ req: "Design systems", status: "met", evidence: "owned tokens" }] };
    const r = citeOrDrop(fields, cov, [V("scaled the team to 200 engineers")]);
    expect(r.fields.why_you).toBeNull(); // flagged → dropped
    expect(r.fields.flag).toBe("Not 100%: light on AI workflows"); // grounded → kept
    expect(r.cov.reason).toBe("Strong systems background"); // readout survives
    expect(r.allFitDropped).toBe(false);
    expect(r.dropped.some((d) => d.startsWith("why_you"))).toBe(true);
  });

  it("drops a flagged edge_frame (the rare-find opening is prunable, not just verifiable)", () => {
    const fields = {
      why_you: "You own a real wayfinding design system",
      edge_frame: "You bring both architecture and eight years of airport master-planning work", // master-planning part is inflated
    };
    const r = citeOrDrop(fields, { thin: true }, [V("eight years of airport master-planning work")]);
    expect(r.fields.edge_frame).toBeNull(); // flagged → dropped (never ships ungrounded)
    expect(r.fields.why_you).toBe("You own a real wayfinding design system"); // grounded → kept
    expect(r.dropped.some((d) => d.startsWith("edge_frame"))).toBe(true); // counts toward the HOLD guard
  });

  it("keeps a grounded edge_frame untouched", () => {
    const fields = { edge_frame: "You bring both an architecture degree and three years designing indoor maps" };
    const r = citeOrDrop(fields, { thin: true }, [V("some other unrelated claim")]);
    expect(r.fields.edge_frame).toBe(fields.edge_frame);
    expect(r.dropped.some((d) => d.startsWith("edge_frame"))).toBe(false);
  });

  it("filters only the flagged items out of resume_tips and facts", () => {
    const fields = {
      resume_tips: ["Lead with your design system work", "Emphasize the invented Series-C raise"],
      facts: [{ k: "location", v: "Bengaluru" }, { k: "title", v: "VP Engineering (inflated)" }],
    };
    const r = citeOrDrop(fields, { thin: true }, [V("invented Series-C raise"), V("VP Engineering (inflated)")]);
    expect(r.fields.resume_tips).toEqual(["Lead with your design system work"]);
    expect(r.fields.facts).toEqual([{ k: "location", v: "Bengaluru" }]);
  });

  it("strips ungrounded evidence off a met readout row (keeps the requirement, downgrades to partly)", () => {
    const cov = { thin: false, coverage: [{ req: "Accessibility", status: "met", evidence: "led WCAG program for 500 apps" }] };
    const r = citeOrDrop({}, cov, [V("led WCAG program for 500 apps")]);
    expect(r.cov.coverage[0]).toMatchObject({ req: "Accessibility", status: "partly", evidence: "" });
    expect(r.dropped).toContain("fit_met: Accessibility");
  });

  it("allFitDropped is true only when NOTHING grounded survives (fallback → neutral + review)", () => {
    // thin readout + the only fit prose (why_you) is flagged → no fit content remains.
    const r = citeOrDrop({ why_you: "invented claim" }, { thin: true }, [V("invented claim")]);
    expect(r.fields.why_you).toBeNull();
    expect(r.allFitDropped).toBe(true);
  });

  it("allFitDropped is false when a live readout survives even if why_you is dropped", () => {
    const cov = { thin: false, reason: "solid", coverage: [{ req: "X", status: "met", evidence: "y" }] };
    const r = citeOrDrop({ why_you: "bad claim" }, cov, [V("bad claim")]);
    expect(r.fields.why_you).toBeNull();
    expect(r.allFitDropped).toBe(false); // readout carries the grounded story
  });
});

describe("groundingMode", () => {
  const orig = process.env.GROUNDING_MODE;
  const restore = () => { if (orig == null) delete process.env.GROUNDING_MODE; else process.env.GROUNDING_MODE = orig; };
  it("defaults to drop (enforcing) — the moat must not depend on an env var being present", () => {
    delete process.env.GROUNDING_MODE; expect(groundingMode()).toBe("drop");
    process.env.GROUNDING_MODE = ""; expect(groundingMode()).toBe("drop"); // set-but-blank is still unset
    restore();
  });
  it("maps the explicit opt-outs", () => {
    process.env.GROUNDING_MODE = "drop"; expect(groundingMode()).toBe("drop");
    process.env.GROUNDING_MODE = "hold"; expect(groundingMode()).toBe("hold");
    process.env.GROUNDING_MODE = "shadow"; expect(groundingMode()).toBe("shadow");
    process.env.GROUNDING_MODE = " SHADOW "; expect(groundingMode()).toBe("shadow"); // tolerant of case/space
    restore();
  });
  // An unknown value (GROUNDING_MODE=enforce is a plausible typo, not a valid value) must fail SAFE,
  // never silently become a mode that ships flagged claims.
  it("an unknown value falls back to drop (safe), not shadow (leaky)", () => {
    process.env.GROUNDING_MODE = "enforce"; expect(groundingMode()).toBe("drop");
    process.env.GROUNDING_MODE = "whatever"; expect(groundingMode()).toBe("drop");
    restore();
  });
});

// ── the send-time decision ────────────────────────────────────────────────────────────────────
// The branch that decides whether an ungrounded claim ships, extracted from scheduler.mjs so it can be
// asserted without running a send.
describe("groundingDecision", () => {
  // stand-in for grounding-verify's shouldHold: holds on high severity or a verifier error.
  const holds = (v) => v?.skipped ? false : (v?.severity === "high" || v?.errored === true);
  const pruned = (n) => ({ dropped: Array.from({ length: n }, (_, i) => `why_you: claim ${i}`) });

  it("high severity HOLDS in every mode — including the shadow opt-out", () => {
    for (const mode of ["drop", "shadow", "hold"]) {
      expect(groundingDecision({ severity: "high", violations: [1] }, pruned(1), mode, holds)).toBe("hold");
    }
  });
  it("a verifier that ERRORED holds (uncertainty is never a clean bill)", () => {
    expect(groundingDecision({ errored: true }, null, "drop", holds)).toBe("hold");
    expect(groundingDecision({ errored: true }, null, "shadow", holds)).toBe("hold");
  });

  // "Low" verdicts with named violations: shouldHold only fires on "high", so unless the named claims
  // are pruned they ship.
  it("low severity with localizable violations PRUNES", () => {
    expect(groundingDecision({ severity: "low", violations: [1] }, pruned(1), "drop", holds)).toBe("prune");
  });
  it("medium severity with localizable violations also prunes", () => {
    expect(groundingDecision({ severity: "medium", violations: [1] }, pruned(2), "drop", holds)).toBe("prune");
  });

  // Fail-closed: the verifier named claims but the substring matcher localized none of them, so we
  // cannot PROVE the bad claim is gone, so it holds whatever the severity.
  it("violations named but NONE localizable holds, even at low severity", () => {
    expect(groundingDecision({ severity: "low", violations: [1] }, pruned(0), "drop", holds)).toBe("hold");
  });

  it("a clean verdict sends unchanged", () => {
    expect(groundingDecision({ severity: "none", violations: [] }, null, "drop", holds)).toBe("send");
    expect(groundingDecision({ skipped: true }, null, "drop", holds)).toBe("send"); // skipped ≠ hold (no over-suppression)
  });
  it("the shadow/hold opt-outs suppress pruning but never the hold", () => {
    expect(groundingDecision({ severity: "low", violations: [1] }, pruned(1), "shadow", holds)).toBe("send");
    expect(groundingDecision({ severity: "low", violations: [1] }, pruned(1), "hold", holds)).toBe("send");
    expect(groundingDecision({ severity: "high", violations: [1] }, pruned(1), "shadow", holds)).toBe("hold");
  });

  // Replay of four low-severity verdicts, using the verifier's own claim spans
  // fed through the REAL citeOrDrop and the REAL shouldHold — not a synthetic pruned object, which
  // would make this pass by construction and prove nothing about localizability.
  // All four must be removed before send.
  it("replays 4 low-severity verdicts through citeOrDrop — all prune, and the claim is gone", () => {
    const real = [
      // verifier: "This instruction inflates or invents a claim not supported by the resume."
      { field: "resume_tips", claim: "the billing gateway you shipped at Quillmark" },
      { field: "resume_tips", claim: "Clarify in any intro note what 'Lead' on your resume actually meant" },
      { field: "resume_tips", claim: "Call out your design systems contribution at Brindle Labs" },
      { field: "why_you", claim: "The Bangalore location is a practical fit" },
    ];
    for (const r of real) {
      const fields = r.field === "why_you"
        ? { why_you: `${r.claim} for this role.`, resume_tips: ["Lead with shipped work"] }
        : { why_you: "You have shipped end-to-end product work.", resume_tips: [`${r.claim}.`] };
      const p = citeOrDrop(fields, { thin: true }, [V(r.claim)]);

      // 1. the enforcer must actually localize it
      expect(p.dropped.length, `"${r.claim}" must be localizable`).toBeGreaterThan(0);
      // 2. the decision must be to prune, using the REAL shouldHold with VERIFY_MODE at its default
      const decision = groundingDecision({ severity: "low", violations: [V(r.claim)] }, p, "drop", shouldHold);
      expect(decision, `"${r.claim}" must not ship`).toBe("prune");
      // 3. and the flagged text must be gone from every surface the email renders
      const surviving = JSON.stringify([p.fields.why_you, p.fields.lede, p.fields.resume_tips]).toLowerCase();
      expect(surviving).not.toContain(r.claim.toLowerCase());
    }
  });

  // The lede fallback: render-email.mjs shows `lede` under the "Why you" label when why_you is null.
  // If lede were not prunable, pruning an ungrounded why_you would substitute an UNVERIFIED line in
  // the same slot — the moat dropping one claim and rendering another.
  it("a flagged lede is pruned too (it renders in the why_you slot)", () => {
    const claim = "You led a team of 40 engineers";
    const p = citeOrDrop({ why_you: null, lede: `${claim}.` }, { thin: true }, [V(claim)]);
    expect(p.fields.lede).toBeNull();
    expect(p.dropped.some((d) => d.startsWith("lede"))).toBe(true);
  });
});

// ── an email can never ship with a blank fit section ─────────────────────────────────────────────
//
// If composed.why_you is null and the posting is too thin to score (so the fit meter is hidden),
// render-email.mjs falls back to `f.why_you || f.lede`, and the person reads the generic lede under
// the heading "Why you": no score, no chart, no reason. Two independent holes lead there, and both are
// covered here.
describe("never a blank fit section", () => {
  describe("hole 1: the thin diagnostic was mistaken for surviving fit prose", () => {
    const fields = { why_you: "Priya led the Acme rocket programme", lede: "One role today. Worth a look." };
    const violations = [{ claim: "priya led the acme rocket programme" }];

    it('cov.reason "jd" is a DIAGNOSTIC, not content — allFitDropped must fire', () => {
      // fit-coverage returns { thin: true, reason: "jd" } when the POSTING is too vague to score.
      // Treating that label as surviving fit content is what silenced the fallback AND the alarm.
      const r = citeOrDrop(fields, { thin: true, reason: "jd" }, violations);
      expect(r.fields.why_you).toBeNull();
      expect(r.allFitDropped).toBe(true);
    });

    it('the same for reason "dossier" (we know too little about the PERSON)', () => {
      expect(citeOrDrop(fields, { thin: true, reason: "dossier" }, violations).allFitDropped).toBe(true);
    });

    it("a LIVE readout's reason is real prose and still counts as content", () => {
      // Not thin -> `reason` is the model's fit sentence, so it legitimately stands on its own.
      const cov = { thin: false, reason: "Ships backend systems at scale.", coverage: [] };
      expect(citeOrDrop(fields, cov, violations).allFitDropped).toBe(false);
    });
  });

  describe("hole 2: the guard only ran when the verifier flagged something", () => {
    // The composer may legitimately return why_you: null (the schema allows it). With no violations
    // there is no cite-or-drop pass at all, so the "never claim-less" check never executed.
    //
    // No fit content -> HOLD the send. Silence beats a reason-less email: an email whose entire reason
    // for existing is the fit, sent without one, is a half-confident send. The role stays in the pool
    // for the next run.
    it("no meter and no why_you -> NOT sendable (hold)", () => {
      expect(hasFitContent({ why_you: null, lede: "One role today. Worth a look." }, { readoutShown: false })).toBe(false);
    });

    it("NEVER accepts the lede as fit content (one generic line for another is the trap)", () => {
      expect(hasFitContent({ why_you: "", lede: "A nice sentence that says nothing about fit." }, { readoutShown: false })).toBe(false);
      expect(hasFitContent({ why_you: "   ", lede: "x" }, { readoutShown: false })).toBe(false);
    });

    it("a real why_you is sendable without the meter", () => {
      expect(hasFitContent({ why_you: "Your OMS/WMS work maps to their fulfilment stack." }, { readoutShown: false })).toBe(true);
    });

    it("the meter alone is sendable — the grounded score IS the fit content", () => {
      expect(hasFitContent({ why_you: null }, { readoutShown: true })).toBe(true);
    });

    it("never throws on a missing/odd fields object", () => {
      expect(() => hasFitContent(null, { readoutShown: false })).not.toThrow();
      expect(hasFitContent(undefined, {})).toBe(false); // unknown -> not sendable (fail closed)
    });
  });
});
