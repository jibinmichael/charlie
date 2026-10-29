// dossier-build.test.mjs — extractName: the person's name is pulled VERBATIM from the resume's first
// line and NEVER touched by the model (grounding). A resume that leads with a SECTION HEADER ("WORK
// EXPERIENCE") must not pass that header through as the name. A wrong name in a real inbox is worse
// than no name, so an obvious header becomes null — WITHOUT rejecting a genuine (even all-caps) name.
import { describe, it, expect } from "vitest";
import { extractName } from "./dossier-build.mjs";

describe("extractName — reject section headers, keep real names", () => {
  it("THE regression: a section-header first line → null (was passed through as the name)", () => {
    expect(extractName("WORK EXPERIENCE\nIT Manager at Acme\n")).toBe(null);
  });

  it("common section headers → null", () => {
    for (const h of ["PROFILE", "Contact", "EDUCATION", "Skills", "Professional Summary", "WORK HISTORY", "OBJECTIVE", "Certifications", "References", "About Me", "Curriculum Vitae", "Resume"]) {
      expect(extractName(`${h}\nJane did things\n`), `header: ${h}`).toBe(null);
    }
  });

  it("a header with a trailing colon → null", () => {
    expect(extractName("SUMMARY:\n...")).toBe(null);
  });

  it("keeps a real name, including an all-caps name (must NOT be rejected)", () => {
    expect(extractName("Lena Hartmann\nNetwork Engineer\n")).toBe("Lena Hartmann");
    expect(extractName("LENA HARTMANN\nNetwork Engineer\n")).toBe("LENA HARTMANN");
    expect(extractName("Priya Raghunathan\n")).toBe("Priya Raghunathan");
  });

  it("strips markdown from the header line", () => {
    expect(extractName("# John Doe\n")).toBe("John Doe");
    expect(extractName("**Ada Lovelace**\n")).toBe("Ada Lovelace");
  });

  it("existing guards still hold (email line, over-long line, empty)", () => {
    expect(extractName("john@example.com\n")).toBe(null);
    expect(extractName(`${"x".repeat(61)}\n`)).toBe(null);
    expect(extractName("")).toBe(null);
    expect(extractName("   \n\n")).toBe(null);
  });

  // The resume is optional, so the "resume text" for many people IS their email to Charlie, and its
  // first line is a greeting. A greeting must never be stored as the name ("Hi Charlie,").
  it("a salutation is never a name (the resume-optional path)", () => {
    for (const line of [
      "Hi Charlie,", "hi charlie", "Hello Charlie,", "Hey Charlie", "Hii Charlie,",
      "Dear Charlie,", "Greetings,", "Good morning Charlie,", "Thanks Charlie,", "Regards,",
    ]) {
      expect(extractName(`${line}\nI have around 13 years in QA automation.\n`)).toBe(null);
    }
  });

  it("a real name that merely starts with those letters is still kept", () => {
    // The guard is word-anchored, so it must not eat Hiroshi, Hillary, Heydar or Grethe.
    expect(extractName("Hiroshi Tanaka\n")).toBe("Hiroshi Tanaka");
    expect(extractName("Hillary Okonkwo\n")).toBe("Hillary Okonkwo");
    expect(extractName("Heydar Aliyev\n")).toBe("Heydar Aliyev");
    expect(extractName("Deary Smith\n")).toBe("Deary Smith");
  });
});
