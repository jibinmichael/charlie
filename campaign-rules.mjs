// campaign-rules.mjs — the SELF-CONTAINED rules + guardrails for the join@ hiring campaign. One place
// holds both bars, and the loop enforces them:
//   1. THE QUALITY BAR NEVER LOWERS when dealing with an applicant.
//   2. AN APPLICANT IS NEVER OVERWHELMED.
// Imported by campaign-loop.mjs.
//
// They are constants rather than prose because a bar you can point to but not measure drifts. These
// knobs are read by the loop and fenced by campaign-loop.test.mjs.

export const CAMPAIGN_RULES = Object.freeze({
  // ── the bar never lowers (quality) ──────────────────────────────────────────
  // (These are enforced structurally elsewhere; listed here so the whole bar reads in one place.)
  verdictIsHuman: true,   // the model NEVER advances or rejects — only a human's typed verdict moves anyone
  neverFlatter: true,     // Charlie never praises, scores, or signals approval mid-conversation (prompt + convo-lint)
  strictOrderGate: true,  // must onboard at start@ AND get a real match before the challenge (deterministic)
  neverAutoAdvance: true, // every stage transition toward "advanced" requires the human

  // ── an applicant is never overwhelmed (humane) ──────────────────────────────
  maxOpeners: 3,          // at most this many hard questions from the bank — a real test, never a barrage
  maxProbesPerOpener: 2,  // dig, but don't grill; after this many follow-ups on one question, move on
  maxTurns: 6,            // absolute ceiling on Charlie messages in the loop (env may LOWER, never raise)
  candidateLedPace: true, // reply-driven: they answer when ready; Charlie never blasts or chases
  easyPause: true,        // stepping out is always allowed and never held against them ("just say so")
});

// the effective hard cap = the smaller of the operator knob and the humane ceiling (env can only lower).
export function turnCap(envMaxTurns) {
  const env = Number(envMaxTurns);
  return Math.min(Number.isFinite(env) && env > 0 ? env : CAMPAIGN_RULES.maxTurns, CAMPAIGN_RULES.maxTurns);
}
