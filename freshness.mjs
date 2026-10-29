// freshness.mjs — freshness as a SEND-SELECTION signal, not just a badge.
//
// Roles people click are markedly fresher than the ones they ignore, and applying early is itself
// winnability. Without this, the scheduler picks the highest-SCORE above-bar role regardless of age, so
// a 40-day-old role can beat a 1-day-old one of near-equal fit. Every candidate weighed here has ALREADY
// cleared the bar (and sent scores sit in a compressed band, so fit barely discriminates within it), so
// reordering WITHIN that set by a freshness blend surfaces the freshest GOOD match without lowering fit.
//
// Deterministic, no model. Shadow-first (FRESHNESS_MODE): logs the would-be reorder and changes NOTHING
// until flipped to enforce (mirrors the grounding / knockout / Tier-2 shadow pattern).

import { freshnessScore } from "./lib/freshness-score.mjs";

const DAY = 86400e3;
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

export const freshnessMode = () => String(process.env.FRESHNESS_MODE || "shadow").toLowerCase();

// 0..1 freshness for a role from its posted_at. Fully fresh (1.0) within FRESH_FULL_DAYS, then a linear
// decay to 0 at FRESH_HORIZON_DAYS. An unknown/unparseable date gets a low-but-nonzero score (mirrors the
// pre-filter's "unknown dates sort last"), so a known-fresh role wins but an undated real role is never
// buried forever.
export { freshnessScore } from "./lib/freshness-score.mjs";


// Blend the matcher score (0..100 -> 0..1) with freshness. Weight FRESHNESS_WEIGHT (default 0.2): the
// score still leads, freshness competes. Calibrated so it DECIDES within the compressed common band (most
// sent scores cluster ~72-78, so those are effectively fit-ties broken by freshness) but a genuinely
// better fit (a large score gap, e.g. 92 vs 72) still wins — freshness nudges, it never sends a worse match.
export function blendedScore(job, now = Date.now()) {
  const w = Math.min(1, Math.max(0, num("FRESHNESS_WEIGHT", 0.2)));
  const s = Math.max(0, Math.min(1, (Number(job?.match?.score) || 0) / 100));
  return (1 - w) * s + w * freshnessScore(job, now);
}

// Stable reorder of candidates by the freshness-blended score, descending. Pure (returns a new array).
// The index tiebreak keeps the original (score) order for equal blends, so it never shuffles equals.
export function freshnessReorder(candidates, now = Date.now()) {
  return (candidates || [])
    .map((job, i) => ({ job, i, b: blendedScore(job, now) }))
    .sort((a, b) => b.b - a.b || a.i - b.i)
    .map((x) => x.job);
}
