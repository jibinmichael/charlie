// cohort-fence.test.mjs — the onboarding cohort fence (deterministic, no DB).
//
// Proves three things without touching Supabase:
//   1. isV2 reads the additive dossier.meta.onboarding marker correctly.
//   2. markOnboardingCohort stamps ONLY when ONBOARDING_V2=on, preserves existing meta,
//      mutates in place (the writers replace the whole dossier, so meta must be pre-set).
//   3. FENCE COVERAGE (static): every v1 lifecycle sweep references isV2, and both new-user
//      entry points call markOnboardingCohort — so the bidirectional fence can't be silently
//      dropped from a sweep in a later edit (same discipline as the send-guard grep rule).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isV2, markOnboardingCohort, onboardingV2Enabled } from "./charlie-store.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const withEnv = (val, fn) => {
  const prev = process.env.ONBOARDING_V2;
  if (val === undefined) delete process.env.ONBOARDING_V2;
  else process.env.ONBOARDING_V2 = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ONBOARDING_V2;
    else process.env.ONBOARDING_V2 = prev;
  }
};

describe("isV2 — the cohort predicate", () => {
  it("is true only when dossier.meta.onboarding === 'v2'", () => {
    expect(isV2({ dossier: { meta: { onboarding: "v2" } } })).toBe(true);
  });
  it("is false for a v1 (unmarked) candidate, and for near-misses", () => {
    expect(isV2({ dossier: { headline: "x" } })).toBe(false);
    expect(isV2({ dossier: { meta: {} } })).toBe(false);
    expect(isV2({ dossier: { meta: { onboarding: "v1" } } })).toBe(false);
    expect(isV2({ dossier: null })).toBe(false);
    expect(isV2(null)).toBe(false);
    expect(isV2({})).toBe(false);
  });
});

describe("markOnboardingCohort — the new-user stamp (gated OFF by default)", () => {
  it("is a no-op when ONBOARDING_V2 is unset (existing behavior: everyone stays v1)", () => {
    withEnv(undefined, () => {
      expect(onboardingV2Enabled()).toBe(false);
      const d = { headline: "x" };
      markOnboardingCohort(d);
      expect(d.meta).toBeUndefined();
      expect(isV2({ dossier: d })).toBe(false);
    });
  });
  it("stamps meta.onboarding='v2' in place when ONBOARDING_V2=on", () => {
    withEnv("on", () => {
      expect(onboardingV2Enabled()).toBe(true);
      const d = { headline: "x" };
      const ret = markOnboardingCohort(d);
      expect(ret).toBe(d); // same object, mutated in place
      expect(isV2({ dossier: d })).toBe(true);
    });
  });
  it("preserves any existing dossier.meta keys when stamping", () => {
    withEnv("on", () => {
      const d = { headline: "x", meta: { source: "linkedin" } };
      markOnboardingCohort(d);
      expect(d.meta).toEqual({ source: "linkedin", onboarding: "v2" });
    });
  });
  it("filtering a mixed list by isV2 selects only the v2 cohort (the v2Candidates predicate)", () => {
    const list = [
      { email: "a", dossier: { meta: { onboarding: "v2" } } },
      { email: "b", dossier: { headline: "v1 user" } },
      { email: "c", dossier: { meta: { onboarding: "v2" } } },
    ];
    expect(list.filter(isV2).map((c) => c.email)).toEqual(["a", "c"]);
  });
});

// The bidirectional fence: v1 sweeps must exclude v2 users; entry points must stamp them.
// A static source check keeps every sweep covered — deleting the fence line trips CI.
const V1_SWEEPS = [
  "completeness-nudge.mjs", "newsletter.mjs", "digest.mjs",
  "announce-referral.mjs", "announce-hiring.mjs", "announce-checkin.mjs",
  // confirm-sweep is transactional, but still a fenced v1 sweep.
  "confirm-sweep.mjs", "first-role.mjs",
];
// One entry point, because there is one door: a new user can only reach Charlie by writing to
// start@, which lands in email-onboard.mjs via /inbound.
const ENTRY_POINTS = ["email-onboard.mjs"];

describe("fence coverage (static) — every v1 sweep is fenced, every entry point stamps", () => {
  for (const f of V1_SWEEPS) {
    it(`${f} references isV2 (v2 cohort fenced out)`, () => {
      expect(/\bisV2\s*\(/.test(src(f)), `${f} does not fence the v2 cohort`).toBe(true);
    });
  }
  for (const f of ENTRY_POINTS) {
    it(`${f} calls markOnboardingCohort (new-user stamp)`, () => {
      expect(/markOnboardingCohort\s*\(/.test(src(f)), `${f} does not stamp the cohort`).toBe(true);
    });
  }
});
