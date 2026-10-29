// lib/role-facts.mjs — two facts the posting already states: pay and a non-default employment type.
//
// PAY. A minority of postings state a real figure, and which ones is a source artifact rather than a
// market one (keka populates a compensation field; greenhouse/ashby/lever mostly do not). The only
// other pay surface, `computePay`, is a BLS-anchored US-only chip, so without this India-reachable
// roles would never show pay. It fires on a minority of emails; that is worth having and not worth
// overselling.
//
// Why it matters where it fires: many candidates will not apply to a posting with no pay range, and
// it is the single fact a person most wants before spending an hour on an application.
//
// EMPLOYMENT TYPE, CONTEXTUALLY. Nearly every role that states one says full-time, which is the
// assumption anyway — printing it is noise. Only a DEPARTURE is information: contract, part-time,
// internship. Those are dealbreakers a person should never discover on the application form.
//
// DETERMINISTIC AND FAIL-CLOSED. No model call, no network, $0. Anything unparseable returns null and
// the chip does not render — an absent fact is a smaller failure than a wrong one, and pay is the
// worst possible field to be wrong about.

// "Competitive", "Best in industry", "As per market" — a number-shaped promise with no number.
const VAGUE = /^(competitive|market|negotiable|as per|best in|attractive|not disclosed|doe|tbd|open)\b/i;

// Full-time in every spelling the sources use: FullTime, Full time, Full-time, full_time,
// fulltime_permanent, Full-time Employment. All mean "the default", and the default is not news.
const FULL_TIME = /^(full[\s._-]*time|fulltime)([\s._-]*(employment|permanent|role|position))?$/i;

const KINDS = [
  [/^(contract|contractor|fixed[\s._-]*term|c2h|contract[\s._-]*to[\s._-]*hire)/i, "Contract"],
  [/^(part[\s._-]*time|parttime)/i, "Part-time"],
  [/^(intern|internship|trainee|apprentice)/i, "Internship"],
  [/^(temp|temporary|seasonal)/i, "Temporary"],
  [/^(freelance|gig)/i, "Freelance"],
  [/^(volunteer)/i, "Volunteer"],
];

/**
 * The work arrangement, ONLY when it departs from full-time. null otherwise.
 *
 * Unknown shapes return null rather than being echoed raw: a chip reading "fulltime_permanent" tells
 * a person nothing and tells them we are printing a database value at them.
 */
export function employmentKind(raw) {
  const s = String(raw || "").trim();
  if (!s || FULL_TIME.test(s)) return null;
  for (const [re, label] of KINDS) if (re.test(s)) return label;
  return null;
}

/** 1200000 -> "12 lakh"; 8500000 -> "85 lakh"; 15000000 -> "1.5 crore". Indian units, as spoken. */
function inrWord(n) {
  if (n >= 10000000) {
    const cr = n / 10000000;
    return `${cr % 1 === 0 ? cr : cr.toFixed(1)} crore`;
  }
  const l = n / 100000;
  return `${l % 1 === 0 ? l : l.toFixed(1)} lakh`;
}

/** 115000 -> "115k"; 20 -> "20" (an hourly rate must not become "0k"). */
function usdWord(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * The stated pay, formatted the way a person in that market says it. null when there is no real
 * figure, which is the common case and must render nothing at all.
 *
 * A BAND WIDER THAN 2.5x COLLAPSES TO "from X". Research on posting practice finds a very wide band
 * suppresses applications and does so measurably more for women, and a range of "₹5 lakh to ₹50 lakh"
 * carries no information anyway — it is a legal hedge printed as a fact. Saying "from ₹5 lakh" is
 * both more honest and less discouraging than repeating a number that means nothing.
 *
 * @returns {{text:string, currency:"INR"|"USD"}|null}
 */
export function payLine(compensation) {
  const raw = String(compensation || "").trim();
  if (!raw || VAGUE.test(raw) || !/\d/.test(raw)) return null;

  const currency = /(₹|\bINR\b|LPA|lakh|lacs?|crore)/i.test(raw) ? "INR" : /(\$|\bUSD\b)/i.test(raw) ? "USD" : null;
  if (!currency) return null; // an unlabelled number could be anything; never guess a currency

  const nums = (raw.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const word = currency === "INR" ? inrWord : usdWord;
  const sym = currency === "INR" ? "₹" : "$";

  if (lo === hi) return { text: `${sym}${word(lo)}`, currency };
  if (hi / lo > 2.5) return { text: `From ${sym}${word(lo)}`, currency };
  return { text: `${sym}${word(lo)} to ${sym}${word(hi)}`, currency };
}
