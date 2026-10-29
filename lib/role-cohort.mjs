// role-cohort.mjs — WHO is allowed to receive a role email.
//
// A named allowlist (ROLE_COHORT) used by operator scripts that deliberately scope themselves to a
// small cohort, so the matching effort (and the model spend) goes only to those people.
//
// What this gate alone stops is ROLE email, nothing else. In practice it is paired with a status pause
// (scripts/pause-cohort.mjs), and THAT is what also stops the digest, the newsletter and the market read
// for everyone outside the cohort — so do not read this file as a promise that excluded people still
// receive those. The one thing both layers deliberately preserve is a REPLY when a person writes in:
// the inbound gate reads suppression only, and never this cohort or the candidate's status.
//
// This is a CADENCE control, not a suppression. It is deliberately NOT the `suppressions` table:
// that table is the bounce/complaint record that protects the sending domain, and an entry in it blocks
// EVERY template including Charlie's replies (lib/send-guard.mjs, lib/suppression-policy.mjs), which
// would turn the product's only surface into a one-way door. Pausing a person's OTHER automated mail is
// `candidates.status`; pausing only their ROLE email is this file.
//
// EMPTY MEANS NOBODY. An unset or blank ROLE_COHORT sends to no one, rather than falling back to
// "everybody" — a var that goes missing should cause loud silence, never a surprise send to the whole
// list (fail closed).
//
//   ROLE_COHORT=a@b.com,c@d.com
//
// Pure + exported so the membership rule is testable without a send, matching the shape of the tested
// `isExcluded` predicate in market-briefing.mjs.

function cohortSet() {
  const raw = String(process.env.ROLE_COHORT || "");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Is this person allowed to receive a role email?
 * @param {string} email the candidate's address (their identity, not the `notify` forwarding alias)
 * @returns {boolean}
 */
export function inRoleCohort(email) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) return false; // no address -> never send
  return cohortSet().has(addr);
}

/** How many addresses the cohort resolves to right now. For the run log, so a misconfigured var is visible. */
export function roleCohortSize() {
  return cohortSet().size;
}
