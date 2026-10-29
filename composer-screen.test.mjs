// composer-screen.test.mjs — why_you is shown the read it will sit above, and cannot argue with it.
//
// THE DEFECT THIS GUARDS. A role email can open:
//
//   "Your 15+ years building scalable frontend systems and enterprise React architecture maps well
//    to what this SDE II role is asking for."
//
// and then, three lines below, showed the reader:
//
//   Level        "you may read as overqualified on first pass"
//   Domain       "A stretch ... different problem space"
//   Recent work  "your most recent role was a WordPress advertising agency project"
//
// Both halves can be individually grounded. Nothing made them agree, because `why_you` is written by
// the composer and the screen lines by the coverage pass — two separate model calls that never saw
// each other's output. An email whose first paragraph disagrees with its own evidence table reads
// as a pitch.
//
// The prompt rule itself is judged by a model and cannot be unit-tested. What CAN be tested, and is
// what this file does: the data reaches the prompt, it carries the verdicts, it fails open when
// absent, and both production send paths actually pass it. Prose in a rubric is not enforcement;
// the wiring underneath it can be.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { screenForComposer } from "./lib/fit-screen.mjs";
import { buildComposerUserContent } from "./prompts/composer.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// The shape of a find whose opener and screen lines disagreed.
const COV = {
  thin: false,
  composite: 69,
  seniorityLevel: "over",
  subscores: { domain: 0.25, skills: 0.62, mustHave: 0.81, seniority: 0.72, parseable: 0.82 },
  screen: {
    level: "They ask for SDE II, roughly mid-to-senior. You have 15+ years; you may read as overqualified on first pass.",
    domain: "They build AI-powered enterprise customer experience software. You've built agency, e-commerce, and WordPress sites, different problem space.",
    recent: "Your most recent role was a WordPress advertising agency project; this role wants modern JS framework work on enterprise SaaS.",
  },
};
const base = { dossierText: "D", jobText: "J", today: "2026-08-11" };

describe("screenForComposer", () => {
  it("carries the verdict for each dimension, not just the sentence", () => {
    const s = screenForComposer(COV);
    expect(s.rows.map((r) => r.dimension)).toEqual(["Level", "Domain", "Recent work"]);
    // domain 0.25 is below the 0.35 floor in verdictFor, so the composer is told plainly it is a gap
    expect(s.rows.find((r) => r.dimension === "Domain").verdict).toBe("no");
    expect(s.seniorityLevel).toBe("over");
  });

  it("returns null when there is no readout, so the prompt is unchanged", () => {
    expect(screenForComposer({ thin: true })).toBeNull();
    expect(screenForComposer(null)).toBeNull();
    expect(screenForComposer({ thin: false, screen: {} })).toBeNull();
  });

  it("passes NO score, subscore, composite or lane — the composer is told what the reader sees, not given a number to talk about", () => {
    const json = JSON.stringify(screenForComposer(COV));
    for (const leak of ["composite", "subscores", "lane", "0.25", "69"]) expect(json).not.toContain(leak);
  });
});

describe("the composer prompt", () => {
  it("contains the read, with its verdicts, when a screen is passed", () => {
    const out = buildComposerUserContent({ ...base, screen: screenForComposer(COV) });
    expect(out).toContain("THE READ THE PERSON WILL SEE");
    expect(out).toContain("may read as overqualified");
    expect(out).toContain('"verdict": "no"');
    expect(out).toContain('they read as "over"');
  });

  it("FAILS OPEN: without a screen the prompt is byte-identical to before this change", () => {
    const withNull = buildComposerUserContent({ ...base, screen: null });
    const without = buildComposerUserContent({ ...base });
    expect(withNull).toBe(without);
    expect(withNull).not.toContain("THE READ THE PERSON WILL SEE");
  });
});

describe("both production send paths actually pass it", () => {
  // A static source check, because the wiring is the part that silently rots: the rubric can be
  // perfect and the block never arrive.
  for (const f of ["scheduler.mjs", "first-role.mjs"]) {
    it(`${f} passes screenForComposer into composeEmailFields`, () => {
      const src = read(`./${f}`);
      expect(src).toContain("screenForComposer");
      const call = src.slice(src.indexOf("composeEmailFields("), src.indexOf("composeEmailFields(") + 900);
      expect(call).toContain("screen:");
    });
  }

  it("the rubric states the rule the data exists to enforce", () => {
    const md = read("./composer.md");
    expect(md).toContain("MUST NOT ARGUE WITH THE READ SHOWN");
    expect(md).toContain("THE READ THE PERSON WILL SEE");
  });
});
