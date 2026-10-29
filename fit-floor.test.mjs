// fit-floor.test.mjs — the fit reweight must classify credentials correctly and make them
// survivable, WITHOUT changing how a core-experience miss scores. Both are the same formula shape.
import { describe, it, expect } from "vitest";
import { reqKind, mustHaveV1, coreMustHave, composite, fitFloorMode } from "./fit-floor.mjs";

describe("reqKind", () => {
  it("flags degrees / certs / licenses as credentials", () => {
    for (const r of ["Bachelor's degree", "MBA", "PhD", "SHRM certification", "PMP", "CPA", "AWS Certified", "RN license", "B.Tech"]) {
      expect(reqKind(r)).toBe("credential");
    }
  });
  it("treats skills, tools, years, and domain as CORE (years is evidence, not a credential)", () => {
    for (const r of ["Design systems", "Kubernetes", "5+ years", "10 years experience", "Fintech domain", "React"]) {
      expect(reqKind(r)).toBe("core");
    }
  });
});

describe("coverage math", () => {
  const reqs = [
    { req: "Design systems", status: "met" },
    { req: "Kubernetes", status: "partial" },
    { req: "Bachelor's degree", status: "unknown" }, // credential, MISSING
  ];
  it("mustHaveV1 counts every req (the missing degree drags it down)", () => {
    // (1 met + 0.5 partial + 0 unknown) / 3 = 0.5
    expect(mustHaveV1(reqs)).toBeCloseTo(0.5, 5);
  });
  it("coreMustHave drops the credential from the denominator (missing degree survivable)", () => {
    // core = [Design systems met, Kubernetes partial] -> (1 + 0.5) / 2 = 0.75
    expect(coreMustHave(reqs)).toBeCloseTo(0.75, 5);
  });
  it("returns null (→ caller falls back to skills) when there are no reqs / no core reqs", () => {
    expect(mustHaveV1([])).toBeNull();
    expect(coreMustHave([{ req: "MBA", status: "met" }])).toBeNull(); // all-credential JD
  });
  it("a missing CORE requirement still hurts both versions equally", () => {
    const coreMiss = [{ req: "Kubernetes", status: "unknown" }, { req: "React", status: "met" }];
    expect(mustHaveV1(coreMiss)).toBeCloseTo(0.5, 5);
    expect(coreMustHave(coreMiss)).toBeCloseTo(0.5, 5); // no credentials to exclude → identical
  });
});

describe("composite", () => {
  it("applies the 40/25/20/10/5 weights and rounds to 0..100", () => {
    expect(composite({ mustHave: 0.75, skills: 0.8, seniority: 0.6, domain: 0.5, parseable: 1 }))
      .toBe(Math.round(100 * (0.4 * 0.75 + 0.25 * 0.8 + 0.2 * 0.6 + 0.1 * 0.5 + 0.05 * 1)));
  });
  it("strong core + missing degree clears the FIT_FLOOR(50) under v2 but can miss under v1", () => {
    const reqs = [
      { req: "Design systems", status: "met" }, { req: "Accessibility", status: "met" },
      { req: "React", status: "partial" }, { req: "Master's degree", status: "unknown" }, { req: "PMP", status: "unknown" },
    ];
    const sub = { skills: 0.6, seniority: 0.6, domain: 0.5, parseable: 1 };
    const v1 = composite({ mustHave: mustHaveV1(reqs), ...sub });
    const v2 = composite({ mustHave: coreMustHave(reqs), ...sub });
    expect(v2).toBeGreaterThan(v1); // the two missing credentials no longer drag the score
  });
  it("mustHave null falls back to skills", () => {
    expect(composite({ mustHave: null, skills: 0.9, seniority: 0, domain: 0, parseable: 0 })).toBe(Math.round(100 * (0.4 * 0.9 + 0.25 * 0.9)));
  });
});

describe("fitFloorMode", () => {
  it("defaults to shadow; maps v1/v2; unknown → shadow", () => {
    const orig = process.env.FIT_FLOOR_MODE;
    delete process.env.FIT_FLOOR_MODE; expect(fitFloorMode()).toBe("shadow");
    process.env.FIT_FLOOR_MODE = "v2"; expect(fitFloorMode()).toBe("v2");
    process.env.FIT_FLOOR_MODE = "v1"; expect(fitFloorMode()).toBe("v1");
    process.env.FIT_FLOOR_MODE = "nope"; expect(fitFloorMode()).toBe("shadow");
    if (orig == null) delete process.env.FIT_FLOOR_MODE; else process.env.FIT_FLOOR_MODE = orig;
  });
});
