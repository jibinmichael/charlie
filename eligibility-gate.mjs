// eligibility-gate.mjs — the pre-ranking KNOCKOUT floor.
//
// Given a role + a candidate, return the list of HARD reasons the role is structurally wrong for THEM
// is the layer that makes a FALSE OFFERING impossible rather than merely unlikely — a student seeking an
// internship can never be sent a role that requires 2 years of professional experience, no matter how
// high the matcher scores it.
//
// GROUNDING + FAIL-OPEN DISCIPLINE (read before adding an axis):
//  - A knockout fires ONLY on a POSITIVE conflict between a STATED role requirement (role-reqs.mjs) and
//    a KNOWN candidate fact (the structured dossier fields). Any unknown — candidate mode null, professional_years
//    null, role min_years unstated — leaves that axis SILENT. We would rather send a role we couldn't
//    knock out (the normal quality gate still judges it) than over-block on a guess: an over-block
//    silently buries a real role, the exact failure this whole effort fights.
//  - knockouts() never throws: an internal error returns [] (no knockout), because this gate is a
//    refinement, not the last line of defense — grounding/geo/liveness still fail closed downstream.
//  - Geo / US-work-auth / language are NOT re-implemented here — they already HARD-drop in quality-gate.
//    This gate adds only the axes fit + the geo gate are blind to: seeker mode, the professional
//    experience floor, employment type, and a stated dealbreaker hiding in the JD body.
//
// ROLLOUT: KNOCKOUT_MODE = shadow (default) | enforce | off. Shadow logs every would-drop with its
// reason and changes NOTHING; flip to enforce only after the shadow log proves the drops are right
// (the same shadow-first pattern as GROUNDING_MODE).
import { extractRoleReqs } from "./role-reqs.mjs";

export function knockoutMode() {
  return String(process.env.KNOCKOUT_MODE || "shadow").toLowerCase();
}
// K8 (dealbreaker hiding in the JD BODY) is gated SEPARATELY and defaults OFF: a plain substring match
// over-blocks on a role that merely MENTIONS a dealbreaker term ("coordinate with external agencies"
// for a person whose dealbreaker is "agencies"). Until the mention/negation false positives are
// refined, K8 stays dark even when the rest of the floor enforces. Flip on with
// KNOCKOUT_DEALBREAKER_BODY=on once refined. The matcher's dealbreaker_hit + the pre-filter
// title/location check still cover dealbreakers in the meantime.
const dealbreakerBodyOn = () => String(process.env.KNOCKOUT_DEALBREAKER_BODY || "off").toLowerCase() === "on";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENTRY_MODES = new Set(["internship", "first_job"]);

// The one-band stretch tolerances. K2a: an entry-stage seeker vs a role that requires real professional
// years is an insult at >= 2 years (a "1 year" ask is a borderline first role, not a wall). K2b: an
// experienced person is only knocked when the gap is large (> 3 years under the floor) — a normal stretch
// still sends, and the model-side deep-chasm stop (quality-gate SENIORITY_UNDER_FLOOR) covers the rest.
const ENTRY_FLOOR_YEARS = 2;
// 5, not 3. `professional_years` is DERIVED from the resume (experience-years.mjs), and that number is
// honestly fuzzy: reasonable readers differ by ~2 years (whether paid internships count, how a career
// gap is treated). A 3-year gate sits INSIDE that noise, so it would fire on measurement error and
// silently delete real roles. At 5 the gap has to be real before it blocks anything.
const EXPERIENCED_GAP = 5;
// A role typed as an internship, offered to someone with this many professional years, is the insult
// the whole floor exists to prevent. Deliberately COARSE: no plausible ±2 error turns an experienced
// person into an intern, so this one fires on a fuzzy number safely where a precise comparison cannot.
const CLEARLY_EXPERIENCED_YEARS = 5;

// How much to trust a DERIVED years figure. A number the person stated themselves (onboarding) carries
// no `experience_basis` and is taken at their word — it is their own claim about themselves. A number
// we read off their resume carries provenance, and we only let it drive a PRECISE comparison when the
// extraction was confident. Coarse questions tolerate "medium"; nothing acts on "low".
function yearsTrust(dossier) {
  const basis = dossier && typeof dossier.experience_basis === "object" ? dossier.experience_basis : null;
  if (!basis) return { precise: true, coarse: true };        // self-stated: their words
  const c = basis.confidence;
  return { precise: c === "high", coarse: c === "high" || c === "medium" };
}

// Returns an array of short machine reasons the role is a HARD miss for this candidate (empty = eligible).
export function knockouts(job, dossier) {
  try {
    const reqs = extractRoleReqs(job);
    const prefs = (dossier && dossier.preferences) || {};
    const mode = typeof prefs.mode === "string" ? prefs.mode : null;
    const typeWanted = typeof prefs.employment_type_wanted === "string" ? prefs.employment_type_wanted : null;
    const py = typeof dossier?.professional_years === "number" ? dossier.professional_years : null;
    const out = [];

    const trust = yearsTrust(dossier);

    // K2a — entry-stage seeker × a role that requires professional experience (THE student/internship case).
    // Fires on an entry mode OR a candidate with zero professional years (a 0-year person cannot be a switch).
    // A DERIVED zero only counts when the extraction was confident: "I found no employment history" and
    // "this resume was hard to read" produce the same 0, and only the first is evidence.
    const isEntry = ENTRY_MODES.has(mode) || (py === 0 && trust.precise);
    if (isEntry && typeof reqs.min_years === "number" && reqs.min_years >= ENTRY_FLOOR_YEARS) {
      out.push(`experience-floor: role asks ${reqs.min_years}+ years of professional experience; candidate is entry-stage`);
    }

    // K2b — an experienced candidate materially under a stated floor (deterministic complement to the
    // model deep-chasm stop). Only a large gap, so a normal stretch still sends, and only on a years
    // figure we trust precisely (see yearsTrust — a fuzzy number must not drive a numeric cutoff).
    if (trust.precise && py != null && py > 0 && typeof reqs.min_years === "number" && reqs.min_years - py >= EXPERIENCED_GAP) {
      out.push(`experience-floor: role asks ${reqs.min_years}+ years, candidate has ${py} professional`);
    }

    // K2c — a clearly experienced person × a role TYPED as an internship. The one experience rule that
    // does not need a precise number: the JD does not have to state a years floor (most real postings
    // don't), and no plausible error margin makes a 13-year professional an intern. Coarse by design,
    // so it works where K2a/K2b cannot.
    if (trust.coarse && py != null && py >= CLEARLY_EXPERIENCED_YEARS && reqs.employment_type === "intern") {
      out.push(`employment-type: internship offered to a candidate with ${py} years of professional experience`);
    }

    // K5c — an internship seeker × a role typed as anything other than an internship.
    if (mode === "internship" && reqs.employment_type && reqs.employment_type !== "intern") {
      out.push(`employment-type: candidate wants an internship, role is ${reqs.employment_type}`);
    }
    // K5a — wants contract × a permanent full-time role.
    if (typeWanted === "contract" && reqs.employment_type === "full_time") {
      out.push("employment-type: candidate wants contract, role is full-time permanent");
    }
    // K5b — wants full-time × an internship.
    if (typeWanted === "full_time" && reqs.employment_type === "intern") {
      out.push("employment-type: candidate wants a full-time role, this is an internship");
    }

    // K8 — a stated dealbreaker hiding in the JD BODY (the pre-filter only checks title+location). Word-
    // boundary, tokens >= 4 chars, so "sales" won't hit "salesforce". DEFAULT OFF (KNOCKOUT_DEALBREAKER_BODY):
    // a plain substring over-blocks on a mere mention ("external agencies") — see the note above. Kept here,
    // gated, so it can be turned on once the mention/negation false positives are refined.
    if (dealbreakerBodyOn()) {
      const dealbreakers = Array.isArray(prefs.dealbreakers) ? prefs.dealbreakers : [];
      const body = `${job?.title || ""} ${job?.description || ""}`.toLowerCase();
      for (const d of dealbreakers) {
        const t = String(d || "").toLowerCase().trim();
        if (t.length >= 4 && new RegExp(`\\b${escapeRegex(t)}\\b`).test(body)) {
          out.push(`dealbreaker: "${t}" appears in this role`);
        }
      }
    }

    return out;
  } catch (e) {
    // never let a knockout bug silence a run: fail open (no knockout); the full gate still protects.
    console.error(`[knockout] error, failing open (no knockout): ${e?.message || e}`);
    return [];
  }
}
