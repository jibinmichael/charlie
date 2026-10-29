// send-audit.mjs — the post-send self-audit ("Charlie catches his own slip").
//
// After a role reaches someone, re-read it against their HARD constraints and FLAG a likely miss to a
// human (log + Sentry). It is a SAFETY NET behind the pre-send gates, not a replacement for them.
//
// TWO hard rules:
//   1) It NEVER auto-sends a correction. A wrong/spam correction is worse than the original miss, and it
//      would be an unattended send path. The flag goes to a human who decides.
//   2) It runs AFTER the send and NEVER throws into the caller (best-effort observability, never a gate).
//
// Canonical case it catches: a remote-only person handed a role in another city.
// Deterministic; extend `auditRole` with new hard constraints (comp floor, work-auth) as they are needed.

/**
 * Deterministic hard-constraint check of ONE role against ONE person. Returns [] when clean.
 * @returns {{rule:string, severity:"high"|"med", detail:string}[]}
 */
// One city, several spellings. Renamed Indian cities are the load-bearing case — candidates type the
// older name they grew up with and employers post the official one (or the reverse) — with a couple
// of common US/UK short forms alongside. Deliberately a SMALL, explicit list of true aliases for the
// SAME place: this widens what counts as "your city", so a wrong entry here would wave through a role
// in a genuinely different city. Never add a near-neighbour (Noida is not Delhi, Thane is not Mumbai)
// or a metro-area shorthand — only names for the same municipality.
const CITY_ALIASES = [
  ["bangalore", "bengaluru"],
  ["mumbai", "bombay"],
  ["chennai", "madras"],
  ["kolkata", "calcutta"],
  ["gurgaon", "gurugram"],
  ["kochi", "cochin", "ernakulam"],
  ["pune", "poona"],
  ["trivandrum", "thiruvananthapuram"],
  ["vadodara", "baroda"],
  ["mysore", "mysuru"],
  ["pondicherry", "puducherry"],
  ["new york", "nyc"],
];

// Words that appear in a location preference but are not a place someone can go to work. Split into
// two kinds, because they are excluded for two different reasons:
//   - GRAMMAR: the connective tissue of a sentence ("open to", "or", "ideally").
//   - TOO BROAD: a country or region. "hybrid in Pune (India), otherwise remote (India)" names ONE city she can commute to;
//     reading "India" as an acceptable place would wave through an onsite role 2,000 km away. People
//     who write a country almost always also name a real city, so dropping the country token costs
//     them nothing. A smaller place stays in — someone who writes "or in Lisbon" means Lisbon.
const NOT_A_PLACE = new Set([
  "remote", "hybrid", "onsite", "office", "anywhere", "open", "also", "only", "either", "ideally",
  "fully", "prefer", "preferred", "willing", "relocate", "roles", "role", "work", "from", "home",
  "and", "or", "in", "at", "the", "a", "city", "based", "flexible", "wfh",
  "india", "usa", "us", "u.s.", "u.s", "america", "american", "united", "states", "uk", "europe",
  "emea", "apac", "asia",
]);

/**
 * Every place a person said yes to, in their own words.
 *
 * WHY THIS READS `preferences.remote` AND NOT JUST `home_place`. `home_place` is often empty for
 * people who want remote, and they name their cities inside the remote preference itself, e.g.
 *
 *     "mostly remote, though Bangalore, Cochin or Hubli would work"
 *     "remote is ideal; a hybrid setup in Chennai or Madurai is fine too"
 *
 * Reading `home_place` alone would see "remote", find no home city, and drop every office role in the
 * cities the person just listed. Not a bad send — silence. And silence is the failure this product
 * cannot see: "Charlie found nothing" and "Charlie stopped looking" arrive in an inbox identically.
 *
 * This can only ever WIDEN, and only to places the person typed. It cannot invent a city (every token
 * comes from their own words) and it cannot reach a city they did not name.
 *
 * @returns {string[]} lowercase place tokens, every known spelling included
 */
export function acceptablePlaces(prefs = {}) {
  const said = `${prefs.home_place || ""} , ${prefs.remote || ""}`.toLowerCase();
  const tokens = (said.match(/[a-z][a-z.]{2,}/g) || []).filter((w) => !NOT_A_PLACE.has(w) && w.length >= 4);
  return [...new Set(tokens.flatMap((t) => cityVariants(t)))];
}

/**
 * Every spelling of a city, including the one given. Unknown cities return just themselves, so this
 * can only ever widen a match for a city we know about — never narrow one.
 * @param {string} city lowercase city token
 * @returns {string[]}
 */
export function cityVariants(city) {
  const c = String(city || "").toLowerCase().trim();
  if (!c) return [];
  for (const group of CITY_ALIASES) if (group.includes(c)) return group;
  return [c];
}

/**
 * What the POSTING says about where the work happens. Tri-state, never a guess.
 *
 * `job.remote` is already normalised to exactly this by scan-jobs.mjs — `true` when the source said
 * remote, `false` when it said otherwise, `null` when it said nothing. Most roles (roughly two in
 * three) say nothing at all, so the unknown case is the COMMON case and must be handled as its own
 * answer, not folded into either side.
 *
 * @returns {"remote"|"onsite"|"unknown"}
 */
export function workArrangement(role) {
  if (role?.remote === true) return "remote";
  if (/\bremote\b/i.test(String(role?.location || ""))) return "remote"; // the location field said it outright
  if (role?.remote === false) return "onsite";
  return "unknown";
}

/**
 * Did this person rule out going to an office — anywhere, including their own city?
 *
 * This is deliberately NARROW. Most people who mention remote in `preferences.remote` have not ruled
 * out an office: they write things like "Remote or Bengaluru, Hyderabad, Pune" or "Fully Remote or
 * Hybrid - Pune, Nagpur" — they want remote AND will take a desk. Treating those as remote-only
 * would digest roles they would happily have taken, which is the silence failure, not a fix for it.
 *
 * So an office word anywhere in the sentence disqualifies, checked BEFORE the remote-only phrase:
 * "Fully Remote or Hybrid" contains "fully remote" and still means they accept hybrid.
 *
 * @returns {boolean}
 */
export function remoteOnly(prefs = {}) {
  const said = String(prefs.remote || "");
  if (!/remote/i.test(said)) return false;
  if (/\b(on[\s-]?site|onsite|hybrid|in[\s-]?office|in the office|wfo)\b/i.test(said)) return false;
  // Either they said so outright, or they named remote and no place to go to.
  return /\b(remote[\s-]?only|only remote|fully remote|100%\s*remote|work from home only)\b/i.test(said)
    || acceptablePlaces(prefs).length === 0;
}

export function auditRole({ dossier, role } = {}) {
  const findings = [];
  const prefs = (dossier && dossier.preferences) || {};
  const loc = String(role?.location || "").toLowerCase();
  const isRemoteRole = role?.remote === true || /\bremote\b/.test(loc);

  // 1) Location / remote — a remote-wanting person handed a non-remote, non-home-city role.
  const wantsRemote = /remote/i.test(String(prefs.remote || ""));
  if (wantsRemote && !isRemoteRole) {
    // Substring-match the home city across ALL of its spellings. A person writes "Bangalore"; the
    // employer writes "Bengaluru". Same city, and both spellings are common in the pool, so a naive
    // compare would withhold a large share of someone's own city — and preSendGuard gates on this.
    const inNamedPlace = acceptablePlaces(prefs).some((v) => loc.includes(v));
    if (!inNamedPlace) {
      findings.push({ rule: "location:remote-mismatch", severity: "high", detail: `wants remote; role location is "${role?.location || "unstated"}"` });
    } else if (remoteOnly(prefs)) {
      // 1b) ARRANGEMENT, asked independently of city.
      //
      // The check above can only ever ask "is this role in a place they named?". For someone who ruled
      // out an office, that is the wrong question, and it answers yes for the one case that matters: a
      // Bengaluru desk offered to somebody in Bengaluru who said fully remote. The city matches, so
      // nothing fires, and the role goes out.
      //
      // The shape this catches: "Fully remote, based in Bengaluru, India" handed a Bengaluru office
      // role. Their city is not the problem; the arrangement is.
      //
      // Unknown is its own answer and is NOT waved through: most of the pool states no arrangement, so
      // guessing "probably remote" would be guessing on two roles in three. It goes to the digest with
      // that as the recorded reason, which is visible now that the rule is stored (digest_rule).
      // `high` routes to digest via presend-guard's hardConstraintMiss — never a drop, never a silent
      // send. A remote-only person still reaches every role that says remote outright.
      const arrangement = workArrangement(role);
      if (arrangement === "onsite") {
        findings.push({ rule: "arrangement:onsite-vs-remote-only", severity: "high", detail: `wants remote only; this role is not remote ("${role?.location || "unstated"}")` });
      } else if (arrangement === "unknown") {
        findings.push({ rule: "arrangement:unknown", severity: "high", detail: `wants remote only; the posting doesn't say whether it is remote ("${role?.location || "unstated"}")` });
      }
    }
  }

  // 2) Dealbreakers — a stated dealbreaker token appears in the role title/description.
  const dealbreakers = Array.isArray(prefs.dealbreakers) ? prefs.dealbreakers : [];
  const hay = `${role?.title || ""} ${role?.description || ""}`.toLowerCase();
  for (const db of dealbreakers) {
    const t = String(db || "").toLowerCase().trim();
    if (t.length >= 4 && hay.includes(t)) {
      findings.push({ rule: "dealbreaker:hit", severity: "high", detail: `role matches stated dealbreaker "${db}"` });
    }
  }

  return findings;
}

/**
 * Best-effort post-send flag. Runs the audit, logs + captures a violation, NEVER throws, NEVER sends.
 * @param {{dossier:any, role:any, email:string, surface:string, log?:Function, capture?:Function}} args
 * @returns {Promise<Array>} the findings (empty when clean)
 */
export async function postSendAudit({ dossier, role, email, surface, log = () => {}, capture = null } = {}) {
  try {
    const findings = auditRole({ dossier, role });
    if (!findings.length) return findings;
    const summary = findings.map((f) => `${f.rule} (${f.detail})`).join("; ");
    log(`[send-audit] ${surface} ${email}: FLAG — ${summary}`);
    if (typeof capture === "function") {
      capture(new Error(`send-audit flag: ${surface} ${email} — ${summary}`), { service: "send-audit", surface, email, findings });
    }
    return findings;
  } catch (e) {
    // Best-effort: an audit failure must never touch the send it is auditing.
    try { log(`[send-audit] audit failed for ${email}: ${e.message}`); } catch { /* noop */ }
    return [];
  }
}
