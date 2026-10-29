// inbound-question.test.mjs — a question never reaches the preference writer.
//
// A person asking "has my application been sent?" must get an answer, not a confirmation of a
// preference change. The dangerous half is that a question fed to applyEmailChange writes facts INTO a
// person's profile: asking "should I apply via the button above?" could change what Charlie believes
// somebody is looking for.
//
// The messages below are representative of real inbound mail (anonymised): a classifier tuned only on
// invented examples proves little about the mail people actually send.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeQuestion, knownAnswer } from "./lib/inbound-question.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

// Questions. These must never touch the preference writer.
const QUESTIONS = [
  "Has it been applied? I mean did my application go out?",
  "Do I use the link above to apply? or do i just answer this mail?\n\nKindly let me know.\nRegards",
  "Hi,\n\nThank you for writing to me.\n\nDo I use the link above to apply? or do i just answer this mail?",
];

// Preference statements. These must keep reaching it, or the product stops learning anything.
const PREFERENCES = [
  "Mid-level, or Senior if the team is small.",
  "Pay floor: $38,000 USD a year (~32L), for remote roles abroad.",
  "I am open to offers now.\nI can start immediately.\nBase pay needs to be at least 55k",
  "Got it, thanks. Two firm no's: night shifts, and anything that is mostly cold outreach.",
  "Remote",
  "Want a junior lab analyst role. Entry level is fine. I am an immediate joiner.",
  "Principal and Staff data engineering roles, ideally in logistics or energy, and greenfield platform work.",
];

describe("looksLikeQuestion, on real mail", () => {
  for (const t of QUESTIONS) {
    it(`treats as a question: "${t.slice(0, 48)}..."`, () => {
      expect(looksLikeQuestion(t).isQuestion).toBe(true);
    });
  }

  for (const t of PREFERENCES) {
    it(`still routes to the writer: "${t.slice(0, 48)}..."`, () => {
      expect(looksLikeQuestion(t).isQuestion, "a stated preference was swallowed as a question").toBe(false);
    });
  }

  it("a preference wins when a message is both", () => {
    // The asymmetric cost, stated in the module: missing a question costs one unanswered email;
    // ignoring a stated preference matches somebody on the wrong thing for weeks.
    expect(looksLikeQuestion("Can you make it remote only? My pay floor is 40k.").isQuestion).toBe(false);
  });

  it("a long message is not treated as a quick question", () => {
    // A nine-paragraph objection asks nothing answerable mechanically.
    const long = readFileSync(join(ROOT, "lib/inbound-question.mjs"), "utf8").slice(0, 3000);
    expect(looksLikeQuestion(long).isQuestion).toBe(false);
  });

  it("empty and whitespace are not questions", () => {
    expect(looksLikeQuestion("").isQuestion).toBe(false);
    expect(looksLikeQuestion("   \n  ").isQuestion).toBe(false);
    expect(looksLikeQuestion(null).isQuestion).toBe(false);
  });
});

describe("knownAnswer only fires for the one answer that is the same for everybody", () => {
  it("recognises the has-it-been-sent question", () => {
    expect(knownAnswer("Has it been applied? I mean did my application go out?")).toBe("applied");
    expect(knownAnswer("have you applied on my behalf?")).toBe("applied");
    expect(knownAnswer("did you submit it for me already?")).toBe("applied");
  });

  it("returns null for anything else, so a human answers it", () => {
    // Guessing at somebody's question would be the same bug, one layer up.
    expect(knownAnswer("what is the salary range?")).toBeNull();
    expect(knownAnswer("who is the hiring manager?")).toBeNull();
    expect(knownAnswer("can I talk to someone?")).toBeNull();
  });
});

describe("the inbound route wires it in front of the writer", () => {
  const src = readFileSync(join(ROOT, "server/charlie-remote.ts"), "utf8");

  it("checks for a question BEFORE applyEmailChange", () => {
    const q = src.indexOf("looksLikeQuestion(ownWords)");
    const w = src.indexOf("await applyEmailChange(from,");
    expect(q, "the question check is missing").toBeGreaterThan(-1);
    expect(w).toBeGreaterThan(-1);
    expect(q, "the writer runs before the question check, which is the bug").toBeLessThan(w);
  });

  it("returns without writing, rather than falling through", () => {
    const block = src.slice(src.indexOf("const q = looksLikeQuestion(ownWords)"), src.indexOf("await applyEmailChange(from,"));
    expect(block).toMatch(/return;/);
    expect(block, "an unanswerable question must reach a human").toMatch(/ALERT_EMAIL|ALERT_TO\(\)/);
  });
});
