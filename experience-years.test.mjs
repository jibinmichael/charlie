// experience-years.test.mjs — the knockout floor knows how many years the PERSON has.
//
// Without `professional_years` every experience rule is inert, and a 13-year professional can be sent
// an internship. experience-years.mjs derives the number from the resume we already hold — nobody is
// asked anything, because silence from a user must never cost them roles. But a derived number is
// FUZZY: compared with people's own stated years, disagreements are definitional rather than
// hallucinated (paid internships counted or not, a career gap discounted or not). Reasonable readers
// differ by ~2 years.
//
// So these tests pin the consequence: a fuzzy number may only answer COARSE questions, and an unknown
// must never manufacture a block.
import { describe, it, expect } from "vitest";
import { knockouts } from "./eligibility-gate.mjs";
import { experienceYearsPatch } from "./experience-years.mjs";
import { ExperienceYears } from "./lib/schemas/experience-years.mjs";

const derived = (professional_years, confidence) => ({
  professional_years,
  experience_basis: { confidence, evidence: "Associate Projects (11/2011 to 5/2016)", source: "resume" },
  preferences: {},
});
// 85% of real postings state NO years floor, so employment TYPE is the only signal that can catch this.
const internRole = { id: "i1", title: "Supply Chain Management Intern", employment_type: "Internship", description: "Join our team and learn." };
const seniorRole = { id: "s1", title: "Program Manager", description: "We require a minimum of 12 years of experience leading enterprise programmes." };

describe("K2c — an internship offered to a clearly experienced person", () => {
  it("knocks out a 13-year professional on an internship-typed role with no stated floor", () => {
    expect(knockouts(internRole, derived(13, "high")).join(" ")).toMatch(/internship offered to a candidate with 13 years/);
  });

  it("fires on MEDIUM confidence too — no ±2 error turns 13 years into an intern", () => {
    expect(knockouts(internRole, derived(13, "medium")).length).toBeGreaterThan(0);
  });

  it("never fires on LOW confidence (we do not act on a number we could not read)", () => {
    expect(knockouts(internRole, derived(13, "low"))).toEqual([]);
  });

  it("leaves an internship alone for someone genuinely early-career", () => {
    expect(knockouts(internRole, derived(1, "high"))).toEqual([]);
  });

  it("takes a SELF-STATED number at their word (no confidence gate on their own claim)", () => {
    expect(knockouts(internRole, { professional_years: 13, preferences: {} }).length).toBeGreaterThan(0);
  });
});

describe("K2a/K2b — precise comparisons need a number we trust precisely", () => {
  it("a 10-year gap under a stated floor knocks out on HIGH confidence", () => {
    expect(knockouts(seniorRole, derived(2, "high")).length).toBeGreaterThan(0);
  });

  it("the same gap does NOT knock out on medium — a fuzzy number cannot drive a numeric cutoff", () => {
    expect(knockouts(seniorRole, derived(2, "medium"))).toEqual([]);
  });

  it("a normal stretch still sends: the gap must exceed 5 years, not 3", () => {
    // 8 years against a 12-year ask is a 4-year stretch — inside the expected fuzziness, so blocking
    // it would be firing on measurement error rather than on a real mismatch.
    expect(knockouts(seniorRole, derived(8, "high"))).toEqual([]);
  });

  it("unknown years leaves every experience rule inert", () => {
    expect(knockouts(internRole, { preferences: {} })).toEqual([]);
    expect(knockouts(seniorRole, { professional_years: null, preferences: {} })).toEqual([]);
  });
});

describe("the extraction boundary", () => {
  it("rejects a number that cannot cite its source (no evidence, no claim)", () => {
    expect(ExperienceYears.safeParse({ professional_years: 12, career_start: "2014-01", evidence: "", confidence: "high" }).success).toBe(false);
  });

  it("accepts a null years figure — 'we do not know' is a valid, safe answer", () => {
    const r = ExperienceYears.safeParse({ professional_years: null, career_start: null, evidence: "no dated employment history found", confidence: "low" });
    expect(r.success).toBe(true);
  });

  it("rejects an absurd figure that a mis-parsed date could produce", () => {
    expect(ExperienceYears.safeParse({ professional_years: 812, career_start: null, evidence: "x", confidence: "high" }).success).toBe(false);
  });

  it("the dossier patch carries provenance beside the number, never the number alone", () => {
    const patch = experienceYearsPatch({ professional_years: 13.67, career_start: "2011-11", evidence: "Associate Projects (11/2011 to 5/2016)", confidence: "high" }, { at: "2026-07-29T00:00:00Z" });
    expect(patch.professional_years).toBe(13.67);
    expect(patch.experience_basis.evidence).toMatch(/11\/2011/);
    expect(patch.experience_basis.source).toBe("resume");
    expect(patch.experience_basis.confidence).toBe("high");
  });

  it("no extraction -> no patch (never writes a guessed number to a dossier)", () => {
    expect(experienceYearsPatch(null)).toBeNull();
  });
});
