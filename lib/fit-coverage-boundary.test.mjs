// fit-coverage-boundary.test.mjs — the Zod boundary on the fit-coverage model call, and the extra
// fields the same call returns. NEITHER MAY MOVE A LIVE DECISION, and that is what this file is for.
//
// The two properties:
//   1. an un-enriched, well-formed reply produces the same output as the plain coverage arithmetic
//   2. a malformed requirement is scored UNKNOWN and LOGGED — never dropped, because dropping it
//      removes it from the coverage denominator and RAISES the score (fail-open)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { CoverageReply, parseRequirement, REQ_STATUSES, REQ_KINDS } from "./schemas/fit-coverage.mjs";

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { create: createMock }; } },
}));

const { computeCoverage } = await import("../fit-coverage.mjs");

const DOSSIER = { proof_points: ["shipped a design system", "led accessibility"], strengths: ["React"], experience: [{ company: "Acme" }] };
// jdIsScoreable (lib/jd-requirements.mjs) needs >= 400 chars AND a requirement signal, so this
// fixture is long enough to be scoreable at all — otherwise every case below returns reason "jd".
const JD = `We are looking for a senior product designer to own our component library end to end.

Requirements: 5+ years of design systems experience across web and mobile surfaces. Strong
accessibility background, including WCAG AA accountability on a shipped product. Must be fluent in
React and comfortable working directly in the codebase alongside engineers. Bachelor's degree
preferred but not required.

What you'll do: own the tokens through adoption, partner with engineering on the component API,
and run the design review forum. You'll report to the Head of Design.`;

const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], usage: {} });

const BASE = {
  requirements: [
    { req: "Design systems", status: "met", evidence: "shipped a design system" },
    { req: "Accessibility", status: "partial", evidence: "led accessibility" },
    { req: "React", status: "unknown", evidence: null },
  ],
  skills_overlap: 0.6, seniority: { level: "at", score: 0.7 }, domain: 0.5, parseable: 0.9,
  top_move: "surface the design system work", reason_points: ["You own a real design system", "Not 100%: React is unshown"],
};

beforeEach(() => { createMock.mockReset(); });

describe("an un-enriched reply behaves exactly as it did before", () => {
  it("produces the same composite, counts and coverage rows", async () => {
    createMock.mockResolvedValue(reply(BASE));
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD, jobTitle: "Product Designer" });
    expect(cov.thin).toBe(false);
    expect(cov.counts).toEqual({ met: 1, partial: 1, unknown: 1 });
    // mustHave = (1 + 0.5)/3 = 0.5 -> composite = 100*(0.4*.5 + 0.25*.6 + 0.2*.7 + 0.1*.5 + 0.05*.9)
    expect(cov.subscores.mustHave).toBe(0.5);
    expect(cov.composite).toBe(Math.round(100 * (0.4 * 0.5 + 0.25 * 0.6 + 0.2 * 0.7 + 0.1 * 0.5 + 0.05 * 0.9)));
    expect(cov.coverage.map((r) => [r.req, r.status])).toEqual([
      ["Design systems", "met"], ["Accessibility", "partial"], ["React", "unknown"],
    ]);
  });

  it("records the stage-1 fields as null rather than omitting them", async () => {
    createMock.mockResolvedValue(reply(BASE));
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    for (const r of cov.coverage) {
      expect(r).toHaveProperty("gating", null);
      expect(r).toHaveProperty("kind", null);
      expect(r).toHaveProperty("locator", null);
    }
  });

  it("still tolerates every field the old code defaulted (missing screen, missing reason_points)", async () => {
    createMock.mockResolvedValue(reply({ requirements: BASE.requirements, skills_overlap: 0.6, seniority: { level: "at", score: 0.7 }, domain: 0.5, parseable: 0.9 }));
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    expect(cov.thin).toBe(false);
    expect(cov.screen).toEqual({ level: null, domain: null, recent: null });
  });
});

describe("the stage-1 fields are carried through when present", () => {
  it("stores gating, kind and locator verbatim", async () => {
    createMock.mockResolvedValue(reply({
      ...BASE,
      requirements: [
        { req: "Design systems", status: "met", evidence: "shipped a design system", gating: true, kind: "capability", locator: "proof points" },
        { req: "Bachelor's degree", status: "unknown", evidence: null, gating: false, kind: "credential", locator: null },
      ],
    }));
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    expect(cov.coverage[0]).toMatchObject({ gating: true, kind: "capability", locator: "proof points" });
    expect(cov.coverage[1]).toMatchObject({ gating: false, kind: "credential", locator: null });
  });

  it("does NOT let the new fields change the composite — they are recorded, not scored", async () => {
    createMock.mockResolvedValue(reply(BASE));
    const plain = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    createMock.mockResolvedValue(reply({
      ...BASE,
      requirements: BASE.requirements.map((r) => ({ ...r, gating: true, kind: "capability", locator: "proof points" })),
    }));
    const enriched = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    expect(enriched.composite).toBe(plain.composite);
    expect(enriched.counts).toEqual(plain.counts);
  });
});

describe("a malformed requirement fails CLOSED, and is no longer silent", () => {
  it('scores an unrecognised status as unknown and KEEPS it in the denominator', async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // "partly" is not a hypothetical: grounding-enforce.mjs can write it.
    createMock.mockResolvedValue(reply({ ...BASE, requirements: [
      { req: "Design systems", status: "met", evidence: "shipped a design system" },
      { req: "Accessibility", status: "partly", evidence: "led accessibility" },
      { req: "React", status: "unknown", evidence: null },
    ] }));
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    expect(cov.coverage).toHaveLength(3);                       // kept: the denominator is unchanged
    expect(cov.coverage[1].status).toBe("unknown");             // scored as unproven, not as 0.5 credit
    expect(cov.subscores.mustHave).toBe(0.33);                  // 1 met of 3 (stored to 2dp) — the fail-CLOSED direction
    expect(err.mock.calls.flat().join(" ")).toMatch(/requirement failed schema/i);
    err.mockRestore();
  });

  it("drops a requirement with no label, exactly as before", async () => {
    createMock.mockResolvedValue(reply({ ...BASE, requirements: [{ req: "", status: "met" }, ...BASE.requirements] }));
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    expect(cov.coverage).toHaveLength(3);
  });

  it("a reply that is not a usable object retries, then goes thin — it never invents a score", async () => {
    createMock.mockResolvedValue(reply([1, 2, 3])); // an array, not an object
    const cov = await computeCoverage({ dossier: DOSSIER, jobDescription: JD });
    expect(cov).toEqual({ thin: true, reason: "error", error: expect.stringMatching(/schema/i) });
    expect(createMock).toHaveBeenCalledTimes(2); // the existing retry is preserved
  });
});

describe("the schema itself", () => {
  it("accepts contradicted so the field is forward-compatible, though nothing requests it yet", () => {
    expect(REQ_STATUSES).toContain("contradicted");
    expect(parseRequirement({ req: "On-call", status: "contradicted", evidence: "left ops deliberately" }).ok).toBe(true);
  });

  it("rejects a status outside the four, and says which field was wrong", () => {
    const r = parseRequirement({ req: "Accessibility", status: "partly" });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/status/);
  });

  it("rejects a kind outside the five", () => {
    expect(parseRequirement({ req: "X", status: "met", kind: "vibes" }).ok).toBe(false);
    for (const k of REQ_KINDS) expect(parseRequirement({ req: "X", status: "met", kind: k }).ok).toBe(true);
  });

  it("is tolerant at the top level, because strictness there would fail OPEN", () => {
    // A thin coverage SKIPS the fit floor, so rejecting a reply over one odd field would send MORE,
    // not fewer. Every defaulted field must still validate when absent.
    expect(CoverageReply.safeParse({}).success).toBe(true);
    expect(CoverageReply.safeParse({ requirements: [] }).success).toBe(true);
    expect(CoverageReply.safeParse("nope").success).toBe(false);
    expect(CoverageReply.safeParse([1, 2]).success).toBe(false);
  });
});

describe("the prompt asks for what the schema accepts", () => {
  const src = readFileSync(new URL("../prompts/fit-coverage.mjs", import.meta.url), "utf8");

  it("requests all three stage-1 fields", () => {
    for (const f of ["gating", "kind", "locator"]) expect(src).toContain(`"${f}"`);
  });

  it("does NOT request contradicted — a fourth verdict would move the live composite", () => {
    expect(src).not.toMatch(/"met"\|"partial"\|"unknown"\|"contradicted"/);
  });

  it("tells the model the abbreviations that are not credentials", () => {
    // Degree abbreviations that a naive regex misreads: BA, BE, MA.
    expect(src).toMatch(/business analyst/i);
    expect(src).toMatch(/be fluent/i);
  });
});
