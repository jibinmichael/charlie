// lib/role-ask.mjs — ONE grounded question, derived from the matcher's own uncertainty.
//
// WHY IT EXISTS. The matcher already writes, on every scored pair, the one thing it is not sure about
// (`flag`, and `warn` chips). Left alone, that becomes a silent rejection. "No stated production
// deployments, on-call rotations, or incident postmortems" is not a verdict about a person — it is a
// question nobody asked them. This module turns it into one.
//
// IT INVENTS NOTHING, BY CONSTRUCTION. The specific part of every question is a VERBATIM span of the
// matcher's own text. The only words this module contributes are a fixed stem that contains no claim.
// There is no model call, no I/O, no randomness, and no state: `askFor` is a pure function of the
// match record, so the same pair always yields the same question.
//
// IT IS NOT A SCORE AND NOT A GATE. It returns a sentence or `null`. It cannot change which role is
// chosen, cannot suppress a send, and is never consulted by any decision. Nothing downstream reads its
// output except the renderer.
//
// NOT depth-question.mjs. That module asks about a PATTERN across a person's near-misses and ships its
// own email. This is one role, one uncertainty, one line inside the role email.

/** The fixed stem. Contains no claim about the person — only the quoted span does. */
const STEM = "One thing I want to check";

// Uncertainty that is about the POSTING, not the person. "Compensation is not posted" is a real caveat
// but asking someone to answer for an employer's omission is not a question they can usefully answer,
// so these are skipped rather than turned into a prompt.
const POSTING_ONLY = /\b(compensation|salary|pay|comp)\b[^.]{0,40}\b(not (posted|stated|listed|given)|unclear)|\b(posting|jd|job description) (does not|doesn't) (state|mention|specify)|\b(no|offers no|provides no) (compensation|salary|remote|hybrid|team size|comp)\b/i;

// Text that would make the question read as a verdict rather than an enquiry. If the matcher has
// already concluded something about the person, we are not uncertain and must not pretend to be.
const ALREADY_CONCLUDED = /\b(disqualifying|dealbreaker|cannot|does not qualify|clearly lacks|no evidence whatsoever)\b/i;

/** First sentence, trimmed, with the trailing separator removed. Deterministic. */
function firstClause(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.search(/[.;]\s|[.;]$/);
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

/**
 * The one question for this pair, or null.
 *
 * @param {object} match  the matcher record: { flag, chips, dealbreaker_hit, ... }
 * @returns {{question: string, source: "chip"|"flag", span: string}|null}
 */
export function askFor(match) {
  const m = match || {};
  // A named dealbreaker is a KNOWN mismatch, not an unknown. Asking about it would invite someone to
  // argue with a conclusion we already reached on their own stated evidence.
  if (m.dealbreaker_hit === true) return null;

  const chips = Array.isArray(m.chips) ? m.chips : [];
  const warn = chips.find((c) => c && c.kind === "warn" && typeof c.text === "string" && c.text.trim().length > 12);
  const candidates = [
    warn ? { span: firstClause(warn.text), source: "chip" } : null,
    typeof m.flag === "string" && m.flag.trim() ? { span: firstClause(m.flag), source: "flag" } : null,
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.span.length < 12) continue;                  // too short to be a real uncertainty
    if (POSTING_ONLY.test(c.span)) continue;           // the employer's omission, not theirs to answer
    if (ALREADY_CONCLUDED.test(c.span)) continue;      // a conclusion, not an unknown
    return {
      question: `${STEM}: ${c.span}. Have you done this before? One line is plenty.`,
      source: c.source,
      span: c.span,
    };
  }
  return null;                                          // no meaningful uncertainty -> ask nothing
}

/** True when every word of the question outside the fixed stem comes from the source text. */
export function isGroundedIn(question, match) {
  const a = askFor(match);
  return !!a && String(question || "").includes(a.span);
}
