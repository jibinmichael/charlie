// lib/blind-dossier.mjs — the scorer judges the work, never the person's name.
//
// WHY. `match-batch` serialises the whole dossier into the scoring prompt, and most dossiers carry a
// `name`. Without this step Charlie tells the model who somebody is before asking how good they are.
// A name has no bearing on whether somebody can do a job, yet it can move a model's score enough to
// change whether a role is sent. That is noise, and noise does not belong in a scoring path.
//
// WHAT THIS IS NOT. It is not anonymisation. A school, a city and a mother tongue all carry
// demographic signal and all remain, deliberately — they are also real evidence about the work.
// Removing the direct identifier removes the strongest and cheapest of the signals, nothing more.
//
// SCORING ONLY. The composer still receives the full dossier, because the email addresses a person by
// name. The name is needed to SPEAK to someone and never to JUDGE them.

// Direct identifiers. Every one is something a person is called or reached at, never something they
// have done. `links` is included because a GitHub or LinkedIn URL usually contains the full name.
const IDENTITY_KEYS = new Set([
  "name", "full_name", "fullname", "first_name", "firstname", "last_name", "lastname",
  "email", "emails", "phone", "mobile", "contact", "contacts",
  "photo", "photo_url", "avatar", "image",
  "dob", "date_of_birth", "age", "gender", "pronouns", "marital_status", "nationality",
  "links", "linkedin", "github", "portfolio", "website", "twitter",
]);

// ── Fields the scorer must not see, because the scorer does not use them ─────────────────────────
//
// The verdict cache key is a hash of the WHOLE dossier JSON (lib/match-cache-key.mjs). Adding any
// field to a dossier therefore changes the key for every one of that person's stored verdicts and the
// next run re-scores their entire pool at full price.
//
// A field listed here is dropped from the scorer's copy, which means two things at once:
//   1. writing it, or changing it later, cannot invalidate a single cached verdict, and
//   2. we stop paying input tokens to send the model something it has no use for.
//
// TOP LEVEL ONLY, unlike IDENTITY_KEYS. "position" nested inside an employer or a case study means
// job title, which is real evidence about the work; only the dossier's own `position` object is the
// Charlie-computed one. Depth-blind removal here would quietly delete evidence.
//
// THE BAR FOR ADDING ONE: the matcher must genuinely not read it. matcher.md names only `preferences`
// and `name` explicitly and is otherwise handed the whole object, so removing a field is a real
// change to what the model sees. `position` qualifies because it is Charlie's own derived sentence
// about the person, computed FROM the fields already here and read by nothing in the scoring path.
//
// ADD A FIELD HERE WHEN IT IS NEW. Listing a field that is already baked into stored cache keys
// invalidates them all at once. `edge` is deliberately absent for that reason.
const NON_SCORING_KEYS = new Set(["position"]);

/**
 * A copy of the dossier with direct identifiers removed, at any depth, and the non-scoring fields
 * above removed from the top level.
 *
 * Pure and non-mutating: the caller's dossier is untouched, because the same object is handed to the
 * composer immediately afterwards and that one MUST still have the name.
 */
export function blindDossier(dossier) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (IDENTITY_KEYS.has(String(k).toLowerCase())) continue;
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  const out = strip(dossier && typeof dossier === "object" ? dossier : {});
  // Top level only — see NON_SCORING_KEYS. `delete` rather than a filtered rebuild so the surviving
  // keys keep their original order: the cache key is a hash of the serialised text, so reordering it
  // would invalidate every stored verdict, which is the exact thing this list exists to prevent.
  for (const k of NON_SCORING_KEYS) delete out[k];
  return out;
}

/**
 * The same thing for the serialised text the scorer actually receives.
 *
 * FAILS OPEN, and that is the deliberate trade. If the text will not parse we return it UNCHANGED
 * rather than sending an empty dossier: a scorer with a name is imperfect, a scorer with no evidence
 * at all scores everyone the same and silently ends the product. An unparseable dossier is already
 * an upstream bug; it must not become a second one here.
 *
 * @param {string} text the dossier as JSON text
 * @returns {string} the same JSON with identity keys removed, or the original on any failure
 */
export function blindDossierText(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return raw;
  try {
    return JSON.stringify(blindDossier(JSON.parse(raw)), null, 2);
  } catch {
    return raw;
  }
}
