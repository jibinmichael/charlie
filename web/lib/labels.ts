// Letter case is the app's, never the model's: every chip and label renders through labelCase, every name through
// personName.

/**
 * Letter case for a chip or a label, one rule everywhere so a model's spelling never reaches the
 * screen: the first letter is a capital, and an initialism is written its one way (b2b → B2B,
 * saas → SaaS, ai → AI) wherever it falls in the label. Nothing else about the words changes.
 */
const INITIALISMS = [
  "B2B",
  "B2C",
  "B2B2C",
  "D2C",
  "SaaS",
  "PaaS",
  "IaaS",
  "AI",
  "ML",
  "LLM",
  "NLP",
  "API",
  "APIs",
  "SDK",
  "SQL",
  "ETL",
  "UX",
  "UI",
  "PM",
  "GTM",
  "KPI",
  "KPIs",
  "OKR",
  "OKRs",
  "CRM",
  "ERP",
  "HR",
  "QA",
  "SEO",
  "SEM",
  "ROI",
  "ARR",
  "MRR",
  "NPS",
  "SMB",
  "SME",
  "SMEs",
  "iOS",
  "AWS",
  "GCP",
  "CEO",
  "CTO",
  "CPO",
  "COO",
  "CFO",
  "VP",
  "SVP",
  "EVP",
  "GM",
  "MBA",
  "PhD",
  "IIT",
  "IIM",
  "NIT",
  "BITS",
  "P&L",
  "R&D",
  "M&A",
  "USA",
  "US",
  "UK",
  "EU",
  "EMEA",
  "APAC",
  "IT",
  "DevOps",
  "MLOps",
  "FinOps",
]
const INITIALISM = new Map(INITIALISMS.map((w) => [w.toLowerCase(), w]))
export function labelCase(s: string): string {
  const t = String(s ?? "")
  if (!t) return t
  const fixed = t.replace(/[A-Za-z0-9&]+/g, (w) => INITIALISM.get(w.toLowerCase()) ?? w)
  return fixed.charAt(0).toUpperCase() + fixed.slice(1)
}

/** A person's name as shown: every part starts with a capital, the rest as recorded. */
export function personName(
  name: string | null | undefined,
  fallback = "Name not recorded",
): string {
  const t = String(name ?? "").trim()
  if (!t) return fallback
  return t
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
