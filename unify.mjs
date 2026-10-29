// unify.mjs — ONE grounded composite driving both the send gate and the email readout.
//
// Two scores exist: the matcher score (holistic Haiku judgment, bar >= MATCH_BAR) and the coverage
// composite (deterministic, grounded JD-requirement coverage, floor >= FIT_FLOOR). They can
// disagree — e.g. 72 vs 26 (matcher likes it, grounded coverage is low) — and two numbers the user
// can never reconcile are worse than one. unifyScore blends
// them into ONE number; unifiedRoute turns that one number into send / digest / drop. Grounded
// coverage is weighted a touch heavier (it is grounded evidence), but a role needs BOTH decent to
// clear. Pure + deterministic, so a before/after diff is reproducible.

export const UNIFY_W_COVERAGE = 0.55; // grounded evidence carries slightly more weight
export const UNIFY_W_MATCHER = 0.45;

/**
 * Blend the matcher score and the grounded coverage composite into one 0..100 score.
 * @param {number} matcherScore
 * @param {number|null} coverageComposite  null/NaN when coverage is thin/unscoreable.
 * @returns {number|null}  the unified score, or null if neither input is usable.
 */
export function unifyScore(matcherScore, coverageComposite) {
  // Guard the Number(null)===0 trap: a null/undefined input is ABSENT, not a zero score.
  const m = matcherScore == null ? NaN : Number(matcherScore);
  const c = coverageComposite == null ? NaN : Number(coverageComposite);
  const hasM = Number.isFinite(m);
  const hasC = Number.isFinite(c);
  if (!hasC) return hasM ? Math.round(m) : null; // thin coverage → lean on the matcher alone
  if (!hasM) return Math.round(c);
  return Math.round(UNIFY_W_COVERAGE * c + UNIFY_W_MATCHER * m);
}

// Routing from the one composite. A GROUNDED-FLOOR guard runs first: a scoreable coverage below the
// fit floor NEVER solo-sends, however much the matcher likes it — that guarantee (the moat) is what
// resolves the 72-vs-26 contradiction to digest by construction. Above the floor, the unified score
// bands into send/digest/drop.
export const GROUNDED_FLOOR = Number(process.env.FIT_FLOOR || 50);
export const MATCH_BAR = Number(process.env.MATCH_BAR || 70);
export const UNIFIED_SEND = Number(process.env.UNIFIED_SEND_BAR || 58);
export const UNIFIED_DIGEST = Number(process.env.UNIFIED_DIGEST_BAR || 45);

/**
 * @param {number|null} unified   the blended composite.
 * @param {number|null} [coverage] the grounded coverage composite (null/thin → guard skipped).
 * @param {number|null} [matcherScore] the raw matcher score — the bar is preserved as a hard floor.
 * @returns {"send"|"digest"|"drop"}
 */
export function unifiedRoute(unified, coverage, matcherScore) {
  // Matcher-bar floor (fail-closed): a role below the match bar is a DROP — the unified score never
  // lowers the bar. Without this, a thin-coverage role (unifyScore = matcher alone) would send at
  // UNIFIED_SEND (58) < MATCH_BAR (70). Reconciliation happens ONLY above the bar.
  const m = matcherScore == null ? NaN : Number(matcherScore);
  if (Number.isFinite(m) && m < MATCH_BAR) return "drop";
  const c = coverage == null ? NaN : Number(coverage);
  if (Number.isFinite(c) && c < GROUNDED_FLOOR) return "digest"; // grounded guard — the moat
  const u = unified == null ? NaN : Number(unified); // guard the Number(null)===0 trap
  if (!Number.isFinite(u)) return "send"; // nothing to judge on → don't block (thin-coverage behavior)
  if (u >= UNIFIED_SEND) return "send";
  if (u >= UNIFIED_DIGEST) return "digest";
  return "drop";
}

// UNIFIED_SCORE_MODE: "shadow" (default — old two-gate live, log the unified route divergence),
// "on" (route on the one number + stamp it as the readout composite), "off" (legacy, no shadow log).
export function unifiedMode() {
  const m = String(process.env.UNIFIED_SCORE_MODE || "shadow").toLowerCase();
  return m === "on" || m === "off" ? m : "shadow";
}
