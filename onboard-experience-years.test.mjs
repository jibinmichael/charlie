// onboard-experience-years.test.mjs — a NEW user must arrive with professional_years.
//
// `professional_years` is the knockout floor's only input about the PERSON (eligibility-gate.mjs).
// The dossier build is asked for the field but rarely emits it, so without a dedicated extraction the
// floor would remove nothing for most people while reporting as enforcing. The dedicated extractor
// (experience-years.mjs) is therefore called from onboardFromEmail, and these tests pin that wiring.
//
// The two properties that matter, and the reason this is a structural test rather than a live one:
//   1. it is AWAITED before saveDossier, so the number is on the dossier the first role email gates
//      against (fire-and-forget would lose that race);
//   2. it FAILS OPEN, so a model blip leaves the field absent — today's behaviour — and can never
//      block an onboarding.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { experienceYearsPatch } from "./experience-years.mjs";

const SRC = readFileSync(new URL("./email-onboard.mjs", import.meta.url), "utf8");
// The body of onboardFromEmail, so a call somewhere else in the file cannot satisfy these.
const ONBOARD = SRC.slice(SRC.indexOf("export async function onboardFromEmail"), SRC.indexOf("// Extract grounded BACKGROUND changes"));

describe("experience-years is wired into the onboarding path", () => {
  it("is imported from the shared module, not reimplemented locally", () => {
    expect(SRC).toMatch(/import\s+\{[^}]*extractExperienceYears[^}]*\}\s+from\s+"\.\/experience-years\.mjs"/);
    expect(SRC).toMatch(/import\s+\{[^}]*experienceYearsPatch[^}]*\}\s+from\s+"\.\/experience-years\.mjs"/);
  });

  it("onboardFromEmail actually calls it", () => {
    expect(ONBOARD).toMatch(/extractExperienceYears\s*\(/);
    expect(ONBOARD).toMatch(/experienceYearsPatch\s*\(/);
  });

  it("AWAITS it — a background write would lose the race with the first role email", () => {
    expect(ONBOARD).toMatch(/await\s+extractExperienceYears\s*\(/);
    // the fire-and-forget shape used by enrichCompanyContext must NOT be used here
    expect(ONBOARD).not.toMatch(/extractExperienceYears\([^)]*\)\s*\.catch\(\s*\(\)\s*=>\s*\{?\s*\}?\s*\)\s*;/);
  });

  it("runs BEFORE saveDossier, so the number is on the row the floor reads", () => {
    const call = ONBOARD.indexOf("extractExperienceYears");
    // `await saveDossier(`, not the bare word: a comment above already mentions saveDossier ("Refuse
    // BEFORE saveDossier"), and matching that made this assert against prose instead of the call.
    const save = ONBOARD.indexOf("await saveDossier(");
    expect(call).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(-1);
    expect(call).toBeLessThan(save);
  });

  it("is wrapped so a failure cannot break onboarding (fails open)", () => {
    const call = ONBOARD.indexOf("extractExperienceYears");
    const before = ONBOARD.slice(0, call);
    expect(before.lastIndexOf("try {")).toBeGreaterThan(before.lastIndexOf("await saveDossier"));
  });

  it("reads the resume it was given, not a re-fetch", () => {
    expect(ONBOARD).toMatch(/extractExperienceYears\(\s*resumeText\s*\)/);
  });
});

describe("experienceYearsPatch — the shape that gets merged onto the dossier", () => {
  it("returns null for a null extraction, so nothing is merged", () => {
    expect(experienceYearsPatch(null)).toBeNull();
    expect(experienceYearsPatch(undefined)).toBeNull();
  });

  it("carries the number AND its grounded basis, so the claim is auditable", () => {
    const patch = experienceYearsPatch({ professional_years: 13, career_start: "2012-06", evidence: ["Fernbrook Studio 2010 - 2012"], confidence: "high" });
    expect(patch.professional_years).toBe(13);
    expect(patch.experience_basis.confidence).toBe("high");
    expect(patch.experience_basis.evidence).toEqual(["Fernbrook Studio 2010 - 2012"]);
    expect(patch.experience_basis.source).toBe("resume");
  });

  it("merging the patch leaves every other dossier field untouched", () => {
    const dossier = { name: "Priya", headline: "h", proof_points: [1, 2], preferences: { role: "PM" } };
    const patch = experienceYearsPatch({ professional_years: 4, career_start: "2021-01", evidence: ["x"], confidence: "high" });
    const merged = { ...dossier, ...patch };
    expect(merged.name).toBe("Priya");
    expect(merged.headline).toBe("h");
    expect(merged.proof_points).toEqual([1, 2]);
    expect(merged.preferences).toEqual({ role: "PM" });
    expect(merged.professional_years).toBe(4);
  });
});
