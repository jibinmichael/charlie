// matcher-version.mjs — the matcher/scoring version stamped onto every find at write time, so an
// outcome can be attributed to the decision that produced it.
//
// Bump MATCHER_VERSION on ANY change that alters what/how Charlie scores or selects:
//   - the matcher rubric (matcher.md) or the batch scorer (match-batch.mjs / match-one.mjs)
//   - the pre-filter / selection (select-jobs.mjs) or the quality gate (quality-gate.mjs)
// It is read by upsertFind (charlie-store.mjs) as the default `matcherVersion`, so every write picks up
// the current value without threading it through call sites.
export const MATCHER_VERSION = "2026-07-28-knockout";
