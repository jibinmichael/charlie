// normalise.test.mjs — the deterministic layer that decides who appears in a shortlist.
//
// These are pure functions with no model and no network, and they are the reason the talent pool can
// be queried at all. They also decide real things about real people: whether somebody is reachable,
// how soon they can start, and whether a hiring manager sees the word "hopper" next to their name.
//
// Unanchored patterns are the trap: `0\s*day` matches inside "30 days", which would record everyone
// on a month's notice as IMMEDIATELY AVAILABLE — exactly the kind of small wrong fact a hiring
// manager discovers on a call.

import { describe, it, expect } from "vitest";
import {
  normaliseLocation, normaliseNotice, normaliseComp, normaliseSeeking,
  normaliseSeniority, normaliseFamily, mobilityProfile, monthsBetween, completenessOf,
} from "./lib/normalise.mjs";

describe("normaliseNotice", () => {
  it("does NOT read '30 days' as immediate", () => {
    // The regression. Unanchored `0\s*day` matches inside "3(0 day)s".
    expect(normaliseNotice("30 days")).toBe(30);
    expect(normaliseNotice("90 days")).toBe(90);
    expect(normaliseNotice("60 days")).toBe(60);
  });

  it("treats a genuine immediate as 0, not as missing", () => {
    // "Immediately" is an ANSWER. Recording it as null would hide the most available people.
    for (const s of ["Immediately", "immediate", "right away", "0 days", "serving notice"]) {
      expect(normaliseNotice(s), s).toBe(0);
    }
  });

  it("takes the UPPER bound of a range", () => {
    // "1-2 months" means a company waits two. Promising one is the small optimism that costs trust.
    expect(normaliseNotice("1-2 months")).toBe(60);
    expect(normaliseNotice("30-45 days")).toBe(45);
    expect(normaliseNotice("2 to 3 months")).toBe(90);
  });

  it("handles the phrasings the forms actually produce", () => {
    expect(normaliseNotice("2 weeks notice")).toBe(14);
    expect(normaliseNotice("8+ weeks notice")).toBe(56);
    expect(normaliseNotice("3 months")).toBe(90);
  });

  it("returns null when there is nothing to read, never a guess", () => {
    for (const s of ["", null, undefined, "depends", "will discuss"]) expect(normaliseNotice(s)).toBeNull();
  });
});

describe("normaliseComp — Indian conventions", () => {
  it("parses the forms lakhs and crores actually arrive in", () => {
    expect(normaliseComp("40 LPA")).toEqual({ value: 4000000, currency: "INR" });
    expect(normaliseComp("₹40L")).toEqual({ value: 4000000, currency: "INR" });
    expect(normaliseComp("60 lakhs")).toEqual({ value: 6000000, currency: "INR" });
    expect(normaliseComp("1.2 Cr")).toEqual({ value: 12000000, currency: "INR" });
  });

  it("reads a bare Indian number as lakhs per annum", () => {
    // "45" in an Indian application means 45 LPA, never 45 rupees.
    expect(normaliseComp("45")).toEqual({ value: 4500000, currency: "INR" });
    expect(normaliseComp("40,00,000")).toEqual({ value: 4000000, currency: "INR" });
  });

  it("keeps dollars as dollars", () => {
    expect(normaliseComp("$120,000")).toEqual({ value: 120000, currency: "USD" });
  });

  it("returns null rather than zero when nothing is stated", () => {
    expect(normaliseComp("")).toEqual({ value: null, currency: null });
    expect(normaliseComp("negotiable")).toEqual({ value: null, currency: null });
  });
});

describe("normaliseLocation", () => {
  it("canonicalises the spellings that would otherwise split a city in two", () => {
    expect(normaliseLocation("Bangalore, India").city).toBe("Bengaluru");
    expect(normaliseLocation("Bengaluru, Karnataka, India").city).toBe("Bengaluru");
    expect(normaliseLocation("Bombay").city).toBe("Mumbai");
    expect(normaliseLocation("Calcutta, India").city).toBe("Kolkata");
    expect(normaliseLocation("Gurgaon").city).toBe("Gurugram");
  });

  it("infers India from a state name when the country is not written", () => {
    expect(normaliseLocation("Noida").country).toBe("India");
    expect(normaliseLocation("Pune, Maharashtra").country).toBe("India");
  });

  it("does not force India onto a non-Indian location", () => {
    expect(normaliseLocation("San Francisco, CA, USA").country).toBe("United States");
  });

  it("returns nulls for nothing", () => {
    expect(normaliseLocation("")).toEqual({ city: null, country: null });
  });
});

describe("normaliseSeniority and normaliseFamily", () => {
  it("puts head-of roles above manager, and does not read 'design' out of 'head of design'", () => {
    expect(normaliseSeniority("Head of Design")).toBe("head");
    expect(normaliseSeniority("VP Product")).toBe("head");
    expect(normaliseSeniority("Staff Product Manager")).toBe("lead");
    expect(normaliseSeniority("Senior Product Designer")).toBe("senior_ic");
  });

  it("does NOT read the word manager in a title where it is the function, not the level", () => {
    // "Product Manager" and "Customer Success Manager" are ICs. Reading them as people-managers
    // would put every PM in the country in the wrong bucket.
    expect(normaliseSeniority("Product Manager")).toBe("ic");
    expect(normaliseSeniority("Customer Success Manager")).toBe("ic");
    expect(normaliseSeniority("Engineering Manager")).toBe("manager");
  });

  it("maps titles to the families the ATS actually has demand in", () => {
    expect(normaliseFamily("Senior Product Designer")).toBe("product_design");
    expect(normaliseFamily("Group Product Manager")).toBe("product_management");
    expect(normaliseFamily("Customer Success Manager")).toBe("customer_success");
    expect(normaliseFamily("Enterprise Account Executive")).toBe("sales");
    expect(normaliseFamily("Technical Program Manager")).toBe("ops");
    expect(normaliseFamily("Chief Marketing Officer")).toBe("marketing");
  });
});

describe("mobilityProfile — the label that follows somebody into an inbox", () => {
  const roles = (...m) => m.map((months) => ({ months }));

  it("calls a long-tenure career stable", () => {
    expect(mobilityProfile(roles(48, 36, 50, 34), 15).profile).toBe("stable");
  });

  it("calls a short-tenure career a hopper, but only with enough history", () => {
    expect(mobilityProfile(roles(12, 18, 11, 15, 14), 8).profile).toBe("hopper");
  });

  it("REFUSES to judge an early career", () => {
    // A graduate with three one-year roles is normal. Labelling them a hopper would be a fact about
    // the industry rather than about them.
    expect(mobilityProfile(roles(12, 12, 12), 3).profile).toBe("unknown");
  });

  it("REFUSES to judge on fewer than three roles", () => {
    // Two short stints is not a pattern, it is two stints.
    expect(mobilityProfile(roles(10, 12), 9).profile).toBe("unknown");
    expect(mobilityProfile(roles(10), 9).profile).toBe("unknown");
  });

  it("ignores roles with no usable dates rather than counting them as zero", () => {
    const mixed = [{ months: 48 }, { months: null }, { months: 36 }, { months: 40 }];
    const out = mobilityProfile(mixed, 12);
    expect(out.avg).toBe(41);
    expect(out.profile).toBe("stable");
  });

  it("always explains itself", () => {
    expect(mobilityProfile(roles(12, 12, 12), 3).reason).toMatch(/four years/);
    expect(mobilityProfile(roles(10, 12), 9).reason).toMatch(/three dated roles/);
  });
});

describe("monthsBetween", () => {
  it("counts whole months and resolves present", () => {
    expect(monthsBetween("2020-01", "2023-01")).toBe(36);
    expect(monthsBetween("2024-06", "present")).toBeGreaterThan(0);
  });
  it("returns null on a missing or reversed range rather than a negative tenure", () => {
    expect(monthsBetween(null, "2023-01")).toBeNull();
    expect(monthsBetween("2023-01", "2020-01")).toBeNull();
  });
});

describe("completenessOf drives the ask", () => {
  it("names what is missing so the person is asked only for that", () => {
    const out = completenessOf({ current_title: "PM", city: "Pune", notice_days: null, seeking_status: "unknown" });
    expect(out.missing_fields).toContain("notice_days");
    expect(out.missing_fields).toContain("seeking_status");
    expect(out.missing_fields).not.toContain("current_title");
    expect(out.completeness).toBeLessThan(100);
  });

  it("treats the string 'unknown' as missing, not as an answer", () => {
    expect(completenessOf({ seeking_status: "unknown" }).missing_fields).toContain("seeking_status");
  });

  it("a fully answered record is 100", () => {
    const full = { notice_days: 30, comp_expected: 1, seeking_status: "active_seeker", current_title: "a",
      current_company: "b", city: "c", total_years: 5, linkedin_url: "d", portfolio_url: "e", willing_to_relocate: "yes" };
    expect(completenessOf(full).completeness).toBe(100);
  });
});
