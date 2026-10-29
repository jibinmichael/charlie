// lib/normalise.mjs — the deterministic half of enrichment. NO MODEL, NO NETWORK, PURE FUNCTIONS.
//
// This is the layer that makes the talent pool queryable. Without it "Bengaluru" and "Bangalore" are
// different cities, "8-10 years" cannot be compared to "9", "Immediately" and "30 days" are strings
// that do not sort, and 60 LPA / 60,00,000 / 6000000 are three unrelated values.
//
// EVERYTHING HERE IS A PURE FUNCTION AND A TEST CASE. It runs on every candidate, it decides who
// appears in a shortlist, and it must produce the same answer today and in six months. A model call
// here would make the pool unqueryable in a different way: reproducibly wrong instead of reproducibly
// right.

/** "Bengaluru, Karnataka, India" -> { city: "Bengaluru", country: "India" }, spelling canonicalised. */
const CITY_CANON = new Map(Object.entries({
  bangalore: "Bengaluru", bengaluru: "Bengaluru", blr: "Bengaluru",
  bombay: "Mumbai", mumbai: "Mumbai",
  "new delhi": "Delhi", delhi: "Delhi", ncr: "Delhi", gurgaon: "Gurugram", gurugram: "Gurugram", noida: "Noida",
  calcutta: "Kolkata", kolkata: "Kolkata",
  madras: "Chennai", chennai: "Chennai",
  hyderabad: "Hyderabad", pune: "Pune", poona: "Pune", ahmedabad: "Ahmedabad",
  kochi: "Kochi", cochin: "Kochi", ernakulam: "Kochi",
  trivandrum: "Thiruvananthapuram", thiruvananthapuram: "Thiruvananthapuram",
  jaipur: "Jaipur", indore: "Indore", chandigarh: "Chandigarh", bhubaneswar: "Bhubaneswar",
  coimbatore: "Coimbatore", mysore: "Mysuru", mysuru: "Mysuru", nagpur: "Nagpur", surat: "Surat",
}));

// Indian STATES, matched separately from the country. "Pune, Maharashtra" has no country in it, and
// taking the last comma-part naively would make Maharashtra a country. A state name is a stronger signal of
// India than the position of a word in a string.
const INDIA_STATE = /^(karnataka|maharashtra|tamil ?nadu|telangana|kerala|gujarat|rajasthan|haryana|punjab|west bengal|uttar pradesh|up|madhya pradesh|odisha|orissa|andhra pradesh|bihar|assam|jharkhand|chhattisgarh|uttarakhand|himachal ?pradesh|goa|delhi|ncr)$/i;
const INDIA_HINT = /\b(india|bharat|karnataka|maharashtra|tamil nadu|telangana|kerala|gujarat|rajasthan|haryana|punjab|west bengal|uttar pradesh|odisha|andhra)\b/i;

export function normaliseLocation(raw) {
  const s = String(raw || "").trim();
  if (!s) return { city: null, country: null };
  const parts = s.split(/[,/|]/).map((x) => x.trim()).filter(Boolean);
  let country = null;
  const last = (parts[parts.length - 1] || "").toLowerCase();
  if (/^india$/.test(last)) country = "India";
  else if (/^(usa|us|united states|u\.s\.a?\.?)$/.test(last)) country = "United States";
  // A state is not a country. Checked BEFORE the positional fallback, which would otherwise make
  // "Pune, Maharashtra" produce a country called Maharashtra.
  else if (INDIA_STATE.test(last)) country = "India";
  else if (INDIA_HINT.test(s)) country = "India";
  else if (parts.length > 1) country = parts[parts.length - 1];

  for (const p of parts) {
    const hit = CITY_CANON.get(p.toLowerCase());
    if (hit) return { city: hit, country: country || "India" };
  }
  const city = parts[0] && parts[0].toLowerCase() !== (country || "").toLowerCase() ? parts[0] : null;
  return { city: city || null, country };
}

/**
 * Country from a phone number's dialling code. Deterministic, no model, and a strong signal on its
 * own: somebody carrying +91 is in India even when their most recent employer is not, which is the
 * exact case that would otherwise file a Bangalore-based product manager under Kuwait.
 * Only the codes we actually see; anything else returns null rather than a guess.
 */
export function countryFromPhone(raw) {
  const s = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+?91\d{10}$/.test(s) || /^\+91/.test(s)) return "India";
  if (/^\+1\d{10}$/.test(s)) return "United States";
  if (/^\+44/.test(s)) return "United Kingdom";
  if (/^\+971/.test(s)) return "United Arab Emirates";
  if (/^\+65/.test(s)) return "Singapore";
  return null;
}

/**
 * Notice period to days. Handles the phrasings the forms actually produce.
 * "Immediately" is 0, not null: it is an answer, and treating it as missing would hide the best people.
 */
export function normaliseNotice(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (!s) return null;
  // \b on the zero, and it is load-bearing. Without it "30 days" contains "0 day" and every
  // candidate on a month's notice would be recorded as immediately available, which is the kind of
  // small wrong fact that a hiring manager discovers on a call.
  if (/immediate|right away|\bnow\b|serving (my )?notice|\b0\s*days?\b/.test(s)) return 0;
  const m = s.match(/(\d+)\s*(?:\+|to|-|–)?\s*(\d+)?\s*(day|week|month)/);
  if (m) {
    // A range takes the UPPER bound. "1-2 months" means a company waits two, and promising one is
    // the kind of small optimism that costs trust when it turns out wrong.
    const n = Number(m[2] || m[1]);
    const unit = m[3];
    if (unit === "day") return n;
    if (unit === "week") return n * 7;
    if (unit === "month") return n * 30;
  }
  if (/\bmonth\b/.test(s)) return 30;
  return null;
}

/**
 * Indian compensation to a plain annual number in the smallest sensible unit (rupees).
 * Handles: "40 LPA", "₹40L", "40,00,000", "40 lakhs", "1.2 Cr", "$120,000".
 */
export function normaliseComp(raw) {
  const s = String(raw || "").toLowerCase().replace(/,/g, "").trim();
  if (!s) return { value: null, currency: null };
  const currency = /\$|usd/.test(s) ? "USD" : "INR";
  const num = (x) => Number(String(x).replace(/[^0-9.]/g, "")) || 0;
  let m;
  if ((m = s.match(/([\d.]+)\s*(?:cr|crore)/))) return { value: Math.round(num(m[1]) * 10000000), currency };
  if ((m = s.match(/([\d.]+)\s*(?:lpa|lakh|lakhs|lac|l\b)/))) return { value: Math.round(num(m[1]) * 100000), currency };
  if ((m = s.match(/([\d.]+)\s*k\b/))) return { value: Math.round(num(m[1]) * 1000), currency };
  const plain = num(s);
  if (!plain) return { value: null, currency: null };
  // A bare number under 200 in an Indian context is lakhs per annum, not rupees. 45 means 45 LPA.
  if (currency === "INR" && plain < 200) return { value: Math.round(plain * 100000), currency };
  return { value: Math.round(plain), currency };
}

/** Their own answer about looking, mapped to a comparable status. Their words are kept alongside. */
export function normaliseSeeking(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s.trim()) return "unknown";
  if (/actively|active(ly)? looking|yes.*(looking|actively)|^yes\b/.test(s)) return "active_seeker";
  if (/right (thing|role|opportunity)|open to|passive.{0,20}open|casually/.test(s)) return "open_to_right_thing";
  if (/not looking|happy where|^no\b/.test(s)) return "not_looking";
  return "unknown";
}

/** Seniority from a title. Ordered most-specific first: "head of design" must not match "design". */
export function normaliseSeniority(title) {
  const t = String(title || "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (/\b(chief|cxo|c-level|vp|vice president|head of|director)\b/.test(t)) return "head";
  if (/\b(manager|managing)\b/.test(t) && !/product manager|program manager|project manager|account manager|customer success manager/.test(t)) return "manager";
  if (/\b(lead|principal|staff)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?)\b/.test(t)) return "senior_ic";
  if (/\b(junior|jr\.?|associate|intern|trainee|graduate)\b/.test(t)) return "ic";
  return "ic";
}

/** Title to role family. The families are the ones the ATS actually has demand in. */
export function normaliseFamily(title) {
  const t = String(title || "").toLowerCase();
  if (/\b(product designer|ux|ui|interaction design|visual design|design lead|design manager|head of design|product design)\b/.test(t)) return "product_design";
  if (/\b(product manager|product owner|product lead|head of product|group product|apm)\b/.test(t)) return "product_management";
  if (/\b(customer success|account manager|client success|renewals|customer experience|support)\b/.test(t)) return "customer_success";
  if (/\b(account executive|sales|business development|bdr|sdr|revenue)\b/.test(t)) return "sales";
  if (/\b(marketing|growth|brand|content|seo|demand gen|communications)\b/.test(t)) return "marketing";
  if (/\b(program manager|project manager|operations|chief of staff|delivery|scrum)\b/.test(t)) return "ops";
  if (/\b(data|analytics|analyst|business intelligence)\b/.test(t)) return "data";
  return "other";
}

/**
 * Mobility from employment history. NEVER from a title, never asked, never inferred from vibes.
 *
 * TWO GUARDS AGAINST CALLING SOMEBODY A HOPPER UNFAIRLY, and they matter because this label follows
 * a person into a hiring manager's inbox:
 *   1. Fewer than three roles is `unknown`. Two short stints is not a pattern, it is two stints.
 *   2. Under four years total is `unknown`. Early careers are short by construction: a graduate with
 *      three one-year roles is normal, and labelling them a hopper would be a fact about the industry
 *      rather than about them.
 *
 * @param {{months:number}[]} roles  completed and current roles with a duration in months
 * @param {number} totalYears
 */
export function mobilityProfile(roles, totalYears) {
  const list = (roles || []).filter((r) => Number.isFinite(r?.months) && r.months > 0);
  if (list.length < 3) return { profile: "unknown", avg: null, longest: null, reason: "fewer than three dated roles" };
  if ((totalYears ?? 0) < 4) return { profile: "unknown", avg: null, longest: null, reason: "under four years of career" };
  const avg = Math.round(list.reduce((n, r) => n + r.months, 0) / list.length);
  const longest = Math.max(...list.map((r) => r.months));
  const profile = avg >= 36 ? "stable" : avg >= 24 ? "steady" : avg >= 18 ? "mover" : "hopper";
  return { profile, avg, longest, reason: `${list.length} roles, average ${avg} months` };
}

/** Months between two YYYY-MM strings; `present` resolves to now. */
export function monthsBetween(start, end) {
  if (!start) return null;
  const p = (s) => { const m = String(s).match(/(\d{4})-(\d{2})/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null; };
  const a = p(start);
  const b = /present|current/i.test(String(end || "")) ? new Date() : p(end);
  if (!a || !b) return null;
  const n = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return n >= 0 ? n : null;
}

/**
 * What is missing, and therefore what we ask them for.
 *
 * The order is the order of usefulness to a hiring manager. `completeness` is a blunt percentage on
 * purpose: it is for sorting a list, not for judging a person.
 */
export const ASKABLE = [
  ["notice_days", "notice period"],
  ["comp_expected", "expected compensation"],
  ["seeking_status", "whether you are actively looking"],
  ["current_title", "your current role"],
  ["current_company", "your current company"],
  ["city", "where you are based"],
  ["total_years", "total years of experience"],
  ["linkedin_url", "your LinkedIn"],
  ["portfolio_url", "a portfolio or work link"],
  ["willing_to_relocate", "whether you would relocate"],
];

export function completenessOf(row) {
  const missing = ASKABLE.filter(([k]) => {
    const v = row[k];
    return v === null || v === undefined || v === "" || v === "unknown";
  });
  const score = Math.round(((ASKABLE.length - missing.length) / ASKABLE.length) * 100);
  return { completeness: score, missing_fields: missing.map(([k]) => k), missing_labels: missing.map(([, l]) => l) };
}
