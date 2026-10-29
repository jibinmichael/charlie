// company-context.mjs — best-effort past-employer DOMAIN enrichment for a built dossier.
//
// Knows what a candidate's PAST companies actually do, so Charlie reads "Lumora" as
// "event-ticketing SaaS" instead of "software". This reuses the existing cached, cross-user
// company-research tool (composer.mjs `lookupCompany`) — pointed at the person's employers instead of the
// hiring company — and attaches the domain as CONTEXT on each employer entry of the dossier.
//
// THE GUARDRAIL: a company's domain is context about WHERE the person
// worked, never an upgraded claim about THEM. The employer NAME is grounded (verbatim from the resume,
// gated in dossier-build.mjs `finalizeEmployers`); the DOMAIN is an attributed external lookup, stored
// ONLY on the employer entry (`{ name, domain, source }`). It is NEVER written into strengths, proof_points,
// narrative, or headline — someone at Lumora could have been in finance, not ticketing, so inferring a skill
// from an employer would upgrade a claim about the person, which is never allowed.
//
// DARK by default behind COMPANY_CONTEXT: a no-op when the flag is off (nothing to enrich, since the build
// only emits `employers` when the flag is on). NON-BLOCKING: callers fire this fire-and-forget AFTER the
// welcome + first role are handled, so it never slows onboarding. FAIL-OPEN: a missing/failed/empty lookup
// leaves the dossier exactly as it was (context omitted, never guessed); this function never throws.

import { getCandidate, saveDossier } from "./charlie-store.mjs";
import { lookupCompany } from "./composer.mjs"; // cached, cross-user web-search company research (never throws)
import { captureError } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)

const companyContextOn = () => String(process.env.COMPANY_CONTEXT || "").toLowerCase() === "on";
// Cost cap: most lookups are cross-user cache hits, but a resume with a long tail of employers still
// bounds the cold-cache web searches per dossier. Tune via COMPANY_CONTEXT_MAX.
const MAX_EMPLOYERS = Number(process.env.COMPANY_CONTEXT_MAX || 6);

// Enrich the STORED dossier for `email` with each employer's domain. Reads the just-saved dossier from the
// store (so it preserves the persisted status and never clobbers a concurrent write with a stale in-memory
// copy), attaches domains, and re-saves. Returns the enriched dossier, or null on any no-op/failure.
export async function enrichCompanyContext(email) {
  if (!companyContextOn() || !email) return null;
  try {
    const cand = await getCandidate(email);
    const dossier = cand?.dossier;
    if (!dossier || typeof dossier !== "object") return null;
    const employers = Array.isArray(dossier.employers) ? dossier.employers : [];
    if (!employers.length) return null;

    let attached = 0;
    for (const entry of employers.slice(0, MAX_EMPLOYERS)) {
      // Isolate each employer: one bad/slow lookup must never break the batch.
      try {
        const name = entry && typeof entry === "object" ? String(entry.name || "").trim() : "";
        if (!name || entry.domain) continue; // ungrounded/blank or already enriched → skip
        const info = await lookupCompany(name); // cached, cross-user; returns { name, what, ... } | null
        const what = info && typeof info.what === "string" ? info.what.trim() : "";
        if (!what) continue; // no verified domain → fail-open: leave this entry as-is (never guess)
        entry.domain = what; // ATTRIBUTED context about the company, NOT a claim about the person
        entry.source = "company-research";
        attached++;
      } catch (err) {
        captureError(err, { service: "company-context", kind: "employer_lookup", email, employer: entry?.name });
      }
    }

    if (!attached) return null; // nothing enriched → leave the stored dossier untouched (fail-open)
    // Preserve the persisted status (e.g. "active"); saveDossier defaults to "screening" otherwise.
    await saveDossier(email, dossier, cand.status || "active");
    return dossier;
  } catch (err) {
    // Best-effort enrichment: never surface to the caller, never crash onboarding.
    captureError(err, { service: "company-context", kind: "enrich", email });
    return null;
  }
}
