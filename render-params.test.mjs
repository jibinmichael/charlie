// render-params.test.mjs — every sender must hand renderEmail the params the spec's slots need.
//
// WHY THIS EXISTS: `renderEmail` defaults EVERY optional param to null, so a caller that forgets one
// renders NOTHING for that slot — silently, with no error and no test failure. Several senders each
// hand-assemble their own param bag, and a drifted one sends a role email with no badge (slot 1) or
// no posted-time line (slot 2) while the template itself is perfectly correct.
//
// The snapshot lock (emails/templates.test.mjs) cannot catch this: it calls renderEmail with a COMPLETE
// fixture, so it proves "given a full basket, the email is right" — and never looks at what the callers
// actually put in the basket. This file checks the basket.
//
// These are source assertions (the senders are scripts that connect on import, so their call sites
// cannot be executed here) — the same technique as evals/rubric-lint.test.mjs and digest-selection's
// call-site block.
//
// DEAD PARAMS — deliberately NOT required of anyone (proven by rendering value-vs-null):
//   weave    — `weaveBlock` is computed in render-email.mjs but never inserted (the Market-signal
//              slot was removed). scheduler.mjs still computes it via skillUnlock(), which is wasted
//              work, not a bug.
//   attached — not a parameter of renderEmail at all. The slot-6 footnote derives from `referral`.
// If either is ever revived, revive it in the renderer FIRST, then add it here.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p) => readFileSync(new URL(`./${p}`, import.meta.url), "utf8");
// The renderEmail call, flattened. Senders wrap the call across lines, so collapse before matching.
const callOf = (src) => {
  const i = src.indexOf("renderEmail({");
  if (i < 0) return "";
  return src.slice(i, i + 1400).replace(/\s+/g, " ");
};
// A param counts as passed whether written `label: x` or as ES shorthand `label,` / `label }`.
// (scheduler.mjs uses shorthand for weave/label/match/cov; first-role uses `key: value`.)
const passes = (call, param) => new RegExp(`\\b${param}\\s*(:|,|\\})`).test(call);

// Params that change the rendered HTML for EVERY user, regardless of region. A sender that omits one
// silently drops a spec slot. (Verified by rendering each value-vs-null against emails/fixtures.)
const UNIVERSAL = {
  label: "slot 1 — the badge (Today's pick / Closest to your profile)",
  postedAt: "slot 2 — the posted-time line",
  jobDescription: "gates the fit readout: without it jdWasTruncated() cannot see a truncated posting",
};

// US-only slots (never rendered when homeRegion(dossier) !== 'us').
const US_ONLY = { pay: "slot 2 pay chip", momentum: "slot 8 momentum chip", referral: "slot 7 referral" };

// The senders that put a role email in a REAL person's inbox.
const USER_FACING = ["scheduler.mjs", "first-role.mjs"];

describe("user-facing senders pass every universal param", () => {
  for (const file of USER_FACING) {
    const call = callOf(read(file));
    it(`${file} calls renderEmail`, () => expect(call).not.toBe(""));
    for (const [param, why] of Object.entries(UNIVERSAL)) {
      it(`${file} passes ${param} (${why})`, () => {
        expect(passes(call, param), `${file} omits "${param}" — renderEmail defaults it to null and the slot silently vanishes`).toBe(true);
      });
    }
  }
});

describe("the daily scheduler is the reference implementation", () => {
  const call = callOf(read("scheduler.mjs"));
  for (const [param, why] of Object.entries(US_ONLY)) {
    it(`scheduler passes ${param} (${why})`, () => expect(passes(call, param)).toBe(true));
  }
});

describe("referral slots stay region-gated at the caller", () => {
  // The renderer gates the referral BLOCK on referralStatus(region, ...), but the slot-6 attach
  // footnote (render-email.mjs) derives from `referral` with NO region check. It is unreachable
  // off-region only because both senders refuse to resolve a referral unless referralRegionAllowed(region)
  // (the reversible, fail-closed REFERRAL_REGIONS switch — default us-only). Keep it that way.
  for (const file of USER_FACING) {
    it(`${file} only resolves a referral when referralRegionAllowed(region)`, () => {
      const src = read(file);
      const i = src.indexOf("resolveInlineReferral({"); // the CALL, not the import at the top
      expect(i, `${file} should resolve a referral`).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, i - 240), i)).toMatch(/referralRegionAllowed\(region\)/);
    });
  }
});

describe("nobody passes a dead param", () => {
  // Passing these is harmless but lies to the reader: it implies the slot renders when it cannot.
  for (const file of [...USER_FACING, "scripts/send-india-first.mjs"]) {
    it(`${file} does not pass "attached" (not a renderEmail param; the footnote derives from referral)`, () => {
      expect(callOf(read(file))).not.toMatch(/\battached\s*:/);
    });
  }
});

describe("the debug senders that reach a real inbox keep slot parity", () => {
  // send-india-first is a guard-exempt operator tool but it DOES mail a real person, so a
  // drifted call there produces a misleading "this is what users get" test send.
  for (const file of ["scripts/send-india-first.mjs"]) {
    const call = callOf(read(file));
    for (const param of ["label", "postedAt", "jobDescription", "region"]) {
      it(`${file} passes ${param}`, () => expect(passes(call, param)).toBe(true));
    }
  }
});
