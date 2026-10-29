// enrichment-null-title.test.mjs — a null title must not cost somebody their row.
//
// A `.default()` fires when a key is ABSENT and never when it is explicitly null. A resume listing an
// employer with no stated title makes the model return `title: null`, which is the grounded answer.
// The schema must accept it rather than reject the whole object (lib/enrich.mjs would retry once,
// give up, and drop the person).
//
// PROOF THIS IS A REAL REGRESSION TEST, not one that passes by construction: the old shape is
// reconstructed below and asserted to FAIL on the same input the new schema accepts.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { EnrichedRole, CandidateEnrichment } from "./schemas/enrichment.mjs";

const OLD = z.object({
  company: z.string().default(""),
  title: z.string().default(""),
  start: z.string().nullable().default(null),
  end: z.string().nullable().default(null),
}).passthrough();

describe("a null title", () => {
  const withNull = { company: "Acme", title: null, start: "2022", end: null };

  it("was rejected by the old schema (the bug, reproduced)", () => {
    expect(OLD.safeParse(withNull).success).toBe(false);
  });

  it("is accepted now, and reads as unknown rather than invented", () => {
    const r = EnrichedRole.safeParse(withNull);
    expect(r.success).toBe(true);
    expect(r.data.title).toBe("");
    expect(r.data.company).toBe("Acme");
  });

  it("a null company is accepted too", () => {
    const r = EnrichedRole.safeParse({ company: null, title: "Designer" });
    expect(r.success).toBe(true);
    expect(r.data.company).toBe("");
  });

  it("an absent key still defaults, as before", () => {
    const r = EnrichedRole.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data.title).toBe("");
    expect(r.data.company).toBe("");
  });

  // The whole point: one unknown field must not discard everything else known about the person.
  it("one null title no longer drops the entire candidate", () => {
    const person = {
      current_title: "Product Designer",
      skills: ["Figma", "design systems"],
      roles: [{ company: "Acme", title: null }, { company: "Globex", title: "UI Designer" }],
    };
    expect(OLD.safeParse(person.roles[0]).success, "the old shape must fail, or this proves nothing").toBe(false);
    const r = CandidateEnrichment.safeParse(person);
    expect(r.success).toBe(true);
    expect(r.data.skills).toEqual(["Figma", "design systems"]);
    expect(r.data.roles[1].title).toBe("UI Designer");
  });
});
