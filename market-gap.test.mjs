// market-gap.test.mjs — pure-logic tests for the market-gap drop's grounded core (no network):
//   aggregateGaps / classifyGap (market-research.mjs) and cohortFor (market-gap.mjs).
// The model calls (coverage recompute, compose, web research) are exercised elsewhere / at runtime;
// here we lock the deterministic decisions that decide WHO gets a drop and about WHAT.
import { describe, it, expect, afterEach } from "vitest";
import { aggregateGaps, classifyGap, isHttpUrl } from "./market-research.mjs";
import { cohortFor, modelCopyClean } from "./market-gap.mjs";

const cov = (reqs) => ({ thin: false, coverage: reqs });

describe("aggregateGaps", () => {
  it("ranks recurring UNKNOWN requirements, counting ROLES not reqs, with a real denominator", () => {
    const covs = [
      cov([{ req: "Product analytics", status: "unknown" }, { req: "SQL", status: "partial" }, { req: "React", status: "met" }]),
      cov([{ req: "product analytics", status: "unknown" }, { req: "SQL", status: "partial" }]),
      cov([{ req: "Product Analytics", status: "unknown" }]),
    ];
    const gaps = aggregateGaps(covs, { minCount: 2 });
    expect(gaps[0]).toMatchObject({ key: "product analytics", count: 3, total: 3, kind: "share" });
    expect(gaps[0].gap).toBe("Product analytics"); // most-frequent original casing
  });

  it("EXCLUDES 'partial' (the person has partly shown it — 'nothing speaks to it' would be a false claim)", () => {
    const covs = [
      cov([{ req: "SQL", status: "partial" }]),
      cov([{ req: "SQL", status: "partial" }]),
    ];
    expect(aggregateGaps(covs, { minCount: 1 })).toEqual([]);
  });

  it("never counts a 'met' requirement as a gap, and counts each role at most once per gap", () => {
    const covs = [cov([{ req: "Go", status: "met" }, { req: "Go", status: "unknown" }])]; // same role, contradictory
    // 'met' present means the role showed it; but even the stray 'unknown' counts the role only once.
    const gaps = aggregateGaps(covs, { minCount: 1 });
    const go = gaps.find((g) => g.key === "go");
    expect(go?.count).toBe(1);
  });

  it("honors minCount (a one-off gap is not a recurring gap) and ignores thin coverages", () => {
    const covs = [
      cov([{ req: "Kubernetes", status: "unknown" }]),
      { thin: true, reason: "dossier" },
    ];
    expect(aggregateGaps(covs, { minCount: 2 })).toEqual([]);
    expect(aggregateGaps(covs, { minCount: 1 })[0].total).toBe(1); // only the scoreable one counts
  });

  it("returns [] on empty / garbage input", () => {
    expect(aggregateGaps([], {})).toEqual([]);
    expect(aggregateGaps(null, {})).toEqual([]);
    expect(aggregateGaps([{ thin: false, coverage: null }], {})).toEqual([]);
  });
});

describe("classifyGap", () => {
  it("routes preference gaps to 'pref' and everything demonstrable to 'share'", () => {
    for (const p of ["comp floor", "salary", "remote", "location", "visa sponsorship", "US work authorization"]) expect(classifyGap(p)).toBe("pref");
    for (const s of ["Kubernetes", "Product analytics", "design systems", "5+ years", "PhD"]) expect(classifyGap(s)).toBe("share");
  });
});

describe("modelCopyClean — the compose grounding gate (prose is not enforcement)", () => {
  const ok = { subject: "the one thing", opening: "you've seen a few.", gap_framing: "roles keep asking for {{GAP}}.", close_line: "just reply and show me.", honest_line: "if you've done it, showing me opens it up." };
  it("passes clean prose that names no number and implies no odds", () => {
    expect(modelCopyClean(ok)).toBe(true);
  });
  it("rejects ANY digit (the real figures are code-rendered; {{GAP}} carries none)", () => {
    expect(modelCopyClean({ ...ok, opening: "5 of the roles asked for it" })).toBe(false);
    expect(modelCopyClean({ ...ok, subject: "3 things" })).toBe(false);
  });
  it("rejects odds/outcome words", () => {
    for (const bad of ["you'll likely land these", "almost guaranteed", "high chance you'll get it", "you'll get the job", "a shoo-in"]) {
      expect(modelCopyClean({ ...ok, honest_line: bad })).toBe(false);
    }
  });
});

describe("isHttpUrl — the market-line source gate (no unsourced claim)", () => {
  it("accepts real http(s) sources", () => {
    for (const u of ["https://bls.gov/x", "http://example.com/a?b=1"]) expect(isHttpUrl(u)).toBe(true);
  });
  it("rejects anything without a real URL (dropped before it can render)", () => {
    for (const u of ["", "#", "example.com", "source: a report", "ftp://x", null, undefined]) expect(isHttpUrl(u)).toBe(false);
  });
});

describe("cohortFor", () => {
  const NOW = Date.UTC(2026, 6, 19);
  const DAY = 24 * 60 * 60 * 1000;
  afterEach(() => { delete process.env.MARKETGAP_STALLED; });

  it("never-matched (0 emailed) is always a cohort at the base recurrence bar", () => {
    expect(cohortFor({ emailedCount: 0, lastEmailedAt: null, now: NOW })).toEqual({ cohort: "never", minCount: 2 });
  });

  it("a user who has received roles is NOT eligible while MARKETGAP_STALLED is off", () => {
    expect(cohortFor({ emailedCount: 3, lastEmailedAt: new Date(NOW - 40 * DAY).toISOString(), now: NOW }).cohort).toBe(null);
  });

  it("with MARKETGAP_STALLED on: eligible only after the quiet window, at the HIGHER recurrence bar", () => {
    process.env.MARKETGAP_STALLED = "on";
    // still recently served → not eligible
    expect(cohortFor({ emailedCount: 3, lastEmailedAt: new Date(NOW - 3 * DAY).toISOString(), now: NOW }).cohort).toBe(null);
    // quiet long enough → stalled, minCount 3
    expect(cohortFor({ emailedCount: 3, lastEmailedAt: new Date(NOW - 40 * DAY).toISOString(), now: NOW })).toEqual({ cohort: "stalled", minCount: 3 });
  });
});
