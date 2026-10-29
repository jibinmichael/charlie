// voice/statuses.mjs — the six requirement statuses and the four coverage bands. The one constant.
//
// Imported by the schema (lib/schemas/vv-report.mjs), the evaluator (voice/evaluate.mjs), the package
// builder (voice/render-package.mjs), and the tests. The migration's check constraint lists the same
// six by hand; voice/status-names.test.mjs reads the migration SQL and asserts the
// set is identical everywhere. There is no seventh status and no numeric anything.
//
// A conversation SUPPORTS a requirement; it does not prove a capability. The strongest status is
// named for what it is. Coverage says how much of the requirement's evidence contract the session
// exercised with reliable evidence; it is not a probability and not a second score.

export const STATUSES = Object.freeze(["strongly_supported", "supported", "stated_only", "contradicted", "insufficient", "not_assessed"]);

export const COVERAGE_BANDS = Object.freeze(["strong_coverage", "partial_coverage", "limited_coverage", "no_usable_evidence"]);

/** Why an item is `insufficient`: a statement about the session, never about the person. */
export const INSUFFICIENT_REASONS = Object.freeze(["audio", "irrelevant", "time", "extraction", "cap", "none"]);

/** Why an item is `not_assessed`. */
export const NOT_ASSESSED_REASONS = Object.freeze(["not_reached", "declined", "unassessable"]);

/** The words a package may use for each status, and nothing stronger. */
export const STATUS_LANGUAGE = Object.freeze({
  strongly_supported: "The candidate provided strong evidence supporting this requirement.",
  supported: "The candidate provided evidence supporting this requirement; part of what would establish it was not reached or not given.",
  stated_only: "The candidate stated this without the specifics that would support it.",
  contradicted: "Two statements about this differ and the difference was not resolved. A question for a human, not a verdict.",
  insufficient: "The session did not produce usable evidence for this. That is a statement about the session, not about the person.",
  not_assessed: "This was not assessed in the session.",
});

export const COVERAGE_LANGUAGE = Object.freeze({
  strong_coverage: "Every element of what would establish this was asked about and answered with usable evidence, including at least one follow-up.",
  partial_coverage: "The core of it was answered with usable evidence; some of what would establish it was not reached or not usable.",
  limited_coverage: "Only one element yielded usable evidence, or the item was interrupted.",
  no_usable_evidence: "Nothing usable was obtained for this item.",
});
