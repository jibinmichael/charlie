// decision-record.test.mjs — a sent role must be able to say why it was sent, and over what.
//
// The aim — "only recommend a role when it can defend why this specific role is a good recommendation
// for this specific person" — is a claim about evidence and a claim about alternatives, so both are
// written down.
//
// These tests pin the two properties that make the record worth having:
//   1. it never credits what it cannot cite (`unknown` earns nothing, evidence-less `met` earns nothing)
//   2. it records the matcher score WITHOUT treating it as authority

import { describe, it, expect } from "vitest";
import { decisionRecord, defensible } from "./decision-record.mjs";

const cov = (over = {}) => ({
  thin: false, composite: 61, lane: "stretch",
  counts: { met: 3, partial: 1, unknown: 2 },
  coverage: [
    { req: "5+ years backend", status: "met", evidence: "8 years at Acme building payments services" },
    { req: "Go or Java", status: "met", evidence: "shipped the Go rewrite of the ledger" },
    { req: "Kubernetes", status: "met", evidence: "" },              // met but NOT cited
    { req: "fintech domain", status: "partial", evidence: "adjacent: payments at Acme" },
    { req: "Bachelor's degree", status: "unknown", evidence: null },
    { req: "on-call rotation", status: "unknown", evidence: null },
  ],
  ...over,
});

const job = { _retrievalRank: 12, _relScore: 9, _semScore: 0.7431, _blendScore: 0.8102, company: "Acme", title: "Backend Engineer" };
const match = { score: 72, verdict: "strong", dealbreaker_hit: false };
const considered = [
  { company: "Beta", title: "Platform Eng", slot: 1, retrieval_rank: 3, outcome: "digest", rule: "fit-floor:below" },
  { company: "Acme", title: "Backend Engineer", slot: 2, retrieval_rank: 12, outcome: "send", rule: "fit:clears" },
];

describe("it records evidence, and never credits what it cannot cite", () => {
  const r = decisionRecord({ rule: "fit:clears", job, match, cov: cov(), slot: 2, considered, rankedBy: ["freshness", "pairwise"] });

  it("counts only MET requirements that carry actual evidence", () => {
    // 3 met, but one has an empty evidence string. Two are citable.
    expect(r.grounded.met).toBe(3);
    expect(r.grounded.evidenced).toBe(2);
  });

  it("carries the unknown count separately, so 'we don't know' is not 'they lack it'", () => {
    expect(r.grounded.unknown).toBe(2);
    expect(r.grounded.partial).toBe(1);
  });

  it("is defensible when at least one stated requirement is evidenced", () => {
    expect(r.grounded.defensible).toBe(true);
  });

  it("is NOT defensible when every met requirement is uncited", () => {
    const uncited = cov({ coverage: [{ req: "Kubernetes", status: "met", evidence: "" }, { req: "Go", status: "met", evidence: null }] });
    expect(defensible(uncited)).toBe(false);
    expect(decisionRecord({ cov: uncited }).grounded.defensible).toBe(false);
  });

  it("is NOT defensible on a thin coverage read", () => {
    expect(defensible({ thin: true })).toBe(false);
    expect(decisionRecord({ cov: { thin: true } }).grounded.thin).toBe(true);
  });

  it("an unknown-only JD earns nothing — unproven is not credited", () => {
    expect(defensible(cov({ coverage: [{ req: "anything", status: "unknown", evidence: null }] }))).toBe(false);
  });
});

describe("the matcher score is recorded, not obeyed", () => {
  const r = decisionRecord({ rule: "fit:clears", job, match, cov: cov(), slot: 2, considered });

  it("writes the score down so it can be evaluated later", () => {
    expect(r.matcher.score).toBe(72);
    expect(r.matcher.verdict).toBe("strong");
    expect(r.matcher.dealbreaker_hit).toBe(false);
  });

  it("the record's own verdict comes from the GATE, not from the score", () => {
    expect(r.rule).toBe("fit:clears");
    expect(r.outcome).toBe("send");
    // Nothing in the record is derived from `matcher.score`. A 72 and a 99 produce identical records
    // apart from the recorded number itself — which is the whole point of it no longer being authority.
    const hi = decisionRecord({ rule: "fit:clears", job, match: { ...match, score: 99 }, cov: cov(), slot: 2, considered });
    expect({ ...hi, matcher: null }).toEqual({ ...r, matcher: null });
  });
});

describe("it records what the sent role was chosen OVER", () => {
  const r = decisionRecord({ rule: "fit:clears", job, match, cov: cov(), slot: 2, considered, rankedBy: ["freshness", "pairwise"] });

  it("keeps every role the walk judged, with its own gate name", () => {
    expect(r.considered).toHaveLength(2);
    expect(r.considered[0]).toMatchObject({ company: "Beta", outcome: "digest", rule: "fit-floor:below" });
    expect(r.considered[1]).toMatchObject({ company: "Acme", outcome: "send", rule: "fit:clears" });
  });

  it("names which re-rankers were live, so the order is attributable", () => {
    expect(r.ranked_by).toEqual(["freshness", "pairwise"]);
  });

  it("keeps the retrieval features, so a click can be attributed to why the role surfaced", () => {
    expect(r.retrieval).toEqual({ rank: 12, lexical: 9, semantic: 0.7431, blend: 0.8102 });
  });
});

describe("it never throws on the shapes production actually produces", () => {
  it("survives no arguments", () => {
    const r = decisionRecord();
    expect(r.outcome).toBe("send");
    expect(r.considered).toEqual([]);
    expect(r.grounded.defensible).toBe(false);
  });

  it("survives a thin cov, a null match, and a missing job", () => {
    const r = decisionRecord({ rule: "fit:clears", cov: { thin: true }, match: null, job: null, considered: null });
    expect(r.retrieval).toEqual({ rank: null, lexical: null, semantic: null, blend: null });
    expect(r.matcher).toEqual({ score: null, verdict: null, dealbreaker_hit: false });
    expect(r.considered).toEqual([]);
  });

  it("does not turn a missing number into a zero", () => {
    // The Number(null)===0 trap. A missing composite must read as "not measured", never as 0/100.
    const r = decisionRecord({ cov: { thin: false, counts: {} } });
    expect(r.grounded.composite).toBeNull();
    expect(r.grounded.met).toBeNull();
  });
});
