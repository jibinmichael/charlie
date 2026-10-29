// eligibility-pregate.test.mjs — the scoring pre-pass counts how many paid pairs a free deterministic
// gate would reject. It must never filter.
//
// The two properties that make it safe to ship into the send path:
//   1. there is NO enforce mode, so it cannot start filtering via a config edit
//   2. every predicate is IMPORTED from the module that owns it, so the pre-pass and the real gate
//      cannot drift into disagreeing about the same role

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { pregateVerdict, pregateCensus, pregateMode } from "./eligibility-pregate.mjs";

// Someone who ruled out an office but named the city they live in. The CITY rule passes (the role IS
// in their city) and only the ARRANGEMENT rule catches it, which is why the fixture needs a
// home_place to exercise rule 1b.
const remoteOnly = { preferences: { remote: "Fully remote, based in Bengaluru, India", home_place: "Bengaluru, India" } };
const remoteRole = { title: "Backend Engineer", location: "Remote", remote: true, description: "Go" };
const officeRole = { title: "Backend Engineer", location: "Bengaluru, India", remote: false, description: "Go" };

let saved;
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { process.env = saved; });

describe("it agrees with the gate that owns each rule", () => {
  it("reports the SAME rule string the live gate would", () => {
    // presend-guard wraps auditRole findings as `constraint:${miss.rule}` — the pre-pass must match,
    // or the shadow numbers cannot be joined to the real decision records.
    const v = pregateVerdict(officeRole, remoteOnly);
    expect(v?.rule).toBe("constraint:arrangement:onsite-vs-remote-only");
  });

  it("passes a role no free gate objects to", () => {
    expect(pregateVerdict(remoteRole, remoteOnly)).toBeNull();
  });

  it("catches a stated dealbreaker in the posting", () => {
    const p = { preferences: { remote: "Remote", dealbreakers: ["gambling"] } };
    const v = pregateVerdict({ title: "PM, Gambling", location: "Remote", remote: true, description: "own the gambling funnel" }, p);
    expect(v?.rule).toBe("constraint:dealbreaker:hit");
  });

  it("respects PAY_FLOOR_MODE=shadow — a gate that is not enforcing must not be counted as eliminating", () => {
    // Counting a shadow gate would overstate the saving, which is the failure mode this module
    // exists to avoid: a number that justifies a change it did not earn.
    process.env.PAY_FLOOR_MODE = "shadow";
    const under = { title: "Intern", location: "Remote", remote: true, description: "x", compensation: "INR 18,000 - 20,000" };
    const p = { preferences: { remote: "Remote", comp_floor: "15 lakh" } };
    expect(pregateVerdict(under, p)?.rule).not.toBe("pay-floor:below");
  });
});

describe("census — counts, never mutates", () => {
  const jobs = [remoteRole, officeRole, officeRole];

  it("counts eliminable pairs and groups them by rule", () => {
    const c = pregateCensus(jobs, remoteOnly);
    expect(c.scored).toBe(3);
    expect(c.eliminable).toBe(2);
    expect(c.byRule["constraint:arrangement:onsite-vs-remote-only"]).toBe(2);
  });

  it("returns the input untouched — it is a census, not a filter", () => {
    const before = JSON.stringify(jobs);
    pregateCensus(jobs, remoteOnly);
    expect(JSON.stringify(jobs)).toBe(before);
    expect(jobs).toHaveLength(3);
  });

  it("never throws on junk", () => {
    expect(pregateCensus(null, null)).toEqual({ scored: 0, eliminable: 0, byRule: {} });
    expect(pregateCensus([null, undefined], {})).toMatchObject({ scored: 2 });
    expect(pregateVerdict(null, null)).toBeNull();
  });
});

describe("it CANNOT be made to filter", () => {
  it("has no enforce mode — PREGATE_MODE=enforce still resolves to shadow", () => {
    process.env.PREGATE_MODE = "enforce";
    expect(pregateMode()).toBe("shadow");
    process.env.PREGATE_MODE = "on";
    expect(pregateMode()).toBe("shadow");
  });

  it("can only be turned off, never up", () => {
    process.env.PREGATE_MODE = "off";
    expect(pregateMode()).toBe("off");
  });

  it("match-batch uses the census for LOGGING only — the shortlist it returns is unfiltered", () => {
    const src = readFileSync(new URL("../match-batch.mjs", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    // `sel` is what gets scored. It must never be reassigned or filtered by the pregate.
    expect(code).not.toMatch(/sel\s*=\s*sel\.filter/);
    expect(code).not.toMatch(/pregate\w*\s*\?\s*sel\.filter/);
    expect(code).toMatch(/pregateCensus\(sel, dossier\)/);
    // and the census result is only ever read into counters and a log line
    expect(code).not.toMatch(/return[^;]*pregateCensus/);
  });

  it("reimplements nothing — every predicate is imported from its owner", () => {
    const src = readFileSync(new URL("./eligibility-pregate.mjs", import.meta.url), "utf8");
    for (const owner of ["../send-audit.mjs", "./role-level.mjs", "../quality-gate.mjs", "./pay.mjs"]) {
      expect(src).toContain(`from "${owner}"`);
    }
    // no local copy of a gate's logic
    expect(src).not.toMatch(/function\s+(auditRole|languageBlocker|belowStatedFloor|seniorityVerdict)\b/);
  });
});
