// prompts/pairwise-rank.mjs — which of these two roles is the better use of this person's next
// application? One question, two options, one letter back.
//
// WHY PAIRWISE AND NOT A SCORE. Asking a model for a calibrated 0-100 number asks it to do the thing
// it is worst at: in practice the scores collapse onto a handful of values, and most of everything
// above the bar carries the IDENTICAL number. Charlie sends one role per person per day and picks it
// off the top of that list, so without a real order the most important decision in the product is
// close to a coin toss among a near-total tie.
//
// A comparison is a different question and models are markedly better at it. It is also the question
// the product actually needs: not "is this a 72" but "of these two, which one do I send".
//
// THE RUBRIC IS DELIBERATELY SHORT. A long one invites the model to invent tie-breakers ("more
// prestigious", "better culture") that are not in either posting and not in the person's record. The
// only permitted grounds are the ones both sides genuinely have: what the role asks for versus what
// this person has actually done.

export const PAIRWISE_SYSTEM = `You compare two job postings for ONE person and say which is the better use of their next application.

Reply with a single character and nothing else: "A" or "B".

Judge on exactly these, in this order:
1. How much of what the role ASKS FOR this person has actually DONE. Evidence in their record beats a keyword in the title.
2. Whether the level fits the work they have really been doing. A stretch is fine; a role they would be screened out of on day one is not.
3. Whether the day-to-day work resembles work they have already done well.

Ignore company fame, funding, perceived prestige, and anything not present in the two postings or the person's record. If you find yourself preferring a role because you have heard of the company, choose on the evidence instead.

If the two are genuinely equal on all three, reply "A".

Never explain. Never output anything but a single A or B.`;

/**
 * The user turn: the person, then the two roles. Kept compact on purpose — this runs O(n log n) times
 * per person, so every token is paid for repeatedly.
 *
 * The person's block comes FIRST and is identical across every comparison for that person, which is
 * what makes it cacheable (same discipline as fit-coverage.mjs: stable prefix, volatile suffix).
 */
export function buildPairwiseUser({ person, a, b }) {
  const role = (r, label) =>
    `### ROLE ${label}\n${r.title || "?"} at ${r.company || "?"}\n${r.location ? `Location: ${r.location}\n` : ""}${String(r.description || "").slice(0, 1200)}`;
  return `## THE PERSON\n${person}\n\n${role(a, "A")}\n\n${role(b, "B")}\n\nWhich is the better use of their next application? Reply A or B.`;
}

/** A compact, stable description of the person. Same string for every comparison in one pass. */
export function personBlock(dossier) {
  const d = dossier || {};
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n).map((x) => (typeof x === "string" ? x : x?.claim || "")).filter(Boolean) : []);
  return [
    d.headline ? `Headline: ${d.headline}` : "",
    Number.isFinite(Number(d.professional_years)) ? `Years: ${d.professional_years}` : "",
    list(d.strengths, 6).length ? `Strengths: ${list(d.strengths, 6).join("; ")}` : "",
    list(d.proof_points, 8).length ? `Has actually done: ${list(d.proof_points, 8).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}
