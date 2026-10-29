// lib/schemas/dossier.mjs — Zod schema for the grounded dossier object.
// External boundary: the dossier produced by dossier-build.mjs (Opus) and consumed by the whole
// matching/compose pipeline (select-jobs, match-*, composer, fit-coverage). This mirrors the
// hand-rolled validateDossier() in dossier-build.mjs exactly — headline is a non-empty
// string, narrative is a string, proof_points/case_studies/strengths/gaps are arrays, preferences
// is an object — plus the deterministically-attached `name`. NOT covered by match-output.mjs:
// that schema is the SCORING output (score/verdict/flag), a different object entirely; the dossier
// is the grounded profile the scorer reads. safeParse lets a caller reject a structurally broken
// dossier instead of feeding garbage into a match.
import { z } from "zod";

export const Dossier = z
  .object({
    // extractName() attaches this verbatim after validateDossier; grounded, never model-touched.
    // NULLISH, not optional: when extraction finds no name in the resume it writes an explicit
    // `null`, and `.optional()` accepts `undefined` but REJECTS `null`, which would fail validation
    // and silently skip the person at match-batch.mjs's dossier check on every run.
    // A missing name is NOT back-filled or guessed (verbatim or absent). Every consumer guards with
    // `|| ""`, firstName(null) returns "", and the templates degrade cleanly
    // ("You're all set." instead of "You're all set, Maya.").
    name: z.string().nullish(),
    headline: z.string().trim().min(1), // validateDossier requires a non-empty string
    narrative: z.string(), // validateDossier coerces non-strings to "", so by save time it is a string
    proof_points: z.array(z.any()),
    case_studies: z.array(z.any()),
    strengths: z.array(z.any()),
    // .default([]) mirrors what the pipeline does: dossier-build.mjs normalizes a non-array `gaps`
    // to [], and every consumer guards (`Array.isArray(j.gaps) ? … : []`). A stricter schema would
    // silently exclude the person on every run, the same class as `name` above.
    gaps: z.array(z.any()).default([]),
    // GROUNDED person-fact: years in REAL DATED employment only — internships,
    // coursework, and self-directed work never count (a current student is 0). null when there is no
    // datable employment. CONSUMER CONTRACT: it is the person's PROFESSIONAL experience floor, used by the
    // knockout gate to compare against a role's stated min-years; never inflate self-directed time into it.
    professional_years: z.number().nullable().optional(),
    preferences: z
      .object({
        // GROUNDED person-fact: where the candidate is BASED,
        // verbatim from their own words, e.g. "Malta", "Bengaluru, India", "Austin, TX". null/absent when
        // the material never states it. homeRegion() (quality-gate.mjs) classifies it into india | us |
        // other; an "other" candidate is sent an honest "I only cover India and the US" note, never foreign
        // roles. CONSUMER CONTRACT: it says WHERE they live and nothing more — never render it as a claim
        // about their work, and it is never inferred from an employer's location. All the other prefs
        // (role, seniority, remote, comp_currency, dealbreakers, …) still ride through .passthrough().
        home_place: z.string().nullable().optional(),
        // GROUNDED preference: what the person is SEEKING —
        // internship | first_job | active_switch | passive | returning | contract_only. Inferred at build
        // ONLY when unambiguous (a student / zero-professional-employment → internship|first_job); every
        // other value is a real preference a resume cannot show, so it is null until the person states it
        // (asked once in onboarding). CONSUMER CONTRACT: it says what they WANT, used by the knockout gate
        // so an internship-seeker is never sent an experienced full-time role; never guessed from vibes.
        // .catch(null) mirrors the CONSUMER exactly: eligibility-gate.mjs reads this as
        // `typeof prefs.mode === "string" ? prefs.mode : null`, so a malformed value is a no-op
        // there. Without the catch, a model that emits ["internship","first_job"] instead of a
        // single string fails the WHOLE dossier and the person is skipped at match on every run.
        // Degrade the field, never drop the human.
        mode: z.string().nullable().optional().catch(null),
        // GROUNDED preference: the employment type they want (intern | contract | full_time |
        // part_time). null unless the source states it. Consumer: knockout gate vs job.employment_type.
        // Same .catch(null) as `mode`, same reason and same consumer shape: eligibility-gate.mjs
        // reads `typeof prefs.employment_type_wanted === "string" ? … : null`.
        employment_type_wanted: z.string().nullable().optional().catch(null),
        // GROUNDED DESIRE: what the person says they are moving TOWARD / what would
        // make them excited about the next role — THEIR words, null when unstated. CONSUMER CONTRACT: it is
        // a claim about the person (cite-or-drop like any fact); never invent or infer an aspiration, and
        // never render an admiration/motivation they did not state. The input to desire-led matching.
        motivation: z.string().nullable().optional(),
        // GROUNDED DESIRE: companies / kinds of company they explicitly said they'd
        // love to work at. null/[] when none named. Never filled from a guess about what suits them.
        admired: z.array(z.any()).nullable().optional(),
      })
      .passthrough(), // an object (not array/null); individual prefs may be null

    // Edge Engine (dark behind EDGE_ENGINE): the grounded rare-combo POSITION. Optional and
    // nullable: absent when the engine is off and `null` for a common single-domain profile (the honest,
    // expected case). `combo`/`evidence` are grounded claims about the person; `strong_in`/`generic_in`
    // are market judgments. Inner shape is loose (.passthrough) so fields can be added without a
    // schema break. Written by dossier-build.mjs only after edge-verify.mjs confirms it.
    edge: z
      .object({
        combo: z.string(), // GROUNDED claim about the person (cites evidence)
        evidence: z.array(z.any()).optional(), // GROUNDED: the source line(s) behind each combo half
        // CONSUMER CONTRACT: strong_in / generic_in are market JUDGMENTS, not person-facts. Never render
        // them as a claim about the user ("you are strong in X"); they name where the combo is rare/common
        // in the market. A consumer that treats them as person-facts would assert something ungrounded.
        strong_in: z.array(z.any()).optional(),
        generic_in: z.array(z.any()).optional(),
        confidence: z.enum(["high", "medium", "low"]).optional(), // set by edge-verify.mjs, not the builder
        source: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // Dark behind COMPANY_CONTEXT: past employers, each grounded verbatim from the resume
    // (dossier-build.mjs `finalizeEmployers`). Absent when the flag is off. `name` is a GROUNDED person-fact
    // (where they worked); `domain`/`source` are ATTRIBUTED external company research attached by
    // company-context.mjs (`domain` = what the company does). CONSUMER CONTRACT: `domain` is context about
    // WHERE they worked, never a claim about the person. Never render it as a capability ("you have X
    // experience") and never promote it into strengths/proof_points — someone at a messaging company could
    // have been in finance. Treating `domain` as a person-skill would assert something ungrounded.
    employers: z
      .array(
        z
          .object({
            name: z.string(), // GROUNDED: verbatim from the resume
            domain: z.string().optional(), // ATTRIBUTED: what the company does (external research), not a person-fact
            source: z.string().optional(), // provenance of the domain (e.g. "company-research")
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough(); // dossiers carry more (e.g. experience); we only assert the load-bearing shape

/** @typedef {import("zod").infer<typeof Dossier>} DossierType */
