// claim-context.mjs — could this claim have been made where they say they made it?
//
// PURE, NO MODEL, AND THAT IS THE POINT. This raises a QUESTION about a real person, so it has to be
// reproducible and arguable in one reading. A model deciding somebody's story is implausible is the
// worst possible owner of this judgement.
//
// IT PRODUCES A QUESTION, NEVER A SCORE, AND NEVER A REJECTION. Agencies embed with clients. Services
// engineers get production access. Contractors ship features. Every pairing below is UNUSUAL, not
// impossible, and the honest output is "worth asking about", which is what an interview is for.
//
// IT NEEDS BOTH SIDES OR IT SAYS NOTHING. No company type, or no claim, means no flag. A missing
// company_type is "we have not classified this employer", never "this employer is suspicious".

/**
 * Claims that are structurally unlikely at a client-services organisation, with the reason stated in
 * the same breath. The reason is what a human reads; the pattern is only how we found it.
 */
const AT_SERVICES_OR_AGENCY = [
  { re: /\b(a\/b test|ab test|split test|multivariate test)\w*\b/i,
    why: "running a live A/B test needs production access to a product you do not own" },
  { re: /\b(owned|own) the (product )?roadmap\b|\bset the roadmap\b/i,
    why: "owning a roadmap is a client-side decision that agencies and services vendors rarely hold" },
  { re: /\b(p&l|profit and loss)\b.{0,30}\b(owned|ownership|carried)\b|\bowned the p&l\b/i,
    why: "carrying a P&L is unusual outside the company whose revenue it is" },
  { re: /\b(retention|churn|activation|dau|mau)\b.{0,40}\b(improved|increased|reduced|moved|drove)\b/i,
    why: "moving a product metric requires ownership of the product it belongs to" },
  { re: /\bshipped to (production|prod)\b|\bdeployed to production\b/i,
    why: "shipping to production is normally the client's release process, not the vendor's" },
];

/** And the reverse: a claim that fits a services shop, made at a product company, is not odd at all. */
const TYPES_THAT_TRIGGER = new Set(["services", "agency", "consultancy"]);

/**
 * @param {{companyType?: string|null, companyName?: string, text?: string}} input
 * @returns {Array<{claim: string, why: string, question: string}>} empty when nothing to ask
 */
export function claimContextFlags({ companyType = null, companyName = "", text = "" } = {}) {
  const type = String(companyType || "").toLowerCase();
  const body = String(text || "");
  // Both halves required. Unknown company type means unclassified, not suspicious.
  if (!TYPES_THAT_TRIGGER.has(type) || !body.trim()) return [];

  const where = companyName ? ` at ${companyName}` : "";
  const out = [];
  for (const { re, why } of AT_SERVICES_OR_AGENCY) {
    const m = body.match(re);
    if (!m) continue;
    // The verbatim span, so a human sees what triggered it rather than trusting the pattern.
    const at = body.indexOf(m[0]);
    const claim = body.slice(Math.max(0, at - 60), at + m[0].length + 60).replace(/\s+/g, " ").trim();
    out.push({
      claim,
      why: `${why}, and ${companyName || "this employer"} is classified as ${type}`,
      question: `Ask how they got access to do this${where}. There is usually a good answer.`,
    });
  }
  // One question per person is a conversation. Five is an interrogation, and it reads as an accusation.
  return out.slice(0, 2);
}
