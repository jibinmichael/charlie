// market-report.mjs — "State of Your Market": a grounded, code-computed market briefing for ONE
// person, built from the LIVE job pool + their dossier. This is the reusable MECHANISM: give it an
// email, it returns a fully-derived report object (funnel, seniority pyramid, geo split, the domains
// where the person has proven GRAVITY vs the market's live demand, disclosed comp reality, the single
// best-grounded standout role, and where the market asks for what the dossier doesn't yet show).
//
//   import { buildMarketReport } from "./market-report.mjs";
//   const report = await buildMarketReport("someone@example.com");
//
// GROUNDING: every number here is COUNTED off the live pool + the person's stored dossier.
// Nothing is invented, inflated, or upgraded. Classification is deterministic keyword matching — no
// model call, no LLM in the fact path. The editorial COPY layer (render-market-report.mjs) only frames
// these facts; it never adds one. Fail-closed: a person with no dossier / an empty pool returns a report
// whose counts are honestly zero, never a fabricated market.
//
// Reachability + relevance reuse the SAME select-jobs.mjs seam the daily send uses, so "your market"
// in the briefing is exactly the market the matcher actually draws from — no second, looser definition.

import { loadEnv, getCandidate, loadJobPool } from "./charlie-store.mjs";
import { selectForUser, userSignals } from "./select-jobs.mjs";
import { coverageDomains, chartPlan } from "./lib/gap-chart.mjs";
import { seniorityChasm } from "./quality-gate.mjs"; // the send gate's level stop, on the spotlight too
import { parseComp } from "./lib/pay.mjs"; // ONE money parser; lives in lib/ so the send gate can use it too

// Re-exported so this module's existing callers and tests keep importing it from here. The definition
// moved to lib/pay.mjs because quality-gate.mjs needs it to honour a person's stated pay floor, and this
// file already imports quality-gate.mjs — importing back would be a cycle.
export { parseComp };

// Seniority tiers, most-senior first. A title is placed in the FIRST tier whose pattern it matches, so
// "Senior Director" lands in director (not senior) and "Head of Product" in exec. Order matters.
//
// LABELS ARE TRACK-AGNOSTIC. The chart is rendered for every user, so a rung names a LEVEL, never a
// job family: a QA engineer or a designer must never see a rung called "Product Manager" (which would
// usually be their LARGEST bar, since the catch-all tier is every title with no seniority word in it).
const TIERS = [
  { key: "exec", label: "VP / Head of", re: /\b(chief|cpo|vp|vice president|svp|evp|head of)\b/i },
  { key: "director", label: "Director", re: /\bdirector\b/i },
  { key: "principalStaff", label: "Principal / Staff", re: /\b(principal|staff|distinguished)\b/i },
  { key: "senior", label: "Senior / Lead", re: /\b(senior|sr\.?|lead)\b/i },
  { key: "apm", label: "Entry / Associate", re: /\b(associate|apm|intern|junior|jr\.?|entry|new ?grad|graduate)\b/i },
  { key: "ic", label: "Mid-level", re: /.*/ }, // fallthrough: a title with no seniority word in it
];
function tierOf(title) {
  const t = String(title || "");
  for (const tier of TIERS) if (tier.re.test(t)) return tier.key;
  return "ic";
}

// The person's OWN line on the ladder — which rung the letter says they stand on, and the anchor the
// renderer windows the chart around. Two sources, in order:
//
//   1. an explicit level in THEIR OWN words (stated seniority, target role, headline), read in BOTH
//      directions, so an intern, fresher or entry-level person is placed at their own rung rather
//      than defaulted to "senior".
//   2. no explicit level -> the GROUNDED `professional_years` off the dossier (real dated employment
//      only; a current student is 0, per dossier.md). Years may place someone AT MOST at "senior":
//      a long tenure is not a claim to Principal or Director, and inferring one would UPGRADE them.
//      Unknown years with no stated level lands at "ic", the honest middle — understating is
//      recoverable, overstating is the thing we never do.
//
// "Chief of Staff" and "Account Executive" are deliberately NOT exec: they are the two titles that
// carry a C-suite word while naming an ordinary role, and both are common in the user base. "Chief of
// Staff" has to be excluded TWICE — the bare `staff` in it also reads as the Staff-engineer rung —
// so the level word is only counted when it is not the tail of "of staff".
const SELF_EXEC = /\bchief\b(?! of staff)|\b(cpo|cto|coo|ceo|cfo|vp|svp|evp|vice president|head of)\b/i;
const SELF_DIRECTOR = /\bdirector\b/i;
const SELF_PRINCIPAL = /\bprincipal\b|(?<!of )\bstaff\b/i;
const SELF_ENTRY = /\b(intern|internship|fresher|entry.?level|graduate|new ?grad|trainee|apprentice|student|junior|jr\.?|associate|early.?career)\b/i;
const SELF_SENIOR = /\b(senior|sr\.?|lead)\b/i;
const SELF_MID = /\bmid.?level\b/i;
// Years the person states in their OWN words ("with 9+ years in grocery retail", "roughly 11 years in river
// surveys"). Read verbatim, never inferred — the headline is their own grounded text, so this is the
// same claim they already make about themselves. It is the FALLBACK to the structured
// professional_years, which older dossiers lack: without it a 16-year fleet operations manager and a 14-year
// water-treatment compliance officer would both sit at "Mid-level".
const YEARS_SAID = /\b(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years|yrs|year)\b/i;
function yearsSaid(text) {
  const m = String(text || "").match(YEARS_SAID);
  return m ? Number(m[1]) : null;
}

/**
 * Where this person stands, grounded in their own words first and their dated employment second.
 * Pure + exported so the classifier itself is testable against inputs production can produce, not
 * a hand-set tier.
 * @param {object} dossier
 * @returns {"exec"|"director"|"principalStaff"|"senior"|"ic"|"apm"}
 */
export function levelOf(dossier) {
  const d = dossier || {};
  const prefs = d.preferences || {};
  const said = `${prefs.seniority || ""} ${prefs.role || ""} ${d.headline || ""}`;
  if (SELF_EXEC.test(said)) return "exec";
  if (SELF_DIRECTOR.test(said)) return "director";
  if (SELF_PRINCIPAL.test(said)) return "principalStaff";
  if (SELF_ENTRY.test(said)) return "apm";
  if (SELF_SENIOR.test(said)) return "senior";
  if (SELF_MID.test(said)) return "ic";
  const yrs = typeof d.professional_years === "number" ? d.professional_years : yearsSaid(said);
  if (yrs == null) return "ic";
  if (yrs < 2) return "apm";
  if (yrs < 5) return "ic";
  return "senior"; // years alone never buy a rung above senior
}

// TOPICS — what this person covers and what their market keeps asking for. DERIVED per person; there
// is deliberately no taxonomy here.
//
// A fixed bucket list (platform, AI, data, fintech, ...) can only describe the tracks it was written
// for: a QA engineer read against a product vocabulary gets "strengths" that are whatever their resume
// collides with, never quality engineering. So both sides are read off real text:
//   - MARKET side: the words in the TITLES of the roles this person can actually reach. A title names
//     what a role IS. The JD body does not — its prose mentions "data" / "platform" / "security" in
//     passing constantly, which is why the job side reads title + team + segment (jobLabel)
//     and never the description.
//   - PERSON side: userSignals(dossier).terms, the SAME grounded vocabulary the daily pre-filter ranks
//     on (their stated target, strengths, tech, values, headline). Reusing that seam means "what you
//     cover" in the briefing is what the matcher already believes about them, not a second and looser
//     definition — the same reason this file reuses selectForUser for the job set.
//
// A term earns a row only when it is INFORMATIVE FOR THIS PERSON: it must appear in at least
// TOPIC_MIN_DF of their reachable roles (below that it is noise, not a market signal) and in no more
// than TOPIC_MAX_SHARE of them (a word in nearly every title — "engineer" for an engineer — separates
// nothing). That document-frequency band is what replaces the hardcoded list: it adapts to whoever is
// reading, with no per-track vocabulary for anyone to maintain. Level words are dropped because the
// ladder chart above already covers those, and the level regexes are reused rather than restated.
// A frequency band alone is not enough. Job titles are built from two kinds of word: TOPIC words
// ("automation", "recruiting", "figma") and STRUCTURE words ("engineer", "software", "manager",
// "years"). A band keeps both, so an engineer would be told their gap is "Engineering" and
// "Software". The separator is that structure words are common EVERYWHERE, while a real topic is
// over-represented in THIS person's market specifically. So each term is scored by LIFT — its share
// of the person's reachable titles over its share of the entire scanned pool. Lift needs no
// vocabulary: it is measured fresh against whatever the market is that morning, for whatever track
// the reader is in.
const TOPIC_MIN_DF = 3;        // in fewer than 3 of their roles -> noise
const TOPIC_MAX_SHARE = 0.6;   // in more than 60% of their roles -> separates nothing
const TOPIC_MIN_LIFT = 1.6;    // must be this much denser in their market than in the pool at large
const TOPIC_MIN_EMPLOYERS = 2; // must appear at 2+ employers -> one company's in-house word is not a market signal
const TOPIC_PER_SIDE = 5;      // rows per side of the diverging chart

// Pure structure words a title is built from. Not a topic vocabulary — no track, domain or skill is
// named here, and nothing is added to it per role type.
const TOPIC_STOP = new Set([
  "and", "or", "of", "the", "for", "with", "a", "an", "in", "at", "to", "on", "amp",
  "remote", "hybrid", "onsite", "full", "part", "time", "contract", "permanent",
  "i", "ii", "iii", "iv", "job", "role", "opening", "hiring", "we", "you", "our",
  "year", "years", "new", "experience", "exp",
  // Words a job TITLE is built from, which name the shape of the job and never a capability.
  // Without these, "Management" (the second word of every "Product Management" posting) reads as a
  // PM's spike and "Owner" ("Product Owner", a synonym for their own job) as a gap.
  // domain or skill, so no capability can be filtered out by this list.
  // TRACK words (engineer, designer, analyst) are deliberately NOT here: an existing test asserts a
  // designer's read surfaces design words and a QA engineer's surfaces QA words. Only the words that
  // describe a title's STRUCTURE are removed.
  "product", "products", "management", "manager", "managers", "owner", "ownership",
  "team", "teams", "department", "division", "position",
]);
const LEVEL_RES = TIERS.filter((t) => t.key !== "ic").map((t) => t.re); // "ic" is the catch-all /.*/
const isLevelWord = (t) => LEVEL_RES.some((re) => re.test(t));

// Tokenize a job label into candidate terms, KEEPING the posting's own spelling so the chart can print
// "QA" and "SaaS" the way the market writes them. Grounded: never a casing or a word we invented.
function titleTerms(label) {
  const out = [];
  for (const raw of String(label || "").match(/[A-Za-z][A-Za-z0-9+#]*/g) || []) {
    const t = raw.toLowerCase();
    if (t.length < 2 || TOPIC_STOP.has(t) || isLevelWord(t)) continue;
    out.push([t, raw]);
  }
  return out;
}

// Count, per term, how many of these roles name it in their TITLE — plus the spellings the market
// actually used, so the label can be printed the market's way rather than ours.
function termCounts(list) {
  const df = new Map(); // term -> { n, casings: Map<spelling, count>, examples }
  for (const j of list) {
    const seen = new Set(); // one vote per role, so a repeated word cannot inflate its own count
    for (const [t, raw] of titleTerms(j.title)) {
      const e = df.get(t) || { n: 0, casings: new Map(), examples: [] };
      e.casings.set(raw, (e.casings.get(raw) || 0) + 1);
      if (seen.has(t)) continue;
      seen.add(t);
      e.n++;
      if (e.examples.length < 4) e.examples.push({ company: j.company, title: j.title });
      df.set(t, e);
    }
  }
  return df;
}
// The spelling the market uses most for this term. Counting beats a casing rule: it prints "QA" and
// "UX" because that is how postings write them, and it does not print a stray ALL-CAPS title's
// "BACKEND" because that spelling is rare (the voice rule: never ALL CAPS).
const modalCasing = (casings) => [...casings.entries()].sort((a, b) => b[1] - a[1])[0][0];

// Does the person's own vocabulary cover this term? Compared on a shared prefix, not equality, so a
// word and its ordinary variant count as the same thing: someone whose target says "engineer" is not
// told that "Engineering" is a gap, and "developer" covers "development", "design" covers "designer",
// "test" covers "testing". This deliberately errs toward COVERED — a false "you have this" is a mild
// overlap claim the count still supports, while a false "you are quiet on this" tells a person their
// own core skill is missing, which is the worse failure.
function covers(mine, term) {
  if (mine.has(term)) return true;
  for (const t of mine) {
    const need = Math.min(5, t.length, term.length);
    if (need >= 4 && t.slice(0, need) === term.slice(0, need)) return true;
  }
  return false;
}

/**
 * The person's topic rows: what their own words cover (`evidenced`) and what their market asks for
 * that they are quiet on, each with the number of THEIR reachable roles that name it.
 * Pure + exported so the derivation is testable without the store.
 * @param {any[]} jobs   the person's reachable roles (selectForUser output)
 * @param {object} dossier
 * @param {any[]} [pool] the whole scanned pool, for the lift baseline. Omitted -> no lift filter.
 */
export function topicsFor(jobs, dossier, pool) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return [];
  const sig = userSignals(dossier || {});
  const mine = termCounts(list);
  const all = Array.isArray(pool) && pool.length ? termCounts(pool) : null;
  const poolSize = all ? pool.length : 0;
  // A capability shows up at MORE THAN ONE employer. A word confined to a single company's postings is
  // that company's own vocabulary, not a market signal: e.g. "Auth0" lifted out of Okta's "Principal
  // Group Product Manager, B2B (Auth0)". A company-name denylist cannot catch that, because Auth0 is a
  // PRODUCT Okta sells and never appears in the `company` field; requiring two independent employers
  // catches it and every other in-house codename for free, with no list to maintain.
  const employers = new Map(); // term -> Set(company)
  const allEmployers = new Set();
  for (const j of list) {
    const co = String(j?.company || "").trim().toLowerCase();
    if (!co) continue;
    allEmployers.add(co);
    for (const [t] of titleTerms(jobLabel(j))) {
      if (!employers.has(t)) employers.set(t, new Set());
      employers.get(t).add(co);
    }
  }
  // FAIL OPEN. The rule can only discriminate when the reachable set actually spans employers. Applied
  // unconditionally it empties the chart for anyone whose market clusters at one company (and for any
  // caller whose jobs carry no company at all) — a silent fail-to-zero. So it engages only when there
  // are employers to compare across.
  const employerRuleOn = allEmployers.size >= TOPIC_MIN_EMPLOYERS;

  const ceiling = Math.max(TOPIC_MIN_DF, Math.floor(list.length * TOPIC_MAX_SHARE));
  const rows = [];
  for (const [t, e] of mine) {
    if (e.n < TOPIC_MIN_DF || e.n > ceiling) continue;
    if (employerRuleOn && (employers.get(t)?.size || 0) < TOPIC_MIN_EMPLOYERS) continue; // one company's own word, not the market's
    if (all) {
      const globalShare = (all.get(t)?.n || 0) / poolSize;
      // A term absent from the wider pool is distinctive by definition, so guard the divide-by-zero
      // by treating it as maximally lifted rather than skipping it.
      const lift = globalShare > 0 ? e.n / list.length / globalShare : Infinity;
      if (lift < TOPIC_MIN_LIFT) continue;
    }
    const label = modalCasing(e.casings);
    rows.push({ key: t, label, flow: label, evidenced: covers(sig.terms, t), live: e.n, examples: e.examples });
  }
  rows.sort((a, b) => b.live - a.live);
  // Cap each side independently so one crowded side cannot squeeze the other off the chart.
  const yours = rows.filter((r) => r.evidenced).slice(0, TOPIC_PER_SIDE);
  const gaps = rows.filter((r) => !r.evidenced).slice(0, TOPIC_PER_SIDE);
  return [...yours, ...gaps].sort((a, b) => b.live - a.live);
}
// For TOPIC classification we read the discriminating STRUCTURED fields (title + team + segment), not
// the full description. A JD's prose mentions "data"/"platform"/"security" in passing constantly, which
// makes every domain near-universal and the tag meaningless; the title/team/segment name what the role
// actually IS. This keeps each domain count defensible ("why is a Platform role tagged security?" can't
// happen). The full description still feeds the person-side dossier read, where breadth is wanted.
const jobLabel = (j) => `${j.title || ""} ${j.team || ""} ${j.segment || ""}`;

// Extract a clean city from a posting's location ("Bengaluru, Karnataka, India" -> "Bengaluru";
// "San Francisco, CA" -> "San Francisco"). First comma/slash segment, minus obvious non-city tokens.
// Grounded: the name is the posting's own, nothing invented. Used for the region-agnostic geo split.
function cityOf(loc) {
  // Some boards prefix the country onto the city in one segment ("US - San Francisco"), which split
  // that city from its plainly-named twin and put both on the chart.
  const first = String(loc || "").split(/[,/|]/)[0].trim()
    .replace(/^(us|usa|u\.s\.?|india|uk|canada|australia)\s*[-–—]\s*/i, "").trim();
  if (!first || first.length > 40) return null;
  // Countries and work models are not cities. "United States" was reaching the chart as a bar of its own.
  if (/^(remote|anywhere|multiple locations?|various|flexible|global|worldwide|hybrid|on-?site|us|usa|u\.s\.?|uk|india|europe|emea|apac|north america|united states( of america)?|united kingdom|canada|australia)$/i.test(first)) return null;
  return first;
}

// Two postings can name the SAME place differently, and the geo chart counted each spelling as its own
// city: "Bangalore" and "Bengaluru" as separate bars would split a person's single biggest location
// in half and make remote look stronger by comparison. Whether two names are
// one city is world knowledge — no amount of counting reveals it — so this is a deliberately small,
// explicit table covering the markets Charlie serves, not a general gazetteer. The name we DISPLAY is
// still the market's own most common spelling for that place, never our preferred one.
const CITY_ALIASES = {
  bangalore: "bengaluru", "bengaluru urban": "bengaluru", "bangalore urban": "bengaluru",
  gurgaon: "gurugram",
  bombay: "mumbai",
  madras: "chennai",
  calcutta: "kolkata",
  trivandrum: "thiruvananthapuram",
  delhi: "new delhi",
  nyc: "new york", "new york city": "new york",
  sf: "san francisco",
};
const cityKey = (name) => {
  const k = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return CITY_ALIASES[k] || k; // lowercasing alone also merges plain case variants
};

// parseComp lives in lib/pay.mjs (imported and re-exported at the top of this file) so the send gate
// reads money with the SAME parser this briefing uses — two parsers would drift, and the one that
// drifted would be the one deciding whether a person's stated pay floor was honoured.

const INR_LAKH = 100000;

// Observed pay band from the disclosed roles ({job, comp:{currency,min,max}}). Picks the dominant currency
// (never mixes ₹ and $), returns the low, the high, and the median of the maxes. Grounded: every number is
// a real posted figure. Null when fewer than 3 roles disclose (too thin to call a band honestly).
const SANE_MIN = { INR: 100000, USD: 1000 }; // drop sub-lakh / sub-$1k garbage parses (e.g. "15" from "15 days")
export function observedRange(rows) {
  const clean = (rows || []).filter(
    (x) =>
      x.comp &&
      x.comp.currency &&
      Number.isFinite(x.comp.min) &&
      Number.isFinite(x.comp.max) &&
      x.comp.max >= x.comp.min &&
      x.comp.min >= (SANE_MIN[x.comp.currency] || 0),
  );
  if (clean.length < 3) return null;
  const byCcy = {};
  for (const x of clean) (byCcy[x.comp.currency] ||= []).push(x.comp);
  const [currency, list] = Object.entries(byCcy).sort((a, b) => b[1].length - a[1].length)[0];
  if (list.length < 3) return null;
  // Robust band: median-of-mins to median-of-maxes (one garbage parse can't drag it), plus the true
  // ceiling shown separately. Reads like an agent ("they land 15-25, top ones reach 35"), not a raw min-max.
  const mid = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const mins = list.map((c) => c.min);
  const maxs = list.map((c) => c.max);
  return { currency, lo: mid(mins), hi: mid(maxs), top: Math.max(...maxs), n: list.length };
}

/**
 * Build the full, grounded market report for one person.
 * @param {string} email
 * @param {{poolOverride?: any[], candidateOverride?: any}} [opts]  test seams
 */
// How many of the most-relevant reachable roles an injected fit-ranker may choose between. Small on
// purpose: each one a caller scores costs a coverage pass, and the tail is not worth the spend.
//
// The same passes are ALSO the substrate of the coverage gap chart, so the passes are SHARED, never
// doubled — the chart consumes what the standout ranker already computed.
const STANDOUT_SHORTLIST = Number(process.env.STANDOUT_SHORTLIST || 5);

// GAP_CHART — which chart the briefing actually renders.
//   keyword  (default) topicsFor + covers(), the 4-char prefix match
//   coverage           the pooled computeCoverage requirements (lib/gap-chart.mjs)
// Both charts are computed and logged side by side on every briefing so real output can be read
// before a flip, the same staging KNOCKOUT_MODE, GROUNDING_MODE and SENIORITY_GATE use: "the new path
// runs" is not "the new path is right".
export const gapChartMode = () => (String(process.env.GAP_CHART || "keyword").toLowerCase() === "coverage" ? "coverage" : "keyword");

/**
 * The two sides of the diverging chart, plus the wedge, derived from a row set. Both the keyword
 * chart and the coverage chart produce the SAME row contract, so this is the single place that
 * decides what counts as a strength, what counts as an ask, and how the wedge anchors — the two
 * charts can never drift apart on that.
 *
 * `minAsk` is the noise floor on the GAP side only, and it differs by chart because the two `live`
 * counts are different quantities. The keyword chart counts the person's whole reachable set (~80-150
 * roles), so 3 is a floor against stray words. The coverage chart counts postings out of the
 * shortlist, and its floor is already enforced upstream as "at least two independent employers"
 * (lib/gap-chart.mjs), so re-gating on a count here would double-charge it on the wrong scale.
 *
 * The asymmetry — a strength needs one, a gap needs more — is deliberate and is the same asymmetry
 * covers() documents: a false "you are quiet on this" tells a person their own core skill is
 * missing, which is the worse failure.
 */
export function chartSides(domains, empObj, { minAsk = 3 } = {}) {
  const rows = Array.isArray(domains) ? domains : [];
  const gravity = rows.filter((x) => x.evidenced && x.live > 0).sort((a, b) => b.live - a.live);
  const marketAsk = rows.filter((x) => !x.evidenced && x.live >= minAsk).sort((a, b) => b.live - a.live);
  const wedge =
    marketAsk[0] && empObj
      ? { employer: empObj.name, tenure: empObj.tenure || null, domain: marketAsk[0].label, flow: marketAsk[0].flow, live: marketAsk[0].live, employerNote: empObj.domain || null }
      : null;
  return { gravity, marketAsk, wedge };
}

export async function buildMarketReport(email, opts = {}) {
  const addr = String(email || "").trim().toLowerCase();
  const c = opts.candidateOverride || (await getCandidate(addr));
  if (!c) throw new Error(`no candidate for ${addr}`);
  const d = c.dossier || {};
  const prefs = d.preferences || {};
  const pool = opts.poolOverride || (await loadJobPool());

  // The person's reachable + relevant market — the SAME selection the daily matcher draws from.
  const sel = selectForUser(d, pool, 100000, {});
  const jobs = sel.jobs;

  // 1) Funnel. Three honest stages: everything scanned -> roles in the person's field (family match,
  // before the geo cut) -> roles they can actually reach. inField = reachable + those dropped only for
  // being out of reach / work-auth, i.e. the family-matching set the geo filter then narrowed.
  const companies = new Set(jobs.map((j) => j.company || "?"));
  const funnel = {
    scanned: pool.length,
    inField: jobs.length + sel.stats.unreachable + sel.stats.ineligible,
    unreachable: sel.stats.unreachable,
    addressable: jobs.length,
    companies: companies.size,
  };

  // 2) Seniority pyramid + where the person's own bar sits.
  const seniority = { exec: 0, director: 0, principalStaff: 0, senior: 0, ic: 0, apm: 0 };
  for (const j of jobs) seniority[tierOf(j.title)]++;
  const barTier = levelOf(d);
  // roles AT-OR-ABOVE the person's declared bar (the honest "how many are really at your level").
  const ORDER = ["exec", "director", "principalStaff", "senior", "ic", "apm"];
  const barIdx = ORDER.indexOf(barTier);
  const atOrAboveBar = ORDER.slice(0, barIdx + 1).reduce((n, k) => n + seniority[k], 0);

  // 3) Geo split — region-agnostic + grounded: a remote count plus the person's TOP actual cities by
  // role count. City names come straight from the postings (never a hardcoded hub), so this reads right
  // whether the person's market is Bengaluru, San Francisco, or London. `other` catches the long tail.
  let remoteCount = 0;
  const cityAgg = new Map(); // canonical key -> { n, spellings: Map<asPosted, count> }
  let placed = 0;
  for (const j of jobs) {
    const loc = String(j.location || "").trim();
    if (!loc) continue;
    if (/\bremote\b/i.test(loc)) { remoteCount++; continue; }
    const city = cityOf(loc);
    if (!city) continue;
    const e = cityAgg.get(cityKey(city)) || { n: 0, spellings: new Map() };
    e.n++;
    e.spellings.set(city, (e.spellings.get(city) || 0) + 1);
    cityAgg.set(cityKey(city), e);
    placed++;
  }
  const topCities = [...cityAgg.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((e) => ({ city: modalCasing(e.spellings), n: e.n }));
  const geo = { remote: remoteCount, cities: topCities, other: Math.max(0, placed - topCities.reduce((s, c) => s + c.n, 0)), total: jobs.length };

  // 4) Topics: what the person's own words cover vs what their market keeps asking for.
  // GRAVITY = topics the person has proven AND the market is hiring for, most-live first.
  // THE MARKET'S ASK = domains with real live volume the dossier does NOT yet evidence, most-live first.
  // Both sides come from chartSides so the coverage chart cannot diverge on what a strength is.
  // These are the KEYWORD chart. When GAP_CHART=coverage they are replaced below, after the ranker
  // seam has produced the coverage results the other chart is built from.
  const keywordDomains = topicsFor(jobs, d, pool);

  // 5) Comp reality — only what's DISCLOSED, never imputed.
  const floor = typeof prefs.comp_floor === "number" ? prefs.comp_floor : null;
  const floorCcy = prefs.comp_currency || null;
  const comped = jobs
    .map((j) => ({ job: j, comp: parseComp(j.compensation) }))
    .filter((x) => x.comp && x.comp.currency);
  const clearFloor =
    floor && floorCcy
      ? comped.filter((x) => x.comp.currency === floorCcy && x.comp.max >= floor).length
      : null;
  // Observed pay band — the REAL posted numbers from the disclosed roles, dominant currency only. This is
  // what lets the briefing SHOW the market's floor to a person who gave none of their own (the honest
  // "here is the number to answer" pull), instead of the weak "only N named pay" line. Grounded: every
  // figure is a posted number, nothing imputed. Null when too few roles disclose to speak to a band.
  // Scope the band to a WINDOW at the person's line — their rung and at most one above it.
  //
  // "At or above your line" would be the whole market for anyone at the bottom of the ladder, and
  // would tell an intern that senior pay is theirs. A window means the sentence is true for whoever
  // reads it. Too few disclosing inside the window -> observedRange returns null and the letter
  // simply does not speak to a band, rather than widening until it can say something.
  const atLevelComped = comped.filter((x) => {
    const i = ORDER.indexOf(tierOf(x.job.title));
    return i <= barIdx && i >= barIdx - 1;
  });
  const observed = observedRange(atLevelComped);
  const comp = {
    total: jobs.length,
    disclosed: comped.length,
    floor,
    floorCcy,
    clearFloor,
    observed,
  };

  // The WEDGE: the market's biggest ask the person is QUIET on, tied to where they actually worked. Never
  // an assertion they have it (grounding) — an invitation to claim it if they do, which is what makes a
  // reader feel seen. Fires only when there IS a top unmet ask AND a grounded employer to anchor it to.
  const empObj = (Array.isArray(d.employers) ? d.employers : [])
    .map((e) => (typeof e === "string" ? { name: e } : e))
    .filter((e) => e && e.name)[0] || null;
  // The company's domain is attached per employer by company-context.mjs as `employers[].domain` — an
  // attributed fact about the COMPANY, never a claim about the person.
  const keywordSides = chartSides(keywordDomains, empObj, { minAsk: 3 });

  // 6) The single best-grounded standout: the most RELEVANT role that clears the person's comp floor
  // (when comp is known), else the top relevance pick. This is the one the briefing zooms in on —
  // chosen by rule, not by taste.
  //
  // Ranking the floor-clearing roles by SENIORITY would optimise for the wrong thing (a designer
  // spotlighted onto a recruiting director role). `jobs` already arrives relevance-ranked from
  // selectForUser, the same order the daily matcher trusts, so it is not re-sorted.
  // LOCATION FIT for the SPOTLIGHT: the one role we zoom in on must respect the person's stated location.
  // A remote-wanting person is NEVER spotlighted onto another city. This guards only the single
  // standout, not the whole reachable set (that is selectForUser's job).
  const wantsRemote = /remote/i.test(String(prefs.remote || ""));
  const homeCity = (String(prefs.home_place || "").match(/[a-z]{4,}/i) || [""])[0].toLowerCase();
  const isRemote = (j) => j.remote === true || /remote/i.test(String(j.location || ""));
  const inHomeCity = (j) => !!(homeCity && String(j.location || "").toLowerCase().includes(homeCity));
  // `comped` is built by mapping over `jobs`, so this keeps relevance order — no sort.
  const clearing = comped.filter((x) => floor && floorCcy && x.comp.currency === floorCcy && x.comp.max >= floor);
  // Pick the spotlight by a predicate: most-relevant clears-floor first, else most-relevant in `jobs`.
  const pick = (pred) => (clearing.find((x) => pred(x.job)) || {}).job || jobs.find(pred) || null;
  // A remote-wanting person is spotlighted onto a TRUE-remote role first, their home city only as fallback,
  // and never another city.
  let standoutJob = wantsRemote
    ? pick(isRemote) || pick(inHomeCity) || (clearing[0] && clearing[0].job) || jobs[0] || null
    : (clearing[0] && clearing[0].job) || jobs[0] || null;

  // FIT, not just relevance. Relevance order answers "is this the right kind of job"; it does not
  // answer "can this person actually clear what the posting asks for". The relevance pick can be a
  // role they barely cover while a much better-covered one sits unmentioned.
  //
  // The ranker is INJECTED rather than called here on purpose. buildMarketReport is deterministic and
  // makes no model call; keeping it that way means the default path is free, and the caller decides
  // whether a coverage pass is worth the spend. It can only REORDER `shortlist`, never add to it — so
  // every location guard above still holds, and a ranker that throws, stalls or returns junk leaves
  // the default pick exactly as it was.
  const locationOk = wantsRemote ? (j) => isRemote(j) || inHomeCity(j) : () => true;
  const shortlist = (() => {
    const seen = new Set(), out = [];
    for (const j of [...clearing.map((x) => x.job), ...jobs]) {
      if (!j || !locationOk(j)) continue;
      const k = j.id || `${j.company}::${j.title}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push(j);
      if (out.length >= STANDOUT_SHORTLIST) break;
    }
    return out;
  })();
  // The coverage passes the ranker runs, retained rather than discarded. This is the whole reason the
  // coverage chart costs one extra call instead of five: the work is already being done.
  let covItems = null;
  if (typeof opts.rankStandout === "function" && shortlist.length > 1) {
    // Promise.resolve(fn()) does NOT catch a SYNCHRONOUS throw — fn() runs before the wrapper exists,
    // so the error escapes and takes the whole briefing with it. Caught by the fail-open test.
    const ranked = await (async () => { try { return await opts.rankStandout(shortlist); } catch { return null; } })();
    // Two accepted shapes. A ranker may return the job it picked (the original contract, still honoured
    // so any other caller keeps working), or { job, items } to also hand back the coverage it computed.
    const better = ranked && typeof ranked === "object" && "job" in ranked ? ranked.job : ranked;
    if (ranked && Array.isArray(ranked.items)) covItems = ranked.items;
    if (better && shortlist.includes(better)) standoutJob = better; // must come FROM the guarded shortlist
  }

  // THE LEVEL CHECK ON THE FINAL PICK. Everything above chose by relevance, comp floor and location —
  // none of which can see whether this person could clear the role at all. The ranker skips a chasm
  // role, but it can only protect a pick it MADE: when it returns nothing scoreable, or STANDOUT_FIT is
  // off, `standoutJob` is still the unchecked relevance pick. So the check happens here, on whatever
  // the spotlight finally is, using the coverage the ranker already handed back: a junior engineer
  // must never open the briefing to an 8-years role under "this is the one". This is the same
  // predicate the daily send gate drops on (quality-gate.mjs).
  //
  // It can only ever REMOVE a spotlight, never add or alter one, and a null standout renders as no
  // block at all (render-market-report.mjs standout()) — so the honest outcome of "nothing here is
  // yours yet" is a letter that keeps its market read and simply does not point at a role.
  // NO VERDICT = NO OPINION: a pick the coverage passes never reached is left exactly as it is and
  // logged, because inventing a verdict here would be the same sin in the other direction.
  if (standoutJob) {
    const key = (j) => j?.id || `${j?.company}::${j?.title}`;
    const hit = Array.isArray(covItems) ? covItems.find((it) => it?.job && (it.job === standoutJob || key(it.job) === key(standoutJob))) : null;
    if (!hit) {
      console.error(`[marketbrief] ${addr} spotlight has no coverage verdict, leaving it as picked: ${standoutJob.company} — ${standoutJob.title}`);
    } else if (seniorityChasm(hit.cov)) {
      console.error(`[marketbrief] ${addr} spotlight dropped, aimed above this person: ${standoutJob.company} — ${standoutJob.title} (seniority ${Number(hit.cov.subscores?.seniority).toFixed(2)})`);
      standoutJob = null;
    }
  }

  // THE GAP CHART. Compute the coverage chart whenever the coverage results exist, log it beside the
  // keyword chart, and render it only under GAP_CHART=coverage. In the default mode this costs no
  // model call of its own (the passes already ran) and changes nothing that leaves the building.
  //
  // FAIL OPEN in every direction, because the alternative is a briefing that silently loses its chart:
  // no ranker, no coverage results, a Voyage outage, a thrown clusterer, or a chart too thin to speak
  // from all leave the keyword chart exactly as it is.
  let domains = keywordDomains;
  let { gravity, marketAsk, wedge } = keywordSides;
  const gapMode = gapChartMode();
  if (covItems && covItems.length) {
    let covDomains = null;
    try { covDomains = await coverageDomains(covItems); }
    catch (e) { console.error(`[gap-chart] coverage chart failed, keeping the keyword chart: ${e.message}`); }
    const covSides = covDomains ? chartSides(covDomains, empObj, { minAsk: 1 }) : null;
    // Report what the EMAIL WILL DRAW, via the same chartPlan the renderer uses — not chartSides,
    // which can disagree with the renderer. A shadow log that cannot describe the artifact is worse
    // than no log, because it reads as evidence.
    const brief = (rows) => {
      const p = chartPlan(rows);
      if (!p.shown) return `NO CHART — ${p.reason}`;
      return `${p.strengths.length} spike(s) / ${p.gaps.length} gap(s) of ${p.rows.length} row(s)` +
        ` · yours: ${p.strengths.slice(0, 3).map((r) => r.label).join(" | ") || "(none)"}` +
        ` · gaps: ${p.gaps.slice(0, 3).map((r) => r.label).join(" | ") || "(none)"}`;
    };
    console.error(`[gap-chart] ${addr} mode=${gapMode} · KEYWORD ${brief(keywordDomains)}`);
    console.error(`[gap-chart] ${addr} mode=${gapMode} · COVERAGE ${covDomains ? brief(covDomains) : "(no coverage rows built)"}`);

    // Two disagreements chartPlan exposes. REPORTED, not reconciled — silently changing either would
    // change what a real person receives, so that is a deliberate product decision, not a log fix.
    //
    // 1. `minAsk` is INERT in the email. chartSides filters the gap side at live >= minAsk, but the
    //    renderer draws every live>0 row, so the noise floor that exists to keep stray words off the
    //    chart has never applied to what anyone actually saw.
    const drawn = chartPlan(gapMode === "coverage" && covDomains ? covDomains : keywordDomains);
    const floored = gapMode === "coverage" && covSides ? covSides.marketAsk : keywordSides.marketAsk;
    if (drawn.shown && drawn.gaps.length !== floored.length) {
      console.error(`[gap-chart] ${addr} minAsk IS INERT: the email draws ${drawn.gaps.length} gap(s), the noise floor would keep ${floored.length}` +
        ` · below the floor: ${drawn.gaps.filter((g) => !floored.includes(g)).map((r) => `${r.label}(${r.live})`).join(" | ")}`);
    }
    // 2. Eligibility and the chart can disagree. marketBriefEligible sends on gravity.length >= 2
    //    (market-briefing.mjs), which is NOT the set the chart draws — so a briefing can be sent whose
    //    chart renders as nothing at all.
    const eligible = (gapMode === "coverage" && covSides ? covSides : keywordSides).gravity.length >= 2;
    if (eligible && !drawn.shown) {
      console.error(`[gap-chart] ${addr} ELIGIBLE BUT CHARTLESS: passes the 2-proven-domain bar, yet the chart draws nothing (${drawn.reason})`);
    }
    // marketBriefEligible demands 2+ proven domains, so a coverage chart with a thin strengths side
    // does not just look harsher, it can SILENCE the briefing entirely. That is fail-closed and safe,
    // but it is a real behaviour change hiding inside a chart swap, so it is counted out loud here
    // rather than discovered after the flip.
    if (covSides && (keywordSides.gravity.length >= 2) !== (covSides.gravity.length >= 2)) {
      console.error(`[gap-chart] ${addr} ELIGIBILITY WOULD FLIP under coverage: keyword ${keywordSides.gravity.length} spike(s) vs coverage ${covSides.gravity.length}`);
    }
    if (gapMode === "coverage" && covSides) {
      domains = covDomains;
      ({ gravity, marketAsk, wedge } = covSides);
    }
  }
  const standout = standoutJob
    ? {
        company: standoutJob.company,
        title: standoutJob.title,
        location: standoutJob.location,
        comp: parseComp(standoutJob.compensation),
        tier: tierOf(standoutJob.title),
        apply_url: standoutJob.apply_url,
      }
    : null;

  // Grounded evidence the copy layer may weave in — the person's OWN proven claims, verbatim from the
  // dossier (never paraphrased into something new). Top proof points + the domains their case studies
  // cover. This is what lets the briefing speak their language ("your API-as-a-product thesis") without
  // inventing anything: every phrase traces to a stored claim.
  const evidence = {
    proof: (d.proof_points || [])
      .map((p) => (typeof p === "string" ? p : p?.claim || ""))
      .filter(Boolean)
      .slice(0, 6),
    caseDomains: (d.case_studies || [])
      .map((c) => (typeof c === "string" ? "" : c?.domain || c?.title || ""))
      .filter(Boolean),
  };

  // Top companies by role count (for the "who is hiring" strip).
  const byCompany = {};
  for (const j of jobs) byCompany[j.company || "?"] = (byCompany[j.company || "?"] || 0) + 1;
  const topCompanies = Object.entries(byCompany)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([company, n]) => ({ company, n }));

  return {
    meta: {
      email: addr,
      name: d.name || null,
      headline: d.headline || null,
      role: prefs.role || null,
      remote: prefs.remote || null,
      region: sel.stats.region,
      poolTotal: pool.length,
    },
    funnel,
    seniority,
    barTier,
    barLabel: (TIERS.find((t) => t.key === barTier) || {}).label,
    atOrAboveBar,
    geo,
    gravity,
    marketAsk,
    wedge,
    comp,
    standout,
    evidence,
    domains, // full taxonomy with { evidenced, live } — drives the coverage / gap chart
    topCompanies,
    tierLabels: Object.fromEntries(TIERS.map((t) => [t.key, t.label])),
  };
}

// CLI: `node market-report.mjs <email>` -> pretty-print the report JSON (read-only, for verification).
// Wrapped in an async IIFE (not top-level await): this file is imported by the server via market-briefing.mjs,
// where tsx/esbuild transforms it to CJS, and top-level await is illegal there. Matches the codebase pattern.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    loadEnv();
    const email = (process.argv[2] || "").trim().toLowerCase();
    if (!email) {
      console.error("usage: node market-report.mjs <email>");
      process.exit(1);
    }
    const report = await buildMarketReport(email);
    console.log(JSON.stringify(report, null, 2));
  })();
}
