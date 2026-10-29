// lib/ghost-score.mjs — is this posting an evergreen req rather than a live opening?
//
// The signal is longitudinal: a posting that
// has been continuously open for months is usually a pipeline/evergreen req, and applying to one is
// the specific waste this product exists to save a person.
//
// READ THIS BEFORE TRUSTING ANY OUTPUT:
//
// This gate is INERT until the persisted seen-store has accumulated roughly GHOST_DAYS of history.
// That is not a defect, it is arithmetic, and it is worth stating loudly because a silent inert gate
// is indistinguishable from a working one that finds nothing.
//
// Why: `first_seen` comes from the seen-store. On a fresh deployment every pooled role carries a
// `first_seen` from the first scan — including roles that have been posted for months — so age
// measures when history began, not how long a job has been open.
//
// So: run this in SHADOW, read the log, and only consider `enforce` once the store has genuinely
// accumulated. The threshold below is a starting point, NOT a calibrated one.

const DAY = 86400e3;

/** shadow (default) logs and changes nothing · enforce routes to digest · off disables. */
export function ghostMode() {
  return String(process.env.GHOST_SCORE || "shadow").toLowerCase();
}

/**
 * Days a posting has been continuously open, or null when that cannot be known.
 * Null is the expected answer for a role first seen this run and is never an error.
 * @param {{first_seen?: string, last_seen?: string}} job
 * @param {number} [now]
 * @returns {number|null}
 */
export function openDays(job, now = Date.now()) {
  const t = Date.parse(job?.first_seen || "");
  if (!Number.isFinite(t)) return null;
  const d = (now - t) / DAY;
  // A future first_seen is a clock or data fault, not a fresh posting. Treat it as unknown rather
  // than as a negative age that would compare as "very new" and quietly pass every threshold.
  return d < 0 ? null : d;
}

/**
 * Has this posting been open long enough to read as evergreen?
 *
 * Deliberately one-directional: it can only ever HOLD a role, never promote one, and it is silent
 * whenever the age cannot be established. An absent or unparseable `first_seen` means no opinion —
 * the store failing must not turn into "every role is a ghost", which is the fail-closed-becomes-
 * fail-to-zero shape.
 *
 * @param {{first_seen?: string, status?: string}} job
 * @param {{now?: number, days?: number}} [opts]
 * @returns {{evergreen: boolean, ageDays: number|null, reason: string}}
 */
export function ghostVerdict(job, { now = Date.now(), days = Number(process.env.GHOST_DAYS || 45) } = {}) {
  const ageDays = openDays(job, now);
  if (ageDays === null) return { evergreen: false, ageDays: null, reason: "age unknown" };
  // A CLOSED posting is not an evergreen req, it is a finished one. The liveness gate already
  // handles closed roles; double-judging them here would attribute the wrong reason to the hold.
  if (String(job?.status || "").toLowerCase() === "closed") return { evergreen: false, ageDays, reason: "already closed" };
  if (ageDays < days) return { evergreen: false, ageDays, reason: `open ${Math.floor(ageDays)}d, under the ${days}d bar` };
  return { evergreen: true, ageDays, reason: `open ${Math.floor(ageDays)}d without ever closing` };
}
