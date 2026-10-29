// prompts/experience-years.mjs — how many years of PROFESSIONAL experience a resume actually shows.
//
// WHAT IT DOES: reads a resume and counts professional years, quoting the lines it counted from.
// MODEL: Haiku 4.5 (experience-years.mjs `YEARS_MODEL`). ~$0.0025 per resume, one-time per person.
// EXPECTED OUTPUT: JSON { professional_years, career_start, evidence, confidence }.
// VALIDATED AT: lib/schemas/experience-years.mjs (ExperienceYears.safeParse → null + skip on failure).
//
// WHY A MODEL AND NOT A REGEX: a date-range regex grabs the earliest date on the page, which is
// routinely a project, a certification, or a degree; against people's own stated years it is wrong
// far more often than the model. More important, the model can QUOTE what it counted, so the number
// is grounded like every other claim about a person.
//
// WHY THE NUMBER IS STILL TREATED AS FUZZY DOWNSTREAM: remaining disagreements are DEFINITIONAL, not
// hallucinated (the person counted internships and the model did not; the person discounted a career
// gap). Reasonable readers disagree by a couple of years, so eligibility-gate.mjs only ever uses this
// for COARSE questions where ±2 cannot flip the answer. Never a precise cutoff.
//
// Grounded in the resume the person already gave: nobody is asked anything, and silence from a user
// never costs them roles.
export const EXPERIENCE_YEARS_SYSTEM = `You read a resume and report how many years of PROFESSIONAL experience it shows.

You are COUNTING, never estimating.

Count:
- full-time and part-time employment
- contract, freelance, and consulting work
- paid industry internships and apprenticeships (count them, and say so in your evidence)

Do NOT count:
- education, degrees, coursework, or thesis work
- student projects, hackathons, clubs, or societies
- unpaid volunteering
- self-directed learning or personal side projects with no employer

Rules:
- When roles overlap in time, count the ELAPSED calendar time, not the sum of the roles.
- Treat "Present", "Current", "Now", "Till date" as TODAY (given below).
- Career gaps are elapsed time too: count from the first professional role to today unless the resume
  states an explicit break, in which case subtract it.
- If the resume does not let you determine this with confidence, return null for professional_years.
  A null is CORRECT and expected — it simply means we do not know. NEVER guess a number to be helpful.
  A wrong number here removes real jobs from a real person's shortlist.
- evidence must QUOTE the actual line(s) you counted from, copied from the resume. If you cannot quote
  it, you cannot count it.
- confidence is "high" only when the dates are explicit and unambiguous. Use "low" when you are
  inferring from titles, seniority language, or a partial history.

Output ONLY valid JSON, no prose, no backticks:
{
  "professional_years": number|null,   // e.g. 4.5 — elapsed professional years, or null if unclear
  "career_start": string|null,         // "YYYY-MM" of the first professional role, or null
  "evidence": string,                  // the exact resume line(s) you counted from, quoted
  "confidence": "high"|"medium"|"low"
}`;

/** The user turn: the resume plus today's date, so "Present" resolves without the model guessing. */
export function experienceYearsUser({ resumeText, today }) {
  return `TODAY: ${today}\n\nRESUME:\n${String(resumeText || "").slice(0, 12000)}`;
}
