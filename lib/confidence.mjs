// confidence.mjs — how much weight a fit assessment can carry, computed rather than described.
//
// WHY. The score is deterministic: the model assigns a level per criterion and the arithmetic lives in
// code, so "why is she a 61?" is answerable from a table. Confidence gets the same treatment. Written
// fresh in prose each time, the same candidate on the same evidence can be called "genuinely strong"
// one minute and "moderate" the next.
//
// So confidence is a FIELD. It is computed here, once, and quoted everywhere: the summary, the client
// mail, the board. A label that can be re-narrated is an opinion wearing a label, and an opinion drifts.
//
// THREE LABELS AND NOTHING IN BETWEEN. Half-steps invite exactly the improvisation this replaces.
//
//   established   the evidence was written for THIS mandate, it covers most of it, something outside
//                 the candidate's own account confirms part of it, and every hard constraint is met.
//   indicative    real, relevant evidence that falls short of the above. The honest default.
//   insufficient  we cannot responsibly say anything about fit, or a hard constraint is failed.
//
// MOST PEOPLE WILL BE "INDICATIVE", and that is the true state rather than a harsh scale. Forms that
// collect only a LinkedIn URL give nothing fetchable, so `verified` is false; and a pool screened
// against a mandate it never applied to has `writtenForMandate` false by definition. The label points
// at the two things that would genuinely raise it, which is the point of having it.
//
// IT DESCRIBES OUR EVIDENCE, NEVER THE PERSON. "insufficient" is a statement about what we hold. It
// is not a verdict, it must never be shown as one, and it never means somebody is a weak candidate.

/** Coverage at or above this is "most of the mandate". Below the lower bar we know too little. */
const COVERAGE_STRONG = 80;
const COVERAGE_FLOOR = 50;

/**
 * @param {{
 *   coverage: number,               // share of criteria with any evidence, 0-100
 *   writtenForMandate: boolean,     // did they answer questions aimed at THIS role?
 *   verified: boolean,              // did anything outside their own account confirm a claim?
 *   hardFailed: number,             // hard constraints they demonstrably do not meet
 *   hardUnknown: number,            // hard constraints nobody has asked them about
 *   scored: boolean,                // did the screen actually run?
 * }} input
 * @returns {{label: "established"|"indicative"|"insufficient", why: string[]}}
 */
export function confidenceOf({
  coverage = 0, writtenForMandate = false, verified = false,
  hardFailed = 0, hardUnknown = 0, scored = true,
} = {}) {
  const why = [];

  // A hard constraint they fail is not a confidence question, it is a fit question, and it caps
  // everything. Saying we are confident about somebody who cannot take the job is a category error.
  if (!scored) return { label: "insufficient", why: ["the screen did not run"] };
  if (hardFailed > 0) {
    return { label: "insufficient", why: [`${hardFailed} hard requirement${hardFailed > 1 ? "s" : ""} not met`] };
  }
  if (Number(coverage) < COVERAGE_FLOOR) {
    return { label: "insufficient", why: [`the application addresses only ${Math.round(coverage)}% of the mandate`] };
  }

  if (writtenForMandate) why.push("their answers were written for this role");
  else why.push("their answers were written for a different role");
  if (verified) why.push("part of it is confirmed outside their own account");
  else why.push("nothing is confirmed outside their own account");
  why.push(`${Math.round(coverage)}% of the mandate is addressed`);
  if (hardUnknown > 0) why.push(`${hardUnknown} hard requirement${hardUnknown > 1 ? "s have" : " has"} never been asked about`);

  const established = writtenForMandate && verified && Number(coverage) >= COVERAGE_STRONG && hardUnknown === 0;
  return { label: established ? "established" : "indicative", why };
}

/** The one sentence that goes in front of a human. Same words every time, by construction. */
export function confidenceLine(c) {
  const head = {
    established: "Established",
    indicative: "Indicative",
    insufficient: "Insufficient",
  }[c.label];
  return `${head} — ${c.why.join("; ")}.`;
}
