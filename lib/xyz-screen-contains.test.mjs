// xyz-screen-contains.test.mjs — the quote verifier contains() in lib/xyz-screen.mjs, on the PDF
// extraction artefacts that break a naive match (a space before a comma, interleaved columns, smart
// punctuation). The resume text is synthetic but keeps those artefacts. OLD is the earlier
// punctuation-sensitive normaliser, kept so the failure is demonstrated rather than described.

import { describe, it, expect } from "vitest";
import { contains } from "./xyz-screen.mjs";

/** The old normaliser, verbatim, so the regression is visible. */
function OLD(haystack, needle) {
  const n = (s) => String(s).toLowerCase().replace(/[\s ]+/g, " ").replace(/[""'']/g, "'").trim();
  const h = n(haystack), q = n(needle);
  if (!q) return true;
  if (h.includes(q)) return true;
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.length > 12);
  return parts.length > 1 && parts.every((p) => h.includes(p));
}

// Note the space before the comma after "Templates", as a PDF extractor emits it.
const RESUME = "Drove the vision, design, and launch of Reusable Templates , enabling seamless template upgrades while preserving\ncustomizations, reducing support overhead by 50%";
const QUOTED = "Drove the vision, design, and launch of Reusable Templates, enabling seamless template upgrades while preserving customizations, reducing support overhead by 50%";

describe("the extraction artifacts that broke it", () => {
  it("a stray space before a comma used to reject a real quote", () => {
    expect(OLD(RESUME, QUOTED)).toBe(false);   // the bug
    expect(contains(RESUME, QUOTED)).toBe(true); // fixed
  });

  it("accepts a quote across a line break in the source", () => {
    expect(contains("reducing support overhead\nby 50% and improving usability", "reducing support overhead by 50%")).toBe(true);
  });

  it("accepts bullet glyphs and non-breaking spaces in the source", () => {
    expect(contains("• Led the product strategy for Atlas", "Led the product strategy for Atlas")).toBe(true);
  });

  it("accepts a smart apostrophe quoted as a straight one", () => {
    expect(contains("the team’s roadmap was mine to own", "the team's roadmap was mine to own")).toBe(true);
  });

  it("accepts an en dash quoted as a hyphen", () => {
    expect(contains("Product Manager, 2019–2026, Northwind", "Product Manager, 2019-2026, Northwind")).toBe(true);
  });
});

describe("it still catches what it exists to catch", () => {
  it("rejects a claim whose words are not in the source", () => {
    expect(contains(RESUME, "Grew annual recurring revenue from 2M to 9M")).toBe(false);
  });

  it("rejects an upgraded quote: one inserted word is one invented fact", () => {
    expect(contains("I worked on the billing service", "I led the billing service")).toBe(false);
    expect(contains("reducing support overhead by 50%", "reducing support overhead by 90%")).toBe(false);
  });

  it("rejects the right words in the wrong order", () => {
    expect(contains("design informed the launch", "the launch informed design")).toBe(false);
  });

  it("treats an empty quote as nothing to verify, which is what a 0 carries", () => {
    expect(contains(RESUME, "")).toBe(true);
  });
});

describe("the two-column resume", () => {
  // A two-column PDF whose columns the extractor interleaved line by line.
  const INTERLEAVED = [
    "- Architected high-scale modules like Expense Travel (4L+",
    "- Spearheading the Product Strategy and Roadmap for core ERP",
    "users) and Contract Desk CLMS, driving a 60% efficiency gain",
    "modules, focusing on digitizing global Agricultural Value",
    "and 40% TAT reduction via automated workflows.",
    "Chains. Leading end-to-end Product Lifecycle (PLC) from user",
    "research to Feature Launch, enhancing Operational efficiency.",
  ].join("\n");
  const QUOTE = "Spearheading the Product Strategy and Roadmap for core ERP modules, focusing on digitizing global Agricultural Value Chains";

  it("used to reject every quote on the page, whatever the normaliser did", () => {
    expect(OLD(INTERLEAVED, QUOTE)).toBe(false);
  });

  it("accepts a real quote the columns broke in half", () => {
    expect(contains(INTERLEAVED, QUOTE)).toBe(true);
  });

  it("does not accept an invented claim just because the page is messy", () => {
    expect(contains(INTERLEAVED, "Owned the P&L for the agricultural division and grew it from 2M to 9M in eighteen months")).toBe(false);
  });

  it("does not accept an upgrade dressed up in the same words", () => {
    // Every important word is on the page; only the adjacency that makes the claim is missing.
    const src = "I worked on the billing service alongside two engineers, and separately I led the design review";
    expect(contains(src, "I led the billing service alongside two engineers and owned it")).toBe(false);
  });

  it("needs eight words before it will reason about phrasing at all", () => {
    expect(contains("alpha beta gamma delta epsilon", "beta gamma zeta")).toBe(false);
  });
});

describe("the ellipsis stitch", () => {
  const SRC = "I owned activation for two years. Lots of other text in between here. Then we cut the wizard from six steps to two.";

  it("verifies both halves of a stitched quote", () => {
    expect(contains(SRC, "I owned activation for two years ... we cut the wizard from six steps to two")).toBe(true);
  });

  it("still rejects a stitch whose second half was invented", () => {
    expect(contains(SRC, "I owned activation for two years ... and doubled revenue in one quarter")).toBe(false);
  });

  it("fires at all, which it could not once the normaliser ate the ellipsis", () => {
    // Splitting the NORMALISED needle would leave no ellipsis to split on, so this branch would be
    // dead code and any stitched quote would be rejected outright.
    expect(contains(SRC, "I owned activation for two years … we cut the wizard from six steps to two")).toBe(true);
  });
});
