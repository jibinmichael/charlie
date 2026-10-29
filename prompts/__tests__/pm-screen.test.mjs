// prompts/__tests__/pm-screen.test.mjs — the product-management and account-manager rubrics, and the
// fence around the design rubric they share parts with.
//
// The screens are assembled from shared template parts, so an edit made for one role can alter
// another by accident: a stray newline where two template literals join, and every designer score
// moves for a reason nobody can find later. The hash below pins the design screen byte for byte, so
// an edit to the shared HEAD or TAIL that changes it fails here and has to be made on purpose.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  XYZ_SCREEN_SYSTEM, PM_SCREEN_SYSTEM, AM_SCREEN_SYSTEM,
  DESIGN_REQUIREMENTS, PM_REQUIREMENTS, AM_REQUIREMENTS, buildXyzMessages,
} from "../xyz-screen.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

describe("the design screen was not disturbed by the split", () => {
  it("is byte for byte what it was before PM_SCREEN_SYSTEM existed", () => {
    // The pinned hash of the design screen. Update it only for an intended change to that prompt.
    // Recompute with: node -e "import('./prompts/xyz-screen.mjs').then(m=>console.log(require('crypto').createHash('sha256').update(m.XYZ_SCREEN_SYSTEM).digest('hex')))"
    expect(sha(XYZ_SCREEN_SYSTEM)).toBe("f9f8fd495dd68048bb749d759a62f71b174ae49168b0d735d5e33e736a50e07c");
  });

  it("keeps its own calibration and does not inherit the PM one", () => {
    expect(XYZ_SCREEN_SYSTEM).toContain("CALIBRATE ON SPECIFICITY, NOT ON METRICS");
    expect(XYZ_SCREEN_SYSTEM).not.toContain("A METRIC WITH NO MECHANISM");
  });
});

describe("the PM anchors invert the design ones", () => {
  it("scores a metric with no mechanism as a 1", () => {
    expect(PM_SCREEN_SYSTEM).toContain("A METRIC WITH NO MECHANISM");
    // The rule has to sit on the 1, not float loose in the prose, or it is decoration.
    expect(PM_SCREEN_SYSTEM).toMatch(/- 1 = [^\n]*A METRIC WITH NO MECHANISM/);
  });

  it("refuses to resolve borrowed credit in the applicant's favour", () => {
    expect(PM_SCREEN_SYSTEM).toContain("Do not resolve that ambiguity in their favour");
    expect(PM_SCREEN_SYSTEM).toMatch(/evidence of the team, not of the applicant/);
  });

  it("does not let a title move a score", () => {
    expect(PM_SCREEN_SYSTEM).toMatch(/Do not let "Senior" or "Lead" in a job title\s+move a score/);
  });

  it("carries none of the design worked examples", () => {
    for (const s of ["design system", "token system", "component library", "information architecture"]) {
      expect(PM_SCREEN_SYSTEM.toLowerCase()).not.toContain(s);
    }
  });

  it("keeps every shared rule the design screen has", () => {
    for (const rule of [
      "Do not invent a quote",           // cite or drop
      "Do not reward vocabulary",
      "You are NOT asked to judge whether writing is AI-assisted",
      "prior_employer_match",
      "COPY RULES",
    ]) expect(PM_SCREEN_SYSTEM).toContain(rule);
  });
});

describe("PM_REQUIREMENTS is the generic product-management set", () => {
  it("has six dimensions, in a fixed order", () => {
    expect(PM_REQUIREMENTS.map((r) => r.key)).toEqual([
      "customer_problem", "prioritisation", "delivery_ownership",
      "outcome_measurement", "stakeholder_alignment", "technical_fluency",
    ]);
  });

  it("scores out of 18, the same as the design screen, so the two are comparable", () => {
    expect(PM_REQUIREMENTS.length * 3).toBe(DESIGN_REQUIREMENTS.length * 3);
  });

  it("asks whether a release worked, not only whether it shipped", () => {
    const d = PM_REQUIREMENTS.find((r) => r.key === "outcome_measurement").label;
    expect(d).toMatch(/whether a release worked/i);
  });

  it("names no industry, so the set stays generic", () => {
    const all = PM_REQUIREMENTS.map((r) => r.label.toLowerCase()).join(" ");
    for (const s of ["saas", "health", "fintech", "e-commerce"]) expect(all).not.toContain(s);
  });

  it("says nothing about years, because years is a slice and not a gate", () => {
    for (const r of PM_REQUIREMENTS) expect(r.label.toLowerCase()).not.toMatch(/\byears?\b|\bsenior\b/);
  });

  it("writes no em dashes into a prompt that forbids them", () => {
    expect(PM_SCREEN_SYSTEM).not.toMatch(/—|–/);
    for (const r of PM_REQUIREMENTS) expect(r.label).not.toMatch(/—|–/);
  });
});

describe("the message builder is genuinely role agnostic", () => {
  it("puts the PM requirements in, in order, and keeps the answers verbatim", () => {
    const msg = buildXyzMessages({
      brief: "Product Manager, example brief",
      requirements: PM_REQUIREMENTS,
      answers: { "Most impressive work": "I cut the wizard from six steps to two." },
      resume: "2019-2026 Product Manager",
    })[0].content;
    expect(msg).toContain("1. Finding a real customer problem");
    expect(msg).toContain("6. Understanding the technical side");
    expect(msg).toContain("I cut the wizard from six steps to two.");
    expect(msg).toContain("2019-2026 Product Manager");
  });
});

describe("AM_REQUIREMENTS is the generic account-management set", () => {
  it("has six dimensions, in a fixed order", () => {
    expect(AM_REQUIREMENTS.map((r) => r.key)).toEqual([
      "book_ownership", "expansion", "renewals",
      "commercial_terms", "account_planning", "pipeline_hygiene",
    ]);
  });

  it("scores out of 18, so it is comparable with the other two screens", () => {
    expect(AM_REQUIREMENTS.length * 3).toBe(PM_REQUIREMENTS.length * 3);
  });

  it("names the thing that separates this job from customer success", () => {
    // A renewal that happened while somebody was the named contact is not a renewal they caused.
    const d = AM_REQUIREMENTS.find((r) => r.key === "book_ownership").label;
    expect(d).toMatch(/what they personally did to keep or grow it/i);
  });

  it("asks how the expansion opening was found", () => {
    expect(AM_REQUIREMENTS.find((r) => r.key === "expansion").label).toMatch(/how they found the opening/i);
  });

  it("says nothing about years or seniority, because that is a slice and not a gate", () => {
    for (const r of AM_REQUIREMENTS) expect(r.label.toLowerCase()).not.toMatch(/\byears?\b|\bsenior\b/);
  });

  it("writes no em dash into a prompt that forbids them", () => {
    expect(AM_SCREEN_SYSTEM).not.toMatch(/—|–/);
    for (const r of AM_REQUIREMENTS) expect(r.label).not.toMatch(/—|–/);
  });

  it("treats support work as different, never as lesser", () => {
    expect(AM_SCREEN_SYSTEM).toMatch(/SUPPORT IS A DIFFERENT JOB, NOT A LESSER ONE/);
    expect(AM_SCREEN_SYSTEM).toMatch(/do not mark somebody down as a person/i);
  });

  it("scores relationship language as a claim, which is the whole calibration", () => {
    expect(AM_SCREEN_SYSTEM).toMatch(/RELATIONSHIP LANGUAGE IS NOT EVIDENCE/);
    expect(AM_SCREEN_SYSTEM).toMatch(/A COMPANY NUMBER WITH NO PERSONAL ACTION/);
  });
});
