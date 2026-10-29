// eligibility.mjs — the must-have gate for client mandates. Binary, deterministic, never scored,
// never a model.
//
// WHY. The mandate score is additive, so a candidate can score zero on a hard must-have and still
// finish near the top. A ranking is a reading order; a client's written must-haves need a gate.
//
// THREE RULES.
//
//   1. NOBODY IS DELETED. This returns a verdict per person. It never filters a list. The board keeps
//      every applicant and the client filters, so loosening a band needs no re-run and no re-score.
//
//   2. UNKNOWN IS NOT FAIL. A question nobody asked is not a failure by the person. It is a hole in
//      what we collected, and it is reported as ours.
//
//   3. A CRITERION WE CANNOT ANSWER IS DECLARED, NOT APPROXIMATED. A brief asking for "3+ years
//      building production web frontends" is not answered by "total years of professional experience":
//      a 6-year backend engineer and a 6-year frontend engineer answer that identically, so the column would look like a
//      filter and could not answer the question -- worse than not collecting it. Such a criterion is marked
//      `uncollectable` and CAN NEVER PRODUCE "meets". The gap shows up on the board instead of
//      hiding inside a number.
//
// A rule that does not recognise the value it is given returns "unknown" and records the value. It
// never guesses. An option string we have not seen before is a thing to go and look at, not a thing
// to resolve in favour of the candidate or against them.

/** @typedef {"pass"|"fail"|"unknown"|"uncollectable"} RuleState */

const text = (v) => String(v ?? "").trim();

/**
 * Build a rule from a set of recognised answers. Anything outside both lists is `unknown`.
 * Written this way so the option strings a rule understands are visible in the mandate, and an
 * unrecognised one is loud rather than silently sorted.
 */
export const oneOf = ({ passes = [], fails = [], blocks = [] }) => (value) => {
  const v = text(value).toLowerCase();
  if (!v) return { state: "unknown", why: "not answered" };
  // BLOCKS ARE CHECKED FIRST and that ordering is load-bearing. For an answer like "B.Com (dropped out)",
  // a passes-first rule sees "b.com" and clears somebody who has no degree.
  if (blocks.some((b) => v.includes(b))) return { state: "fail", why: `answered "${text(value)}"` };
  if (passes.some((p) => v.includes(p))) return { state: "pass", why: `answered "${text(value)}"` };
  if (fails.some((f) => v.includes(f))) return { state: "fail", why: `answered "${text(value)}"` };
  return { state: "unknown", why: `unrecognised answer "${text(value)}"` };
};

/** At least one of these tools, named by the person themselves. */
export const namesAnyOf = (tools) => (value) => {
  const v = text(value).toLowerCase();
  if (!v) return { state: "unknown", why: "not answered" };
  const hit = tools.filter((t) => v.includes(t));
  return hit.length
    ? { state: "pass", why: `named ${hit.join(", ")}` }
    : { state: "fail", why: `named none of ${tools.join(", ")}` };
};

/** A number at or above a floor. A non-numeric answer is unknown, never zero. */
export const atLeast = (n) => (value) => {
  const num = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num) || !String(value ?? "").trim()) return { state: "unknown", why: "not answered" };
  return num >= n
    ? { state: "pass", why: `${num} >= ${n}` }
    : { state: "fail", why: `${num} < ${n}` };
};

/**
 * A criterion the client wrote that our form cannot answer. Always uncollectable, and the `reason`
 * is written to be read by us, not by the candidate: it says what we would have to ask instead.
 */
export const cannotAnswer = (reason) => () => ({ state: "uncollectable", why: reason });

/**
 * Evaluate one candidate against one mandate's eligibility block.
 *
 * @param {object} mandate  an entry from MANDATES
 * @param {Record<string, unknown>} answers  factKey -> what the person wrote
 * @returns {{verdict:"meets"|"fails"|"unknown", rows:Array, failed:string[], missing:string[]}}
 */
export function evaluateEligibility(mandate, answers = {}) {
  const rules = Array.isArray(mandate?.eligibility) ? mandate.eligibility : [];
  const rows = rules.map((r) => {
    const value = r.fact ? answers[r.fact] : undefined;
    let out;
    try {
      out = r.test(value);
    } catch (err) {
      // A throwing rule must not read as a pass. Fail closed to unknown and say so.
      out = { state: "unknown", why: `rule errored: ${String(err?.message || err).slice(0, 80)}` };
    }
    const state = ["pass", "fail", "unknown", "uncollectable"].includes(out?.state) ? out.state : "unknown";
    return { key: r.key, criterion: r.criterion, fact: r.fact || null, column: r.column || null,
             state, why: out?.why || "", value: value === undefined ? null : text(value) || null };
  });

  const failed = rows.filter((r) => r.state === "fail").map((r) => r.key);
  const missing = rows.filter((r) => r.state === "unknown" || r.state === "uncollectable").map((r) => r.key);
  // Order matters. A stated failure beats an unanswered question: somebody who told us they work
  // inbound has answered the criterion, whatever else is blank.
  const verdict = failed.length ? "fails" : missing.length ? "unknown" : "meets";
  return { verdict, rows, failed, missing };
}

/**
 * The line that goes at the top of a client board.
 * It reports the unknowns separately because "9 of 58 meet your must-haves" and "9 meet, 12 we never
 * asked" are different facts, and collapsing them is how a hole in our form reads as a thin market.
 */
export function eligibilitySummary(results = []) {
  const n = results.length;
  const meets = results.filter((r) => r.verdict === "meets").length;
  const unknown = results.filter((r) => r.verdict === "unknown").length;
  const fails = results.filter((r) => r.verdict === "fails").length;
  return { total: n, meets, unknown, fails,
    line: `${n} applied · ${meets} meet the stated must-haves · ${unknown} we cannot tell · ${fails} do not` };
}
