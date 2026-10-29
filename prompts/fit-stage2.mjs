// prompts/fit-stage2.mjs — judging a FIXED requirement list against one person (Fit Engine v2, stage 2).
//
// WHAT IT DOES: given stage 1's requirement list and the candidate's dossier, says what the person's
//   own record shows about EACH requirement. It is never asked what the job requires.
// MODEL: Sonnet 4.6 (lib/fit-stage.mjs `FIT_MODEL`).
// EXPECTED OUTPUT: JSON { requirements: [{ req, status, evidence, locator, evidence_strength }] }.
// VALIDATED AT: lib/schemas/fit-stage.mjs (Stage2Reply.safeParse, per-requirement log-and-skip).
//
// WHY THE LIST IS GIVEN. Re-deriving the requirements on every (person, role) evaluation makes the
// decision unstable across identical temperature-0 runs. Handing over a fixed list makes both the
// send set and the per-requirement JUDGING much more stable: choosing the questions and answering
// them are better kept apart.
//
// THE JD IS PRESENT FOR CONTEXT ONLY. It lets a short label be read in the posting's own terms. The
// rules below forbid extracting anything new from it.
//
// KNOWN LIMITS. `contradicted` (wrong field of study, degree not yet held) is rarely used by the model;
// the status is kept because the operator handles it and the arithmetic contradictions use the same
// channel. A named instance of a requirement (e.g. FastAPI for "Python") is sometimes graded
// `adjacent` rather than `direct`; a prose rule telling the model otherwise does not change its
// behaviour, so do not add one.
export const FIT_STAGE2_SYSTEM = `You are given a FIXED list of a job posting's requirements, and one candidate's profile. Your only job is to say what the candidate's own record shows about EACH requirement on that list.

You do NOT decide what the job requires. The list is fixed. Do not add requirements, do not remove requirements, do not reword them. Return exactly the same requirements, in the same order, with the same "req" strings.

Output ONLY valid JSON, no prose, no backticks:
{
  "requirements": [ {
    "req": string,               // COPIED VERBATIM from the list you were given
    "status": "met"|"partial"|"unknown"|"contradicted",
    "evidence": string|null,
    "locator": string|null,
    "evidence_strength": "direct"|"adjacent"|"self-reported"|"aspirational"|"trivial"|null
  } ]
}

RULES (non-negotiable):
- status: "met" only if the profile EXPLICITLY shows it (put the citing line in evidence). "partial" if real-but-adjacent or under-evidenced (Docker when they ask Kubernetes -> partial, not met). "unknown" is the DEFAULT whenever the profile does not show it — NEVER convert silence into a met or a miss.
- "contradicted" when the profile shows something INCOMPATIBLE with the requirement — not missing, but at odds with it. This is NOT a weaker "partial"; it means the record answers the question and the answer is no. Use it only where the record is explicit, and put the incompatible fact in evidence:
  · the requirement names a FIELD OF STUDY and the record shows a different one ("B.E/B.Tech in CS or IT" against a B.Tech in Mechanical Engineering, or a BA in History).
  · the requirement asks for a degree the record shows is NOT YET HELD (still studying, graduation in a future year).
  · anything else the record states that is plainly at odds with what is asked.
  Silence is never a contradiction — that is "unknown". A near-miss is never a contradiction — that is "partial".
- NEVER invent a strength the profile does not state. Compare ONLY what the requirement asks against ONLY what the profile explicitly shows.
- evidence: the citing line from the profile, or null when status is unknown.
- locator: name the part of the profile the evidence came from, in the profile's own words — the employer, the role title, or the section it sits in ("Product Head at Acme", "proof points"). null whenever status is unknown.
- evidence_strength: how good the evidence you just cited actually is. null when status is unknown. Judge it strictly and never generously:
  · "direct"        — the profile shows them DOING this thing, at a named employer, project, or artifact.
  · "adjacent"      — real, cited work that is genuinely near the ask but is not the ask itself.
  · "self-reported" — the ONLY support is that they say so: a skills list, a headline, a summary line. Nothing shows them doing it.
  · "aspirational"  — the profile shows what they WANT, not what they have done: a target role, a stated interest.
  · "trivial"       — technically satisfied, but by something that separates nobody ("English listed as a spoken language").
  When two could apply, pick the WEAKER one. Understating evidence costs a person one email; overstating it costs them their trust.
- The JOB DESCRIPTION is provided for context only, so you can read a requirement in the terms the posting uses. Do NOT extract new requirements from it.`;

/**
 * The stage-2 turn.
 *
 * ORDER IS BILLING-LOAD-BEARING, exactly as in prompts/fit-coverage.mjs: the dossier is STABLE across
 * a user's roles in one gate walk and carries the cache breakpoint; the posting and the requirement
 * list are volatile and must sit behind it.
 */
export function buildStage2Messages({ today, dossierText, jobTitle, jobDescription, requirements }) {
  const list = (requirements || []).map((q, i) => `${i + 1}. ${q.req}`).join("\n");
  return [{
    role: "user",
    content: [
      { type: "text", text: `## TODAY\n${today}\n\n## CANDIDATE PROFILE (the ONLY source of truth about them)\n${dossierText}\n\n`, cache_control: { type: "ephemeral" } },
      { type: "text", text: `## ROLE\n${jobTitle || "(untitled)"}\n\n## JOB DESCRIPTION (context only)\n${String(jobDescription).slice(0, 6000)}\n\n## THE REQUIREMENTS TO JUDGE (fixed - return these exact strings, in this order)\n${list}` },
    ],
  }];
}
