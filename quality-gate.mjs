// quality-gate.mjs — the pre-send Quality Gate: routes every candidate role to send, digest or drop.
//
// Every role Charlie is about to send is routed to exactly one outcome:
//   send   — posting is LIVE, location is genuinely reachable, and the fit clears a floor (not just
//            the matcher bar). This is the one honest solo role.
//   digest — the profile fits, the posting is live, but a soft thing is off: location not reachable,
//            or the matcher likes it yet the fit composite is below the floor (the 72-vs-26 case).
//            Held for the weekly "worth a look" digest, never a solo send with contradictory copy.
//   drop   — the posting is closed / the link is dead. Never send a link that 404s.
//
// Design choices that protect the moat:
//  - Liveness is checked against the ATS API by id (source:slug:jobId), authoritative for ~98% of the
//    pool; a network error or an uncheckable source FAILS OPEN (never drop a real role over a blip).
//  - computeCoverage (the Sonnet fit pass) runs ONLY for roles that are already live + reachable, via
//    the getCov callback, so we never spend it on a dead or foreign posting.

import { safeFetch } from "./safe-fetch.mjs";
import { unifyScore, unifiedRoute, unifiedMode } from "./unify.mjs"; // one composite for the gate + readout
import { verifyRemoteAccess } from "./remote-access-verify.mjs"; // Tier 2: grounded remote-accessibility check
import { knockouts, knockoutMode } from "./eligibility-gate.mjs"; // the knockout floor
import { belowStatedFloor } from "./lib/pay.mjs"; // the stated pay floor Charlie promises to honour

const FIT_FLOOR = Number(process.env.FIT_FLOOR || 50); // composite below this → digest, not a solo send
// Seniority-gap hard stop: the fit pass rates the person "under" the role AND the seniority subscore
// (0..1) is at/below this → the gap is a real chasm, not a one-level stretch → DROP (never a solo send,
// never the weekly digest). A 7-year person cannot honestly be sent a 12-14-year role as their one role.
const SENIORITY_UNDER_FLOOR = Number(process.env.SENIORITY_UNDER_FLOOR || 0.34);

// The chasm test itself, extracted so every surface that has a coverage verdict in hand (the daily
// send and the market briefing's spotlight) asks the SAME question from one definition.
//
// FAILS OPEN, deliberately: a thin, errored, absent or unscoreable verdict is NO OPINION, never a
// guessed chasm. A caller must be able to say "I could not tell" without a role being discarded for it.
export function seniorityChasm(cov) {
  const scoreable = cov && !cov.thin && typeof cov.composite === "number";
  return !!(scoreable && cov.seniorityLevel === "under" && Number(cov.subscores?.seniority) <= SENIORITY_UNDER_FLOOR);
}
const FETCH_MS = Number(process.env.GATE_FETCH_MS || 9000);
const LIVE_RETRIES = Number(process.env.GATE_LIVE_RETRIES || 3); // total attempts on a checkable source before we give up
const LIVE_BACKOFF_MS = Number(process.env.GATE_LIVE_BACKOFF_MS || 400); // short backoff between attempts

// India, by the names employers actually post: metros, tier-2 cities and states. A city missing from
// this list reads as FOREIGN and drops the role for every India user, so it is deliberately broad.
//
// STATES ARE INCLUDED because employers write "Kochi (Kerala)" far more often than "Kochi, India".
// Punjab is deliberately absent — it spans India and Pakistan, so the Punjabi CITIES are listed
// instead and the ambiguous state name is not.
const INDIA = /\b(india|bharat|remote[- ]?india|india[- ]?remote|bengaluru|bangalore|mumbai|bombay|delhi|new delhi|ncr|hyderabad|pune|poona|chennai|madras|gurgaon|gurugram|noida|kolkata|calcutta|ahmedabad|kochi|cochin|ernakulam|trivandrum|thiruvananthapuram|kozhikode|calicut|thrissur|kollam|kottayam|coimbatore|madurai|tiruchirappalli|trichy|salem|erode|vellore|tirupur|indore|bhopal|jaipur|udaipur|jodhpur|nagpur|nashik|surat|vadodara|baroda|rajkot|gandhinagar|bhubaneswar|cuttack|visakhapatnam|vizag|vijayawada|guntur|warangal|mysore|mysuru|mangalore|mangaluru|hubli|belgaum|chandigarh|mohali|ludhiana|amritsar|jalandhar|dehradun|lucknow|kanpur|varanasi|agra|patna|ranchi|raipur|guwahati|shillong|goa|panaji|panjim|thane|navi mumbai|pimpri|chinchwad|faridabad|ghaziabad|greater noida|kerala|tamil nadu|tamilnadu|karnataka|maharashtra|telangana|andhra pradesh|gujarat|rajasthan|haryana|odisha|orissa|assam|bihar|jharkhand|chhattisgarh|uttarakhand|himachal|madhya pradesh|uttar pradesh|west bengal)\b/i;
// A role pinned to a specific non-India country/region is NOT truly available to an India-based
// person, even if it says "remote" (e.g. "United States (Remote)" = US-only).
const FOREIGN = /\b(united states|u\.?s\.?a?|americas|north america|san francisco|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|london|united kingdom|canada|toronto|vancouver|singapore|dubai|u\.?a\.?e|australia|sydney|melbourne|germany|berlin|munich|france|paris|amsterdam|netherlands|ireland|dublin|spain|madrid|poland|warsaw|brazil|mexico|emea|latam)\b/i;

// US state NAMES, spelled out. Without them an employer writing the state instead of the city
// ("Chandler, Arizona", "Hoover, Alabama", "Rhode Island") reads as `foreign-place-named` and the role
// is dropped for a US candidate: a correct-looking verdict quietly binning real inventory. Spelled-out
// state names are unambiguous, so this stays inside the "NAMES, never bare codes" discipline the CA/AU
// block below depends on.
//
// "georgia" is DELIBERATELY ABSENT. It is also a country, exactly like the "victoria"/"newcastle"
// exclusions in CA_PLACE. Roles that name Georgia almost always co-list another US state, so they
// still match; an Atlanta role is covered by "atlanta" below.
//
// DO NOT add bare two-letter codes here. The "XX - City" shape in real postings is usually an ISO
// COUNTRY code, not a US state code: CA -> Toronto, DE -> Berlin, IN -> Bangalore,
// GB -> London, AE -> Dubai. Reading "IN - Crawfordsville" as Indiana necessarily also reads
// "IN - Bangalore" as Indiana, putting an India role in a US inbox. A location whose only US signal is
// a bare code must stay unreachable and be fixed at INGEST (where the source's own country field is
// available), never decoded here. quality-gate.test.mjs asserts this in both directions.
const US_STATE_NAMES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|" +
  "illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|" +
  "mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|" +
  "north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|" +
  "texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming";
// The 50 states plus DC, as CODES. Used ONLY by US_CITY_STATE below, which anchors them to a comma
// at the end of a location string — never matched loose (see the note there).
const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

const US_PLACE = new RegExp(
  `\\b(united states|u\\.?s\\.?a?\\.?|america|americas|north america|san francisco|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|los angeles|remote[- ]?us|us[- ]?remote|${US_STATE_NAMES})\\b`,
  "i",
);

// "City, ST" — a US state CODE anchored to a comma at the end of the location string.
//
// WHY THIS IS SEPARATE FROM US_PLACE. US_PLACE deliberately matches place NAMES and never bare
// two-letter codes, because a loose "WA" collides with Western Australia and a loose "CA" with
// Canada. That rule is right and it stays. But it also means a plain American posting whose city is
// not on the hand-written city list ("Hawthorne, CA") would be invisible to the US market, and
// "City, ST" is the most common US location shape.
//
// The comma anchor is what makes a code safe where a bare code is not: it separates "Hawthorne, CA"
// (a US city) from "CA - Toronto" (a country prefix), and it requires the code to END the string, so
// it cannot fire on a stray word mid-sentence. Multi-location rows like "Peru; Scottsdale, AZ" are
// roles a US user can take, and "Ontario, CA" is Ontario, California.
const US_CITY_STATE = new RegExp(
  `,\\s*(?:${US_STATE_CODES})\\s*(?:,\\s*(?:USA|U\\.S\\.A\\.|US|United States))?\\s*$`,
  "i",
);

// WA is the ONLY US state code that collides with an Australian state (Western Australia), so the
// Australia guard applies to WA ALONE. Guarding on every Australian city name instead would read
// "Melbourne, FL" as Australian and hide Florida from Americans — the same homonym bug in reverse,
// which the collision battery in quality-gate tests pins in both directions.
const AU_WA_CITY = /\b(perth|fremantle|bunbury|western australia)\b/i;
const TRAILING_WA = /,\s*WA\s*(?:,\s*(?:USA|US|United States))?\s*$/i;

/** Does this raw location string name a US place as "City, ST"? Exported for the tests. */
export function isUSCityState(loc) {
  const l = String(loc || "");
  if (!US_CITY_STATE.test(l)) return false;
  if (/\baustralia\b/i.test(l)) return false;
  if (TRAILING_WA.test(l) && AU_WA_CITY.test(l)) return false;
  return true;
}

// ── Markets 3 + 4: Canada + Australia (MULTI_REGION) ─────────────────────────────────────────
// Charlie is expanding past India+US. These follow US_PLACE's discipline EXACTLY: match city,
// province/state and country NAMES, never a bare two-letter code. That is what makes "Perth, WA"
// read as Perth (not Washington) and "Seattle, WA" read as Seattle — bare "WA" matches nothing on
// either side, so the WA / NSW / ON collisions cannot fire. Do not add bare codes here.
//
// DARK by default. MULTI_REGION=on turns ca/au into real regions; with it off, every path below is
// a no-op and India/US behaviour is byte-identical (that equivalence is asserted in the tests).
const multiRegionOn = () => String(process.env.MULTI_REGION || "off").toLowerCase() === "on";
const CA_PLACE = /\b(canada|canadian|toronto|vancouver|montreal|montréal|ottawa|calgary|edmonton|winnipeg|mississauga|brampton|scarborough|etobicoke|markham|burnaby|laval|gatineau|saskatoon|halifax|regina|kitchener|ontario|quebec|québec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|remote[- ]?canada|canada[- ]?remote)\b/i;
// "victoria" and bare "newcastle" are deliberately ABSENT: Victoria is also British Columbia and
// Newcastle is also the UK, so each needs its country stated and falls through unqualified.
const AU_PLACE = /\b(australia|australian|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|gold coast|wollongong|geelong|new south wales|nsw|queensland|western australia|south australia|tasmania|australian capital territory|remote[- ]?australia|australia[- ]?remote)\b/i;
// Fail-closed disqualifier. Several CA/AU city names are ALSO real US cities ("Melbourne, FL",
// "Vancouver, WA", "Ontario, California", "Brisbane, CA"). A US role landing in a Sydney inbox is
// unrecoverable, so an ambiguous city carrying a US state qualifier is refused as CA/AU and falls
// through to the existing behaviour (fail closed).
//
// TWO regexes, because ", CA" is genuinely ambiguous and only in ONE direction: a real Canadian row
// reads "Toronto, ON, CA" (CA = Canada), while no Australian address ever ends ", CA". So the AU list
// treats ", CA" as California and the CA list must not. The comma is REQUIRED — bare two-letter
// tokens like OR / IN / ME / PA are ordinary words ("Perth or Adelaide") and matching them
// unqualified would disqualify real roles.
// "california" spelled out is unambiguous and belongs to BOTH lists; only the bare "ca" abbreviation
// is contested, so it is added to the AU pattern alone.
const US_STATES = "fl|florida|california|oh|ohio|ky|kentucky|tx|texas|va|virginia|mi|michigan|or|oregon|wa|washington|in|indiana|nj|new jersey|il|illinois|me|maine|nh|new hampshire|ma|massachusetts|pa|pennsylvania|nd|north dakota|az|arizona";
const US_HOMONYM_AU = new RegExp(`\\b(melbourne|brisbane|perth|sydney|newcastle|richmond|victoria)\\s*,\\s*(${US_STATES}|ca)\\b`, "i");
const US_HOMONYM_CA = new RegExp(`\\b(vancouver|ontario|london|hamilton|windsor|kingston|richmond|victoria|newcastle)\\s*,\\s*(${US_STATES})\\b`, "i");
const usHomonym = (region, s) => (region === "au" ? US_HOMONYM_AU : US_HOMONYM_CA).test(s);
// One place that answers "is this string market X?", so classifyPlace and REGION_PLACE can never
// disagree about the same text. Null when MULTI_REGION is off, or when a US homonym disqualifies it.
function classifyNewMarket(s) {
  if (!multiRegionOn()) return null;
  if (CA_PLACE.test(s)) return usHomonym("ca", s) ? null : "ca";
  if (AU_PLACE.test(s)) return usHomonym("au", s) ? null : "au";
  return null;
}
export const isIndia = (j) => INDIA.test(`${j?.location || ""} ${j?.region || ""}`);
export const isForeign = (j) => { const l = `${j?.location || ""}`; return FOREIGN.test(l) && !INDIA.test(l); };

// Where the candidate can actually work, derived from the WHOLE dossier (not just the optional
// preferences.remote field, which most users never set). Reads the
// resume location/headline/contact + phone + currency. An India-based person's resume almost always
// carries an India signal even when they set no preference; same for US. Only "global" (truly no
// signal anywhere) skips the geo filter.
const INDIA_SIGNAL = /\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|kerala|tamil nadu|karnataka|maharashtra)\b/i;
// Charlie serves exactly two markets: India + US. A candidate who POSITIVELY states a home OUTSIDE
// both is "other" — sent an honest "I only cover India and the US right now" note, never foreign roles
// (they'd be dropped at the gate anyway; the point is to say so instead of going silent). This is a
// POSITIVE signal, checked ONLY after india/us are ruled out, so a bare-unknown still defaults to India
// (the anti-leak default). It reads only explicit home fields (comp currency, stated location/remote
// preference), never the headline/narrative — a passing "worked with UK clients" is not where you live.
//   - A specific non-INR/USD home currency: you are paid where you live.
const OTHER_CURRENCY = /^(EUR|GBP|AED|SGD|CAD|AUD|CHF|SEK|NOK|DKK|ZAR|NGN|KES|PHP|PKR|BDT|LKR|NPR|MYR|IDR|THB|VND|BRL|MXN|ARS|CLP|COP|SAR|QAR|KWD|BHD|OMR|NZD|HKD|JPY|CNY|KRW|TWD|PLN|CZK|HUF|RON|BGN|TRY|ILS|EGP|UAH)$/i;
//   - An explicit non-India/non-US country/region name. Deliberately excludes every India + US term
//     (those are handled first, above) so this can only ever fire on a genuinely foreign place.
const FOREIGN_HOME = /\b(malta|united kingdom|u\.?k\.?|great britain|britain|england|scotland|wales|northern ireland|ireland|dublin|germany|berlin|munich|frankfurt|france|paris|spain|madrid|barcelona|portugal|lisbon|porto|italy|rome|milan|netherlands|amsterdam|belgium|brussels|luxembourg|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|czech|prague|switzerland|zurich|geneva|austria|vienna|greece|athens|cyprus|estonia|latvia|lithuania|europe|european union|\beu\b|emea|singapore|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|vietnam|hanoi|philippines|manila|dubai|abu dhabi|u\.?a\.?e|qatar|doha|saudi arabia|riyadh|kuwait|bahrain|oman|israel|tel aviv|turkey|istanbul|egypt|cairo|nigeria|lagos|abuja|kenya|nairobi|ghana|south africa|johannesburg|cape town|pakistan|karachi|lahore|islamabad|bangladesh|dhaka|sri lanka|colombo|nepal|kathmandu|canada|toronto|vancouver|montreal|ontario|quebec|australia|sydney|melbourne|brisbane|perth|new zealand|auckland|brazil|sao paulo|mexico|mexico city|argentina|buenos aires|chile|santiago|colombia|bogota|peru|latam|japan|tokyo|osaka|china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|south korea|seoul)\b/i;
// Classify a single stated place string against the three markets. Positive-match only: returns "other"
// solely on a FOREIGN_HOME hit, so an unrecognized value (e.g. "Remote", "Anywhere") yields null and the
// caller falls through to the currency/hay heuristic rather than a false "other".
export function classifyPlace(place) {
  const s = String(place || "");
  if (!s) return null;
  if (INDIA_SIGNAL.test(s) || INDIA.test(s)) return "india";
  if (US_PLACE.test(s)) return "us";
  // ca/au are checked BEFORE FOREIGN_HOME (which still lists canada|australia|toronto|sydney…) so
  // opening a market needs no edit to that shared regex: an open market is simply claimed first.
  // With MULTI_REGION off this returns null and FOREIGN_HOME decides exactly as it does today.
  const newMarket = classifyNewMarket(s);
  if (newMarket) return newMarket;
  if (FOREIGN_HOME.test(s)) return "other";
  return null;
}
export function homeRegion(dossier) {
  const d = dossier || {}; const p = d.preferences || {};
  // 1) Grounded, model-extracted home location first (verbatim; see prompts/dossier-build.mjs). It is the
  //    cleanest signal — one stated place, not the noisy resume hay — but still only forces "other" on a
  //    positive foreign match; an unrecognized value falls through, never to a false "other".
  const grounded = classifyPlace(p.home_place);
  if (grounded) return grounded;
  const hay = [p.remote, p.location, d.location, d.headline, d.contact_address, d?.contact?.location, d?.contact?.phone]
    .filter(Boolean).join(" ");
  if (p.comp_currency === "INR" || INDIA_SIGNAL.test(hay) || /\+91|\bIST\b/.test(hay)) return "india";
  if (p.comp_currency === "USD" || US_PLACE.test(hay)) return "us";
  // 2) Positive foreign signal from the EXPLICIT home fields only (stated location/remote preference +
  //    home currency) — never the headline/narrative, where an incidental foreign mention is not a home.
  //    Checked AFTER india/us so any term shared with the foreign list is already resolved in-market.
  const homeHay = [p.home_place, p.remote, p.location, d.location, d.contact_address, d?.contact?.location].filter(Boolean).join(" ");
  // Same precedence as classifyPlace: an OPEN market is claimed before the foreign catch-all, so
  // OTHER_CURRENCY (which still lists CAD|AUD) needs no edit either. Currency is read first because
  // it is the same "you are paid where you live" signal INR/USD get above.
  if (multiRegionOn() && p.comp_currency === "CAD") return "ca";
  if (multiRegionOn() && p.comp_currency === "AUD") return "au";
  const newMarket = classifyNewMarket(homeHay);
  if (newMarket) return newMarket;
  if (OTHER_CURRENCY.test(String(p.comp_currency || "")) || FOREIGN_HOME.test(homeHay)) return "other";
  return "india"; // India-first: an unknown region defaults to India, so foreign roles are BLOCKED, never leaked ("global" would filter nothing)
}
// Back-compat: some callers still ask "does this person want India?"
export const wantsIndia = (d) => homeRegion(d) === "india";

// Reversible, fail-closed allowlist for the warm-intro / referral feature. Referrals surface
// only for a region named in REFERRAL_REGIONS (comma list). Default "us" keeps India (and
// everything else) DARK — flip to "us,india" to open our second market. An unknown/blank region
// is never in the list, so it fails closed to silence. This is the ONE region switch: scheduler,
// first-role, and the render gate (referralStatus) all consult it, so opening a region can never
// be a fail-to-zero where one site broadens and another still drops.
export function referralRegionAllowed(region) {
  const allowed = String(process.env.REFERRAL_REGIONS || "us")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(String(region || "").toLowerCase());
}

// Robust location test (allowlist, not a foreign-place denylist which always leaks a city like
// "São Paulo"): a person can reach a role only if it names a place IN their home region, or is
// genuinely global-remote (the location, once generic remote words are stripped, names NO specific
// place). "United States (Remote)" = US-only, "São Paulo" = not reachable for an India person.
// Location-FREE work signals: the role is not tied to an office, so stripping them can leave a
// genuinely placeless posting behind.
const GENERIC_REMOTE = /\b(remote|work from home|wfh|anywhere|world ?wide|global|distributed|fully remote|flexible|multiple locations)\b/gi;
// PRESENCE signals: the role requires physically being at an office. These are the OPPOSITE of
// remote and must never be stripped as if they meant "anywhere" — that category error is why an
// "In-Office" Cloudflare role (an Austin desk) was reachable for a Bengaluru candidate: the words
// were stripped, the residue came out empty, the role read as "bare remote", and it fell through
// to companyHiresIndia (true, because Cloudflare posts 2 roles in India).
const ONSITE_PRESENCE = /\b(on[- ]?site|in[- ]?office|hybrid)\b/i;
// Same pattern, global, for stripping only: a real row is "Hybrid; In-Office", and a non-global
// replace leaves "In Office" behind — which then reads as a place name and suppresses the
// Available-Locations lookup below. Kept separate because a /g/ regex is stateful under .test().
const ONSITE_STRIP = /\b(on[- ]?site|in[- ]?office|hybrid)\b/gi;
// Connectives left behind after stripping ("Hybrid or Remote" → "or"). Not places. Treating "or"
// as a place name is why a real "(Based in Bangalore)" role was withheld from India candidates.
// CASE-SENSITIVE on purpose: lowercase "or" is a conjunction, but uppercase "OR" is Oregon —
// "Remote - OR" is a US state posting, and matching it case-insensitively here would strip the
// only evidence of place and let an Oregon role fall through to India.
const NON_PLACE = /^(?:or|and|&|[,;/|\-\s])*$/;
const namesAPlace = (residue) => Boolean(residue) && !NON_PLACE.test(residue);
// When the `location` field holds a work model, some employers state the real city on a STRUCTURED
// line inside the JD ("Available Locations: Bengaluru, India"). Measured on the live pool: 111 of
// Cloudflare's 124 office roles carry it — 11 say "Bengaluru, India", 26 "Austin, US", 4 "Beijing,
// China". That line is the employer's own answer, so it is authoritative in BOTH directions: it
// rescues the real Bengaluru roles AND rules out the Beijing ones. Deliberately narrow: only an
// explicit locations line counts, never a passing mention of a city elsewhere in the prose.
const AVAILABLE_LOC = /available\s+locations?\s*[-:—]?\s*([^\n.]{1,80})/i;
// ca/au are registered UNCONDITIONALLY, not behind MULTI_REGION. reachabilityVerdict's `!placeRe`
// branch fails OPEN ("no-region-filter"), so a region with no entry here would make every role on
// earth reachable. With the flag off homeRegion never returns ca/au and these are simply unused;
// if one ever arrives by another path it is filtered properly instead of waved through.
const REGION_PLACE = { india: INDIA, us: US_PLACE, ca: CA_PLACE, au: AU_PLACE };
// reachabilityVerdict — the single source of truth for the country-level geo gate. Returns
// { reachable, basis }, where `basis` names WHICH branch decided it. reachableForRegion below is a thin
// wrapper returning `.reachable`. The basis lets a caller distinguish a genuinely-foreign drop from
// the ONE recoverable case: `remote-company-unconfirmed` = a placeless bare-remote role dropped ONLY by
// the weak per-company `companyHiresIndia===false` fallback (the case select-jobs.mjs may recover after
// a grounded check). Every other false basis (foreign place, restricted, onsite-no-city) is a correct
// hard drop.
export function reachabilityVerdict(job, region) {
  if (region === "other") return { reachable: false, basis: "out-of-market" }; // out of both markets → NOTHING is reachable (fail closed). "other" users are dropped before scoring; this is the backstop if one ever reaches here.
  if (!region || region === "global") return { reachable: true, basis: "no-region-filter" }; // unknown home region → cannot geo-filter
  const placeRe = REGION_PLACE[region];
  if (!placeRe) return { reachable: true, basis: "no-region-filter" };
  // ONE seam for "does this text name the home region", used by every place test below, so the JOB
  // side and the USER side (classifyNewMarket) can never disagree about the same string. Without it
// AU_PLACE matches "Melbourne, FL" on its own and a Florida role reaches a Sydney inbox.
// Decided ONCE off the RAW location, never off the residue: the residue strip removes commas
// ("Melbourne, FL" -> "Melbourne FL"), and the homonym patterns require the comma, so testing the
// residue would stop disqualifying homonyms.
  const homonymBlocked = (region === "ca" || region === "au")
    && usHomonym(region, `${job?.location || ""} ${job?.region || ""}`);
  const isHome = (text) => !homonymBlocked && placeRe.test(String(text || ""));
  if (isHome(`${job?.location || ""} ${job?.region || ""}`)) return { reachable: true, basis: "home-place-named" }; // a home-region place is named
  // "City, ST" — read off the RAW location only, never the concatenation above. The anchor is
  // end-of-string, so appending job.region would break it, and the whole safety of using a bare state
  // CODE rests on that anchor. US only: no other market uses two-letter codes this way.
  if (region === "us" && isUSCityState(job?.location)) return { reachable: true, basis: "home-place-named" };

// Remote access, Tier 1: for a NON-US candidate, read the role's OWN remote-accessibility from the full JD before the
  // leaky per-company fallback. A home-region-located role already returned above. Computed once, reused
  // below. High precision by design: only an UNAMBIGUOUS bar / openness fires; the ambiguous middle falls
  // through unchanged (Tier 2's grounded verifier judges it). Kill-switch REMOTE_ACCESS=off.
  //   - "restricted" (a hard work-auth / US-hours / EU-only bar) drops here, even on a bare-remote role.
  //   - "open" is applied ONLY at the bare-remote branch below, NEVER here: it must not override an
  //     explicit FOREIGN location (a "Remote (EU)" / "United States" role whose prose happens to say
  //     "anywhere in the world" is still a foreign role — the location is the employer's own answer).
  const access = region !== "us" && remoteAccessOn() ? remoteAccessibility(job) : null;
  if (access === "restricted") return { reachable: false, basis: "remote-restricted" };

  const loc = String(job?.location || "").trim();
  const residue = loc.replace(GENERIC_REMOTE, "").replace(ONSITE_STRIP, "").replace(/[(),;\-/|:]+/g, " ").replace(/\s+/g, " ").trim();

  if (namesAPlace(residue)) { const home = isHome(residue); return { reachable: home, basis: home ? "home-place-named" : "foreign-place-named" }; } // a specific place is named → only if it's home

  // No place in the location field (blank, or only work-model words). Ask the JD's own structured
  // locations line next — the employer stating "Available Locations: Bengaluru, India" settles it,
  // and "Beijing, China" settles it the other way. Only consulted when the location field is silent,
  // so a real location always wins.
  const stated = String(job?.description || "").match(AVAILABLE_LOC)?.[1];
  if (stated) { const home = isHome(stated); return { reachable: home, basis: home ? "home-place-stated" : "foreign-place-stated" }; }

  // Otherwise the city may be in the TITLE ("… SAARC (Based in Bangalore)"). Same precedence rule:
  // a Singapore-LOCATED role titled "… India & South East Asia" already returned above as a
  // Singapore role, so this can only help a posting that named no place at all.
  if (isHome(String(job?.title || ""))) return { reachable: true, basis: "home-place-in-title" };

  // An on-site/hybrid role requires being AT an office, and no city is named in the location, the
  // JD's locations line, or the title — so we cannot know which office. "The company hires in India"
  // is not evidence THIS role is in India. Fail closed: a missed real role is recoverable, a
  // Bengaluru designer emailed an Austin desk job is not.
  if (ONSITE_PRESENCE.test(loc)) return { reachable: false, basis: "onsite-no-city" };

  if (!loc) return { reachable: job?.remote === true, basis: job?.remote === true ? "flagged-remote" : "no-location-not-remote" }; // blank location: reachable ONLY if explicitly flagged remote
// Genuinely bare remote (a placeless role: only work-model words survived the residue strip). A named
// foreign location was already ruled out above, so the Tier-1 "open" verdict is safe to apply HERE: an
  // explicit global-openness signal in the JD ("anywhere in the world", any-timezone, IST-friendly) makes
  // a placeless remote role reachable regardless of the per-company signal.
  if (access === "open") return { reachable: true, basis: "remote-open" };
  // ca/au: the per-company fallback below is companyHiresIndia, which says nothing about whether a
  // company can hire in Canada or Australia. Reusing an India signal to clear an Australian role
  // would be a guess wearing the costume of evidence, so a placeless bare-remote role fails CLOSED
  // in the new markets until a per-market reach signal exists (the tagCompanyReach equivalent).
  // A missed remote role is recoverable; a US-only role in a Toronto inbox on week one is not.
  if (region === "ca" || region === "au") return { reachable: false, basis: "remote-no-market-signal" };
// Otherwise fall back to the per-COMPANY reach signal (companyHiresIndia, from tagCompanyReach). This is
// the ambiguous no-signal bucket the Tier 2 grounded verifier judges at the gate.
  if (region === "us") return { reachable: true, basis: "us-remote-default" };
// NON-US placeless bare-remote, the one recoverable branch. companyHiresIndia===false → a hard
  // drop on the weakest signal (a per-company guess, not evidence about THIS role). Labelled distinctly so
  // the pre-filter can COUNT it (shadow) without touching the drop.
  return job?.companyHiresIndia !== false
    ? { reachable: true, basis: "remote-company-confirmed" }
    : { reachable: false, basis: "remote-company-unconfirmed" };
}
export function reachableForRegion(job, region) { return reachabilityVerdict(job, region).reachable; }

// ── City-corridor (within-region location preference) ─────────────────────────────────────────
// reachableForRegion is COUNTRY-level, so a person who named specific cities in their own words
// ("remote or hybrid within Pune/Nagpur/Bangalore/Indore", "onsite in Bangalore") could otherwise
// get an onsite role in a DIFFERENT same-country city (Noida) as their ONE solo role. This routes that case to
// words only: a person who named NO city, or a REMOTE role, or a role in a city they DID name, is
// untouched. Aliases collapse to one canonical (bengaluru==bangalore, gurgaon==gurugram, cochin==kochi).
const CITY_ALIASES = [
  ["bangalore", /\b(bengaluru|bangalore)\b/i],
  ["mumbai", /\b(mumbai|bombay)\b/i],
  ["delhi", /\b(new delhi|delhi)\b/i],
  ["hyderabad", /\bhyderabad\b/i],
  ["pune", /\bpune\b/i],
  ["chennai", /\bchennai\b/i],
  ["gurugram", /\b(gurgaon|gurugram)\b/i],
  ["noida", /\bnoida\b/i],
  ["kolkata", /\b(kolkata|calcutta)\b/i],
  ["ahmedabad", /\bahmedabad\b/i],
  ["kochi", /\b(kochi|cochin)\b/i],
  ["trivandrum", /\b(thiruvananthapuram|trivandrum)\b/i],
  ["coimbatore", /\bcoimbatore\b/i],
  ["indore", /\bindore\b/i],
  ["jaipur", /\bjaipur\b/i],
  ["san francisco", /\b(san francisco|sf bay|bay area)\b/i],
  ["new york", /\b(new york city|new york|nyc)\b/i],
  ["seattle", /\bseattle\b/i],
  ["austin", /\baustin\b/i],
  ["boston", /\bboston\b/i],
  ["chicago", /\bchicago\b/i],
  ["denver", /\bdenver\b/i],
  ["atlanta", /\batlanta\b/i],
  ["los angeles", /\blos angeles\b/i],
];
function citiesIn(text) {
  const t = String(text || "");
  const found = new Set();
  for (const [canon, re] of CITY_ALIASES) if (re.test(t)) found.add(canon);
  return found;
}
// The canonical cities a person EXPLICITLY named in their stated preference + resume location signal.
export function statedCities(dossier) {
  const d = dossier || {}; const p = d.preferences || {};
  const hay = [p.remote, p.location, d.location, d.headline, d.contact_address, d?.contact?.location].filter(Boolean).join(" ");
  return citiesIn(hay);
}
// The canonical city/cities a role is pinned to IF it is location-bound (not explicitly remote and not a
// bare-remote location). null for a remote role or one that names no known city (fail-open: an unknown
// city never over-holds). A role may name more than one ("Bangalore / Chennai").
export function onsiteCity(job) {
  if (job?.remote === true) return null; // explicitly remote → no city pin
  const loc = String(job?.location || "");
  const residue = loc.replace(GENERIC_REMOTE, "").replace(ONSITE_STRIP, "").replace(/[(),;\-/|:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!loc || (!namesAPlace(residue) && !ONSITE_PRESENCE.test(loc))) return null; // bare-remote / placeless
  const cities = citiesIn(`${loc} ${job?.title || ""}`);
  return cities.size ? cities : null;
}
const cityCorridorOn = () => String(process.env.CITY_CORRIDOR ?? "on").toLowerCase() !== "off";

// ── Remote accessibility (Tier 1, deterministic) ─────────────────────────────────────────────
// The per-company `companyHiresIndia` guess is not evidence THIS remote role is open to India — that is
// the "dump every remote role on Indian candidates" behavior the Indian boards do; we don't. Read the
// role's OWN region/timezone/eligibility signal from the full JD instead. Calibrated on real remote
// roles: a naive "overlap with US" or a bare "EMEA" mention is mostly a FALSE positive
// (multi-region employers; "evening IST overlap" roles that actually WANT an India-based person), so
// Tier 1 fires ONLY on unambiguous signals. The ambiguous middle is deferred to Tier 2's grounded
// model verifier (never guessed here). Returns "open" | "restricted" | "unknown".
//
// AFFIRMATIVE openness (high precision): explicitly works from anywhere / any timezone. Only counts for a
// genuinely remote role. IST/India named in a working-hours context means the role WANTS an India person.
const REMOTE_OPEN = /\b(work from anywhere|anywhere in the world|globally distributed|distributed (?:across|around) the (?:world|globe)|remote worldwide|across all time ?zones|regardless of (?:location|time ?zone)|any time ?zone)\b/i;
const IST_FRIENDLY = /\b(ist\b|india standard time|indian standard time)\b/i;
// UNAMBIGUOUS timezone bar (candidate must sit in US hours) — NOT the soft "overlap with US/Europe",
// which is often IST-doable or India-welcoming and is left for Tier 2.
const TZ_RESTRICT = /\b(?:must (?:be|work)|core (?:working )?hours (?:are|of)|standard (?:working )?hours are|work(?:ing)? (?:hours|schedule) (?:are|is|aligned))\s+[^.]{0,30}\b(?:est|pst|cst|mst|eastern time|pacific time|central time|us business hours|u\.?s\.? (?:business )?hours)\b/i;
// EMEA/EU EXCLUSIVE eligibility (a real bar) — NOT a bare "EMEA" mention among several regions.
const EU_ONLY = /\b(?:eligible to work in (?:the )?(?:eu|european union|uk|united kingdom|europe)|must (?:be|reside|be based|be located) (?:in|within) (?:the )?(?:eu|european union|europe|emea)|(?:eu|europe)[- ]based (?:only|role|position|candidates?)|within (?:the )?emea (?:region|market) only)\b/i;
export function remoteAccessibility(job) {
  const isRemote = job?.remote === true || /\bremote\b/i.test(String(job?.location || ""));
  const text = `${job?.title || ""} . ${job?.description || ""}`;
  if (isRemote && (REMOTE_OPEN.test(text) || IST_FRIENDLY.test(text))) return "open";
  if (usAuthRequired(job)) return "restricted"; // reuse the candidate-scoped US work-auth check
  if (TZ_RESTRICT.test(text)) return "restricted";
  if (EU_ONLY.test(text)) return "restricted";
  return "unknown";
}
const remoteAccessOn = () => String(process.env.REMOTE_ACCESS ?? "on").toLowerCase() !== "off";
const isRemoteish = (job) => job?.remote === true || /\bremote\b/i.test(String(job?.location || ""));
// Remote access Tier 2 mode: "on" (default, enforce a drop), "shadow" (log the would-drop, don't act), "off".
// Exported so the recovery path in select-jobs.mjs can REQUIRE the verifier before letting a role through.
// One definition of "is Tier 2 armed", never two strings that agree today and drift tomorrow.
export const tier2Mode = () => String(process.env.REMOTE_ACCESS_TIER2 ?? "on").toLowerCase();

// ── Language requirement gate ─────────────────────────────────────────────────────────────────
// A non-English fluency requirement in the JD is a hard eligibility bar: an English-only candidate
// cannot do a role that demands business-fluent German. We only trigger on a genuine FLUENCY demand
// (not "German market" or "German a plus"), and only block when the candidate's dossier shows no
// evidence of that language. English is assumed present.
const LANG_TERMS = {
  german: /\b(german|deutsch)\b/i, french: /\b(french|fran[cç]ais)\b/i,
  spanish: /\b(spanish|espa[nñ]ol|castellano)\b/i, dutch: /\b(dutch|nederlands)\b/i,
  italian: /\b(italian|italiano)\b/i, portuguese: /\b(portuguese|portugu[eê]s)\b/i,
  mandarin: /\b(mandarin|cantonese|chinese)\b/i, japanese: /\b(japanese|nihongo)\b/i,
  korean: /\b(korean)\b/i, arabic: /\b(arabic)\b/i, polish: /\b(polish|polski)\b/i,
};
const FLUENCY_CTX = /\b(fluent|fluency|native|proficient|proficiency|required|must speak|business[- ]?fluent|c1|c2|b2|verhandlungssicher|mother ?tongue|speaker|speaking|bilingual|working knowledge)\b/i;
const NOT_REQUIRED_CTX = /\b(a plus|nice to have|bonus|preferred|optional|desirable|advantageous|would be|is a plus)\b/i;
export function jobLanguageRequirements(job) {
  const title = String(job?.title || ""); const text = `${title} . ${job?.description || ""}`;
  const req = [];
  for (const [lang, re] of Object.entries(LANG_TERMS)) {
    const m = re.exec(text); if (!m) continue;
    // a "(German)" / "[German]" tag in the TITLE is an unambiguous hard requirement
    if (new RegExp(`[\\(\\[]\\s*${lang}[^\\)\\]]*[\\)\\]]`, "i").test(title)) { req.push(lang); continue; }
    // otherwise require a fluency context nearby, and NOT a "a plus / nice to have" context
    const idx = m.index; const win = text.slice(Math.max(0, idx - 70), idx + m[0].length + 70);
    if (FLUENCY_CTX.test(win) && !NOT_REQUIRED_CTX.test(win)) req.push(lang);
  }
  return [...new Set(req)];
}
export function dossierLanguages(dossier) {
  const set = new Set(["english"]); // English is assumed; safe default
  const p = dossier?.preferences || {};
  const listed = [].concat(p.languages || dossier?.languages || []);
  const hay = [dossier?.headline, ...(Array.isArray(dossier?.proof_points) ? dossier.proof_points.map((pp) => `${pp.claim || ""} ${pp.evidence || ""}`) : [])]
    .filter(Boolean).join(" ");
  for (const [lang, re] of Object.entries(LANG_TERMS)) {
    if (listed.some((l) => re.test(String(l)) || String(l).toLowerCase().includes(lang))) set.add(lang);
    if (re.test(hay) && FLUENCY_CTX.test(hay)) set.add(lang); // "fluent in German" stated on the resume
  }
  return set;
}
// Returns the array of required languages the candidate LACKS, or null if none (i.e. eligible).
export function languageBlocker(job, dossier) {
  const req = jobLanguageRequirements(job); if (!req.length) return null;
  const have = dossierLanguages(dossier);
  const missing = req.filter((l) => !have.has(l));
  return missing.length ? missing : null;
}

// ── Work-authorization eligibility gate ───────────────────────────────────────────────────────
// A hard US work-authorization / citizenship / security-clearance / US-residency requirement is an
// eligibility bar a candidate outside the US cannot clear, EVEN when the location string looked
// global-remote. This is the classic false-positive of a location-only check: a role labelled
// "Remote" that actually says "must be authorized to work in the US". Like the language gate, we
// trigger only on a genuine requirement, and we STAND DOWN if the JD explicitly offers sponsorship.
const US_AUTH_REQ = new RegExp(
  [
    "authoriz(?:ed|ation) to work in (?:the )?(?:united states|u\\.?s\\.?a?)",
    "legally authoriz(?:ed|ation) to work in (?:the )?u\\.?s",
    "u\\.?s\\.? work authoriz(?:ation|ed)",
    "eligib(?:le|ility) to work in (?:the )?(?:united states|u\\.?s)",
    "must be (?:a |an )?(?:u\\.?s\\.?|united states) citizen",
    "u\\.?s\\.? citizenship (?:is )?required",
    "require[sd]? (?:u\\.?s\\.?|united states) citizenship",
    "(?:active|current|ability to obtain)(?: a)? (?:u\\.?s\\.? )?security clearance",
    "must (?:reside|be based|be located) (?:in|within) (?:the )?(?:united states|u\\.?s\\b)",
    "u\\.?s\\.?[- ]based (?:role|position|candidates?|only|applicants?)",
  ].join("|"),
  "i",
);
// Sponsorship is OFFERED (an outside-US candidate can still get the role) vs explicitly DENIED
// (strengthens the bar). "offer <up to 3 words> sponsor" catches "offer visa sponsorship" etc.
const YES_SPONSOR = /\b(?:offer|offering|provide|providing|will|can|happy to|willing to|open to)\s+(?:\w+\s+){0,3}sponsor|sponsorship\s+(?:is\s+)?(?:available|offered|provided|possible)/i;
const NO_SPONSOR = /\b(?:no|not|never|cannot|can'?t|won'?t|unable to|without|do(?:es)?n'?t|do(?:es)? not)\s+(?:\w+\s+){0,3}sponsor/i;
export function usAuthRequired(job) {
  const text = `${job?.title || ""} . ${job?.description || ""}`;
  if (!US_AUTH_REQ.test(text)) return false;
  // If they positively offer sponsorship (and don't also deny it), an outside-US candidate can get it.
  if (YES_SPONSOR.test(text) && !NO_SPONSOR.test(text)) return false;
  return true;
}
// Returns a short reason string if the role is a hard eligibility bar for this home region, else null.
// A US-based candidate clears US authorization; anyone else is blocked by a genuine US-auth demand.
export function eligibilityBlocker(job, region) {
  if (region === "us") return null;
  return usAuthRequired(job) ? "requires US work authorization" : null;
}

async function fetchWithTimeout(url, fetchImpl) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_MS);
  try { return await (fetchImpl || fetch)(url, { headers: { accept: "application/json" }, signal: c.signal }); }
  finally { clearTimeout(t); }
}

// The set of sources we can authoritatively check by id against an ATS API. For these, a NETWORK
// failure is NOT the same as "posting is gone" — it means we couldn't confirm, so after retries we
// return {ok:false, ambiguous:true} and the gate routes to DIGEST (never a confident solo send, never
// a hard drop). A confirmed non-200 (404/410) is a real close → {ok:false} → drop.
const CHECKABLE_SOURCES = new Set(["greenhouse", "lever", "smartrecruiters", "ashby"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One attempt against the by-id ATS endpoint. Returns a concrete {ok,status} on a real HTTP answer,
// or throws so the retry loop can catch a transient network/timeout error and try again.
async function checkableAttempt(source, slug, jobId, fetchImpl) {
  if (source === "greenhouse") { const r = await fetchWithTimeout(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}`, fetchImpl); return { ok: r.status === 200, status: r.status }; }
  if (source === "lever") { const r = await fetchWithTimeout(`https://api.lever.co/v0/postings/${slug}/${jobId}`, fetchImpl); return { ok: r.status === 200, status: r.status }; }
  if (source === "smartrecruiters") { const r = await fetchWithTimeout(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${jobId}`, fetchImpl); return { ok: r.status === 200, status: r.status }; }
  // ashby: the board is one document; a non-200 on the board itself is NOT a confirmed close (the board
  // may be briefly unreadable) → throw so it's treated as a transient/ambiguous error, not a drop.
  const r = await fetchWithTimeout(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, fetchImpl);
  if (r.status !== 200) throw new Error(`ashby board status ${r.status}`);
  const j = await r.json().catch(() => ({}));
  const found = (j.jobs || []).some((x) => String(x.jobId || x.id) === jobId || (x.applyUrl || "").includes(jobId));
  return { ok: found, status: found ? 200 : 410 };
}

// Is this posting still open?
//   checkable source (ATS by-id): confirmed 200 → live; confirmed 404/410 → closed (drop); after
//     LIVE_RETRIES all NETWORK errors (can't confirm) → {ok:false, ambiguous:true} → gate routes to
//     digest, never a confident send and never a hard drop.
//   uncheckable remote-board source: HTML fallback on the (SSRF-guarded) apply_url. A 200 that doesn't
//     look closed = live; a 4xx/5xx or a closed-marker = drop. A network error here is UNconfirmable →
//     ambiguous → digest (failing open here could send a dead link).
//   nothing to check at all → fail open (ok, status 0): there is no evidence of a close and nothing we
//     could ever verify, so we don't punish a role for being on a source we can't probe.
export async function checkLiveness(job, fetchImpl) {
  const [source, slug, jobId] = String(job?.id || "").split(":");

  if (CHECKABLE_SOURCES.has(source)) {
    let lastErr = null;
    for (let attempt = 1; attempt <= Math.max(1, LIVE_RETRIES); attempt++) {
      try {
        return await checkableAttempt(source, slug, jobId, fetchImpl);
      } catch (e) {
        lastErr = e;
        if (attempt < Math.max(1, LIVE_RETRIES)) await sleep(LIVE_BACKOFF_MS * attempt);
      }
    }
    // retries exhausted on a checkable source: we could not CONFIRM live or closed → ambiguous → digest.
    return { ok: false, ambiguous: true, status: -1, error: lastErr?.message || "network" };
  }

  // remote boards / unknown source: HTML fallback on the apply URL — SSRF-guarded, because apply_url
  // for these sources comes verbatim from a third-party board (attacker can post a job pointing at an
  // internal/metadata address). safeFetch blocks that; an unsafe URL throws → caught below → ambiguous.
  if (job?.apply_url) {
    try {
      const r = await safeFetch(job.apply_url, { timeoutMs: FETCH_MS });
      if (r.status >= 400) return { ok: false, status: r.status };
      const t = await r.text().catch(() => "");
      const closed = /no longer (accepting|available)|position (has been )?(closed|filled)|this (job|position) is (closed|no longer)|not accepting applications|posting (is )?closed/i.test(t);
      return { ok: !closed, status: closed ? 410 : 200 };
    } catch (e) {
      // couldn't reach the board (network/timeout/SSRF-blocked) → cannot confirm → ambiguous → digest.
      return { ok: false, ambiguous: true, status: -1, error: e?.message || "network" };
    }
  }
  return { ok: true, status: 0 }; // nothing to check anywhere → fail open (no close evidence, nothing to verify)
}

// Route ONE role. getCov: an async () => cov (computeCoverage result); called only if the role is
// live + reachable, so we never spend the Sonnet pass on a dead/foreign posting. Returns the cov it
// computed so the caller can reuse it for the send.
export async function gateRole({ job, dossier, matcherScore, getCov, fetchImpl, verifyAccess = verifyRemoteAccess } = {}) {
  // 1) Liveness — a dead posting is always a drop (send OR digest must be live). But a liveness check
  //    we could NOT confirm (transient network error after retries) is uncertainty, not death: fail
  //    CLOSED to a confident solo send by routing it to the digest ("worth a look"), never a hard drop
  //    (we might be dropping a live role) and never a confident send (we can't prove the link works).
  const live = await checkLiveness(job, fetchImpl);
  if (!live.ok && live.ambiguous) {
    return { outcome: "digest", rule: "liveness:unconfirmed", reason: "couldn't confirm this posting is still open, so holding it back from a solo send", cov: null };
  }
  if (!live.ok) return { outcome: "drop", rule: "liveness:closed", reason: `posting closed (${live.status})`, cov: null };

  // 2) Location accessibility — fits the profile but isn't reachable from the candidate's home
  //    region (derived from the whole dossier, symmetric for India AND US) → digest.
  const region = homeRegion(dossier);
  if (!reachableForRegion(job, region)) {
    // HARD STOP, not digest: a role in a region the person cannot work in has no value even in the
    // weekly list, and it must never reach them. A US role never reaches an India candidate, period.
    return { outcome: "drop", rule: "region:unreachable", reason: `location (${job.location || "unspecified"}) is not reachable from your region`, cov: null };
  }

  // 2-remote) Remote access Tier 2: the ambiguous remote roles (Tier-1 verdict "unknown") that reachableForRegion
  //     passed only on the weak per-company signal get a grounded, fail-closed model check against the FULL
  //     JD. Only a NON-US candidate, only a genuinely remote role, only the handful that reach the gate, so
  //     cost is negligible (a few calls per user per day). fail-closed: accessible=false → hard drop, same
  //     as the region gate above. "skipped" (no key / Tier 2 off) → keep the Tier-1 result, never a blanket
  //     drop (guards the fail-closed-becomes-fail-to-zero class). shadow mode logs the would-drop only.
  // Skip a role whose location already NAMES the home region (it passed reachableForRegion on that explicit
  // signal, not the weak company fallback) — verifying an India-located remote role is wasteful and wrong.
  const homeNamed = REGION_PLACE[region]?.test(`${job?.location || ""} ${job?.region || ""}`);
  const t2 = tier2Mode();
  if (region !== "us" && t2 !== "off" && isRemoteish(job) && !homeNamed && remoteAccessibility(job) === "unknown") {
    const v = await verifyAccess({ job, region });
    if (!v.skipped && !v.accessible) {
      if (t2 === "shadow") {
        console.error(`[tier2 shadow] WOULD drop ${job.id || job.title || "?"} — not open to ${region}: ${v.reason || "region/timezone bar"}`);
      } else {
        return { outcome: "drop", rule: "remote-access:region-barred", reason: `this remote role isn't genuinely open to your region (${v.reason || "region or timezone restriction"})`, cov: null };
      }
    }
  }

  // 2a) Work-authorization eligibility — a hard US work-auth / citizenship / clearance requirement the
  //     candidate can't meet, even on a role whose LOCATION looked global-remote. Hard drop, not digest:
  //     a role that requires authorization she cannot get has no value even in the weekly list.
  const eligBlock = eligibilityBlocker(job, region);
  if (eligBlock) {
    return { outcome: "drop", rule: "eligibility:work-auth", reason: `this role ${eligBlock}, which isn't available from your region`, cov: null };
  }

  // 2a-ko) THE KNOCKOUT FLOOR (eligibility-gate.mjs). Hard + score-INDEPENDENT: a role
  //     that is structurally wrong for THIS person — their seeker mode, professional-experience floor,
  //     employment type, or a stated dealbreaker sitting in the JD body — is dropped before fit is ever
  //     considered, so a student seeking an internship is never sent a "2 years required" role however
  //     high the matcher scored it. BOTH send paths reach here via preSendGuard. Shadow by default
  //     (KNOCKOUT_MODE): logs the would-drop and changes NOTHING until flipped to enforce (mirrors the
  //     grounding + Tier-2 shadow pattern). knockouts() fires only on a positive conflict with a KNOWN
  //     candidate fact, so an existing user without seeker fields is never over-blocked (fail-open).
  const ko = knockouts(job, dossier);
  if (ko.length) {
    if (knockoutMode() === "enforce") {
      return { outcome: "drop", rule: "knockout:structural", reason: `this role isn't a fit for what you're looking for (${ko[0]})`, cov: null };
    }
    if (knockoutMode() === "shadow") console.error(`[knockout shadow] WOULD drop ${job?.id || job?.title || "?"} — ${ko.join("; ")}`);
  }

  // 2a-bis) City-corridor: the person named specific cities they want to work in, and this role is
  //     onsite/hybrid pinned to a DIFFERENT city in the same country (region already matched above, so the
  //     country gate can't see it). Route to DIGEST, not the solo send: they might relocate, so keep it out
  //     of the ONE role but surface it weekly. Runs BEFORE the cov (Sonnet) pass so a city mismatch is
  //     cheap. Fail-open: no stated city, a remote role, an unknown city, or a matching city → untouched.
  if (cityCorridorOn()) {
    const mine = statedCities(dossier);
    const theirs = onsiteCity(job);
    if (mine.size && theirs && ![...theirs].some((c) => mine.has(c))) {
      // Worded to contain "location" so digest.mjs's noteFor() routes it to the clean canned
      // location note ("outside your usual area, worth a look if you're flexible") — the raw city
  //     tokens here are for logs only, never shown to the user (no mechanism/raw-token leak).
      return { outcome: "digest", rule: "city-corridor:outside", reason: `onsite location (${job.location || "another city"}) is outside the cities you named (${[...mine].join(", ")})`, cov: null };
    }
  }

  // 2b) Language eligibility — a hard non-English fluency requirement the candidate can't meet → digest
  //     (kept out of the solo send; the honest reason names the language, so a speaker can add it).
  const missingLang = languageBlocker(job, dossier);
  if (missingLang) {
    return { outcome: "digest", rule: "language:required", reason: `this role needs ${missingLang.join(", ")} fluency, which isn't in your profile`, cov: null };
  }

  // 3+4) Fit routing. The LEGACY route is two separate gates: the matcher bar (drop below MATCH_BAR)
  //      then the fit floor (digest below FIT_FLOOR). The unified mode folds them into ONE composite; both
  //      routes are computed so shadow mode can log the divergence without changing behavior.
  const cov = getCov ? await getCov() : null;
  const covScoreable = cov && !cov.thin && typeof cov.composite === "number";

  // 2c) THE DATA-SUFFICIENCY GATE. computeCoverage could not score this person at all: their profile is
  //     too sparse to compare against ANY posting (reason "dossier", not "jd"). Without this, `thin`
  //     silently SKIPS the fit floor below, so the people we know least about would receive the
  //     least-checked roles, judged on the matcher score alone. That inverts the whole product.
  //     Rather send nothing: a dropped role is invisible, and with no emailed find the completeness
  //     nudge takes over and asks them for more (completeness-nudge.mjs only nudges while no role has
  //     landed). This is the "gentle nudges only until we genuinely know enough" rule, in code.
  //     NOTE: reason "jd" (a vague posting) deliberately does NOT drop — that is the employer's
  //     fault, not the person's, and blocking it would silence real roles.
  if (cov?.thin && cov.reason === "dossier") {
    return { outcome: "drop", rule: "data-sufficiency:profile-thin", reason: "I don't know enough about you yet to be sure this one fits", cov: null };
  }

  // 2d) THE SENIORITY-GAP HARD STOP. The fit pass already judged the person materially UNDER the role's
  //     required years/level (seniorityLevel "under") AND the seniority subscore is deep (a real chasm,
  //     not a one-level stretch). A 7-year person must not be emailed a 12-14-year role as their ONE
  //     role of the day; a role they cannot
  //     realistically land has no value even in the weekly digest. Gated on the DEEP band only
  //     (SENIORITY_UNDER_FLOOR) so a normal stretch still sends. The matcher rubric (matcher.md) caps the
  //     score for the same case; this deterministic stop is the belt to that model-side suspenders.
  if (seniorityChasm(cov)) {
    return { outcome: "drop", rule: "seniority:chasm", reason: `this role is aimed well above your level right now (${job.title || "senior role"})`, cov: null };
  }

  // 2e) THE PAY-FLOOR HARD STOP. Onboarding asks for "your pay floor, so I never send you anything
  //     below it" (email-onboard.mjs); this keeps that promise in code rather than relying on the
  //     matcher prompt to notice an under-floor posting.
  //
  //     Same fail-open discipline as 2d: belowStatedFloor returns NO OPINION unless the posting
  //     volunteered a readable number in the person's own currency. Most postings disclose no pay,
  //     so this can never become a quiet mass silence. PAY_FLOOR_MODE=shadow counts without
  //     dropping, so it can be stood down without a deploy.
  const payVerdict = belowStatedFloor(job?.compensation, dossier?.preferences);
  if (payVerdict?.below) {
    const shadow = String(process.env.PAY_FLOOR_MODE || "enforce").toLowerCase() === "shadow";
    console.error(`[pay-floor] ${shadow ? "SHADOW " : ""}below stated floor: role max ${payVerdict.roleMax} < floor ${payVerdict.floor} ${payVerdict.currency} — ${job?.title || "?"}`);
    if (!shadow) {
      return { outcome: "drop", rule: "pay-floor:below", reason: "it pays below the floor you gave me", cov: null };
    }
  }

  // legacy two-gate decision (matcher bar, then fit floor)
  let legacy;
  if (typeof matcherScore === "number" && matcherScore < Number(process.env.MATCH_BAR || 70)) {
    legacy = { outcome: "drop", rule: "match-bar:below", reason: `below the match bar (${matcherScore})`, cov: null };
  } else if (covScoreable && cov.composite < FIT_FLOOR) {
    legacy = { outcome: "digest", rule: "fit-floor:below", reason: `fits your profile, but you clear only ${cov.composite}/100 of what they ask`, cov };
  } else {
    legacy = { outcome: "send", rule: "fit:clears", reason: "live, reachable, and clears your bar", cov };
  }

  const mode = unifiedMode();
  const unified = unifyScore(matcherScore, covScoreable ? cov.composite : null);
  const uRoute = unifiedRoute(unified, covScoreable ? cov.composite : null, matcherScore);

  if (mode === "on") {
    const grounded = covScoreable ? cov.composite : null; // the true grounded number, BEFORE the readout stamp
    if (covScoreable && unified != null) cov.composite = unified; // ONE number also drives the readout
    if (uRoute === "drop") return { outcome: "drop", rule: "match-bar:below", reason: `below the match bar (${matcherScore})`, cov };
    // A digest here comes from the grounded-floor guard, so report the GROUNDED coverage, never the
  // matcher-inflated blend (never overstate a fit metric). Legacy phrasing so digest.mjs's
  // noteFor() replaces it with the canned user note (no raw score / mechanism leak).
    if (uRoute === "digest") return { outcome: "digest", rule: "fit-floor:below", reason: `fits your profile, but you clear only ${grounded ?? unified}/100 of what they ask`, cov };
    return { outcome: "send", rule: "fit:clears", reason: "live, reachable, and clears your bar", cov };
  }
  if (mode === "shadow" && uRoute !== legacy.outcome) {
    console.error(`[unify shadow] matcher=${matcherScore} cov=${covScoreable ? cov.composite : "thin"} unified=${unified} · legacy=${legacy.outcome} unified-route=${uRoute}`);
  }
  return legacy;
}

