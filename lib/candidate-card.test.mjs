// candidate-card.test.mjs — the row a hiring manager decides from. Unknown must stay unknown.
//
// Every derived value here exists so a decision can be made without opening the row. The one thing
// that would make that dangerous is a computed field quietly filling a gap: a missing notice period
// rendered as "Immediate", or a missing consent rendered as permission.

import { describe, it, expect } from "vitest";
import { readyBand, bandFit, lakhs, consentTag, mobilityTag, watchOuts, nowLine } from "./candidate-card.mjs";

describe("readyBand", () => {
  it("bands a real notice period", () => {
    expect(readyBand(0)).toBe("Immediate");
    expect(readyBand(15)).toBe("15 days or less");
    expect(readyBand(30)).toBe("30 days or less");
    expect(readyBand(60)).toBe("31 to 60 days");
    expect(readyBand(90)).toBe("60 days or more");
  });

  // A person we never asked is not a person who can start tomorrow.
  it("never reads a missing notice as immediate", () => {
    expect(readyBand(null)).toBe("Unknown");
    expect(readyBand(undefined)).toBe("Unknown");
  });
});

describe("bandFit", () => {
  it("places an ask against the mandate range", () => {
    expect(bandFit(1800000, 35, 42)).toBe("Below band");
    expect(bandFit(3800000, 35, 42)).toBe("Inside band");
    expect(bandFit(7000000, 35, 42)).toBe("Above band");
  });

  it("says Not stated rather than guessing a number", () => {
    expect(bandFit(null, 35, 42)).toBe("Not stated");
  });

  // An unreadable unit is not a low expectation. "Below band" beside 5000 would be a judgement made
  // on a typo, and a manager would act on it.
  it("does not read an implausible figure as Below band", () => {
    expect(bandFit(5000, 35, 42)).toBe("Not stated");
    expect(bandFit(15000, 35, 42)).toBe("Not stated");
  });

  it("treats the edges as inside, because a band is inclusive", () => {
    expect(bandFit(3500000, 35, 42)).toBe("Inside band");
    expect(bandFit(4200000, 35, 42)).toBe("Inside band");
  });
});

describe("consentTag", () => {
  // THE ONE THAT MATTERS. Pool consent is permission to write to somebody about other roles. It is
  // NOT permission to show them to a client, and collapsing the two would put a name in front of a
  // company that person never agreed to be shown to.
  it("does not read pool consent as permission to share", () => {
    expect(consentTag({ consent_pool: true, consent_share: false })).toBe("Pool only, not asked");
  });

  it("says yes only when they said yes to sharing", () => {
    expect(consentTag({ consent_pool: true, consent_share: true })).toBe("Can share with client");
    expect(consentTag({ consent_pool: false, consent_share: true })).toBe("Can share with client");
  });

  // Some forms never ask the share question in a recognisable form: one asks nothing at all, another
  // asks it as consent to be contacted by that client's own HR. On the board FOR THE MANDATE THEY
  // APPLIED TO, "No" would be wrong and would stop a manager reading.
  it("treats applying to the mandate as permission for that mandate", () => {
    expect(consentTag({ consent_share: false, consent_pool: false }, true)).toBe("Can share - they applied");
    expect(consentTag({ consent_share: true }, true)).toBe("Can share - said yes");
  });

  it("does not let an application become permission for a DIFFERENT client", () => {
    expect(consentTag({ consent_share: false, consent_pool: true }, false)).toBe("Pool only, not asked");
    expect(consentTag({ consent_share: false, consent_pool: false }, false)).toBe("No");
  });

  it("defaults to No on an empty record", () => {
    expect(consentTag({})).toBe("No");
    expect(consentTag(null)).toBe("No");
  });
});

describe("lakhs", () => {
  it("renders an ask a person can read", () => {
    expect(lakhs(1800000)).toBe("18L");
    expect(lakhs(4250000)).toBe("42.5L");
  });
  it("renders nothing rather than a wrong number", () => {
    expect(lakhs(null)).toBe("");
    expect(lakhs(undefined)).toBe("");
  });

  // Applicants often type 1500, 5000 or 15000 into a field labelled "annual CTC".
  // Rendering "0.2L" tells a hiring manager somebody wants twenty thousand rupees a year.
  it("refuses a figure too small to be an annual salary", () => {
    for (const v of [1500, 5000, 15000, 99999]) expect(lakhs(v), String(v)).toBe("");
    expect(lakhs(100000)).toBe("1L");
  });
});

describe("watchOuts", () => {
  // A flag is a fact we do not have, never a judgement about the person. That is what makes it safe
  // to show a client-facing reader: it tells them what to ask, not what to think.
  it("names the gaps and nothing else", () => {
    expect(watchOuts({ total_years: null, linkedin_url: null, portfolio_url: null, comp_expected: null }, {}))
      .toEqual(["Years not recorded", "No LinkedIn", "No portfolio or link", "No expected pay", "Thin answers"]);
  });

  it("flags a pay figure it cannot read, rather than showing it", () => {
    const r = { total_years: 6, linkedin_url: "x", portfolio_url: "y", comp_expected: 15000 };
    expect(watchOuts(r, { a: "x".repeat(300) })).toEqual(["Pay figure unclear"]);
  });

  it("is empty when the record is complete", () => {
    const full = { total_years: 6, linkedin_url: "x", portfolio_url: "y", comp_expected: 1800000 };
    expect(watchOuts(full, { a: "x".repeat(300) })).toEqual([]);
  });

  it("flags thin answers on length, not on tone", () => {
    const full = { total_years: 6, linkedin_url: "x", portfolio_url: "y", comp_expected: 1 };
    expect(watchOuts(full, { a: "short" })).toContain("Thin answers");
  });
});

describe("nowLine and mobilityTag", () => {
  it("joins what exists and drops what does not", () => {
    expect(nowLine("Data Scientist", "Turing")).toBe("Data Scientist · Turing");
    expect(nowLine("Data Scientist", null)).toBe("Data Scientist");
    expect(nowLine(null, null)).toBe("");
  });

  it("passes through only the four real mobility values", () => {
    expect(mobilityTag("hopper")).toBe("Hopper");
    expect(mobilityTag("unknown")).toBe("Unknown");
    expect(mobilityTag(null)).toBe("Unknown");
    expect(mobilityTag("nonsense")).toBe("Unknown");
  });
});
