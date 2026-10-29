// mandate-parse.test.mjs — the quote check and report in lib/mandate-parse.mjs. The rule that matters:
// a requirement survives only if its quote is really in the job description. The fixture is a
// synthetic job description.

import { describe, it, expect } from "vitest";
import { verifyQuotes, renderMatrix } from "./mandate-parse.mjs";

const JD = `Frontend Engineer. Chennai. 14-20 LPA. Hybrid, 3 days in office.
Build lesson, quiz and progress screens used by students on low-cost phones.
Requirements:
At least 3 years of experience building production web frontends
Overall 4-8 years of experience in software engineering
Must have shipped an app in React or Vue that real users depend on.
Comfortable measuring and fixing slow pages on low-end Android devices
Good communication and a passion for education`;

const base = {
  role: "Frontend Engineer", company: null, location: "Chennai",
  hard: [], preferred: [], capabilities: [], ambiguous: [], contradictions: [], unknowns: [],
};

describe("the quote check", () => {
  it("keeps a requirement whose words are in the document", () => {
    const { kept, dropped } = verifyQuotes({ ...base, hard: [
      { requirement: "3 years frontend", quote: "At least 3 years of experience building production web frontends", evidence_needed: "a dated frontend role" },
    ] }, JD);
    expect(kept.hard).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("DROPS an invented requirement, however plausible it sounds", () => {
    // Nothing in this JD asks for a computer science degree. This is the failure the check exists for.
    const { kept, dropped } = verifyQuotes({ ...base, hard: [
      { requirement: "CS degree required", quote: "must hold a computer science degree from a top institute", evidence_needed: "the degree" },
    ] }, JD);
    expect(kept.hard).toHaveLength(0);
    expect(dropped[0].requirement).toBe("CS degree required");
  });

  it("reports the drop rather than swallowing it", () => {
    const { dropped } = verifyQuotes({ ...base, preferred: [
      { requirement: "invented", quote: "this sentence is nowhere in the source", evidence_needed: "x" },
    ] }, JD);
    expect(dropped).toHaveLength(1);
    expect(renderMatrix({ ...base }, dropped)).toMatch(/DROPPED/);
  });

  it("is tolerant of whitespace and case, not of different words", () => {
    const { kept } = verifyQuotes({ ...base, hard: [
      { requirement: "years", quote: "OVERALL  4-8   years of experience", evidence_needed: "x" },
    ] }, JD);
    expect(kept.hard).toHaveLength(1);
  });

  it("refuses a quote too short to be distinctive", () => {
    const { kept, dropped } = verifyQuotes({ ...base, hard: [
      { requirement: "years", quote: "4-8", evidence_needed: "x" },
    ] }, JD);
    expect(kept.hard).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("needs BOTH quotes for a contradiction", () => {
    const { kept, dropped } = verifyQuotes({ ...base, contradictions: [
      { what: "years disagree", quote_a: "Overall 4-8 years of experience in software engineering", quote_b: "we want two to three years" },
    ] }, JD);
    expect(kept.contradictions).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
});

describe("the report says what it is and is not", () => {
  it("never claims to have scored anybody", () => {
    const out = renderMatrix({ ...base, hard: [{ requirement: "x", quote: "Build lesson, quiz and progress screens", evidence_needed: "y" }] }, []);
    expect(out).toMatch(/Nobody was scored/);
    expect(out).not.toMatch(/shortlist|recommend|reject/i);
  });

  it("says plainly when no company is named", () => {
    expect(renderMatrix({ ...base }, [])).toMatch(/company not named/);
  });

  it("does not resolve a contradiction it found", () => {
    const out = renderMatrix({ ...base, contradictions: [
      { what: "years", quote_a: "4-8 years", quote_b: "2-3 years" },
    ] }, []);
    expect(out).toMatch(/for the client to settle/);
  });
});

// The size caps fit real job-post lines, and an item that breaks one is dropped and reported; the
// rest of the post is never refused with it.
import { salvageMandate } from "./schemas/mandate-parse.mjs";
describe("one bad item never refuses the whole post", () => {
  const item = (requirement, extra = {}) => ({ requirement, quote: "At least 3 years of experience building production web frontends", evidence_needed: "a dated frontend role", ...extra });
  const raw = (over = {}) => ({ ...base, hard: [item("3 years frontend")], ...over });
  it("a requirement restated at real length (up to 400 characters) is kept", () => {
    const r = salvageMandate(raw({ hard: [item("x".repeat(300))] }));
    expect(r.success).toBe(true);
    expect(r.data.hard).toHaveLength(1);
  });
  it("an item past the cap is dropped and reported; the rest of the post is kept", () => {
    const r = salvageMandate(raw({ hard: [item("3 years frontend"), item("y".repeat(450))] }));
    expect(r.success).toBe(true);
    expect(r.data.hard.map((h) => h.requirement)).toEqual(["3 years frontend"]);
    expect(r.dropped).toEqual([expect.objectContaining({ bucket: "hard", reason: expect.stringMatching(/schema/) })]);
  });
  it("a capability missing what would establish it is dropped and reported, not the post", () => {
    const r = salvageMandate(raw({ capabilities: [{ requirement: "Builds lesson screens", quote: "Build lesson, quiz and progress screens", observable: ["a screen"] }] }));
    expect(r.success).toBe(true);
    expect(r.data.capabilities).toEqual([]);
    expect(r.dropped[0]).toMatchObject({ bucket: "capabilities", requirement: "Builds lesson screens" });
  });
  it("a location over the cap becomes empty and is reported (the ATS location wins anyway)", () => {
    const r = salvageMandate(raw({ location: "z".repeat(320) }));
    expect(r.success).toBe(true);
    expect(r.data.location).toBeNull();
    expect(r.dropped[0]).toMatchObject({ bucket: "location" });
  });
  it("a post with no role is still refused", () => {
    expect(salvageMandate(raw({ role: "" })).success).toBe(false);
    expect(salvageMandate(null).success).toBe(false);
  });
});
