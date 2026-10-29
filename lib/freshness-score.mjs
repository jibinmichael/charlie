// lib/freshness-score.mjs — how fresh is a posting, 0..1. ONE definition, shared.
//
// Split out of freshness.mjs so both services can use the SCORE without either inheriting
// FRESHNESS_MODE. That flag gates the daily send's reorder and belongs to charlie-engine alone;
// importing freshness.mjs into the server-side market briefing would drag it onto both services
// (lib/env-parity.test.mjs). A var that only one service acts on must not look like shared config, or
// the parity report cries wolf and stops being read.
//
// freshness.mjs re-exports this, so there is exactly one answer to "how fresh is this" in the product.

const DAY = 86400e3;
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

/**
 * 0..1 freshness from posted_at. Fully fresh (1.0) within FRESH_FULL_DAYS, then a linear decay to 0
 * at FRESH_HORIZON_DAYS. An unknown/unparseable date gets a low-but-nonzero score (mirroring the
 * pre-filter's "unknown dates sort last"), so a known-fresh role wins but an undated real role is
 * never buried forever.
 * @param {{posted_at?: string}} job
 * @param {number} [now]
 * @returns {number}
 */
export function freshnessScore(job, now = Date.now()) {
  const full = num("FRESH_FULL_DAYS", 2);
  const horizon = Math.max(full + 1, num("FRESH_HORIZON_DAYS", 45));
  const t = Date.parse(job?.posted_at || "");
  if (!Number.isFinite(t)) return Math.max(0, Math.min(1, num("FRESH_UNKNOWN", 0.2)));
  const age = (now - t) / DAY;
  if (age <= full) return 1;
  return Math.max(0, 1 - (age - full) / (horizon - full));
}
