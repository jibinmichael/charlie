// lib/jd-requirements.mjs — "does this posting state its requirements, and where?"
//
// ONE definition, because two files depend on the same answer and drift between them is silent:
//
//   fit-coverage.mjs  uses it to decide whether a JD is scoreable at all. If it says no, coverage
//                     returns { thin: true, reason: "jd" } and the email ships without its fit chart.
//   charlie-store.mjs uses it to decide WHICH 2500 characters of a long posting to keep when slimming
//                     the shared pool object. If the kept slice contains no requirements, the reader
//                     above declares the posting unscoreable and the chart disappears.
//
// Sharing the predicate is what lets the cap honour its stated intent ("the cap must clear a JD's
// requirements section"): a blind head-slice can cut the requirements off and leave a posting the
// reader then declares unscoreable.
//
// Deliberately a separate tiny module rather than an export from fit-coverage.mjs: that file imports the
// Anthropic SDK, and charlie-store.mjs is imported by every script and both services.

/** Wording that indicates a posting actually states what it wants, rather than being marketing copy. */
export const REQ_SIGNAL = /require|must have|you have|you'?ll|qualif|years|experience with|proficien|familiar with|strong.{0,20}(in|with)|responsib|what you'?ll (do|need)/i;

/** Is this JD scoreable at all? Long enough to carry requirements, and actually stating some. */
export function jdIsScoreable(jd) {
  const t = String(jd || "");
  return t.length >= 400 && REQ_SIGNAL.test(t);
}

/**
 * Trim a JD to `cap` characters while KEEPING the requirements, which is the whole point of the cap.
 *
 * The pool object has to be slimmed to stay under the storage object-size ceiling, so the question is
 * never "trim or not", only "trim WHERE". A blind head-slice is right for most long postings and
 * throws the requirements away for the rest.
 *
 * No truncation MARKER is added, on purpose: `jdWasTruncated` in render-email.mjs treats a trailing
 * ellipsis as "hide the fit chart", and marking most of the pool would suppress the chart on almost
 * every first-role email. Length is not truncation.
 *
 * @param {string} d   the full description
 * @param {number} cap max characters to keep
 * @returns {string}   `d` unchanged when short enough, else a `cap`-length window
 */
export function capKeepingRequirements(d, cap) {
  const s = typeof d === "string" ? d : "";
  if (!Number.isFinite(cap) || cap <= 0 || s.length <= cap) return s;
  const head = s.slice(0, cap);
  if (REQ_SIGNAL.test(head)) return head; // the common case: requirements are already up front
  const at = s.search(REQ_SIGNAL);
  if (at < 0) return head; // nothing to preserve anywhere — the head is as good as any slice
  // Slide the window back a little so the requirements aren't flush against the first character, and
  // clamp so we never read past either end.
  const start = Math.min(Math.max(0, at - 200), s.length - cap);
  return s.slice(start, start + cap);
}

// ── The bonus section, kept even though the cap swallows it ──────────────────────────────────────
//
// Most postings are longer than the description cap, and the nice-to-have section sits after the
// requirements, so it is exactly what capKeepingRequirements lets fall off the end.
//
// The bonuses are the only place a candidate can be MEMORABLE: everyone who applies meets the
// requirements. "They listed Kubernetes as a bonus and you have run it in production" needs the text.
//
// STORED SEPARATELY AND SMALL, rather than by raising the cap. Raising the cap would multiply the pool
// size, which already sits close to V8's single-string ceiling. Extracting a few hundred characters
// adds little and costs no model call.
const NICE_HEAD = /\b(nice[- ]to[- ]haves?|bonus points|bonus if|preferred qualifications|good to have|would be great|even better|pluses)\b/i;

/** A line that starts a DIFFERENT section, so the extract stops before swallowing the rest. */
const NEXT_SECTION = /\b(benefits|perks|what we offer|compensation|salary|equal opportunity|about us|our team|how to apply|interview process|why join)\b/i;

/**
 * Pull the bonus/nice-to-have section out of a FULL description.
 *
 * Returns "" when there is none, which is the common case and must stay cheap: no allocation beyond
 * the regex test, and never a guess. A wrong extract would put words in an employer's mouth, so this
 * only ever returns text that appeared verbatim after a heading the posting itself wrote.
 *
 * @param {string} full  the UNCAPPED description
 * @param {number} max   characters to keep
 */
export function extractNiceToHave(full, max = 400) {
  const s = typeof full === "string" ? full : "";
  const m = s.match(NICE_HEAD);
  if (!m || m.index == null) return "";
  const after = s.slice(m.index, m.index + max * 3);
  // Stop at the next section heading if one appears inside the window — benefits and EEO boilerplate
  // are not bonuses, and including them would make the extract read as if the employer asked for them.
  const stop = after.slice(m[0].length).search(NEXT_SECTION);
  const body = stop > 0 ? after.slice(0, m[0].length + stop) : after;
  return body.replace(/\s+/g, " ").trim().slice(0, max);
}
