// jd-requirements.test.mjs — the pool cap must keep the thing it exists to keep.
//
// charlie-store.mjs slims the shared pool object to a fixed description length. The cap exists so the
// daily role email's fit readout can still read a JD's requirements, so a blind head-slice is wrong:
// it keeps the first N characters, not the requirements, and a posting with a long preamble becomes
// unscoreable (fit-coverage returns { thin: true, reason: "jd" } and the email ships with no chart).
//
// It matters on the first-role path: scheduler.mjs reads the FULL local jobs.json, but match-one.mjs
// (used by first-role.mjs) reads the CAPPED pool object.
//
// The cap cannot simply be raised: uncapped, the pool object exceeds the storage ceiling. The question
// is never "trim or not", only "trim WHERE".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REQ_SIGNAL, jdIsScoreable, capKeepingRequirements } from "./jd-requirements.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const CAP = 2500;

// A posting shaped like the ones that broke: a long marketing preamble, requirements only afterwards.
const PREAMBLE = "We are a mission driven company changing the world. ".repeat(60); // ~3100 chars, no req wording
const REQS = "What you'll need: 5 years of experience with React and strong proficiency in TypeScript.";

describe("the cap keeps the requirements, not merely the first N characters", () => {
  it("recovers a posting whose requirements sit beyond the cap", () => {
    // The exact failure. A head-slice yields an unscoreable stub; the window keeps the requirements.
    const jd = PREAMBLE + REQS;
    expect(jd.length).toBeGreaterThan(CAP);
    expect(jdIsScoreable(jd.slice(0, CAP))).toBe(false);      // the OLD behaviour
    expect(jdIsScoreable(capKeepingRequirements(jd, CAP))).toBe(true); // the NEW one
    expect(capKeepingRequirements(jd, CAP)).toContain("5 years of experience with React");
  });

  it("leaves a posting whose requirements are already up front byte-identical", () => {
    // Most over-cap postings. A fix that rewrote all of them would be a much bigger change than the
    // problem, and would churn the pool object for no reason.
    const jd = REQS + " " + PREAMBLE;
    expect(capKeepingRequirements(jd, CAP)).toBe(jd.slice(0, CAP));
  });

  it("never grows the payload — the cap length is the storage contract", () => {
    // The pool object sits close to the storage ceiling. A fix that spent headroom would trade one
    // outage for another (loadJobPool failing breaks preflight, which aborts the daily send).
    for (const jd of [PREAMBLE + REQS, REQS + PREAMBLE, "x".repeat(9000)]) {
      expect(capKeepingRequirements(jd, CAP).length).toBeLessThanOrEqual(CAP);
    }
  });

  it("returns a short description untouched", () => {
    expect(capKeepingRequirements(REQS, CAP)).toBe(REQS);
    expect(capKeepingRequirements("", CAP)).toBe("");
  });

  it("falls back to the head when the posting states no requirements anywhere", () => {
    // Nothing to preserve, so there is no better window than the first one. It stays unscoreable, which
    // is the honest answer: the employer wrote marketing copy.
    const jd = PREAMBLE + PREAMBLE;
    expect(capKeepingRequirements(jd, CAP)).toBe(jd.slice(0, CAP));
    expect(jdIsScoreable(capKeepingRequirements(jd, CAP))).toBe(false);
  });

  it("never reads past the end of the document", () => {
    // The window is clamped both ways; an off-by-one here would silently shorten the slice.
    const jd = "a".repeat(2400) + REQS + "b".repeat(300);
    const out = capKeepingRequirements(jd, CAP);
    expect(out.length).toBe(CAP);
    expect(jd).toContain(out);
  });

  it("adds NO truncation marker, or the chart would be hidden on 84.6% of the pool", () => {
    // render-email's jdWasTruncated treats a trailing ellipsis as "hide the fit readout". Marking these
    // would suppress the chart almost everywhere — strictly worse than a narrower window. Length is
    // not truncation.
    const out = capKeepingRequirements(PREAMBLE + REQS, CAP);
    expect(out).not.toMatch(/(\.\.\.|…|\[truncated\]|\[cut\])\s*$/);
  });

  it("is deterministic", () => {
    const jd = PREAMBLE + REQS;
    expect(capKeepingRequirements(jd, CAP)).toBe(capKeepingRequirements(jd, CAP));
  });
});

describe("one definition, so the cap and the reader cannot disagree", () => {
  it("fit-coverage uses the shared predicate instead of its own copy", () => {
    // Two files need the same answer, so they share one predicate. A cap that preserves a window the
    // reader still calls unscoreable fixes nothing.
    const s = read("fit-coverage.mjs");
    expect(s).toMatch(/import \{ jdIsScoreable \} from "\.\/lib\/jd-requirements\.mjs"/);
    expect(s).not.toMatch(/^const REQ_SIGNAL = /m);
    expect(s).not.toMatch(/^function jdIsScoreable/m);
  });

  it("charlie-store caps through the shared helper, not a blind slice", () => {
    const s = read("charlie-store.mjs");
    expect(s).toMatch(/import \{ capKeepingRequirements \} from "\.\/lib\/jd-requirements\.mjs"/);
    expect(s).toMatch(/description: capKeepingRequirements\(j\.description, DESC_CAP\)/);
    expect(s).not.toMatch(/description: j\.description\.slice\(0, DESC_CAP\)/);
  });

  it("the shared module stays free of the Anthropic SDK", () => {
    // charlie-store.mjs is imported by every script and both services; pulling the SDK in through it
    // would be a real side effect. That is why this is its own module rather than a fit-coverage export.
    const s = read("lib/jd-requirements.mjs");
    expect(s).not.toMatch(/from "@anthropic-ai|new Anthropic\(/); // the word appears in the header comment; the IMPORT must not
    expect(s).not.toMatch(/^import /m); // and in fact it imports nothing at all, which is the stronger guarantee
  });

  it("the predicate still requires BOTH length and requirement wording", () => {
    expect(jdIsScoreable("short but has 5 years of experience with React")).toBe(false); // too short
    expect(jdIsScoreable("x".repeat(500))).toBe(false); // long, no requirements
    expect(jdIsScoreable("x".repeat(500) + REQS)).toBe(true);
    expect(REQ_SIGNAL.test(REQS)).toBe(true);
  });
});
