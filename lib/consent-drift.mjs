// consent-drift.mjs — did a live form stop asking a consent question it used to ask?
//
// tally-applicants.test.mjs pins the consent wordings we know about, so it catches a pattern somebody
// narrows. It cannot catch the other half: a form's question title EDITED in Tally to wording the
// detector does not know. Nothing in the repo changes; the form moves underneath it.
//
// Both halves fail the same way: the question is not found, `false` is stored, and a refusal nobody
// made is indistinguishable from one they did. This compares the live forms against a committed
// baseline (lib/consent-baseline.json) so that drift is caught mechanically.
//
// A REGRESSION IS A FORM THAT USED TO MATCH AND NO LONGER DOES. That is the only condition treated as
// a failure, because it is the only one that can silently rewrite an answer somebody already gave.
// A form that has never asked is not a regression: those people were never asked and storing them as
// not-contactable is correct.

/**
 * @param {Record<string, {pool: string|null, share: string|null}>} baseline  last known good
 * @param {Record<string, {pool: string|null, share: string|null}>} observed  what the live forms say now
 * @returns {{regressions: object[], recovered: object[], unknown: string[], gone: string[]}}
 */
export function compareToBaseline(baseline, observed) {
  const regressions = [], recovered = [], unknown = [];
  for (const [form, now] of Object.entries(observed)) {
    const was = baseline[form];
    if (!was) { unknown.push(form); continue; } // a new form: a human confirms whether it asks at all
    for (const field of ["pool", "share"]) {
      // The dangerous direction: we used to find it, and now we do not.
      if (was[field] && !now[field]) regressions.push({ form, field, was: was[field], now: null });
      // Worth printing, never a failure: a question appeared, or its wording changed and still matches.
      else if (!was[field] && now[field]) recovered.push({ form, field, was: null, now: now[field] });
      else if (was[field] && now[field] && was[field] !== now[field]) recovered.push({ form, field, was: was[field], now: now[field] });
    }
  }
  // A form that vanished from Tally is reported, not failed: deleting a form is a deliberate act.
  const gone = Object.keys(baseline).filter((f) => !observed[f]);
  return { regressions, recovered, unknown, gone };
}

/** Detect both consent questions on one form's question list. */
export function detectOn(questions, POOL_Q, SHARE_Q) {
  const find = (re) => (questions.find((q) => re.test(q.title)) || {}).title || null;
  return { pool: find(POOL_Q), share: find(SHARE_Q) };
}
