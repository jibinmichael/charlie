// lib/inbound-question.mjs — tell a question apart from a preference statement.
//
// A reply to a role email otherwise falls through to applyEmailChange, which reads it as "change what
// you are looking for" and confirms the change. That is right for "make it remote only" and wrong for
// "should I apply via the button or reply to this email?": the question gets a preference
// confirmation, and its words are fed to a writer that puts facts into the person's profile.
//
// DETERMINISTIC, NO MODEL. This decides whether to write to somebody's profile, so it must be
// reproducible and arguable in one reading. It is conservative in the safe direction: a message that
// is BOTH a question AND a statement of preference is treated as a preference, because missing a
// question costs one unanswered email and ignoring a stated preference means matching on the wrong
// thing for weeks.

/** Phrases that mean "I am telling you something about what I want", not "I am asking". */
const STATES_A_PREFERENCE =
  /\b(?:i(?:'m| am)? ?(?:looking|open|available|interested|actively)|my (?:notice|pay|salary|floor|budget|preference)|salary|pay floor|notice period|ctc|lpa|remote only|onsite only|hybrid|relocat|start(?:ing)? (?:immediately|from)|dealbreaker|not interested in|no longer|prefer)\b/i;

/** Openings that are unmistakably interrogative even without a question mark. */
const ASKS =
  /(?:^|\n)\s*(?:is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|when|what|where|which|who|whom|why|how)\b[^.\n]{0,120}\?/i;

/**
 * Is this message a question we owe an answer to, rather than an instruction to update a profile?
 *
 * @param {string} body the person's OWN words, already de-quoted
 * @returns {{ isQuestion: boolean, why: string }}
 */
export function looksLikeQuestion(body) {
  const t = String(body || "").trim();
  if (!t) return { isQuestion: false, why: "empty" };

  // A preference statement wins, even if it also contains a question. See the note above: the
  // asymmetric cost is why this check comes first.
  if (STATES_A_PREFERENCE.test(t)) return { isQuestion: false, why: "states a preference" };

  const hasMark = t.includes("?");
  if (!hasMark && !ASKS.test(t)) return { isQuestion: false, why: "no question" };

  // Long messages that happen to contain a question mark are usually a person telling us something,
  // not asking something we can answer mechanically. Those are still routed onward; this branch is
  // for the short, direct ask.
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 120) return { isQuestion: false, why: "long message, not a quick question" };

  return { isQuestion: true, why: hasMark ? "asks a question" : "interrogative opening" };
}

/**
 * The one question we can answer mechanically and truthfully, because the answer is the same for
 * everybody and never depends on a fact about them: no, Charlie does not submit applications.
 *
 * Anything else returns null and a human answers it: guessing at somebody's question would repeat
 * the same misreading one layer up.
 */
export function knownAnswer(body) {
  const t = String(body || "").toLowerCase();
  const aboutApplying =
    /\b(?:applied|applying|apply|application|submit(?:ted)?|sent)\b/.test(t) &&
    /\b(?:is it|has it|have you|did you|does .{0,20}sent|already|on my behalf|for me|through charlie|via charlie)\b/.test(t);
  return aboutApplying ? "applied" : null;
}
