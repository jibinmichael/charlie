// lib/match-cache-key.test.mjs — the correctness fence for incremental matching.
// Two failures would be silent and costly: a key that changes day-to-day (cache never hits, no saving)
// or a key that DOESN'T change when a real input changes (serves a stale verdict — a quality bug). Both
// are asserted here, plus read/write parity (the raw pool job and the scored job must key identically).
import { describe, it, expect } from "vitest";
import { matchCacheKey, cacheableVerdict, JOB_KEY_FIELDS } from "./match-cache-key.mjs";

// A realistic pool job (mirrors scan-jobs.mjs shape) with the two volatile fields set to "today".
const job = {
  id: "lever:15five:abc", source: "lever", company: "15Five", slug: "15five", segment: null,
  title: "Director, Product", location: "US Remote", remote: true, team: "Product",
  employment_type: "Full Time", compensation: null, apply_url: "https://x/a", posted_at: "2026-07-06T20:55:01Z",
  description: "Build the thing.", first_seen: "2026-07-25T02:35:50Z", last_seen: "2026-07-25T02:35:50Z",
};
const base = { model: "claude-haiku-4-5", maxTokens: 1000, matcherText: "RUBRIC", dossierText: "DOSSIER", job, constrained: false };
const key = (o) => matchCacheKey({ ...base, ...o });

describe("matchCacheKey — stable across days, sensitive to real change", () => {
  it("identical inputs -> identical key", () => {
    expect(key()).toBe(key());
  });

  it("ONLY first_seen/last_seen changed (the daily re-stamp) -> SAME key (else cache never hits)", () => {
    const restamped = { ...job, first_seen: "2026-07-26T02:35:50Z", last_seen: "2026-07-26T02:35:50Z" };
    expect(key({ job: restamped })).toBe(key());
  });

  it("read/write parity: a scored job (job + match + passed_bar) keys the same as the raw job", () => {
    // On the write side match-batch passes the scored object (job spread + match + passed_bar). The key
    // must ignore those non-job fields, or a fresh verdict is stored under a key the read side never asks for.
    const scored = { ...job, match: { score: 88, verdict: "send" }, passed_bar: true };
    expect(key({ job: scored })).toBe(key());
  });

  it("a changed dossier -> different key (the person updated their profile -> re-score)", () => {
    expect(key({ dossierText: "DOSSIER v2" })).not.toBe(key());
  });

  it("a changed matcher rubric -> different key (rule change -> re-score everyone)", () => {
    expect(key({ matcherText: "RUBRIC v2" })).not.toBe(key());
  });

  it("a changed model -> different key", () => {
    expect(key({ model: "claude-sonnet-5" })).not.toBe(key());
  });

  it("a changed constrained-decode mode -> different key (reply shape differs)", () => {
    expect(key({ constrained: true })).not.toBe(key());
  });

  it.each(JOB_KEY_FIELDS.filter((f) => f !== "compensation" && f !== "segment"))(
    "a changed semantic job field (%s) -> different key (the posting really changed)",
    (field) => {
      const changed = { ...job, [field]: `${job[field] ?? "x"}-EDITED` };
      expect(key({ job: changed })).not.toBe(key());
    },
  );

  it("a full 64-hex sha-256 digest", () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cacheableVerdict — cache real verdicts (incl. legit skips), reject ONLY error placeholders", () => {
  it("true for send / digest verdicts", () => {
    expect(cacheableVerdict({ score: 88, verdict: "send" })).toBe(true);
    expect(cacheableVerdict({ score: 40, verdict: "digest" })).toBe(true);
  });
  it("true for a LEGITIMATE model skip (the majority outcome — this is where most saving lives)", () => {
    // A real not-a-fit "skip" is the most common verdict and must cache; only error placeholders
    // (identified by their flag) are refused.
    expect(cacheableVerdict({ score: 42, verdict: "skip" })).toBe(true);
    expect(cacheableVerdict({ score: 0, verdict: "skip" })).toBe(true);
  });
  it("true for a real verdict whose flag is a flaw note, not an error (must not be mistaken for one)", () => {
    expect(cacheableVerdict({ score: 71, verdict: "send", flag: "backend depth is thin, PHP only" })).toBe(true);
  });
  it("false ONLY for the error placeholders match-batch stores on a failed reply", () => {
    expect(cacheableVerdict({ score: 0, verdict: "skip", flag: "unparseable score" })).toBe(false);
    expect(cacheableVerdict({ score: 0, verdict: "skip", flag: "schema-invalid score" })).toBe(false);
    expect(cacheableVerdict({ score: 0, verdict: "skip", flag: "score failed: errored" })).toBe(false);
  });
  it("false for malformed / missing score (fail closed)", () => {
    expect(cacheableVerdict(null)).toBe(false);
    expect(cacheableVerdict({})).toBe(false);
    expect(cacheableVerdict({ score: "88" })).toBe(false);
  });
});
