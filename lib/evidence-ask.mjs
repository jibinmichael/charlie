// evidence-ask.mjs — which question to put to a person, in the vocabulary of their own work.
//
// WHY THIS IS A TABLE AND NOT A MODEL CALL. There are eight role families and one question each. A
// model would cost money per person, could not be reviewed before it went out, and would occasionally
// invent a question about a job somebody does not do. A table is readable, testable, and the same
// every time.
//
// EVERY QUESTION ASKS FOR A THING THAT EXISTS, never for a self-assessment. "What did the number go
// from and to" is answerable and checkable. "What are your strengths" is an invitation to write
// marketing copy about oneself, which is the exact material this product refuses to trade in.
//
// THE FALLBACK IS DELIBERATELY THE WEAKEST ONE, and it is used when the role family is unknown or
// unclassified rather than being guessed at. A slightly generic question to somebody we cannot place
// is honest; a confidently product-flavoured question to a recruiter is not.

/** The question, per family. Keys match `familyOf` below. */
export const EVIDENCE_QUESTION = {
  design: "One piece of work you are proud of. A case study, a link, or just the story: what the problem was, what you changed, and what happened after.",
  product: "One thing you shipped that you would defend in a room. What it was, what you decided, and the number that moved because of it.",
  customer: "One account you grew, saved, or lost and learned from. Which account, what you did, and what it was worth.",
  infra: "One system you actually ran in production. What it was, roughly what it handled, and one thing that broke and what turned out to be causing it.",
  engineering: "One thing you built that is still running. What it does, what constraint you were under, and how you know it works.",
  data: "One piece of analysis or one model that changed a decision. What the question was, what you found, and what somebody did differently.",
  marketing: "One campaign or piece of work that moved a number. What you ran, who it was for, and what the number went from and to.",
  other: "One piece of work you are proud of, in your own words. What it was, what you did, and what changed because of it.",
};

/**
 * The person's role family, from their stored role_family and title.
 *
 * PURE and deliberately ordered: `design` is tested before `product` because "product designer"
 * contains both, and a product designer asked the product-manager question is the failure this whole
 * file exists to avoid. Same reason `infra` precedes the broader `engineering`.
 */
export function familyOf(row) {
  const s = `${row?.role_family || ""} ${row?.current_title || ""}`.toLowerCase();
  if (/design/.test(s)) return "design";
  // Bare /product/ is safe ONLY because design is tested above: "Product Designer" contains both, and
  // a product designer asked the shipping-and-metrics question is the exact mistake this file exists
  // to avoid. A narrower pattern ("product manage|product owner|product lead") would send Product
  // Head, Product Associate or Director of Product & Technology to the generic fallback, a worse
  // question asked of people we can plainly place.
  if (/product|\bpm\b|\bapm\b/.test(s)) return "product";
  if (/customer success|account manage|\bcsm\b|client partner|client engagement|client success|account executive|relationship manager/.test(s)) return "customer";
  // "site reliability" spelled out, not just the acronym: people write their titles out, and an
  // abbreviation-only pattern sends every Site Reliability Engineer to the generic question.
  if (/devops|\bsre\b|site reliability|cloud|infra|platform engineer|systems? engineer/.test(s)) return "infra";
  if (/engineer|developer|software|full.?stack|frontend|backend|\bqa\b/.test(s)) return "engineering";
  if (/data|analyst|scientist|analytics/.test(s)) return "data";
  if (/market|growth|content|brand|communications/.test(s)) return "marketing";
  return "other";
}

/** The question to put to this person. Never empty. */
export function evidenceQuestionFor(row) {
  return EVIDENCE_QUESTION[familyOf(row)] || EVIDENCE_QUESTION.other;
}
