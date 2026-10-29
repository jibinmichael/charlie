// fit-coverage-cache.test.mjs — the fit pass sends a ~3k-token STABLE prefix up to GATE_SCAN (=6)
// times per user per run (scheduler.mjs), same dossier, a different JD each time. This file locks
// the two things that make that prefix cacheable, because both are invisible at runtime: the API
// silently declines to cache a prefix below the model's minimum (Sonnet 4.6 = 1,024 tokens) and
// silently ignores a breakpoint placed behind volatile bytes. No write, no read, NO ERROR — a
// cache_control marker can be attached and inert while reading as "handled".
//
// So the assertions are about ORDER and BREAKPOINT PLACEMENT, not about the presence of the marker:
//   1. CANDIDATE PROFILE (stable) must precede JOB DESCRIPTION (volatile) in the rendered turn.
//   2. The single cache_control breakpoint sits on the dossier block and NOT on the JD block.
//
// Third: computeCoverage's RETURN CONTRACT is unchanged. Reordering the model's INPUT must not move
// its OUTPUT — quality-gate.mjs reads composite/coverage/seniorityLevel/subscores/thin/reason, and a
// shape change there is a wrong send, not a failed test.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Captured `messages.create` params from the most recent call.
let lastParams = null;

const MODEL_REPLY = JSON.stringify({
  requirements: [
    { req: "Design systems", status: "met", evidence: "Owned the design system" },
    { req: "Kubernetes", status: "partial", evidence: "Shipped on Docker" },
    { req: "5+ years", status: "unknown", evidence: null },
  ],
  skills_overlap: 0.7,
  seniority: { level: "at", score: 0.8 },
  domain: 0.6,
  parseable: 0.9,
  top_move: "Lead with the design-system ownership you already have",
  reason_points: ["You own a real design system", "Not 100%: your profile is silent on Kubernetes"],
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      this.messages = {
        create: vi.fn(async (params) => {
          lastParams = params;
          return { content: [{ type: "text", text: MODEL_REPLY }], usage: { input_tokens: 10, output_tokens: 4 } };
        }),
      };
    }
  },
}));

// Dense enough for dossierIsDense (>= 2 items across proof_points/strengths/case_studies/experience).
const DOSSIER = {
  name: "Asha Rao",
  proof_points: [{ claim: "Owned the design system end to end" }, { claim: "Shipped checkout on Docker" }],
  strengths: ["design systems", "accessibility"],
};

// Long enough + carries a REQ_SIGNAL, so jdIsScoreable passes (lib/jd-requirements.mjs).
const JD_A = `We are hiring a Senior Product Designer. You will require deep experience with design systems,
tokens, and adoption across teams. Requirements: 5+ years of experience in product design, proficiency with
Figma, and strong accountability for WCAG AA accessibility. You'll partner with engineering to ship. What
you'll do: own the system, run adoption, and measure it. Familiar with Kubernetes is a plus but not needed.
Responsibilities include mentoring and running design reviews across the whole product organisation here.`;

const JD_B = JD_A.replace("Senior Product Designer", "Staff Design Systems Engineer");

/** The rendered user turn as the API would see it: content blocks concatenate in order. */
function renderedUserTurn(params) {
  const c = params.messages[0].content;
  return typeof c === "string" ? c : c.map((b) => b.text).join("");
}

/** The content blocks of the user turn, normalised so a legacy single string is still inspectable. */
function userBlocks(params) {
  const c = params.messages[0].content;
  return typeof c === "string" ? [{ type: "text", text: c }] : c;
}

beforeEach(() => {
  lastParams = null;
  vi.resetModules();
});

describe("the fit-coverage request is shaped so its stable prefix can actually cache", () => {
  it("puts CANDIDATE PROFILE before JOB DESCRIPTION, so the volatile JD cannot sit in front of the dossier", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    await computeCoverage({ dossier: DOSSIER, jobDescription: JD_A, jobTitle: "Senior Product Designer" });

    const turn = renderedUserTurn(lastParams);
    const profileAt = turn.indexOf("## CANDIDATE PROFILE");
    const jdAt = turn.indexOf("## JOB DESCRIPTION");
    expect(profileAt).toBeGreaterThan(-1);
    expect(jdAt).toBeGreaterThan(-1);
    // The whole point: everything behind a byte that changes per call is uncacheable, and the JD
    // changes on every one of the six gate-walk calls.
    expect(profileAt).toBeLessThan(jdAt);
  });

  it("puts the cache breakpoint on the dossier block and NOT on the JD block", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    await computeCoverage({ dossier: DOSSIER, jobDescription: JD_A, jobTitle: "Senior Product Designer" });

    const blocks = userBlocks(lastParams);
    const marked = blocks.filter((b) => b.cache_control);
    // Exactly one breakpoint: a second one on volatile content would write a fresh entry per call
    // and read none, paying the 1.25x write premium for nothing.
    expect(marked).toHaveLength(1);
    expect(marked[0].cache_control).toEqual({ type: "ephemeral" });
    expect(marked[0].text).toContain("## CANDIDATE PROFILE");
    expect(marked[0].text).not.toContain("## JOB DESCRIPTION");

    const jdBlock = blocks.find((b) => b.text.includes("## JOB DESCRIPTION"));
    expect(jdBlock).toBeDefined();
    expect(jdBlock.cache_control).toBeUndefined();
  });

  it("holds the stable prefix byte-identical across two different jobs for the same person", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");

    await computeCoverage({ dossier: DOSSIER, jobDescription: JD_A, jobTitle: "Senior Product Designer" });
    const firstStable = userBlocks(lastParams).find((b) => b.cache_control)?.text;
    const firstSystem = lastParams.system;

    await computeCoverage({ dossier: DOSSIER, jobDescription: JD_B, jobTitle: "Staff Design Systems Engineer" });
    const secondStable = userBlocks(lastParams).find((b) => b.cache_control)?.text;

    // A single differing byte anywhere in system + this block means zero cache reads. Both halves of
    // the prefix are asserted because the cache key spans tools -> system -> messages, in that order.
    expect(secondStable).toBe(firstStable);
    expect(lastParams.system).toBe(firstSystem);
    // ...and the part that DOES differ is behind the breakpoint, where it belongs.
    expect(renderedUserTurn(lastParams)).toContain("Staff Design Systems Engineer");
  });

  it("does not change the prompt's wording, only its order", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    await computeCoverage({ dossier: DOSSIER, jobDescription: JD_A, jobTitle: "Senior Product Designer" });

    const turn = renderedUserTurn(lastParams);
    // The dossier's label is grounding-load-bearing (it is what tells the model this is the ONLY
    // source of truth about the person). Reordering must not quietly reword it.
    expect(turn).toContain("## CANDIDATE PROFILE (the ONLY source of truth about them)");
    expect(turn).toContain("## TODAY");
    expect(turn).toContain("## ROLE");
    expect(turn).toContain("## JOB DESCRIPTION");
    expect(turn.startsWith("## TODAY")).toBe(true);
  });
});

describe("reordering the INPUT does not change the OUTPUT contract", () => {
  it("returns the same shape quality-gate.mjs reads", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD_A, jobTitle: "Senior Product Designer" });

    expect(cov.thin).toBe(false);
    expect(typeof cov.composite).toBe("number");
    expect(Array.isArray(cov.coverage)).toBe(true);
    expect(cov.coverage[0]).toEqual(expect.objectContaining({ req: expect.any(String), status: expect.any(String) }));
    expect(["under", "at", "over"]).toContain(cov.seniorityLevel);
    expect(cov.subscores).toEqual(expect.objectContaining({
      mustHave: expect.any(Number),
      skills: expect.any(Number),
      seniority: expect.any(Number),
      domain: expect.any(Number),
      parseable: expect.any(Number),
    }));
    expect(typeof cov.reason).toBe("string");
    // The downstream reads that gate the send (quality-gate.mjs unifyScore + the lane/caption the
    // renderer prints) must survive the reorder too.
    expect(["apply", "tune", "bypass"]).toContain(cov.lane);
    expect(cov.caption).toBe("my read of the posting, not their scoreboard");
    expect(cov.counts).toEqual({ met: 1, partial: 1, unknown: 1 });
  });

  it("still fails closed when the model call throws — reason 'error', never a silent pass", async () => {
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        constructor() {
          this.messages = { create: vi.fn(async () => { throw new Error("boom"); }) };
        }
      },
    }));
    const { computeCoverage } = await import("./fit-coverage.mjs");
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD_A, jobTitle: "x" });
    expect(cov).toMatchObject({ thin: true, reason: "error" });
    vi.doUnmock("@anthropic-ai/sdk");
  });
});
