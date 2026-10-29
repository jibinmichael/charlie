// lib/enrich.mjs — one candidate, read then computed. The model reads; code decides.
//
// THE SPLIT THAT MATTERS. The model returns dates, employers, titles and skills. Everything a hiring
// manager would treat as a JUDGEMENT -- seniority, role family, notice in days, compensation as a
// number, and whether somebody changes jobs often -- is computed in lib/normalise.mjs from those
// facts. A model asked to label somebody a "hopper" does it inconsistently, and that label follows a
// person into somebody's inbox.
//
// EMPLOYERS ARE VERIFIED. Every company name the model returns is checked against the source text.
// An employer that is not there is dropped, and the row is flagged. This is the same cite-or-drop
// discipline as the screen, applied to the facts that drive the mobility maths.

import Anthropic from "@anthropic-ai/sdk";
import { ENRICH_SYSTEM, buildEnrichMessages } from "../prompts/enrich-candidate.mjs";
import { CandidateEnrichment } from "./schemas/enrichment.mjs";
import {
  normaliseLocation, normaliseNotice, normaliseComp, normaliseSeeking,
  normaliseSeniority, normaliseFamily, mobilityProfile, monthsBetween, completenessOf, countryFromPhone,
} from "./normalise.mjs";

// BUMPING THIS MAKES EVERY EXISTING ROW STALE, so an unrestricted --apply re-reads all of them at
// ~$0.02 each. Use scripts/talent-enrich.mjs --emails to apply a fix to the subset it affects.
export const ENRICHMENT_VERSION = "enrich@2026-08-29"; // employer verification survives annotation
const MODEL = process.env.ENRICH_MODEL || "claude-sonnet-4-6";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Legal suffixes a resume prints inconsistently: "Contoso" on the page, "Contoso Technology
// Solutions" from the model. Trimmed only as a last resort, and only to CHECK -- see below.
const LEGAL = /\b(pvt|private|ltd|limited|inc|llc|llp|corp|corporation|technologies|technology|solutions|services|systems|global|group|labs?)\b/gi;

/**
 * The employer, as the source actually names them, or null if the source does not name them at all.
 *
 * A plain `source.includes(company)` check drops a role whenever the model ANNOTATES the employer,
 * and it annotates constantly: "Acme Consulting Pvt Ltd (client: Globex)", "ShopNow (Initech
 * Retail)", "Hooli Software / Pied.photo", "Contoso (Contoso Research Lab)". A dropped employer takes
 * the role's DATES with it, and the dates are what the mobility arithmetic runs on.
 *
 * NOT A LOOSER CHECK. Matching on the annotated string and then STORING it would put "Globex" on a
 * hiring record as an employer this person never had -- a client is not an
 * employer, and that invention is worse than the missing role. So the annotation is stripped first,
 * and what gets verified is what gets stored. Nothing is ever stored that is not in the source.
 *
 * Returns the verified name, or null. Never returns a string the source does not contain.
 */
export function verifiedCompany(raw, normalisedSource) {
  const src = String(normalisedSource || "");
  const stated = String(raw || "");
  if (!stated.trim() || !src) return null;
  // WHOLE WORDS ONLY. norm() leaves space-separated tokens, so padding both sides turns a substring
  // test into a word-boundary test. Without it "Co" matches inside "co-branded" and a two-letter
  // fragment verifies an employer nobody worked for.
  const padded = ` ${src} `;
  const has = (v, min) => { const n = norm(v); return n.length >= min && padded.includes(` ${n} `); };
  // 1. exactly as the model wrote it
  if (has(stated, 3)) return stated;
  // 2. without the model's own annotation: "(client: X)", "(unnamed)", "A / B", "A - B"
  const core = stated.replace(/\([^)]*\)/g, " ").split(/[\/|]|\s[-\u2013]\s/)[0].trim();
  if (has(core, 3)) return core;
  // 3. without a legal suffix the resume may not print
  const bare = core.replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  if (has(bare, 4)) return bare;
  return null;
}

export async function enrichCandidate({ email, name, resume = "", answers = {}, prefs = {}, meta = {}, log = () => {} }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const source = `${resume}\n\n${Object.values(answers).join("\n\n")}`;
  let usage = null, ex = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 2500, temperature: 0,
      system: ENRICH_SYSTEM, messages: buildEnrichMessages({ resume, answers, name }),
    });
    usage = res.usage;
    const text = (res.content || []).map((c) => c.text || "").join("").trim().replace(/^```(?:json)?|```$/g, "");
    let parsed; try { parsed = JSON.parse(text); } catch { log(`unreadable JSON (attempt ${attempt})`); continue; }
    const ok = CandidateEnrichment.safeParse(parsed);
    // Name the offending field, as lib/xyz-screen.mjs does. Without it a rejection says only that
    // something was wrong, which is indistinguishable from the model being unreliable.
    if (!ok.success) { log(`schema rejected (attempt ${attempt}): ${ok.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join(" | ")}`); continue; }
    ex = ok.data; break;
  }
  if (!ex) return { row: null, usage, reason: "extraction failed after 2 attempts" };

  // Cite or drop, applied to employers. An employer that is not in the source cannot anchor a date,
  // and a wrong date is a wrong claim about how long somebody stays anywhere.
  const src = norm(source);
  const flags = [];
  const roles = (ex.roles || []).map((r) => {
    const company = verifiedCompany(r.company, src);
    if (!company) { if (String(r.company || "").trim()) flags.push(`unverified-employer:${r.company}`); return null; }
    // Store the verified form, not the model's annotated one.
    if (company !== r.company) flags.push(`employer-annotation-stripped:${r.company} -> ${company}`);
    return { ...r, company, months: monthsBetween(r.start, r.end) };
  }).filter(Boolean);

  // THE NAMED COLUMNS GO THROUGH THE SAME DOOR AS THE ROLES. Otherwise an employer the citation
  // check rejected (often the model describing rather than naming: "enterprise SaaS consultancy")
  // still lands in current_company / previous_company. Those columns are what a client reads on a
  // board, so an unverifiable employer is a claim we cannot back. Unknown is the honest value.
  const namedCompany = (raw, which) => {
    if (!String(raw || "").trim()) return null;
    const v = verifiedCompany(raw, src);
    if (!v) { flags.push(`unverified-${which}:${raw}`); return null; }
    if (v !== raw) flags.push(`${which}-annotation-stripped:${raw} -> ${v}`);
    return v;
  };
  const currentCompany = namedCompany(ex.current_company, "current-company");
  const previousCompany = namedCompany(ex.previous_company, "previous-company");

  const totalYears = ex.total_years_stated ?? null;
  const mob = mobilityProfile(roles, totalYears);
  // LOCATION, IN ORDER OF HOW MUCH THE PERSON MEANT IT.
  //   1. what they typed on the form, when the form asked
  //   2. what their resume header says
  //   3. their dialling code, which is deterministic and surprisingly reliable
  // Not every form asks for location, so without 2 and 3 a country filter would silently miss
  // everyone who applied through a form that did not.
  const formLoc = normaliseLocation(prefs.home_place || "");
  const cvLoc = normaliseLocation(ex.location_stated || "");
  const phoneCountry = countryFromPhone(ex.phone);
  const loc = {
    city: formLoc.city || cvLoc.city || null,
    country: formLoc.country || cvLoc.country || phoneCountry || null,
  };
  const locSource = formLoc.country ? "form" : cvLoc.country ? "resume" : phoneCountry ? "dialling code" : "unknown";
  const compCur = normaliseComp(ex.comp_current_stated);
  const compExp = normaliseComp(ex.comp_expected_stated);
  const withMonths = roles.filter((r) => Number.isFinite(r.months));
  const current = roles[0] || {};

  const row = {
    email: String(email).toLowerCase(),
    full_name: name || null,
    phone: ex.phone || null,
    linkedin_url: ex.linkedin_url || null,
    portfolio_url: ex.portfolio_url || null,

    current_title: ex.current_title || null,
    current_company: currentCompany,
    previous_title: ex.previous_title || null,
    previous_company: previousCompany,

    total_years: totalYears,
    roles_count: roles.length || null,
    avg_tenure_months: mob.avg,
    longest_tenure_months: mob.longest,
    current_tenure_months: Number.isFinite(current.months) ? current.months : null,
    seniority: normaliseSeniority(ex.current_title),
    role_family: normaliseFamily(`${ex.current_title || ""} ${meta.source_role || ""}`),

    city: loc.city, country: loc.country,
    willing_to_relocate: prefs.relocate || null,

    notice_period_raw: prefs.notice_period || null,
    notice_days: normaliseNotice(prefs.notice_period),
    seeking_status: normaliseSeeking(prefs.mode),

    comp_current: compCur.value, comp_expected: compExp.value,
    comp_currency: compExp.currency || compCur.currency || null,

    mobility_profile: mob.profile,
    top_skills: (ex.skills || []).slice(0, 8),
    domains: (ex.domains || []).slice(0, 8),

    consent_process: Boolean(meta.consent_process),
    consent_share: Boolean(meta.may_share),
    consent_pool: Boolean(meta.may_write_again),
    consent_text: meta.consent_text || {},

    source_form: meta.source || null,
    source_role: meta.source_role || null,
    applied_at: meta.applied_at || null,

    provenance: {
      extractor: ENRICHMENT_VERSION,
      mobility_basis: mob.reason,
      dated_roles: withMonths.length,
      total_years_source: totalYears == null ? "unknown" : "stated by candidate",
      location_source: locSource,
      flags: [...flags, ...(ex.notes ? [`note: ${ex.notes}`] : [])],
    },
    enrichment_version: ENRICHMENT_VERSION,
    enriched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { completeness, missing_fields } = completenessOf(row);
  row.completeness = completeness;
  row.missing_fields = missing_fields;
  return { row, usage, reason: "ok" };
}
