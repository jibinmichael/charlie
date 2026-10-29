// lib/represent-ready.mjs — do we know enough about this person to name a role to them?
//
// THE FAILURE THIS PREVENTS. Putting someone forward for an ON-SITE role when their profile does not
// say where they can work: the pitch goes first, the qualifying question second, and by the time the
// answer ("remote only") arrives the wrong pitch is already in their inbox.
//
// preSendGuard catches the same shape at send time, but only when the fact EXISTS. This module
// covers the case that has no fact to check: we do not know, so we do not guess, and we do not pitch.
//
// TWO TIERS, AND THE SPLIT IS THE WHOLE DESIGN.
//
//   BLOCKING — can make the pitch WRONG. Only one thing qualifies: where they can work. Pitch an
//     on-site role to someone who can only work remotely and the email is not merely incomplete, it
//     is an error the reader sees instantly and cannot unsee.
//
//   ASK-WITH — makes the intro INCOMPLETE, not wrong. Notice period, pay expectation, whether they
//     are actively looking. renderPutForward already asks for all three in the same email, so
//     blocking on them would stop the motion for no gain.
//
// Blocking on all four would leave the motion reachable for almost nobody, which is the same as not
// building it. Blocking on the one that misfires keeps most people reachable and closes the actual
// hole.

/** True when a preference value is genuinely present (an empty array is not an answer). */
const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Do we know where this person can actually work?
 *
 * Any ONE of these settles it: a stated remote preference, a home place, a location on the profile,
 * or a dealbreaker that names the constraint. Deliberately generous — this gate exists to stop a
 * confident wrong pitch, not to demand a form be filled in.
 */
export function knowsWhereTheyCanWork(dossier) {
  const d = dossier || {};
  const p = d.preferences || {};
  if (has(p.remote) || has(p.home_place) || has(p.location) || has(d.location) || has(d.city)) return true;
  // "on-site only" / "no relocation" as a dealbreaker is an answer to the same question.
  const db = Array.isArray(p.dealbreakers) ? p.dealbreakers.join(" ") : "";
  // `relocat\w*` deliberately, not `\brelocat\b`: the latter cannot match "relocation" or
  // "relocating", because there is no word boundary in the middle of a word.
  return /\b(remote|on-?site|onsite|hybrid|wfh)\b|\brelocat\w*/i.test(db);
}

/**
 * The reason we must not name a role to this person yet, or null.
 *
 * FAIL CLOSED: a missing or unreadable dossier blocks. We are about to tell someone a specific job
 * might be theirs; doing that on no information is worse than doing nothing.
 *
 * @returns {string|null} a human reason, suitable for a log line an operator reads at 2am
 */
export function blockingGap(dossier) {
  if (!dossier || typeof dossier !== "object") return "no profile on file";
  if (!knowsWhereTheyCanWork(dossier)) {
    return "we do not know where they can work (no remote preference, home place, or location). Ask before naming a role.";
  }
  return null;
}

/** Convenience for callers that only want the boolean. */
export function readyToRepresent(dossier) {
  return blockingGap(dossier) === null;
}

/**
 * The facts the introduction email should ASK for, in the order a founder asks them.
 *
 * These never block. renderPutForward requests all of them in the same message, so the yes and the
 * facts arrive together rather than costing a second email that half the people never answer.
 */
export function askWith(dossier) {
  const p = (dossier && dossier.preferences) || {};
  const out = [];
  if (!has(p.notice_period)) out.push("notice period");
  if (!has(p.comp_floor)) out.push("pay expectation");
  if (!has(p.mode)) out.push("whether they are actively looking");
  return out;
}
