// name-shape.test.mjs — the stored name must be a name, or nothing at all.
//
// WHY THIS EXISTS. `extractName` takes the first non-empty line of the grounding source, and with
// resume-optional onboarding that source is often the person's EMAIL, not a resume. The greeting
// guard handles "Hi Charlie,". Three other shapes would otherwise reach every lifecycle template as
// the person's name:
//
//   "Portfolio: behance.net/abc"                     a label + a url
//   "Q A L e a d | J a i p u r , I n d i a"  a letter-spaced tagline
//   "PRIYA K. S ."                                   a REAL name, stray space
//
// The first two must become null — a wrong name in a real inbox is worse than no name, and
// every template degrades cleanly to "You're all set." The third must NOT be nulled: it is a correct
// name that a PDF spaced badly, and throwing it away loses something true about the person. It is
// whitespace-normalised instead, which changes no character of the name and keeps it verbatim.
//
// The false-positive direction matters as much as the true-positive one, so real names from a range
// of conventions are asserted to SURVIVE. A guard that nulls everything would "fix" the bug and
// silently strip every name in the product.

import { describe, it, expect } from "vitest";
import { extractName } from "./dossier-build.mjs";

describe("three non-name first-line shapes", () => {
  it('nulls "Portfolio: behance.net/abc" (a label and a url, not a name)', () => {
    expect(extractName("Portfolio: behance.net/abc")).toBeNull();
  });

  it('nulls the letter-spaced PDF tagline "Q A L e a d | J a i p u r , I n d i a"', () => {
    expect(extractName("Q A L e a d | J a i p u r , I n d i a")).toBeNull();
  });

  it('REPAIRS "PRIYA K. S ." rather than discarding a real name', () => {
    expect(extractName("PRIYA K. S .")).toBe("PRIYA K. S.");
  });
});

describe("still nulls everything the earlier guards caught", () => {
  it("a salutation, a section header, an email address, an empty line", () => {
    for (const s of ["Hi Charlie,", "Hey there", "Dear Charlie", "WORK EXPERIENCE", "Skills:", "reviewer@example.com", "", "   \n  "]) {
      expect(extractName(s), `expected null for ${JSON.stringify(s)}`).toBeNull();
    }
  });

  it("a line that is plainly a headline or a job title, not a name", () => {
    for (const s of ["Senior Product Designer at Acme Corp Ltd", "Full-stack engineer with 8 years of experience", "Product leader | Bangalore"]) {
      expect(extractName(s), `expected null for ${JSON.stringify(s)}`).toBeNull();
    }
  });

  it("contact details that often lead a resume", () => {
    for (const s of ["+91 98765 43210", "Bengaluru, India 560001", "linkedin.com/in/someone", "https://example.com"]) {
      expect(extractName(s), `expected null for ${JSON.stringify(s)}`).toBeNull();
    }
  });
});

describe("real names SURVIVE — the guard must not strip every name in the product", () => {
  const REAL = [
    "Alex Morgan",
    "Maria del Carmen Garcia Lopez", // 5 tokens, the documented ceiling
    "Dr. Anita Rao",                 // an honorific with a period
    "Jean-Luc O'Brien",              // hyphen + apostrophe
    "Jean-Luc O’Brien",         // curly apostrophe
    "PRIYA K. S.",                 // initials, already clean
    "Ng Wei Ling",
    "Priya",                         // a single name is a name
    "José Álvarez",                  // accents
  ];
  it.each(REAL)("keeps %s", (n) => {
    expect(extractName(n)).toBe(n);
  });

  it("keeps a markdown-headed name, stripping only the markdown", () => {
    expect(extractName("# Alex Morgan")).toBe("Alex Morgan");
    expect(extractName("**Alex Morgan**")).toBe("Alex Morgan");
  });

  it("reads the FIRST non-empty line of a real multi-line resume", () => {
    expect(extractName("\n\n  Alex Morgan  \nProduct engineer\nBengaluru, India")).toBe("Alex Morgan");
  });
});

describe("fails closed on anything ambiguous", () => {
  it("nulls rather than guessing when the line is too long to be a name", () => {
    expect(extractName("A".repeat(61))).toBeNull();
  });

  it("nulls a line with more than five words", () => {
    expect(extractName("One Two Three Four Five Six")).toBeNull();
  });

  it("never throws on junk input", () => {
    for (const s of [null, undefined, 0, {}, []]) {
      expect(() => extractName(s)).not.toThrow();
    }
  });
});

// ── a place above the name ───────────────────────────────────────────────────────────────────────
//
// A resume can put the city above the name, so extractName would greet the person as "You're all set
// Pune, Maharashtra." Every rule in NOT_NAME_SHAPED passes it: two capitalised words, no digits, no
// separator, and the comma sits mid-string rather than at the end.
describe("a place is not a person", () => {
  for (const place of ["Pune, Maharashtra", "Bengaluru", "Mumbai, India", "Bangalore, Karnataka", "Remote", "Delhi NCR", "Kochi, Kerala"])
    it(`nulls ${JSON.stringify(place)}`, () => expect(extractName(place)).toBeNull());

  // The other direction matters as much: a surname CAN be a place, and nulling a true name is the
  // error this whole guard exists to avoid.
  for (const real of ["Rahul Pune", "Delhi Kumar", "Shreya Kulkarni", "Goa Sharma"])
    it(`keeps ${JSON.stringify(real)}`, () => expect(extractName(real)).toBe(real));
});

// The form writer (scripts/pool-applicants.mjs, the Tally "Full name" field) goes through extractName
// too, so an email address or a city typed into a name field is not stored as a name.
describe("the form field meets the same guard as a resume", () => {
  it("nulls an email address typed into a name field", () => {
    expect(extractName("someone.name@example.com")).toBeNull();
  });
  it("nulls a city typed into a name field", () => {
    expect(extractName("Pune")).toBeNull();
  });
  it("keeps an ordinary name typed into a name field", () => {
    expect(extractName("Ajay Deshmukh")).toBe("Ajay Deshmukh");
  });
});

// A place word that is ALSO a given name must survive. "Bharat" is both a name for India and a common
// Indian given name; nulling it would be the guard causing the exact harm it exists to prevent.
describe("a place word that is also a given name survives", () => {
  it('keeps "Bharat"', () => expect(extractName("Bharat")).toBe("Bharat"));
  it('keeps "Bharat Modi"', () => expect(extractName("Bharat Modi")).toBe("Bharat Modi"));
});
