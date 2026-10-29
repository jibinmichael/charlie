// digest-retention.mjs — which held-back roles are worth persisting as a digest row.
//
// Only FIT-shaped held rows are retained. The retained digest set is the substrate for the two
// near-miss features, and a constraint-shaped row is useless to both:
//
// A constraint-shaped row can NEVER carry coverage, mechanically: the constraint gates return
// `cov: null` before `gateRole` reaches its `getCov()` call (presend-guard.mjs, quality-gate.mjs). So:
//
//   depth-question  reads STORED coverage and never recomputes, so it cannot read a constraint row at
//                   all, and such rows occupy slots in its most-recent window and DISPLACE the rows it
//                   can read.
//   market-gap      recomputes coverage, so it can read them, but would spend model calls deriving
//                   "what the market keeps asking for" from roles the person cannot take.
//
// market-gap's purpose is evidence-shaped: "the recurring requirement the person's own near-miss roles
// ask for but their profile has not shown". A role held because they cannot take it is not a
// statement about their evidence.
//
// WHAT THIS DOES NOT DO. It deletes nothing. Historical rows are untouched; this only decides what
// FUTURE writes persist. It changes no email, no flag, and neither consumer's code.

/** Rules that mean "they were close on FIT" — the only kind worth retaining. */
const FIT_SHAPED = /^(fit-floor|match-bar):/;

/**
 * Is this the machine-readable rule of a fit-shaped hold?
 * Reuses `digest_rule`. There is deliberately no second classification system.
 */
export function isFitShaped(rule) {
  return FIT_SHAPED.test(String(rule || ""));
}

/**
 * Should a role held back under this rule be persisted as a digest row?
 *
 * FAIL-OPEN ON ANYTHING UNRECOGNISED, and that is the important half. Older rows and careless writers
 * carry no `digest_rule`. A missing, empty or `unrecorded` rule therefore means "we cannot classify
 * this", NOT "this is constraint-shaped". Retaining an extra row costs a row; dropping one we could
 * not classify destroys data we cannot get back.
 *
 * An unknown FUTURE rule string behaves the same way: retained, and visible as such.
 *
 * @param {string|null|undefined} rule  composed.digest_rule
 * @returns {{retain: boolean, why: string}}
 */
export function retainDecision(rule) {
  const r = String(rule || "").trim();
  if (!r || r === "unrecorded") return { retain: true, why: "unclassified — retained rather than guessed" };
  if (isFitShaped(r)) return { retain: true, why: "fit-shaped" };
  return { retain: false, why: `constraint-shaped (${r})` };
}
