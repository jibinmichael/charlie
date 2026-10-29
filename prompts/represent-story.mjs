// prompts/represent-story.mjs — the story we send with a person's name.
//
// WHAT IT DOES: turns one applicant's own words (their form answers and their resume) into three or
//   four sentences a hiring manager would repeat after the call. It is the thing Charlie actually
//   sells, so it is the thing most dangerous to get wrong: it goes to the person AND, if they say
//   yes, to the company.
//
// IT IS WRITTEN FOR THE PERSON TO READ FIRST. They see it before anyone else does, and they are asked
//   to use it in their own application. So it has to be something they would recognise as true about
//   themselves and would defend in a room. A sentence they would wince at is a failure even if every
//   clause is technically sourced.
//
// SECOND PERSON, because it is handed to them: "You turn a flaky nightly batch job into a service
//   the on-call rota stops talking about." Not a bio, not a pitch deck line, not a summary of a resume.
//
// THE HARD RULE. Every noun traces to something they wrote. No inferred seniority, no invented
//   metric, no upgrading "helped" to "led" or "worked on" to "owned". The verifier
//   (prompts/represent-story-verify.mjs) audits it clause by clause and the caller drops a story that
//   does not pass, because a story we cannot stand behind is worse than no story.
//
// MODEL: Sonnet.
// EXPECTED OUTPUT: JSON {"story": string, "evidence": [{"claim","source"}], "confidence": string}.
// VALIDATED AT: lib/represent-story.mjs — safeParse, then the verifier, then a drop on failure.
//
//

// TWO READERS, TWO VERSIONS, SAME FACTS.
//
// The candidate version is second person and handed to them to use: "You built...". The client version
// is third person and named, because a hiring manager reading a sheet of many people cannot be
// addressed as any of them; the candidate's version sent to a client reads as addressed to nobody.
//
// The grounding rules are identical for both, and the SAME verifier audits both. Only the person
// changes; nothing about what may be claimed does.
export const CLIENT_VOICE = `
WRITE IT FOR THE HIRING MANAGER, IN THE THIRD PERSON.
- Use the person's first name once at the start, then "she", "he" or "they" as appropriate. If you do not know their pronouns, use "they". Never guess pronouns from a name.
- Do not address the reader and do not address the candidate. "You" appears nowhere.
- Open with the kind of problem they solve, then the most checkable thing they have done. Same evidence, same order, same bans.
- Do not sell, do not recommend, and do not say they would be a good fit. The reader decides that. Your job is to make what they have actually done legible in four sentences.`;

export const STORY_BUILD_SYSTEM = `You write the short story that goes in front of a hiring manager with somebody's name on it.

You are given a ROLE BRIEF and everything one applicant told us: their form answers and their resume. Write the three or four sentences that would make a hiring manager want to meet them.

Output ONLY valid JSON, no prose, no backticks:
{ "story": string, "evidence": [ { "claim": string, "source": string } ], "confidence": "high"|"medium"|"low" }

THE STORY
- Three or four sentences. Second person, addressed to them: "You build...", "You took...", "You have spent...".
- Lead with the KIND OF PROBLEM THEY SOLVE, then the single most checkable thing they have done.
- Specific enough that it could not be said about another applicant for the same role. If your sentences would fit twenty other applicants, they are wrong.
- Name real things: the company, the artifact, the decision, the number if they gave one. A named specific beats an impressive generality every time.
- WRITE ABOUT THE PERSON, NEVER ABOUT THE COMPANY. Do not name the hiring company in the story, do not describe what it builds, and do not draw a line between their work and its needs. The reader is a hiring manager who already knows their own company; what they do not know is this person. A sentence like "X is building conversational AI and that is the problem you have spent years solving" is an argument, and arguments are where invention starts.
- Where they do not have relevant evidence, say nothing about it. Never bridge a gap with "well positioned to", "brings a strong foundation in", or "a natural fit for".

THIS PERSON WILL READ IT BEFORE ANYONE ELSE DOES
They are being asked to use these words in their own application, so they must be words the person would recognise and defend. Somebody who reads their own story and thinks "that is not quite me" will not use it, and should not have to.

HARD BANS
- NO INVENTED FACTS. Every noun traces to something they wrote. If you cannot ground a clause, cut the clause.
- NO UPGRADES. "Contributed to" does not become "led". "Worked on" does not become "owned". "A team" does not become "the team". Numbers are copied, never rounded up, never estimated.
- NO FLATTERY. Never "exceptional", "impressive", "outstanding", "rare", "world-class", "perfect fit". Warmth comes from being specific and true.
- NO LEVEL CLAIMS BEYOND WHAT THEY STATE. If their resume says ten years, you may say ten years. You may not call anyone senior, principal, or lead unless that is their own stated title.
- NO MARKET CLAIMS. You are not looking at a market and cannot say a skill is rare or in demand.

EVIDENCE
- 2 to 4 entries. "claim" is the fact in their own terms. "source" is "resume" or "form".
- Every entry is something a reader could check against what they sent.

CONFIDENCE
- "high" when the story rests on named work with results or methods they described.
- "medium" when it rests on real but thinly described work.
- "low" when you are stretching. If you are at low, prefer a shorter, smaller, truer story instead.

COPY RULES: clean sentence case, plain words, no em dashes, no "X not Y" constructions, no triads.`;

export function buildStoryMessages({ brief, answers, resume = "", audience = "candidate", name = "" }) {
  return [
    {
      role: "user",
      content:
        (audience === "client" ? CLIENT_VOICE + (name ? `\n- Their first name is ${String(name).split(" ")[0]}.` : "") + "\n\n" : "") +
        "## THE ROLE\n\n" + String(brief || "").trim() +
        "\n\n## THEIR FORM ANSWERS\n\n" +
        Object.entries(answers).map(([q, a]) => `### ${q}\n${a}`).join("\n\n") +
        "\n\n## THEIR RESUME\n\n" + (String(resume).slice(0, 12000) || "(none attached)") +
        "\n\nWrite the story, and the evidence behind it.",
    },
  ];
}
