// lib/role-level.test.mjs — the level gate.
//
// THE CENTRAL CASE. A person asks for "Chief Operating Officer, VP of Operations, Director of Operations".
// levelOf() calls them `exec`, because COO is the first thing the target names. A naive "one rung
// below your level is an insult" rule would therefore hold a well-matched Director role. The rule has
// to read the target as a RANGE whose FLOOR is the bar, or it blocks the exact role it exists to
// surface. That is the first assertion below and it is the whole design.
import { describe, it, expect } from "vitest";
import { roleLevelOf, seniorityFloor, seniorityVerdict, RUNG } from "./role-level.mjs";
import { levelOf } from "../market-report.mjs";

// Synthetic preference shapes.
const EXEC_TARGET = { professional_years: 20, headline: "Operations leader with 19+ years in hospital logistics", preferences: { seniority: "Executive / head of operations level", role: "Chief Operating Officer, VP of Operations, Director of Operations" } };
const DESIGNER = { professional_years: 12, headline: "Senior Product Designer", preferences: { seniority: "senior", role: "product designer" } };
const NO_TARGET = { professional_years: 11.5, headline: "Senior Category Manager with 9+ years in grocery retail", preferences: {} };

describe("seniorityFloor — the bar is the LOWEST level they named, not their top one", () => {
  it("reads a multi-level target as a range and takes its floor", () => {
    // "Chief Operating Officer, VP of Operations, Director of Operations" names exec AND director.
    expect(levelOf(EXEC_TARGET)).toBe("exec"); // what they are
    expect(seniorityFloor(EXEC_TARGET, levelOf)).toEqual({ rung: "director", basis: "stated" }); // what they will take
  });

  it("marks an unstated target as inferred, so the caller can demand a wider gap", () => {
    expect(seniorityFloor(DESIGNER, levelOf)).toEqual({ rung: "senior", basis: "stated" });
    expect(seniorityFloor(NO_TARGET, levelOf).basis).toBe("inferred");
  });
});

describe("roleLevelOf — unknown is the expected answer, not a failure", () => {
  it("reads an unambiguous level word", () => {
    expect(roleLevelOf({ title: "Product Management Director" })).toBe("director");
    expect(roleLevelOf({ title: "VP of Product" })).toBe("exec");
    expect(roleLevelOf({ title: "Principal Inbound Product Manager" })).toBe("principalStaff");
    expect(roleLevelOf({ title: "Senior Product Manager - Platform" })).toBe("senior");
    expect(roleLevelOf({ title: "Junior Designer" })).toBe("apm");
  });

  it("stays SILENT on a bare title — most of the live pool", () => {
    for (const t of ["Product Manager", "Product Designer", "Group Product Manager", "Software Engineer"])
      expect(roleLevelOf({ title: t }), t).toBe(null);
  });

  // The numbered-ladder rule. "Designer II" is Adobe's internal scale and means nothing across
  // employers, so the NUMBER is never decoded. The years the employer states are read instead.
  it("never decodes the number itself", () => {
    expect(roleLevelOf({ title: "Product Designer II", description: "Design things." })).toBe(null);
    expect(roleLevelOf({ title: "Software Engineer III" })).toBe(null);
  });

  it("reads the JD's stated years floor for a numbered title", () => {
    expect(roleLevelOf({ title: "Analytics Engineer II", description: "You have 3 years of experience." })).toBe("ic");
    expect(roleLevelOf({ title: "Product Security Engineer II", description: "minimum 2 years experience" })).toBe("ic");
    expect(roleLevelOf({ title: "Software Engineer II", description: "5+ years of experience required" })).toBe("senior");
  });

  it("years never buy a rung above senior — a high floor is experience, not authority", () => {
    expect(roleLevelOf({ title: "Engineer II", description: "12+ years of experience" })).toBe("senior");
  });

  it("a level WORD always beats the numbered-ladder path", () => {
    // "Sr. Product Manager II" is senior with an internal sub-rung, not a mid role.
    expect(roleLevelOf({ title: "Sr. Product Manager II, Audit & History", description: "3 years of experience" })).toBe("senior");
  });
});

describe("seniorityVerdict — what actually gets held", () => {
  const at = (title, description = "") => ({ title, description, company: "Acme" });

  it("SENDS a Director role to someone whose stated range includes Director", () => {
    const v = seniorityVerdict(at("Product Management Director"), EXEC_TARGET, levelOf);
    expect(v.below, "director is inside his stated range, not below it").toBe(false);
  });

  it("HOLDS the roles he was actually emailed, all of them beneath what he asked for", () => {
    for (const t of ["Senior Product Manager - Platform", "Principal Product Manager (India)", "Sr. Product Manager II, Audit & History"]) {
      const v = seniorityVerdict(at(t), EXEC_TARGET, levelOf);
      expect(v.below, `${t} should be held`).toBe(true);
      expect(v.reason).toMatch(/you asked for director or above/);
    }
  });

  it("holds a mid-level numbered role for a senior person, once the JD states its years", () => {
    expect(seniorityVerdict(at("Product Designer II", "We are looking for 3 years of experience."), DESIGNER, levelOf).below).toBe(true);
    // ...and stays silent on the same title when the employer states nothing.
    expect(seniorityVerdict(at("Product Designer II", "Design things."), DESIGNER, levelOf).below).toBe(false);
  });

  it("never holds a stretch upward", () => {
    for (const t of ["VP of Product", "Product Management Director", "Principal Product Manager"])
      expect(seniorityVerdict(at(t), DESIGNER, levelOf).below, t).toBe(false);
  });

  it("demands a WIDER gap when the target was inferred rather than stated", () => {
    // NO_TARGET reads `senior` by inference. One rung down is not enough to act on a guess.
    expect(seniorityVerdict(at("Product Designer II", "3 years of experience"), NO_TARGET, levelOf).below).toBe(false);
    expect(seniorityVerdict(at("Junior Product Manager"), NO_TARGET, levelOf).below).toBe(true);
  });

  it("is silent whenever the role level cannot be read", () => {
    const v = seniorityVerdict(at("Product Manager"), EXEC_TARGET, levelOf);
    expect(v.below).toBe(false);
    expect(v.roleRung).toBe(null);
  });

  it("never throws on junk input", () => {
    for (const j of [null, undefined, {}, { title: "" }, { title: 42 }])
      expect(() => seniorityVerdict(j, EXEC_TARGET, levelOf)).not.toThrow();
    for (const d of [null, undefined, {}, { preferences: null }])
      expect(() => seniorityVerdict({ title: "Senior Engineer" }, d, levelOf)).not.toThrow();
  });

  it("the ladder is ordered low to high", () => {
    expect(RUNG.apm).toBeLessThan(RUNG.ic);
    expect(RUNG.senior).toBeLessThan(RUNG.principalStaff);
    expect(RUNG.director).toBeLessThan(RUNG.exec);
  });
});
