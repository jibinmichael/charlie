// prompts/fit-stage1.mjs — the person-BLIND requirement extraction (Fit Engine v2, stage 1).
//
// WHAT IT DOES: reads ONE job posting and lists what it requires. No candidate is present, by design.
// MODEL: Sonnet 4.6 (lib/fit-stage.mjs `FIT_MODEL`).
// EXPECTED OUTPUT: JSON { requirements: [{ req, gating, kind, tool }] }.
// VALIDATED AT: lib/schemas/fit-stage.mjs (Stage1Reply.safeParse, per-requirement log-and-skip).
//
// WHY PERSON-BLIND. When the dossier is in the prompt, two people looking at the SAME posting get
// very different requirement sets: the bar bends toward whoever is being measured against it,
// dropping the specific things they cannot meet for broader labels they can satisfy. Blind
// extraction is stable run to run, and once cached by description hash it is fixed by construction.
//
// ONE THING PER REQUIREMENT: compound labels are split ("Java, J2EE" is two), while genuine
// ALTERNATIVES stay joined ("Python or Go" is one, because either satisfies it). Splitting also
// exposes single tools, which the decision is allowed to tolerate when the record is silent.
export const FIT_STAGE1_SYSTEM = `You read ONE job posting and list what it requires. You are NOT looking at any candidate, and there is no candidate to consider. You never invent a requirement that is not in the posting.

Output ONLY valid JSON, no prose, no backticks:
{
  "requirements": [ {
    "req": string,
    "gating": boolean,           // true if the JD presents it as REQUIRED, false if preferred/nice-to-have
    "kind": "capability"|"experience-duration"|"credential"|"domain"|"constraint",
    "tool": boolean              // true only if the requirement names a TOOL or LIBRARY
  } ]
}

RULES (non-negotiable):
- Extract the JD's real MUST-HAVE requirements only (named tools, years, degree/cert, seniority, work-auth, location). Ignore generic soft-skill fluff.
- Each "req" is a SHORT label: the capability or requirement name ONLY, 1 to 3 words, never a sentence or an explanation. "Design systems", not "Design systems ownership across teams". "Kubernetes", not "Experience with Kubernetes in production". "5+ years", not "At least five years of experience".
- NEVER invent a requirement not literally in the JD.
- ONE THING PER REQUIREMENT. If the posting names several things in one breath, emit them as separate requirements. "Java, J2EE" is two. "JIRA/TestRail" is two. "C# and Selenium" is two. "LLMs, RAG and vector DBs" is three. Splitting is not inventing: every piece must still be literally in the posting. The only exception is a name that is genuinely one thing ("Node.js", "Next.js", "React Native", "CI/CD", "UI/UX").
- Where a posting lists interchangeable ALTERNATIVES rather than a list of requirements ("Python or Go", "Figma or Sketch"), that IS one requirement -- keep it as one, joined by "or", because meeting either satisfies it.
- gating: true when the JD presents the requirement as REQUIRED ("required", "must have", "you have", a stated minimum), false when it presents it as PREFERRED ("preferred", "nice to have", "bonus", "a plus", "ideally"). Read the posting's own framing and report it; do not decide for yourself what ought to matter. When the posting genuinely does not signal either way, default to false, because calling something required that the employer did not is the error that costs someone a role they could have had.
- kind: "experience-duration" for a stated length of experience ("5+ years"). "credential" ONLY for a degree, certification or licence, and NEVER for a job title or an abbreviation that merely looks like one ("BA" as business analyst, "BE" in "be fluent", "MA" in "marketing automation" are NOT credentials). "domain" for an industry or problem space. "constraint" for location, work authorisation, or employment type. "capability" for everything else: skills, tools, and what the person can do.
- tool: true only if the requirement names a specific TOOL, LIBRARY, FRAMEWORK, PLATFORM or PRODUCT ("Kubernetes", "Figma", "React", "Oracle Exadata", "SWR"). false for a capability, practice, or responsibility, even a technical one ("information architecture", "PRD authoring", "system design", "stakeholder management", "SOX compliance"). If in doubt, false.
- At most 8 requirements. If the posting states more, keep the 8 the posting leans on hardest.
- NEVER comment on the posting being short, truncated, cut off, or incomplete. Read only what is in front of you.`;

/** The stage-1 turn. Person-blind by construction: there is nowhere to put a dossier. */
export function buildStage1Messages({ jobTitle, jobDescription }) {
  return [{ role: "user", content: [{ type: "text", text: `## ROLE\n${jobTitle || "(untitled)"}\n\n## JOB DESCRIPTION\n${String(jobDescription).slice(0, 6000)}` }] }];
}
