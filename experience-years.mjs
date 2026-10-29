// experience-years.mjs — read a person's PROFESSIONAL years off the resume they already gave us.
//
// WHY THIS EXISTS. The knockout floor (eligibility-gate.mjs) reads what a ROLE requires — role-reqs.mjs
// pulls a stated minimum out of the JD. Without the PERSON's years (`professional_years`) the
// experience floor removes nothing, and a senior professional can be shown an internship.
//
// WHY IT READS THE RESUME INSTEAD OF ASKING. Silence from a user must never cost them roles — a person
// who does not reply still gets the same product. Most users have a resume on file, so the answer is
// already in our hands. Nobody is asked anything.
//
// GROUNDING. The number is a claim about a person, so nothing may be invented: the model must QUOTE the resume
// lines it counted from, the reply is schema-validated at the boundary, and a number that cannot cite
// itself is discarded rather than stored. Provenance rides with the value in `experience_basis`.
//
// FUZZINESS IS THE POINT. Disagreements with what people say about themselves are definitional, not
// hallucinations (internships counted or not, a career gap discounted or not). Reasonable readers
// differ by a couple of years. So this module reports a
// number AND a confidence, and eligibility-gate.mjs only ever asks it coarse questions.
import Anthropic from "@anthropic-ai/sdk";
import { EXPERIENCE_YEARS_SYSTEM, experienceYearsUser } from "./prompts/experience-years.mjs";
import { ExperienceYears } from "./lib/schemas/experience-years.mjs";

const YEARS_MODEL = process.env.YEARS_MODEL || "claude-haiku-4-5-20251001";
const MIN_RESUME_CHARS = 200; // below this there is nothing to count; do not spend a call

function stripFences(s) {
  return String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}
function textOf(res) {
  return (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

/**
 * Extract professional years from a resume. FAIL-OPEN by design: every failure path returns null,
 * which leaves the experience knockout inert for that person. An unknown must never manufacture a
 * block — the cost of missing a knockout is one stretch role; the cost of a confident wrong number is
 * a third of someone's shortlist silently deleted.
 *
 * @param {string} resumeText
 * @param {{log?: Function}} [opts]
 * @returns {Promise<null | import("./lib/schemas/experience-years.mjs").ExperienceYearsType>}
 */
export async function extractExperienceYears(resumeText, { log = console.error } = {}) {
  const text = String(resumeText || "");
  if (text.length < MIN_RESUME_CHARS) return null;
  let raw;
  try {
    const client = new Anthropic();
    const today = new Date().toISOString().slice(0, 10);
    const res = await client.messages.create({
      model: YEARS_MODEL,
      max_tokens: 400,
      system: EXPERIENCE_YEARS_SYSTEM,
      messages: [{ role: "user", content: experienceYearsUser({ resumeText: text, today }) }],
    });
    raw = JSON.parse(stripFences(textOf(res)));
  } catch (e) {
    log(`[years] extraction failed (${e.message}) — leaving years unknown (knockout stays inert)`);
    return null;
  }
  const parsed = ExperienceYears.safeParse(raw);
  if (!parsed.success) {
    // Boundary validation: log the offending field and skip the record, never crash the batch.
    log(`[years] schema reject: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`);
    return null;
  }
  return parsed.data;
}

/**
 * The dossier patch for a validated extraction. Kept pure + separate so the storage shape is testable
 * without a model call, and so the caller decides when to persist.
 *
 * `professional_years` is the field the knockout gate already reads. `experience_basis` carries the
 * provenance beside it, so anyone can see WHERE a number came from instead of trusting it.
 */
export function experienceYearsPatch(extracted, { at = new Date().toISOString() } = {}) {
  if (!extracted) return null;
  return {
    professional_years: extracted.professional_years,
    experience_basis: {
      career_start: extracted.career_start,
      evidence: extracted.evidence,
      confidence: extracted.confidence,
      source: "resume",
      model: YEARS_MODEL,
      extracted_at: at,
    },
  };
}
