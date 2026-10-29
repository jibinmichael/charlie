// lib/scoring/index.test.mjs — the pluggable candidate scorer: chosen by CANDIDATE_SCORER, fails closed. No network.
import { describe, it, expect } from "vitest";
import { createScorer, registerScorer, normalizeResult, pieworksThreshold, pieworksScoreOf, pieworksLookup, scorerNames, DEFAULT_SCORER } from "./index.mjs";

const PERSON = { candidate_id: "c-1", email: "asha@x.com", full_name: "Asha Rao" };
const ROLE = { id: "job-1", external_id: "1000101", title: "Support Engineer", client: "Northwind Labs", must_haves: ["Billing support"], experience: { min: 2, max: 4 }, payload: {} };

/** A stand-in for the Supabase client over pieworks_activations rows. */
const fakeDb = (rows, error = null) => ({
  from: (t) => {
    expect(t).toBe("pieworks_activations");
    const q = { filters: [] };
    const b = { select: () => b, order: () => b, limit: () => b, eq: (k, v) => (q.filters.push([k, v]), b), then: (ok, bad) => Promise.resolve(error ? { data: null, error } : { data: rows.filter((r) => q.filters.every(([k, v]) => r[k] === v)), error: null }).then(ok, bad) };
    return b;
  },
});

describe("choosing a scorer", () => {
  it("defaults to pieworks; none and pieworks are built in; an unknown name throws", () => {
    expect(DEFAULT_SCORER).toBe("pieworks");
    expect(createScorer({ env: {} }).name).toBe("pieworks");
    expect(createScorer({ env: { CANDIDATE_SCORER: " None " } }).name).toBe("none");
    expect(scorerNames()).toEqual(expect.arrayContaining(["none", "pieworks"]));
    expect(() => createScorer({ env: { CANDIDATE_SCORER: "magic" } })).toThrow(/not a known scorer/);
  });

  it("none passes everyone, with no score", async () => {
    expect(await createScorer({ name: "none" }).score(PERSON, ROLE)).toEqual({ score: null, pass: true, reasons: [expect.any(String)] });
  });

  it("a registered scorer is used by name, and its answer is checked on the way out", async () => {
    registerScorer("test-rules", () => ({ name: "test-rules", score: async (c, r) => ({ score: 64.04, pass: true, reasons: [`${c.full_name} for ${r.title}`, "", "  two   spaces "] }) }));
    expect(await createScorer({ env: { CANDIDATE_SCORER: "test-rules" } }).score(PERSON, ROLE)).toEqual({ score: 64, pass: true, reasons: ["Asha Rao for Support Engineer", "two spaces"] });
    expect(() => registerScorer("Bad Name!", () => ({}))).toThrow(/a scorer name/);
  });

  it("fails closed: a throw, a missing pass, or a score outside 0 to 100 never lets anyone through", async () => {
    registerScorer("test-throws", () => ({ name: "test-throws", score: async () => { throw new Error("vendor down"); } }));
    expect(await createScorer({ name: "test-throws" }).score(PERSON, ROLE)).toEqual({ score: null, pass: false, reasons: [expect.stringMatching(/vendor down/)] });
    expect(normalizeResult({ score: 90 })).toMatchObject({ pass: false });
    expect(normalizeResult({ score: 140, pass: true })).toMatchObject({ pass: false, score: null });
    expect(normalizeResult(null)).toMatchObject({ pass: false });
    expect(normalizeResult({ pass: true, reasons: Array(20).fill("r") }).reasons).toHaveLength(10);
  });
});

describe("the pieworks scorer", () => {
  it("reads the threshold from PIEWORKS_SCORE_THRESHOLD, 70 by default or when it is not a number in 0 to 100", () => {
    expect(pieworksThreshold({})).toBe(70);
    expect(pieworksThreshold({ PIEWORKS_SCORE_THRESHOLD: "55" })).toBe(55);
    expect(pieworksThreshold({ PIEWORKS_SCORE_THRESHOLD: "high" })).toBe(70);
    expect(pieworksThreshold({ PIEWORKS_SCORE_THRESHOLD: "250" })).toBe(70);
  });

  it("finds the numeric score in the stored webhook record; text or out of range is no score", () => {
    expect(pieworksScoreOf({ aiScore: 82 })).toBe(82);
    expect(pieworksScoreOf({ ai_score: "75.5" })).toBe(75.5);
    expect(pieworksScoreOf({ aiScoreReason: "<p>good</p>" })).toBeNull();
    expect(pieworksScoreOf({ aiScore: 900 })).toBeNull();
    expect(pieworksScoreOf(null)).toBeNull();
  });

  it("prefers the score sent for this role, else their latest; none at all is not a pass", async () => {
    const rows = [
      { email: "asha@x.com", requirement_id: 999, candidate: { aiScore: 95 }, received_at: "2026-10-28" },
      { email: "asha@x.com", requirement_id: 1000101, candidate: { aiScore: 60 }, received_at: "2026-10-20" },
    ];
    expect(await pieworksLookup(fakeDb(rows), PERSON, ROLE)).toEqual({ score: 60, same_role: true });
    expect(await pieworksLookup(fakeDb(rows), PERSON, { ...ROLE, external_id: "1" })).toEqual({ score: 95, same_role: false });
    const s = createScorer({ name: "pieworks", env: {}, db: fakeDb(rows) });
    expect(await s.score(PERSON, ROLE)).toEqual({ score: 60, pass: false, reasons: ["Pieworks AI score 60 is below 70"] });
    expect(await createScorer({ name: "pieworks", env: { PIEWORKS_SCORE_THRESHOLD: "60" }, db: fakeDb(rows) }).score(PERSON, ROLE)).toMatchObject({ pass: true });
    expect(await s.score({ ...PERSON, email: "nobody@x.com" }, ROLE)).toEqual({ score: null, pass: false, reasons: ["Pieworks has sent no score for this person"] });
  });

  it("a database error is a fail-closed answer, never a pass", async () => {
    const s = createScorer({ name: "pieworks", env: {}, db: fakeDb([], { message: "timeout" }) });
    expect(await s.score(PERSON, ROLE)).toMatchObject({ pass: false, score: null, reasons: [expect.stringMatching(/timeout/)] });
  });
});
