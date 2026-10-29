// lib/match-cache-key.mjs — the incremental-matching cache key (pure, no deps but node:crypto).
//
// WHY: most of the job pool is the SAME roles day to day, yet match-batch.mjs would otherwise re-score
// every (user x role) pair every morning. The match verdict is a pure function of its real inputs —
// model, the matcher rubric, the person's dossier, and the posting's content — so it can be memoized:
// score a pair once, reuse the verdict until one of those inputs changes. Same score, not an
// approximation, so there is no quality change.
//
// KEY CORRECTNESS (two things this file has to get exactly right):
//   1. Read/write PARITY. The key computed when we DECIDE to skip a request (read side) must equal the
//      key computed when we STORE a fresh verdict (write side). Both go through matchCacheKey(), and the
//      job projection ignores any non-job fields (e.g. the `match`/`passed_bar` that scoring appends to
//      the job object), so passing the raw pool job OR the scored job yields the same key.
//   2. EXCLUDE the volatile bits, INCLUDE everything that changes the verdict. The pool re-stamps
//      first_seen/last_seen to the scan time on every run (both == today's scan), and match-scoring.mjs
//      injects a TODAY date line — none of those carry fit signal, and all of them change daily, so a
//      whole-prompt hash would miss 100% of the time. We key on the semantic job fields only. Anything
//      that genuinely changes the verdict (the rubric, the dossier, the posting text, the model) IS in
//      the key, so a real change re-scores; a spurious timestamp change does not. A short TTL on the
//      read side (see charlie-store getVerdicts) bounds any tenure/recency drift from the excluded date.
//
// If the scanner's job shape gains a new field that the model should weigh, add it to JOB_KEY_FIELDS —
// otherwise a change to that field would be silently ignored and serve a stale verdict.

import { createHash } from "node:crypto";

// The semantic job fields the matcher sees and that define a posting's fit. Mirrors the pool job shape
// in scan-jobs.mjs; DELIBERATELY excludes first_seen/last_seen (re-stamped to the scan time every run).
export const JOB_KEY_FIELDS = [
  "id", "source", "company", "slug", "segment", "title", "location",
  "remote", "team", "employment_type", "compensation", "apply_url", "posted_at", "description",
];

// Bump when the key's meaning changes (e.g. JOB_KEY_FIELDS changes) to invalidate every stored verdict.
const KEY_VERSION = 1;

function stableJob(job) {
  const o = {};
  for (const k of JOB_KEY_FIELDS) o[k] = job?.[k] ?? null;
  return o;
}

/**
 * Deterministic cache key for one (person x job) match verdict. Identical inputs -> identical key;
 * any change to the model, the matcher rubric, the dossier, the constrained-decode mode, or a semantic
 * job field -> a different key -> a re-score. The TODAY date line and first_seen/last_seen are NOT
 * inputs here (they carry no fit signal and would defeat day-over-day reuse).
 *
 * @param {object}  o
 * @param {string}  o.model         the scoring model id
 * @param {number}  o.maxTokens     max_tokens for the scoring call
 * @param {string}  o.matcherText   the rubric text (matcher.md)
 * @param {string}  o.dossierText   the person's dossier as sent to the model
 * @param {unknown} o.job           the job (raw pool job OR a scored job; non-job fields are ignored)
 * @param {boolean} [o.constrained] constrained-decode flag (changes the reply shape -> part of the key)
 * @returns {string} hex sha-256
 */
export function matchCacheKey({ model, maxTokens, matcherText, dossierText, job, constrained = false }) {
  return createHash("sha256")
    .update(JSON.stringify({
      v: KEY_VERSION,
      model: model ?? null,
      maxTokens: maxTokens ?? null,
      constrained: !!constrained,
      matcher: matcherText ?? "",
      dossier: dossierText ?? "",
      job: stableJob(job),
    }))
    .digest("hex");
}

// The exact error-placeholder flags match-batch stores on a FAILED reply ({score:0, verdict:"skip"} +
// one of these). Anchored so a legitimate model flaw note in `flag` can never be mistaken for an error.
const ERROR_PLACEHOLDER_FLAG = /^(unparseable score|schema-invalid score|score failed:)/i;

/**
 * A verdict is cacheable unless it is an ERROR placeholder. On a failed/malformed reply match-batch
 * stores { score:0, verdict:"skip", flag:"unparseable score" | "schema-invalid score" | "score
 * failed: <type>" } — caching that would suppress a legitimate re-score, so it fails closed here. But a
 * LEGITIMATE model "skip" verdict (a real not-a-fit judgment — the MOST COMMON outcome, and where most
 * of the saving lives) IS cached: reusing a stable not-a-fit judgment is correct. Errors are identified
 * by their flag, NOT by verdict==="skip" (which real skips also carry). A cached verdict is additionally
 * re-validated against the current schema by the caller before use.
 */
export function cacheableVerdict(match) {
  if (!match || typeof match !== "object") return false;
  if (typeof match.score !== "number") return false;
  if (typeof match.flag === "string" && ERROR_PLACEHOLDER_FLAG.test(match.flag)) return false;
  return true;
}
