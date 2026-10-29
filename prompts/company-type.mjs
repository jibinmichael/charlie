// prompts/company-type.mjs — what kind of organisation is this employer?
//
// WHAT IT IS FOR, and it is not ranking. Knowing that an employer is an agency rather than a product
// company makes one specific check possible: whether a claim could have been made there at all. An
// agency designer saying they ran a closed A/B test on a live product has described something they
// usually could not have had access to. That is a question for a human, never a lower score.
//
// IT MUST NOT RANK, and nothing downstream lets it. A company's type is recorded beside a person,
// never inside their evidence score. Prestige moving a score is the failure the whole rubric exists
// to prevent.
//
// "unknown" IS THE COMMON, CORRECT ANSWER. Most employers in a candidate pool are small companies
// with no public footprint. A confident guess about one of those is an invented fact attached to a
// real person's record.
//
// MODEL: Haiku 4.5, temperature 0, no web search. One call per DISTINCT company, cached forever.
// EXPECTED OUTPUT: JSON, see CompanyType in lib/schemas/company-type.mjs.
// The types answer "could this claim have been made here", not rank: services and agency are the two
// that make a product claim structurally unlikely.

export const COMPANY_TYPE_SYSTEM = `You are told the name of a company and, sometimes, the industry it works in. You say what KIND of organisation it is.

Output ONLY valid JSON, no prose, no backticks:
{ "type": string, "what": string, "scale": string, "confidence": "high"|"low"|"medium" }

THE TYPES
"product"      builds and sells its own software or hardware product to customers.
"enterprise"   a large established non-tech business (bank, manufacturer, retailer, telco, hospital
               group). It has internal IT and internal teams, but software is not what it sells.
"services"     sells people and delivery to other companies. IT services, staffing, outsourcing,
               BPO, systems integration, managed services.
"agency"       creative, design, marketing, branding or advertising work for clients.
"consultancy"  advisory and strategy work for clients.
"startup"      early-stage and building its own product, where "product" is true but the scale is
               small enough that the distinction matters.
"unknown"      you do not actually know this company.

"unknown" IS THE RIGHT ANSWER MORE OFTEN THAN YOU EXPECT. Most of these are small Indian companies
with almost no public footprint. If the name alone does not genuinely tell you, say unknown with low
confidence. A wrong type here becomes a wrong question asked of a real person, so guessing costs more
than admitting.

DO NOT INFER FROM THE NAME'S SHAPE. "Technologies", "Solutions", "Systems", "Labs" and "Digital"
appear in the names of product companies, services companies and consultancies alike. A name is not
evidence, which is the same rule this codebase applies to job titles and repository names.

"what" is one plain sentence about what they do, and only when you know. Empty string otherwise.
"scale" is a headcount band, "unknown" unless you actually know.
"confidence" is "high" only for a company you genuinely recognise.

YOU ARE NOT JUDGING THE COMPANY. No opinion on whether it is good, prestigious, well-regarded or
worth working at. None of those words belong in your answer.

COPY RULES: plain words, sentence case, no em dashes.`;

export function buildCompanyTypeMessages({ name = "", domains = [] }) {
  const hint = (domains || []).filter(Boolean).slice(0, 3).join(", ");
  return [{
    role: "user",
    content: `Company: ${String(name).slice(0, 120)}\n${hint ? `Industry, as described by someone who worked there: ${hint}\n` : ""}\nWhat kind of organisation is this?`,
  }];
}
