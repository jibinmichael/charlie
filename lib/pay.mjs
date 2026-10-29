// lib/pay.mjs — the ONE place money is read: parse a posting's pay, and judge it against the floor a
// person actually stated.
//
// WHY. At onboarding Charlie asks, in these words (email-onboard.mjs):
//
//     "your pay floor, so I never send you anything below it."
//
// This module keeps that promise in code: a role that discloses pay below the stated floor is
// dropped by the send gate, rather than relying on the matcher prompt to notice.
//
// parseComp lives here rather than in market-report.mjs because quality-gate.mjs needs it and
// market-report.mjs already imports quality-gate.mjs — importing back would be a cycle. This is a leaf:
// it imports nothing. market-report.mjs re-exports parseComp so its existing callers are unaffected.

const INR_LAKH = 100000;

// The units salary is actually written in. Indian postings use lakh (1e5) and crore (1e7) far more
// often than full figures; US postings use K and M.
const UNIT = {
  cr: 1e7, crore: 1e7, crores: 1e7,
  l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, lpa: 1e5,
  k: 1e3, m: 1e6, mn: 1e6,
};
// A number, then optionally the unit written beside it. The trailing \b is load-bearing: without it
// the `l` in "10 Lead engineers" would read as lakh and turn 10 into 1,000,000. Longer spellings come
// first in the alternation so "crore" is not matched as "cr" with a dangling "ore".
const NUM_UNIT = /([\d][\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lpa|mn|[lkm])?\b/gi;

/**
 * Parse a compensation value (string like "INR 70,00,000.00 - 1,00,00,000.00", or a Greenhouse/Ashby
 * object) into a best-effort { currency, min, max } in absolute units. Returns null when nothing
 * parseable — we NEVER guess a number that isn't stated (grounding).
 */
export function parseComp(comp) {
  if (!comp) return null;
  let s = typeof comp === "string" ? comp : comp.compensationTierSummary || comp.scrapeableCompensationSalarySummary || "";
  if (!s || typeof s !== "string") return null;
  // Rupee tokens must be WHOLE words. Without the leading \b, `rs\b` matched the "rs" tail of ordinary
  // English (offers, years, peers, hours), so a US "$200K, best offers reach $500K" would read as INR
  // and render as ₹2L/₹5L. \b anchors both rupee forms.
  const currency = /\binr\b|₹|\brs\.?\b/i.test(s) ? "INR" : /\$|usd/i.test(s) ? "USD" : null;
  // Read each number WITH the unit written next to it, rather than testing the whole string for one
  // suffix. A whole-string K/M test would collapse every Indian notation to its
  // bare digits: "₹70L - ₹90L" would become 70 and 90 RUPEES, fall under the person's stated floor,
  // and be dropped. Shorthand is how LARGE salaries are written, so that misreading would delete the
  // best-paying roles first.
  //
  // The unit must end on a word boundary, which is what stops an ordinary word being read as one:
  // "10 Lead engineers" does not make 10 into 10 lakh, because the `l` is followed by `e`.
  const pairs = [];
  for (const m of s.matchAll(NUM_UNIT)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n > 0) pairs.push({ n, scale: m[2] ? UNIT[m[2].toLowerCase()] : null });
  }
  if (!pairs.length) return null;
  // A range usually writes the unit ONCE, at the end: "12-18 LPA" means twelve to eighteen LAKH, not
  // twelve rupees to eighteen lakh. So a number with no unit of its own borrows the first one found.
  const fallback = pairs.find((p) => p.scale)?.scale ?? 1;
  // The borrow applies only to a small bare number, which is the pre-existing "164 -> 164k" guard kept
  // intact: a figure already written in full (70,00,000) must never be multiplied again.
  const scaled = pairs.map((p) => (p.scale ? p.n * p.scale : p.n < 10000 ? p.n * fallback : p.n));
  return { currency, min: Math.min(...scaled), max: Math.max(...scaled) };
}

// A currency we can compare on. Deliberately an exact whole-token match: comp_currency can hold a
// free-text value such as "USD OR INR", and a floor whose currency is ambiguous
// cannot be compared to anything. Ambiguity means NO OPINION, never a guess.
const CLEAN_CURRENCY = /^(INR|USD|EUR|GBP|AUD|CAD|SGD)$/;

// A posting quoting a monthly figure. India postings often do ("₹2,00,000 per month"), and comparing a
// monthly number to an annual floor would drop a role that pays 12x what the person asked for.
const MONTHLY = /\b(per\s*month|\/\s*?mo\b|a\s*month|monthly|p\.m\.)\b/i;
// A posting quoting an HOURLY rate. "$50 per hour" is ~$104k a year, but against an annual floor it
// reads as fifty dollars and the role is dropped for paying too little. 2,080 = 40h x 52w, the
// standard full-time year.
const HOURLY = /\b(per\s*hour|an\s*hour|hourly|\/\s*hr\b|\bp\.?h\.?\b)/i;
const HOURS_PER_YEAR = 2080;

/**
 * A stated floor, in absolute units.
 *
 * THE SAME FIELD HOLDS TWO UNITS. INR floors are stored either in LAKHS (15, 30, 45) or in RUPEES
 * (40000 … 8000000). Comparing a salary of 1,800,000 against a floor of "18" passes everything.
 *
 * The <1000 cut is safe in both directions: nobody's annual floor is ₹999, and nobody means 1,000 lakh.
 * Applied to INR only — a USD floor of 45000 is already absolute.
 */
export function floorToAbsolute(floor, currency) {
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0) return null;
  const ccy = String(currency || "").trim().toUpperCase();
  if (!CLEAN_CURRENCY.test(ccy)) return null;
  return ccy === "INR" && floor < 1000 ? floor * INR_LAKH : floor;
}

/**
 * Is this posting's disclosed pay below what the person said they would accept?
 *
 * FAILS OPEN IN EVERY DIRECTION — returns null ("no opinion") unless the comparison is unambiguous.
 * That is deliberate: a false drop is a person who silently stops hearing from Charlie, and only a
 * minority of postings disclose pay at all. No opinion means the role is judged on everything else. The stop only ever fires on a posting that
 * VOLUNTEERED a number we can read, in the person's own currency, that is genuinely under their floor.
 *
 * @returns {{below: boolean, floor: number, roleMax: number, currency: string}|null}
 */
// A bare figure under 1,000 is not a year's pay. What to do about it differs by currency, and both
// answers fail OPEN.
//
// A posting of "INR 26.00 - 35.00" means twenty-six to thirty-five LAKH, written with no unit at all.
// parseComp has nothing to read and returns 35, which is under every floor anyone states, so without
// this rule the role would be dropped for someone whose ₹30 lakh floor it clears.
//
// FOR INR the floor side already answers this: floorToAbsolute reads a stated floor under 1,000 as
// lakhs, because nobody's annual floor is ₹999. The role side gets the SAME rule — one interpretation
// of "a small rupee number", not two. It also fails in the safe direction: reading it as lakhs makes
// the figure LARGER, so the worst case is keeping a role we might have dropped.
//
// FOR EVERY OTHER CURRENCY there is no such convention, so a bare small figure is simply unreadable
// (almost always an hourly or daily rate whose unit went missing). No opinion.
const NOT_AN_ANNUAL_FIGURE = 1000;

export function belowStatedFloor(rawComp, prefs) {
  const ccy = String(prefs?.comp_currency || "").trim().toUpperCase();
  const floor = floorToAbsolute(prefs?.comp_floor, ccy);
  if (floor == null) return null; // no floor stated, or a currency we cannot read
  const comp = parseComp(rawComp);
  if (!comp || !comp.currency) return null; // the posting disclosed nothing readable
  if (comp.currency !== ccy) return null; // never compare rupees to dollars
  // Judge on the TOP of the posted band. A range of "12-18 lakh" against a floor of 15 is a role the
  // person can land at their number, so it is not below their floor.
  // Annualise before comparing. The raw value may be an object (Greenhouse/Ashby), so the unit test
  // reads the STRINGIFIED payload, not just a string input — an hourly rate can hide inside
  // compensationTierSummary.
  const rawText = typeof rawComp === "string" ? rawComp : JSON.stringify(rawComp ?? "");
  let roleMax = comp.max;
  if (HOURLY.test(rawText)) roleMax *= HOURS_PER_YEAR;
  else if (MONTHLY.test(rawText)) roleMax *= 12;
  if (!Number.isFinite(roleMax) || roleMax <= 0) return null;
  // Only reached when the posting gave no unit of its own — an explicit "L"/"lakh"/"per hour" has
  // already been applied above, so this never double-scales.
  if (roleMax < NOT_AN_ANNUAL_FIGURE) {
    if (ccy !== "INR") return null;      // no lakh convention: unreadable, so no opinion
    roleMax *= INR_LAKH;                 // same reading floorToAbsolute gives a small rupee number
  }
  return { below: roleMax < floor, floor, roleMax, currency: ccy };
}
