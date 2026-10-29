// consent-questions.mjs — the two permission questions, and every wording a form asks them in.
//
// ONE COPY. scripts/pool-applicants.mjs and scripts/backfill-consent.mjs both read these exports, so
// the repair script can never share a blind spot the detector does not, and a new wording is added in
// one place or not at all.
//
// A MISSED WORDING IS RECORDED AS A REFUSAL. `may_write_again` is false when the question is not
// found, which is indistinguishable downstream from somebody ticking "no", and a run with a missed
// wording looks like a clean run with a small number.
//
// MATCH THE INTENT, NOT ONE FORM'S PHRASING. Add the wording; never narrow an existing branch.

/**
 * Permission to write to somebody again about roles other than the one they applied to.
 * Wordings covered:
 *   "Would you like to join the Charlie talent pool?"
 *   "Yes, Charlie may also send me roles from other companies it works with..."
 *   "Even if this role isn't the one, would you like to be part of Charlie's talent network?"
 *   "Would you like Charlie to consider you for other relevant roles in the future...?"
 */
export const POOL_Q = /talent (pool|network|community)|partner network|roles from other companies|send me (relevant |other )?roles|be part of .*(network|pool)|consider (you|me) for .*roles/i;

/**
 * Permission to put their profile in front of the employer.
 * Wordings covered:
 *   "If shortlisted, may we share your Charlie profile with the employer?"
 *   "I consent to being contacted by the <client> HR / hiring team regarding this application..."
 *
 * The second is a client-side wording and reads wider than the first: agreeing to be contacted by the
 * employer's own HR team presumes the employer has been given the profile. It is recorded as share
 * consent, with the verbatim text stored beside the boolean so the words somebody actually agreed to
 * can always be produced.
 */
export const SHARE_Q = /share your .*profile|share my profile|with the employer|contacted by the .*(hr|hiring team)/i;

/**
 * Did they agree? Read from the answer's own words.
 *
 * Not every form phrases agreement as "Yes": a checkbox consent renders as its own label, so a share
 * permission can come back as the literal string "I consent". Reading only `/^yes\b/` would score
 * that agreement as a no.
 *
 * The answer shapes these two branches cover:
 *   "Yes", "Yes, please.", "Yes - send me relevant opportunities as they arise/arrive",
 *   "Yes - keep me in consideration for relevant roles", "Yes - you may share my profile if
 *   shortlisted", "I consent"
 * and every refusal starts with "No", so nothing here can turn a refusal into agreement:
 *   "No", "No - only contact me about this search", "No - contact me first",
 *   "No - only consider me for this role"
 *
 * A negation is not an agreement: "I do not consent" fails the second branch because the anchor
 * requires "consent"/"agree" to follow "I" immediately. Never relax that anchor to a bare search.
 */
export const affirmative = (v) => {
  const s = String(v || "").trim();
  return /^yes\b/i.test(s) || /^i (consent|agree)\b/i.test(s);
};
