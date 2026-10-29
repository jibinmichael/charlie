// form-answers.test.mjs — lib/form-answers.mjs never loses a character of a stored narrative.
//
// `OLD` below is the earlier block-splitting reader. Every test that matters runs the SAME input
// through both and shows the old one losing characters the new one keeps; a test that only exercised
// the new code would pass by construction.

import { describe, it, expect } from "vitest";
import { formAnswers, parseNarrative } from "./form-answers.mjs";

/** The old reader, verbatim. Kept only so the loss is demonstrable. */
function OLD(narrative) {
  const answers = {};
  String(narrative || "").split(/\n\n(?=[A-Z])/).forEach((b) => {
    const i = b.indexOf("\n");
    if (i > 0) answers[b.slice(0, i)] = b.slice(i + 1);
  });
  return answers;
}

const chars = (o) => Object.entries(o).reduce((n, [k, v]) => n + k.length + String(v).length, 0);

// A synthetic applicant: one question, an answer written one idea per paragraph.
const NARRATIVE = [
  "Most impressive work, in your own words",
  "I owned activation at a B2B billing product.",
  "",
  "When I started looking into the journey, I noticed users were struggling before they ever reached the paywall.",
  "",
  "I mapped the onboarding journey end to end, grouped the support themes, and found the three steps that lost the most people.",
  "",
  "The outcome was a shorter onboarding flow and fewer support tickets.",
  "",
  "Why are you interested in this role?",
  "Because the problem is workflow automation and I have shipped it before.",
].join("\n");

describe("the old reader dropped the evidence", () => {
  it("throws away every single-paragraph block", () => {
    const old = OLD(NARRATIVE);
    const text = Object.values(old).join(" ");
    // The claim that decides `outcome_measurement` never reached the model.
    expect(text).not.toContain("I mapped the onboarding journey end to end");
    expect(text).not.toContain("The outcome was a shorter onboarding flow");
  });

  it("loses characters that were in the narrative", () => {
    expect(chars(OLD(NARRATIVE))).toBeLessThan(NARRATIVE.length);
  });
});

describe("parseNarrative keeps all of it", () => {
  it("keeps the paragraphs the old reader dropped", () => {
    const text = Object.values(parseNarrative(NARRATIVE)).join(" ");
    expect(text).toContain("I mapped the onboarding journey end to end");
    expect(text).toContain("The outcome was a shorter onboarding flow");
  });

  it("attaches continuations to the question they belong to", () => {
    const out = parseNarrative(NARRATIVE);
    expect(Object.keys(out)).toEqual([
      "Most impressive work, in your own words",
      "Why are you interested in this role?",
    ]);
    expect(out["Most impressive work, in your own words"]).toContain("fewer support tickets");
  });

  it("loses nothing: every non-blank line of the narrative survives", () => {
    const kept = Object.entries(parseNarrative(NARRATIVE)).map(([k, v]) => `${k}\n${v}`).join("\n");
    for (const line of NARRATIVE.split("\n").filter((l) => l.trim())) expect(kept).toContain(line);
  });

  it("keeps an orphan first block instead of dropping it", () => {
    const out = parseNarrative("A paragraph with no question above it.");
    expect(Object.keys(out)).toEqual(["A paragraph with no question above it."]);
  });

  it("appends a repeated title rather than overwriting it", () => {
    const out = parseNarrative("Question\nfirst answer\n\nQuestion\nsecond answer");
    expect(out.Question).toContain("first answer");
    expect(out.Question).toContain("second answer");
  });
});

describe("formAnswers prefers the stored map", () => {
  it("returns the stored answers without parsing", () => {
    const out = formAnswers({ answers: { "Why this role?": "Because." }, narrative: "ignored\nentirely" });
    expect(out).toEqual({ "Why this role?": "Because." });
  });

  it("falls back to the narrative for rows written before the field existed", () => {
    expect(formAnswers({ narrative: NARRATIVE })["Why are you interested in this role?"])
      .toContain("workflow automation");
  });

  it("does not treat an empty object as a stored map", () => {
    expect(Object.keys(formAnswers({ answers: {}, narrative: NARRATIVE })).length).toBe(2);
  });

  it("survives a dossier with neither", () => {
    expect(formAnswers({})).toEqual({});
    expect(formAnswers(null)).toEqual({});
  });
});
