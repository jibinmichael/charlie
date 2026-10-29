// lib/dossier-write-cost.mjs — what a dossier write costs the NEXT run, not what it costs today.
//
// THE BILL NOBODY ESTIMATES. A script can print its own model spend and still miss the larger number:
// the verdict cache key is a hash of the whole dossier text (lib/match-cache-key.mjs, fed by
// scheduler.mjs), so touching a dossier can invalidate every stored verdict for that person and the
// next run silently re-scores their entire pool at full price. Writing one new field to a few dozen
// people can cost many times a normal run.
//
// So this asks the question before `--apply` does the damage: for the people about to be written,
// how many cached verdicts exist, and will this write orphan them?
//
// IT READS THE REAL PROJECTION. `willInvalidate` does not consult a list of field names — it runs the
// actual blindDossierText the scorer uses and compares the before and after text. A field excluded
// from the scoring projection (lib/blind-dossier.mjs NON_SCORING_KEYS) genuinely costs nothing, and a
// field that IS in the projection costs the full re-score no matter what anyone believed. That makes
// this a measurement rather than a promise.

import { blindDossierText } from "./blind-dossier.mjs";

// Haiku 4.5 batch, the model the daily match runs on: roughly $0.00266 per re-scored pair.
export const USD_PER_RESCORED_PAIR = 0.0026644;

/**
 * Would replacing `before` with `after` change what the scorer sees, and therefore the cache key?
 * Pure, no I/O. Compares the serialised scoring projection exactly as match-batch builds it.
 */
export function willInvalidate(before, after) {
  const text = (d) => blindDossierText(JSON.stringify(d ?? {}, null, 2));
  return text(before) !== text(after);
}

/**
 * The warning line a dossier-writing script prints BEFORE it writes anything.
 *
 * @param {object}   o
 * @param {boolean}  o.invalidates  whether the write changes the scoring projection (willInvalidate)
 * @param {number}   o.people       how many dossiers will be written
 * @param {number}   o.verdicts     how many cached verdicts those people hold today
 * @returns {string} a line to print, safe to show whether or not it costs anything
 */
export function invalidationWarning({ invalidates, people = 0, verdicts = 0 } = {}) {
  if (!invalidates) {
    return `next run's cost: $0. This field is outside the scoring projection (lib/blind-dossier.mjs), so no cached verdict moves.`;
  }
  const usd = verdicts * USD_PER_RESCORED_PAIR;
  return (
    `next run's cost: ~$${usd.toFixed(2)}. This write changes what the scorer sees, so all ${verdicts} ` +
    `cached verdict(s) across ${people} person/people are orphaned and re-scored at full price. ` +
    `That is ON TOP of this script's own spend.`
  );
}
