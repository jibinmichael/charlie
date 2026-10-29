// evidence-ask.test.mjs — the question put to somebody must be about the job they actually do.
//
// A generic ask returns generic answers, and a generic answer is what cannot be handed to a company.
// The ordering inside familyOf is load-bearing rather than incidental, so it is pinned here.

import { describe, it, expect } from "vitest";
import { familyOf, evidenceQuestionFor, EVIDENCE_QUESTION } from "./evidence-ask.mjs";

describe("familyOf", () => {
  // THE ORDERING BUG THIS PINS. "Product Designer" matches both /design/ and /product/. Testing
  // product first would ask every product designer in the pool what number moved when they shipped.
  it("a product designer is a designer, not a product manager", () => {
    expect(familyOf({ current_title: "Product Designer" })).toBe("design");
    expect(familyOf({ current_title: "Senior Product Designer" })).toBe("design");
    expect(familyOf({ role_family: "design", current_title: "Product Design Lead" })).toBe("design");
  });

  it("a platform engineer is infra, not generic engineering", () => {
    // Same shape: /engineer/ would swallow these, and "what broke and what was causing it" is what
    // separates real production experience from a tool list.
    expect(familyOf({ current_title: "Cloud Infrastructure Engineer" })).toBe("infra");
    expect(familyOf({ current_title: "Site Reliability Engineer" })).toBe("infra");
    expect(familyOf({ current_title: "DevOps Engineer" })).toBe("infra");
    expect(familyOf({ current_title: "Backend Engineer" })).toBe("engineering");
  });

  it("places the product titles the narrow regex missed", () => {
    // Each of these must not land in `other` with the weakest question in the table.
    for (const t of ["Product Head", "Product Associate", "Senior Product Executive", "Director of Product & Technology", "Group Product Manager"]) {
      expect(familyOf({ current_title: t }), t).toBe("product");
    }
  });

  it("places the client-facing titles with customer success", () => {
    for (const t of ["Client Engagement Manager", "Customer Success Manager", "Key Account Manager", "Relationship Manager"]) {
      expect(familyOf({ current_title: t }), t).toBe("customer");
    }
  });

  it("falls back to other rather than guessing", () => {
    // Plenty of people have no title at all. A confidently product-flavoured question to a
    // recruiter is worse than a general one to somebody we genuinely cannot place.
    expect(familyOf({})).toBe("other");
    expect(familyOf({ current_title: "Founder" })).toBe("other");
    expect(familyOf({ current_title: "" , role_family: null })).toBe("other");
  });
});

describe("evidenceQuestionFor", () => {
  it("always returns a question", () => {
    for (const row of [{}, { current_title: "???" }, null, undefined]) {
      expect(String(evidenceQuestionFor(row)).length).toBeGreaterThan(40);
    }
  });

  it("asks for a thing that exists, never for a self-assessment", () => {
    // "What are your strengths" invites marketing copy about oneself, which is the one material this
    // product refuses to trade in. Every question here names an artefact, an account, or a number.
    for (const [fam, q] of Object.entries(EVIDENCE_QUESTION)) {
      expect(q, fam).not.toMatch(/your strengths|best at|describe yourself|why are you|what makes you/i);
      expect(q, fam).toMatch(/what|which/i);
    }
  });

  it("carries no em dash (voice rule)", () => {
    for (const q of Object.values(EVIDENCE_QUESTION)) expect(q).not.toMatch(/—|–/);
  });
});
