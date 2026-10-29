// lib/unreachable-cohort.mjs — is anyone we are supposed to be serving unable to receive mail?
//
// THE BLIND SPOT this closes. scheduler.mjs drops suppressed recipients BEFORE scoring (a cost
// optimisation: a suppressed address is blocked at the send door anyway, so scoring it burns model
// spend on an email that can never go out). Correct on cost, catastrophic on visibility: a dropped
// person also leaves the coverage denominator, so `silent_no_send` can never fire for them, and the
// run prints a bare count and reports success.
//
// The typical case: a user's `email_config.notify` points at an address that has HARD BOUNCED, so
// every role email they are owed goes nowhere, and from the outside that is indistinguishable from
// "no role cleared their bar today".
//
// A count is not an alarm. This turns the drop into a named list — who, which address, and why it is
// blocked — so both the run log and the watchdog can say it out loud every single run.
//
// Pure (no DB, no env): the callers own the reads, which is what makes the rule testable.
//
// SCOPE, deliberately: only candidates we are actively trying to mail. A paused or unsubscribed
// person receiving nothing is the intended outcome, not a fault, and alarming on them would train the
// operator to ignore this check — which is the same silence, one level up.

/**
 * @typedef {{email: string, status?: string|null, email_config?: {notify?: string|null}|null}} Candidate
 * @typedef {{email: string, routing: string, reason: string, viaNotify: boolean}} Unreachable
 */

/** The address a send actually goes to, mirroring `email_config.notify || email` in scheduler.mjs's
 * send path (lower-cased, because that is how `suppressions.address` is stored). A divergence here
 * would check one address and mail another, which is how this class of bug hides, so
 * unreachable-cohort.test.mjs asserts the send path still resolves its recipient the same way. */
export function routingAddress(candidate) {
  return String(candidate?.email_config?.notify || candidate?.email || "").trim().toLowerCase();
}

/**
 * Active cohort members whose routing address is on the do-not-send list.
 *
 * @param {object} o
 * @param {Candidate[]} o.candidates      candidate rows (any status; filtered here)
 * @param {Map<string,string>|Record<string,string>} o.suppressed  address -> reason
 * @param {(email:string)=>boolean} [o.inCohort]  cohort membership; defaults to "everyone"
 * @returns {Unreachable[]} one entry per person we are trying to mail and cannot reach
 */
export function unreachableCohort({ candidates, suppressed, inCohort = () => true } = {}) {
  const reasonOf = suppressed instanceof Map
    ? (a) => suppressed.get(a) ?? null
    : (a) => (suppressed && Object.prototype.hasOwnProperty.call(suppressed, a) ? suppressed[a] : null);
  const out = [];
  for (const c of candidates ?? []) {
    if ((c?.status ?? "active") !== "active") continue; // paused/unsubscribed silence is deliberate
    if (!inCohort(c.email)) continue;                   // outside the allowlist: also deliberate
    const routing = routingAddress(c);
    if (!routing) continue;                             // no address at all is a different fault
    const reason = reasonOf(routing);
    // Any suppression counts, including an `unsubscribe`. An ACTIVE cohort member carrying an
    // unsubscribe row is not a resolved opt-out, it is a contradiction between two tables that silently
    // blocks their role email. Report the reason so a bounce and an opt-out are told apart by a human,
    // not silently merged by this function.
    if (reason != null) out.push({ email: c.email, routing, reason, viaNotify: routing !== String(c.email || "").trim().toLowerCase() });
  }
  return out;
}

/** One line an operator can act on. Names the person, the address that is actually failing, and why. */
export function unreachableDetail(list) {
  return (list ?? [])
    .map((u) => `${u.email}${u.viaNotify ? ` (routed to ${u.routing})` : ""} — ${u.reason}`)
    .join("; ");
}
