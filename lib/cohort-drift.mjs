// cohort-drift.mjs — the two ways the role allowlist and the candidate table stop agreeing.
//
// ROLE_COHORT is an allowlist for who may receive a role email (lib/role-cohort.mjs). It is meant to
// be PAIRED with `candidates.status`: somebody we are not mailing roles is supposed to be `paused`
// (scripts/pause-cohort.mjs). When the two disagree, a person sits in a state nobody chose — active,
// so they are counted as served, and off the allowlist, so they receive nothing.
//
// A watchdog WARN line alone never triggers the alert email, so drift has to be graded by age to be
// actionable: a day-old signup outside the cohort is normal, a week-old one is a hole.
//
// Pure and exported so the grading is testable without a database, matching lib/unreachable-cohort.mjs.

/** A brand-new signup legitimately sits outside the cohort for a day: the first role is a day-2
 *  event by design (first-role.mjs), so anything under two days is normal onboarding, not drift. */
export const GRACE_DAYS = 2;

/**
 * @param {{
 *   candidates: {email:string, created_at?:string|null}[],
 *   cohortRaw?: string,
 *   inCohort: (email:string) => boolean,
 *   now?: number,
 *   graceDays?: number,
 * }} args
 * @returns {{
 *   orphans: {email:string, days:number|null}[],   active, not allowlisted — oldest first
 *   overdue: {email:string, days:number|null}[],   the subset past the grace window
 *   stale: string[],                               allowlisted, no longer an active candidate
 * }}
 */
export function cohortDrift({ candidates = [], cohortRaw = "", inCohort, now = Date.now(), graceDays = GRACE_DAYS } = {}) {
  const has = typeof inCohort === "function" ? inCohort : () => false;

  const orphans = candidates
    .filter((c) => !has(c.email))
    .map((c) => {
      const t = c?.created_at ? Date.parse(c.created_at) : NaN;
      return { email: c.email, days: Number.isFinite(t) ? Math.floor((now - t) / 864e5) : null };
    })
    // Oldest first, so the worst case leads the line. Unknown age sorts to the very top: a missing
    // created_at must never let somebody hide inside the grace window forever.
    .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity));

  // Unknown age counts as OVERDUE for the same reason.
  const overdue = orphans.filter((o) => o.days === null || o.days >= graceDays);

  const active = new Set(candidates.map((c) => String(c.email || "").toLowerCase()));
  const stale = String(cohortRaw || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .filter((addr) => !active.has(addr));

  return { orphans, overdue, stale };
}
