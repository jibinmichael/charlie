// resume-optional-onboarding.test.mjs — a NEW person can onboard from a written bio, no resume needed.
//
// A new person who writes a bio and attaches nothing must still get a dossier: a substantive bio is
// promoted to the grounding source and goes through the SAME grounded, fail-closed build path as a
// resume, so copy that says "no resume needed" is true. These tests prove (1) the bio/junk decision,
// and (2) the wiring: the `if (!existing && !resumeText)` branch in server/charlie-remote.ts grounds a
// real bio and only asks (renderMissingResume) when the body is too thin.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { substantiveBio } from "./email-onboard.mjs";

const REAL_BIO =
  "I'm a product designer with 6 years of experience, most recently at Razorpay where I led the " +
  "checkout redesign. I'm after senior product roles, remote or in Bangalore, minimum 35 lakh.";

describe("substantiveBio — the resume-optional grounding gate", () => {
  it("an empty or whitespace body is not groundable (falls back to the ask)", () => {
    expect(substantiveBio("")).toBe("");
    expect(substantiveBio("   \n  ")).toBe("");
    expect(substantiveBio(null)).toBe("");
    expect(substantiveBio(undefined)).toBe("");
  });

  it("a one-line 'sign me up' is below the floor (still asks)", () => {
    expect(substantiveBio("sign me up please")).toBe("");
    expect(substantiveBio("hi, interested in product roles")).toBe("");
  });

  it("a real written bio is groundable and returned verbatim (trimmed)", () => {
    expect(substantiveBio(`  ${REAL_BIO}  `)).toBe(REAL_BIO);
  });

  it("measures the sender's OWN words only — a short line over a big quoted reply still asks", () => {
    const mostlyQuote =
      "thanks!\n\nOn Mon, Charlie <charlie@mail.example.com> wrote:\n" +
      "> here is a very long quoted message that is definitely more than eighty characters of prior email\n" +
      "> and another quoted line that should never count as the person's own bio at all whatsoever";
    expect(substantiveBio(mostlyQuote)).toBe("");
  });

  it("a real bio ABOVE a quoted reply is grounded on the bio, quote excluded", () => {
    const bioThenQuote =
      `${REAL_BIO}\n\nOn Mon, Charlie wrote:\n> your earlier message here that must not be counted`;
    expect(substantiveBio(bioThenQuote)).toBe(REAL_BIO);
  });
});

// Wiring: the branch is deep in the Express /inbound handler (not unit-callable), so we assert the
// SOURCE shape — the exact guarantees that make the copy honest (the same source-assertion approach
// as first-contact.test.mjs).
describe("the /inbound resume-missing branch grounds a bio before asking", () => {
  const SERVER = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");
  const start = SERVER.indexOf("if (!existing && !resumeText) {");
  const branch = SERVER.slice(start, SERVER.indexOf("\n    }", start));

  it("the branch still exists (re-point this test if it moved)", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("it calls substantiveBio on the body and promotes a real bio to the grounding source", () => {
    expect(branch).toMatch(/substantiveBio\s*\(\s*body\s*\)/);
    expect(branch).toMatch(/resumeText\s*=\s*bio/);
  });

  it("renderMissingResume fires ONLY in the else (too-thin body), after the bio check", () => {
    const bioAt = branch.indexOf("substantiveBio");
    const askAt = branch.indexOf("renderMissingResume");
    expect(bioAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(-1);
    expect(bioAt).toBeLessThan(askAt); // decide groundable-or-not FIRST, ask only as the fallback
    expect(branch).toMatch(/else\s*\{[\s\S]*renderMissingResume/); // the ask lives in the else
  });

  it("substantiveBio is imported from the onboarding seam, not redefined locally", () => {
    expect(SERVER).toMatch(/import\s+\{[^}]*substantiveBio[^}]*\}\s+from\s+"\.\.\/email-onboard\.mjs"/);
  });
});
