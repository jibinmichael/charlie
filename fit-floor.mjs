// fit-floor.mjs — the evidence-based fit floor (deterministic, governed).
//
// The fit floor is the composite score that gates a solo send (quality-gate.mjs: composite >=
// FIT_FLOOR -> send, else digest). v1 weighted EVERY must-have equally, so a missing "Bachelor's
// degree" tanked the score exactly like missing core experience. That's the SHRM-2022 anti-pattern:
// skills + experience predict fit; a degree/cert requirement is often inflation, not signal.
//
// v2 keeps the same 40/25/20/10/5 shape but makes the must-have term COUNT ONLY CORE-EXPERIENCE
// requirements. Credential/education requirements (degree, certification, license) are SURVIVABLE:
// excluded from the coverage denominator, so a strong-core candidate missing a credential still
// clears the floor. Nothing is invented — we only re-weight the grounded requirement array.
//
// Pure + deterministic (no model call), so both formulas are unit-testable and the v1/v2
// distribution diff is a reproducible, no-PII, no-model comparison.

// A requirement label is a CREDENTIAL when it names a degree, certification, or license (the things
// SHRM 2022 says shouldn't gate). Everything else — named tools, skills, "5+ years", domain — is CORE
// (evidence of what the person can do). Years-of-experience is CORE, not a credential.
const CREDENTIAL_RE =
  /\b(bachelor'?s?|master'?s?|mba|ph\.?\s?d|doctorate|doctoral|degree|diploma|under\s?grad(uate)?|graduate\s+degree|b\.?tech|m\.?tech|b\.?e\.?\b|b\.?sc|m\.?sc|b\.?a\.?\b|m\.?a\.?\b|certif(ied|ication)?|licen[sc]ed?|accredit(ed|ation)?|cpa|pmp|cfa|shrm|comptia|aws\s+certified)\b/i;

/** @returns {"credential"|"core"} the kind of a requirement, from its short label. */
export function reqKind(reqLabel) {
  return CREDENTIAL_RE.test(String(reqLabel || "")) ? "credential" : "core";
}

// Coverage over a requirement array: met=1, partial=0.5, unknown=0 (unproven, not credited).
function coverage(reqs) {
  if (!reqs.length) return null;
  const met = reqs.filter((r) => r.status === "met").length;
  const partial = reqs.filter((r) => r.status === "partial").length;
  return (met + 0.5 * partial) / reqs.length;
}

/** v1 must-have term — EVERY requirement counts equally. null when no reqs (caller falls back to skills). */
export function mustHaveV1(reqs) {
  return coverage(Array.isArray(reqs) ? reqs : []);
}

/** v2 must-have term — only CORE-experience requirements count (credentials survivable). null when no
 *  core reqs (all-credential JD, or none) so the caller falls back to skills, same as v1's empty case. */
export function coreMustHave(reqs) {
  return coverage((Array.isArray(reqs) ? reqs : []).filter((r) => r && reqKind(r.req) === "core"));
}

/** The deterministic composite — same 40/25/20/10/5 shape for both versions. mustHave null -> skills. */
export function composite({ mustHave, skills, seniority, domain, parseable }) {
  const mh = mustHave == null ? skills : mustHave;
  return Math.round(100 * (0.4 * mh + 0.25 * skills + 0.2 * seniority + 0.1 * domain + 0.05 * parseable));
}

// FIT_FLOOR_MODE: "shadow" (default — return v1, but log what v2 would decide), "v2" (enforce the
// evidence-based floor), or "v1" (legacy, no shadow log). Unknown => shadow.
export function fitFloorMode() {
  const m = String(process.env.FIT_FLOOR_MODE || "shadow").toLowerCase();
  return m === "v2" || m === "v1" ? m : "shadow";
}
