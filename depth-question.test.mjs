// depth-question.test.mjs — the market read, the one question, and the two things that must never
// happen: a re-buy of coverage we already own, and a claim where a question belongs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { storedCoverages, questionFor, depthQuestionMode, DEPTH_QUESTION_SUBJECT_RE } from "./depth-question.mjs";
import { renderDepthQuestion } from "./email-kit.mjs";

const cov = (reqs) => ({ thin: false, coverage: reqs.map((r) => ({ req: r[0], status: r[1] })) });
const find = (c) => ({ composed: { digest_reason: "x", _cov: c } });

let saved;
beforeEach(() => { saved = process.env.DEPTH_QUESTION; });
afterEach(() => { if (saved === undefined) delete process.env.DEPTH_QUESTION; else process.env.DEPTH_QUESTION = saved; });

describe("the flag is off until someone turns it on", () => {
  it("defaults to off and rejects an unknown value", () => {
    delete process.env.DEPTH_QUESTION;
    expect(depthQuestionMode()).toBe("off");
    process.env.DEPTH_QUESTION = "please";
    expect(depthQuestionMode()).toBe("off");
  });
});

describe("it reads coverage we already own, and never invents any", () => {
  it("pulls the stored coverage off near-miss rows", () => {
    const out = storedCoverages([find(cov([["Kubernetes", "unknown"]])), find(cov([["React", "full"]]))]);
    expect(out).toHaveLength(2);
  });

  it("returns FEWER rather than recomputing when a row has no stored coverage", () => {
    // Rows without a stored _cov must come back with less and let
    // the sweep skip the person: a silent re-buy is a model call per user, every pass, for a number already
    // bought once. A skipped question is recoverable next pass; a quiet bill is not.
    const out = storedCoverages([
      { composed: { digest_reason: "old row, no coverage" } },
      { composed: null },
      {},
      null,
      find(cov([["Kubernetes", "unknown"]])),
    ]);
    expect(out).toHaveLength(1);
  });

  it("ignores a malformed coverage blob rather than trusting it", () => {
    expect(storedCoverages([find({ coverage: "not an array" }), find({ thin: true }), find(null)])).toHaveLength(0);
  });
});

describe("the question is only asked about a recurring UNKNOWN", () => {
  it("picks the requirement that recurs across near-misses", () => {
    const q = questionFor([
      cov([["Kubernetes", "unknown"], ["React", "full"]]),
      cov([["Kubernetes", "unknown"]]),
      cov([["React", "full"]]),
    ]);
    expect(q.gap).toBe("Kubernetes");
    expect(q.count).toBe(2);
    expect(q.total).toBe(3);
  });

  it("says nothing when a requirement appears only once — one role is an anecdote", () => {
    expect(questionFor([cov([["Kubernetes", "unknown"]]), cov([["React", "full"]])])).toBeNull();
  });

  it("never asks about something their record already COVERS", () => {
    // status "full" means the dossier answered it. Asking anyway would tell someone Charlie has not
    // read their own record — and is one step from asserting a gap that isn't there.
    expect(questionFor([cov([["React", "full"]]), cov([["React", "full"]])])).toBeNull();
  });

  it("ignores thin coverages, which carry no readout to aggregate", () => {
    expect(questionFor([{ thin: true }, { thin: true }])).toBeNull();
  });

  it("returns null on empty or junk input rather than throwing into the sweep", () => {
    for (const bad of [[], null, undefined, [null], ["nope"]]) expect(questionFor(bad)).toBeNull();
  });
});

describe("the email asks, and never tells", () => {
  const r = () => renderDepthQuestion({ email: "a@b.com", name: "Priya", gap: "Kubernetes in production", count: 2, total: 6 });

  it("leads with the market read, then the question", () => {
    const t = r().text;
    expect(t.indexOf("Of the 6 roles")).toBeLessThan(t.indexOf("Have you done"));
    expect(t).toContain("2 asked for Kubernetes in production");
  });

  it("SAYS WE DO NOT KNOW, never that they lack it", () => {
    // The gate's readout marks the requirement "unknown": the posting asked, the record was silent.
    // "You're missing this" would be a verdict on someone's career built on our own silence.
    const t = r().text.toLowerCase();
    expect(t).toContain("doesn't say either way");
    expect(t).not.toContain("you lack");
    expect(t).not.toContain("you are missing");
    expect(t).not.toContain("gap");
  });

  it("makes BOTH answers pay the reader", () => {
    const t = r().text;
    expect(t).toContain("If yes, I start counting those roles in");
    expect(t).toContain("If no, I stop showing you");
  });

  it("carries no em dash in either half", () => {
    const { text, html } = r();
    expect(/—|–/.test(text + html)).toBe(false);
  });

  it("reads correctly at every count, including the singular", () => {
    for (const [count, total] of [[1, 1], [2, 6], [5, 9]]) {
      const t = renderDepthQuestion({ email: "a@b.com", gap: "AWS", count, total }).text;
      expect(t).not.toContain("undefined");
      expect(t).not.toMatch(/of them\. \d/); // the doubled phrasing an earlier draft produced
    }
  });
});

describe("the answer is caught before the generic reply writer sees it", () => {
  it("every subject the template sends matches the inbound pattern, with and without Re:", () => {
    // If these drift, "yes, ran it in production for two years" routes into the preference writer and
    // becomes a claim about the person, written from a sentence we prompted. Asking rather than
    // assuming would be undone at the last step.
    const { subject } = renderDepthQuestion({ email: "a@b.com", gap: "AWS", count: 2, total: 4 });
    expect(DEPTH_QUESTION_SUBJECT_RE.test(subject)).toBe(true);
    expect(DEPTH_QUESTION_SUBJECT_RE.test(`Re: ${subject}`)).toBe(true);
    expect(DEPTH_QUESTION_SUBJECT_RE.test("Fwd: About your last few roles")).toBe(true);
  });

  it("does not swallow an unrelated reply", () => {
    for (const s of ["Did the Toddle role end with you?", "I want in on Pro", "hello", ""]) {
      expect(DEPTH_QUESTION_SUBJECT_RE.test(s), s).toBe(false);
    }
  });
});
