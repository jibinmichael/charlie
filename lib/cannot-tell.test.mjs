// cannot-tell.test.mjs — "I could not read this" must never come out as "this person is weak".
//
// A 0 can mean two unrelated things: the model looked and found nothing, or the verifier failed to
// check what it found. These tests pin the distinction in lib/xyz-screen.mjs, so a screen that did
// not run is refused rather than stored as a low score.
//
// The model is stubbed. These are assertions about OUR verification and refusal logic, not about
// Anthropic's output, so no key and no network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { create }; } },
}));

const { screenApplicant } = await import("./xyz-screen.mjs");

const REQS = Array.from({ length: 6 }, (_, i) => ({ key: `r${i}`, label: `requirement ${i}` }));
const SOURCE = "I cut the setup wizard from six steps to two and moved verification after first value.";

/** One canned model reply. `scores` is a list of [score, quote]. */
const reply = (scores) => ({
  usage: { input_tokens: 10, output_tokens: 10 },
  content: [{ type: "text", text: JSON.stringify({
    scores: scores.map(([score, quote], i) => ({ requirement: `requirement ${i}`, score, quote, why: "because" })),
    years_total: 9, years_evidence: "2017-2026", prior_employer_match: false,
    standout: "a thing", gap: "", flags: [],
  }) }],
});

const run = (scores) => {
  create.mockResolvedValueOnce(reply(scores));
  return screenApplicant({ brief: "b", requirements: REQS, answers: { q: SOURCE }, resume: "" });
};

const GOOD = "I cut the setup wizard from six steps to two";
const FAKE = "I grew annual recurring revenue from two million to nine million";

beforeEach(() => create.mockReset());

describe("every score says which kind of zero it is", () => {
  it("a found quote is observed", async () => {
    const { screen } = await run([[3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD]]);
    expect(screen.scores.map((s) => s.status)).toEqual(Array(6).fill("observed"));
  });

  it("a real zero from the model is absent, not cannot_verify", async () => {
    const { screen, readable } = await run([[0, ""], [0, ""], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD]]);
    expect(screen.scores.slice(0, 2).map((s) => s.status)).toEqual(["absent", "absent"]);
    // Two genuine zeros is a person who scored low. That is a readable screen.
    expect(readable).toBe(true);
  });

  it("an unfindable quote is cannot_verify, and keeps what was rejected", async () => {
    const { screen } = await run([[3, FAKE], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD]]);
    expect(screen.scores[0].status).toBe("cannot_verify");
    expect(screen.scores[0].score).toBe(0);
    expect(screen.scores[0].rejected_quote).toBe(FAKE);
    expect(screen.scores[0].rejected_score).toBe(3);
  });

  it("a positive score with no quote is cannot_verify, not a free 3", async () => {
    // contains("") is satisfied by anything, so this used to pass the one check that exists to stop
    // invention. Rare in practice, which is not the same as impossible.
    const { screen } = await run([[3, ""], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD]]);
    expect(screen.scores[0].status).toBe("cannot_verify");
    expect(screen.scores[0].score).toBe(0);
    expect(screen.scores[0].rejected_score).toBe(3);
    expect(screen.flags).toContain("unquoted-score");
  });
});

describe("a screen that did not run is refused, not reported small", () => {
  it("six of six unverifiable is not a score of zero", async () => {
    const { readable, screen, reason } = await run(Array(6).fill([3, FAKE]));
    expect(readable).toBe(false);
    expect(screen.flags).toContain("unreadable");
    expect(reason).toMatch(/needs a human, not a score/);
  });

  it("two of six crosses the third and is refused", async () => {
    const { readable } = await run([[3, FAKE], [3, FAKE], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD]]);
    expect(readable).toBe(false);
  });

  it("one of six is ordinary and still scores", async () => {
    const { readable, total } = await run([[3, FAKE], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD], [3, GOOD]]);
    expect(readable).toBe(true);
    expect(total).toBe(15);
  });

  it("a total is still returned so a human can see how it broke", async () => {
    const { total, screen } = await run(Array(6).fill([3, FAKE]));
    expect(total).toBe(0);
    expect(screen.scores.every((s) => s.rejected_quote === FAKE)).toBe(true);
  });

  it("an unreadable reply after two attempts is also not a score", async () => {
    create.mockResolvedValue({ usage: {}, content: [{ type: "text", text: "not json" }] });
    const { screen, readable } = await screenApplicant({ brief: "b", requirements: REQS, answers: { q: SOURCE } });
    expect(screen).toBe(null);
    expect(readable).toBe(false);
  });
});
