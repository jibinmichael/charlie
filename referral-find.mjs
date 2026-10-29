// referral-find.mjs — the warm-intro finder.
//
// Given a role at a company, find ONE real, verified person who could put the user on
// the radar (a peer, a manager in the same function, or a recruiter). The user emails
// them from their own inbox; Charlie never contacts anyone. Provider-abstracted so the
// data source (Huntr, Hunter) is swappable without touching callers.
//
// Quota-safe: results are cached per company domain in Supabase, and a monthly counter
// keeps us inside Hunter's free tier. Dark until a provider key is set (an owner-only
// stub allows a dry run of the whole experience without a key — never for real users).

import { getReferralCache, recordReferralLookup, referralSearchesThisMonth } from "./charlie-store.mjs";
import { classifyPlace } from "./quality-gate.mjs"; // one region classifier, shared with homeRegion

// Leave headroom under Hunter's free tier (50 searches/mo; results capped at 10 per search).
const MONTHLY_CAP = Number(process.env.HUNTER_MONTHLY_CAP || 45);
const CACHE_DAYS = Number(process.env.REFERRAL_CACHE_DAYS || 30);
// High-confidence bar for the Hunter fallback path: a contact is surfaced only when it is
// email-verified AND clears this confidence AND carries a LinkedIn (a public identity the user can
// eyeball before reaching out). Below the bar we return nobody — a wrong warm intro is unrecoverable.
const MIN_CONFIDENCE = Number(process.env.REFERRAL_MIN_CONFIDENCE || 80);

// ── company → email domain ───────────────────────────────────────────────────
// Prefer a domain we can read off the job's own apply URL (when it's the company's own
// site, not an ATS). Otherwise fall back to the company NAME and let the provider resolve
// it. ATS/board hosts are never the company's mail domain, so we skip them.
const ATS_HOSTS = /(greenhouse|lever|ashbyhq|workable|workday|myworkdayjobs|jobvite|smartrecruiters|bamboohr|recruitee|breezy|rippling|gem|teamtailor|personio|join\.com|notion\.site|linkedin|indeed|google|bit\.ly)/i;

// registrable domain, honouring multi-label TLDs (foo.co.uk -> foo.co.uk, not co.uk).
const MULTI_TLD = /\.(co|com|org|net|gov|ac|edu)\.(uk|au|in|nz|za|br|jp|sg)$/i;
export function domainFromJobUrl(jobUrl) {
  if (!jobUrl) return null;
  try {
    const host = new URL(jobUrl).hostname.replace(/^www\./, "");
    if (ATS_HOSTS.test(host)) return null;      // an ATS host, not the employer's mail domain
    const parts = host.split(".");
    if (parts.length <= 2) return host;         // customer.io, stripe.com
    if (MULTI_TLD.test(host)) return parts.slice(-3).join("."); // acme.co.uk
    return parts.slice(-2).join(".");           // careers.stripe.com -> stripe.com
  } catch { return null; }
}

// ── role → function map (Hunter dept + a title regex + adjacent allowed depts) ──
// Hunter buckets EVERY manager of every function into department="management", so the title
// string is the primary function signal; department is the fallback. HR is always cross-allowed
// (recruiters route any referral). Hunter's 14 depts: executive, it, finance, management, sales,
// legal, support, hr, marketing, communication, education, design, health, operations.
const ROLE_MAP = [
  { dept: "design", re: /design|ux|ui|product design|brand|visual|creative/, allowed: ["design", "management", "marketing"] },
  { dept: "it", re: /engineer|developer|swe|software|data|ml|machine learning|devops|infra|backend|frontend|full.?stack|architect/, allowed: ["it", "management"] },
  { dept: "management", re: /product manager|product owner|program manager|\bpm\b|product lead|head of product/, allowed: ["management", "it", "marketing"] },
  { dept: "marketing", re: /market|growth|content|seo|demand gen|comms/, allowed: ["marketing", "communication", "sales"] },
  { dept: "sales", re: /sales|account exec|\bae\b|business develop|\bbd\b|partnership|revenue/, allowed: ["sales", "management"] },
  { dept: "finance", re: /finance|account(ant|ing)|fp&a|controller|treasur/, allowed: ["finance", "executive"] },
  { dept: "support", re: /support|customer success|\bcs\b|solutions|success/, allowed: ["support", "operations"] },
  { dept: "operations", re: /\bops\b|operations|logistics|supply/, allowed: ["operations", "management"] },
  { dept: "hr", re: /recruit|talent|people ops|\bhr\b|human resource/, allowed: ["hr", "management"] },
];
export function roleKeywords(title) {
  const t = String(title || "").toLowerCase();
  for (const m of ROLE_MAP) if (m.re.test(t)) return { roleDept: m.dept, titleRegex: m.re, ALLOWED: [...new Set([...m.allowed, "hr"])] };
  return { roleDept: null, titleRegex: null, ALLOWED: ["hr", "management"] };
}

// A person's org level, parsed from the TITLE first (Hunter's seniority enum is coarse + often
// null). Sweet spot for a referral is a peer or a one-up manager; execs rarely reply, juniors
// can't refer. null/ambiguous -> neutral peer (2), NEVER a penalty for missing data.
function contactLevel(c) {
  const p = String(c.position || "").toLowerCase();
  if (/\b(head|vp|vice president|chief|c[teofm]o|cxo|director|founder|owner|president|partner)\b/.test(p)) return 3;
  if (/\b(manager|lead|principal|staff)\b/.test(p)) return 2.5;
  if (/\b(senior|sr\.?|snr)\b/.test(p)) return 2;
  if (/\b(intern|junior|jr\.?|associate|assistant|trainee|graduate)\b/.test(p)) return 1;
  return ({ senior: 2, executive: 3, junior: 1 })[c.seniority] ?? 2;
}
// how good a referrer this person is: peers + one-up managers peak; execs below; juniors low.
function referAbility(c, tiny) {
  const lvl = contactLevel(c);
  let r = lvl === 2.5 || lvl === 2 ? 3 : lvl === 3 ? 2 : lvl === 1 ? 1.5 : 2;
  if (lvl === 3 && tiny) r += 1; // tiny company: a founder/exec can refer anyone
  return r;
}
// how well this person's FUNCTION matches the role (title match dominates department).
function functionScore(c, roleDept, titleRegex, ALLOWED) {
  const p = String(c.position || "").toLowerCase();
  if (titleRegex && titleRegex.test(p)) return 3;      // same function by title
  if (roleDept && c.department === roleDept) return 2;  // same Hunter department
  if (c.department === "hr") return 1.5;               // recruiter, routes any referral
  if (ALLOWED.includes(c.department)) return 1;         // adjacent allowed department
  if (c.department === "management") return 0.5;        // a manager of unknown function
  return 0;                                             // off-function
}
// token Jaccard of two titles, stripping seniority/filler words.
function titleSim(roleTitle, position) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w && !/^(senior|junior|sr|snr|staff|lead|principal|the|of|and|ii|iii|iv|i|a|an|at)$/.test(w));
  const A = new Set(norm(roleTitle)), B = new Set(norm(position));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Two-stage LEXICOGRAPHIC rank (not additive — additive let confidence + exec-seniority drown
// out function). Named personal contacts only. A same-function peer can never be outranked by a
// high-confidence off-function exec: the tuple is compared component-by-component, higher wins.
function rankContacts(contacts, roleTitle) {
  const { roleDept, titleRegex, ALLOWED } = roleKeywords(roleTitle);
  // name + personal is the floor; email is NOT required here — Huntr resolves the address only after
  // ranking (per pick), whereas Hunter's contacts already carry it. Either way junk is dropped.
  const named = (contacts || []).filter((c) => c && c.type === "personal" && (c.first || c.last));
  const tiny = named.length < 10;
  return named
    .map((c) => ({ c, t: [functionScore(c, roleDept, titleRegex, ALLOWED), referAbility(c, tiny), titleSim(roleTitle, c.position), (c.confidence || 0) / 100, c.linkedin ? 1 : 0] }))
    .sort((a, b) => { for (let i = 0; i < a.t.length; i++) if (a.t[i] !== b.t[i]) return b.t[i] - a.t[i]; return 0; })
    .map((s) => s.c);
}

const fullName = (c) => [c.first, c.last].filter(Boolean).join(" ").trim();
export { contactLevel }; // for alternates classification in findReferralContact

// ── providers ────────────────────────────────────────────────────────────────
// A provider exposes: search(domainOrCompany) -> { domain, contacts[] } and
// verify(email) -> { deliverable, status, score }. Contacts are normalized to:
// { first, last, email, position, seniority, department, confidence, type }.

function hunterProvider(apiKey) {
  const base = "https://api.hunter.io/v2";
  return {
    name: "hunter",
    async search({ domain, company, department }) {
      const qs = new URLSearchParams({ api_key: apiKey, limit: "10", type: "personal" });
      if (domain) qs.set("domain", domain); else if (company) qs.set("company", company); else return { domain: null, contacts: [] };
      if (department) qs.set("department", department); // pre-narrow to the role's function
      const res = await fetch(`${base}/domain-search?${qs}`);
      if (!res.ok) throw new Error(`hunter domain-search ${res.status}`);
      const j = await res.json();
      const d = j?.data || {};
      const contacts = (d.emails || []).map((e) => ({
        first: e.first_name || "", last: e.last_name || "", email: e.value,
        position: e.position || "", seniority: e.seniority || "",
        department: e.department || "", confidence: e.confidence ?? 0, type: e.type || "personal",
        linkedin: e.linkedin || "", // a warmer channel than a cold email, when Hunter has it
      }));
      return { domain: d.domain || domain || null, contacts };
    },
    async verify(email) {
      const qs = new URLSearchParams({ api_key: apiKey, email });
      const res = await fetch(`${base}/email-verifier?${qs}`);
      if (!res.ok) throw new Error(`hunter email-verifier ${res.status}`);
      const j = await res.json();
      const d = j?.data || {};
      // treat clearly-bad addresses as undeliverable; accept_all/unknown pass (can't disprove)
      const bad = d.status === "invalid" || d.result === "undeliverable" || d.disposable === true;
      return { deliverable: !bad, status: d.status || d.result || "unknown", score: d.score ?? null };
    },
  };
}

// Huntr GTM (api.tryhuntr.com) — a two-call model, unlike Hunter's single domain-search:
//   1) person-search (semantic query: role + company + location) returns PEOPLE, no emails
//   2) person-email (name + domain [+ linkedin]) resolves AND verifies one email, returning
//      result.certainty (live | model | ...). We treat certainty === "ultra_sure" as the ONLY
//      surface-worthy tier — the fail-closed switch. See findViaHuntr for the gate.
function huntrProvider(apiKey) {
  const base = "https://api.tryhuntr.com";
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`huntr ${path} ${res.status}`);
    return res.json();
  };
  return {
    name: "huntr",
    // people at the company in the role's function + location. Emails resolved later, per pick.
    async search({ company, roleTitle, location }) {
      // Huntr's semantic parser matches the title EXACTLY, so search on the core role (drop the
      // seniority prefix for recall — rankContacts restores seniority preference) and a CLEAN city
      // (a "City, ST" or a parenthetical breaks the location filter). Fall back to no-location if
      // the city-constrained pass comes back empty. locationMatch still enforces US/metro after.
      const coreRole = String(roleTitle || "").replace(/\b(senior|sr\.?|snr|staff|lead|principal|junior|jr\.?|associate)\b/gi, " ").replace(/\s+/g, " ").trim() || String(roleTitle || "");
      const city = String(location || "").replace(/\(.*?\)/g, "").split(",")[0].trim();
      const useCity = city && !/^(remote|anywhere|hybrid|us|usa|united states|india)$/i.test(city);
      const build = (withCity) => [coreRole, company ? `at ${company}` : "", withCity && useCity ? `in ${city}` : ""].filter(Boolean).join(" ").trim();
      let j = await post("/person-search", { semantic_query: build(true) });
      let people = Array.isArray(j?.people) ? j.people : [];
      if (!people.length && useCity) { j = await post("/person-search", { semantic_query: build(false) }); people = Array.isArray(j?.people) ? j.people : []; }
      const contacts = people.map((p) => {
        const [first, ...rest] = String(p.name || "").trim().split(/\s+/);
        const title = p.title || p.headline || "";
        return {
          first: first || "", last: rest.join(" "), email: "", position: title,
          seniority: /senior|staff|lead|principal|head|director|\bvp\b|chief/i.test(title) ? "senior" : "",
          department: roleKeywords(title).roleDept || "", confidence: null, type: "personal",
          linkedin: p.linkedin_url || "", location: p.location || "", website: p.website || "",
        };
      });
      return { domain: null, contacts };
    },
    // resolve + verify one email. certainty is the gate field; status FOUND when an address exists.
    async resolveEmail({ name, domain, linkedin }) {
      const j = await post("/person-email", { name, domain, linkedin_url: linkedin || undefined });
      const r = j?.result || {};
      return { email: r.email || null, certainty: r.certainty || "not_found", status: r.status || "" };
    },
  };
}

// A contact is location-eligible only if it is in the user's OWN region (the same classifier that
// decides homeRegion, so "us" or "india" must match positively — an unknown/foreign place fails
// closed), and — when the role names a specific city — in that city. Tight by design: better to
// surface nobody than someone in the wrong country.
function locationMatch(contactLoc, region, roleLoc) {
  const c = String(contactLoc || "");
  if (classifyPlace(c) !== region) return false;                        // must be in the user's region
  const city = String(roleLoc || "").split(",")[0].trim();
  if (!city || city.length < 3 || /remote|united states|\busa\b|\bindia\b|anywhere|hybrid/i.test(city)) return true; // no specific city → in-region is enough
  return new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(c);
}

// Huntr flow: search people → US/metro filter → rank → resolve email on the top picks → surface
// ONLY when certainty is ultra_sure AND status FOUND. Anything less returns none (defer).
async function findViaHuntr({ provider, email, company, seedDomain, roleTitle, location, region }) {
  const used = await referralSearchesThisMonth().catch(() => 0);
  if (used >= MONTHLY_CAP) return { none: true, reason: "quota" };
  let result;
  try { result = await provider.search({ company, roleTitle, location }); }
  catch (err) { console.error(`[referral] huntr search failed: ${err.message}`); return { none: true, reason: "lookup_failed" }; }
  const inLoc = (result.contacts || []).filter((c) => locationMatch(c.location, region, location));
  const dept = roleKeywords(roleTitle).roleDept || "all";
  await recordReferralLookup({ email, domain: `${seedDomain || company}#${dept}`, company, contacts: inLoc, chosen: null, provider: "huntr" }).catch(() => {});
  const ranked = rankContacts(inLoc, roleTitle);
  if (!ranked.length) return { none: true, reason: "no_person" };
  for (const c of ranked.slice(0, 3)) {
    const dom = seedDomain || (c.website ? c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "") : null);
    if (!dom) continue;
    let r;
    try { r = await provider.resolveEmail({ name: fullName(c), domain: dom, linkedin: c.linkedin }); }
    catch { continue; }
    // ultra_sure + FOUND is the verified bar; a LinkedIn is required too, so the user has a public
    // identity to eyeball before reaching out (and a warmer channel than a cold email).
    if (r.email && r.certainty === "ultra_sure" && r.status === "FOUND" && c.linkedin) {
      return {
        contact: { name: fullName(c), first: c.first, position: c.position, email: r.email, linkedin: c.linkedin, department: c.department, confidence: 100, certainty: r.certainty, unverified: false },
        alternates: [], company: company || null, domain: dom,
      };
    }
  }
  return { none: true, reason: "low_certainty" }; // nobody cleared the ultra_sure + LinkedIn bar → stay quiet
}

// Owner-only stub: returns a plausible contact so we can exercise the FULL experience
// (draft + email + send-intro) before a real key exists. Never used for real users.
function stubProvider() {
  return {
    name: "stub",
    async search({ domain, company }) {
      const d = domain || `${String(company || "acme").toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
      return {
        domain: d,
        contacts: [
          { first: "Priya", last: "Nair", email: `priya.nair@${d}`, position: "Engineering Manager", seniority: "senior", department: "it", confidence: 92, type: "personal", linkedin: "https://www.linkedin.com/in/priya-nair-example" },
          { first: "Sam", last: "Cole", email: `sam.cole@${d}`, position: "Recruiter", seniority: "junior", department: "hr", confidence: 88, type: "personal", linkedin: "" },
        ],
      };
    },
    async verify() { return { deliverable: true, status: "stub", score: 90 }; },
  };
}


// Find one warm-intro contact for a role. Returns { contact, company, domain } on success,
// or { none: true, reason } when there's nothing good / quota is spent / the feature is dark.
// `owner` (the account owner) may use the stub when no real key is set, for dry runs only.
export async function findReferralContact({ email, company, jobUrl, roleTitle, location = "", region = "us", owner = false } = {}) {
  const huntrKey = process.env.HUNTR_GTM_API_KEY;
  const apiKey = process.env.HUNTER_API_KEY;
  if (!huntrKey && !apiKey && !owner) return { none: true, reason: "disabled" };

  const domainHint = domainFromJobUrl(jobUrl);
  // a company NAME that is itself a domain (customer.io, monday.com) — resolves those reliably.
  const companyAsDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(company || "").trim()) ? company.trim().toLowerCase() : null;
  const seedDomain = domainHint || companyAsDomain || null;
  const { roleDept } = roleKeywords(roleTitle);
  // cache per company + function: the same company can need a designer OR an engineer.
  const cacheKey = seedDomain ? `${seedDomain}#${roleDept || "all"}` : null;

  // Huntr has a different shape (search people -> resolve+verify per pick, gated on ultra_sure +
  // location). It runs its own quota-capped path and does not share Hunter's contact-list cache.
  //
  // FALL BACK TO HUNTER WHEN HUNTR FINDS NOBODY. These are two different people-indexes, so "Huntr
  // has nobody at Acme" is not "nobody at Acme is findable".
  //
  // The bar does NOT move: whichever provider answers, the contact still has to clear MIN_CONFIDENCE,
  // be email-verified, and carry a LinkedIn. Falling back is asking a second source, never accepting
  // a weaker answer.
  //
  // NOT on `quota`. referralSearchesThisMonth() counts every row in referral_lookups regardless of
  // provider, so a spent month is spent for BOTH — falling through there would walk straight past the
  // cap it exists to enforce. `disabled` cannot occur here (huntrKey is set).
  if (huntrKey) {
    const viaHuntr = await findViaHuntr({ provider: huntrProvider(huntrKey), email, company, seedDomain, roleTitle, location, region });
    if (!viaHuntr.none) return viaHuntr;                        // found someone — done
    if (viaHuntr.reason === "quota" || !apiKey) return viaHuntr; // cap is shared / no second provider
    console.error(`[referral] huntr found nobody (${viaHuntr.reason}) — asking hunter`);
  }
  const provider = apiKey ? hunterProvider(apiKey) : stubProvider();

  // 1) cache (shared across users, quota-free)
  let domain = seedDomain;
  let contacts = null;
  let cachedCompany = null;
  if (cacheKey) {
    const cached = await getReferralCache(cacheKey, { maxAgeDays: CACHE_DAYS });
    if (cached) { contacts = cached.contacts; cachedCompany = cached.company; }
  }

  // 2) live search when the cache misses. PRE-NARROW to the role's department first (Hunter's
  // free 10 skew to execs otherwise — the CEO is not your referrer). If the narrowed pass is
  // empty, fall back to ONE unfiltered pass and rank the adjacent people client-side.
  if (!contacts) {
    if (provider.name === "hunter") {
      const used = await referralSearchesThisMonth();
      if (used >= MONTHLY_CAP) return { none: true, reason: "quota" };
    }
    // search by resolved domain when we have one, else let Hunter resolve the company NAME. The
    // department pre-narrow applies to BOTH (Hunter accepts company + department together).
    const base = seedDomain ? { domain: seedDomain } : { company };
    let result;
    try {
      if (roleDept) {
        result = await provider.search({ ...base, department: roleDept });
        if (!(result.contacts && result.contacts.length)) result = await provider.search(base); // fallback: adjacent/any
      } else {
        result = await provider.search(base);
      }
    } catch (err) {
      console.error(`[referral] search failed: ${err.message}`);
      return { none: true, reason: "lookup_failed" };
    }
    domain = result.domain || seedDomain || null;
    contacts = result.contacts || [];
    const key = domain ? `${domain}#${roleDept || "all"}` : null;
    if (key) await recordReferralLookup({ email, domain: key, company, contacts, chosen: null, provider: provider.name });
  }

  // 3) rank (two-stage lexicographic), then apply the high-confidence gate: a contact is surfaced
  //    ONLY when it is email-verified AND clears MIN_CONFIDENCE AND carries a LinkedIn. Below the
  //    bar we return nobody (fail closed) — a wrong warm intro in a real inbox is unrecoverable, so
  //    we never fall back to an unverified best-guess. Never fabricate a person.
  const ranked = rankContacts(contacts, roleTitle);
  if (!ranked.length) return { none: true, reason: "no_person", domain };

  let chosen = null;
  for (const c of ranked.slice(0, 3)) {
    if (!((c.confidence || 0) >= MIN_CONFIDENCE) || !c.linkedin) continue; // must clear confidence + have a public identity
    let deliverable = false;
    try { deliverable = (await provider.verify(c.email)).deliverable; }
    catch { deliverable = false; } // a verifier error fails closed — we do not surface an unverified contact
    if (deliverable) { chosen = c; break; }
  }
  if (!chosen) return { none: true, reason: "low_confidence", domain };

  // alternates: offer "a peer, or their manager" when a clearly different-level person exists.
  const peer = ranked.find((c) => c !== chosen && contactLevel(c) <= 2);
  const mgr = ranked.find((c) => c !== chosen && contactLevel(c) >= 2.5);
  const alternates = [...new Set([peer, mgr].filter(Boolean))].slice(0, 2)
    .map((c) => ({ name: fullName(c), position: c.position || "", linkedin: c.linkedin || "" }));

  return {
    contact: { name: fullName(chosen), first: chosen.first, position: chosen.position, email: chosen.email, linkedin: chosen.linkedin || "", department: chosen.department, confidence: chosen.confidence, unverified: false },
    alternates,
    company: company || cachedCompany || null,
    domain,
  };
}
