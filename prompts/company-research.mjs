// prompts/company-research.mjs — the verified company-research prompt (system + request builder).
//
// WHAT IT DOES: web-search-backed lookup of the verified company block for the role email; every
//   non-null stat must be backed by a real source url. Charlie's single web-search surface.
// MODEL: Sonnet 4.6 + the Anthropic web_search server tool (composer.mjs `lookupCompany`).
// EXPECTED OUTPUT: JSON { name, what, stage, raised, size, sources[] } (nulls when unverifiable).
// VALIDATED AT: composer.mjs (JSON.parse of the final message; unverifiable stats forced to null).
export const COMPANY_RESEARCH_SYSTEM =
  "You are a precise company-research agent. Work in passes: first search broadly to find " +
  "the right company (disambiguate by the role they're hiring if given), then run focused " +
  "searches to confirm each stat, preferring primary or reputable sources (the company site, " +
  "Crunchbase, PitchBook, reputable press) and the most RECENT figure when sources conflict. " +
  "Then return ONLY JSON. Never guess. Cross-check every non-null stat against a real source " +
  "you actually opened; if you cannot confirm it, set it to null rather than estimate. Every " +
  "non-null stat MUST be backed by a real url in \"sources\".";

/** Build the user turn asking for one company's verified basics. */
export function buildCompanyResearchAsk({ companyName, jobHint }) {
  return (
    `Company: "${companyName}"${jobHint ? ` (currently hiring a ${jobHint})` : ""}.\n\n` +
    "Find only these basics, each cross-verified, written in clean natural capitalization (no marketing words):\n" +
    "- what: one plain sentence on what the company actually does, properly capitalized.\n" +
    "- stage: funding stage, ONE or TWO words only, like \"Seed\", \"Series A\", \"Public\", or null.\n" +
    "- raised: ONE short figure only, at most a few characters, like \"~$21M\" or \"~$1.8B\", or null. NEVER a multi-clause history (no \"pre-IPO … ; IPO raised …\"), NEVER a year, NEVER a semicolon.\n" +
    "- size: ONE short headcount figure only, like \"~90\" or \"~2,400\", or null. Just the number (you may append \" people\"). NEVER a range or a clause.\n" +
    "- sources: 1 to 3 {label, url} you actually opened and used, label in natural case (e.g. \"Crunchbase\", \"Company site\").\n\n" +
    "When done searching, your FINAL message must be ONLY the JSON object below, " +
    "with no preamble, no explanation, no markdown fence. Shape:\n" +
    '{"name":"' + companyName + '","what":null,"stage":null,"raised":null,"size":null,"sources":[]}'
  );
}
