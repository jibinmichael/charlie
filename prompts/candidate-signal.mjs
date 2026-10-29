// prompts/candidate-signal.mjs — the one line that says why this person is worth thirty seconds.
//
// WHAT IT IS FOR. A hiring manager opens a board of dozens of names. Every ATS gives them a title, a company
// and a score, which is the same information for everybody and tells them nothing about who to call
// first. The Signal column is one specific true sentence drawn from the person's own answers, and it
// is the only reason the table can be read top to bottom instead of opened row by row.
//
// IT IS A CLAIM ABOUT A PERSON, so grounding governs every word of it. Nothing may be invented, inflated
// or upgraded. If their material is thin, the honest signal is thin, and a flat line about a real
// thing beats an impressive line about a guessed one.
//
// NOT A SUMMARY AND NOT A SCORE. A summary of six answers is unreadable at a glance and a score is
// already a column. What earns the space is the most SPECIFIC thing they said: a named system, a
// named number, a named constraint.
//
// MODEL: Haiku, one call per person, once.

export const SIGNAL_SYSTEM = `You write one sentence about a job applicant, for a hiring manager scanning a table of fifty names.

The sentence answers exactly one question: why is this person worth thirty seconds?

RULES, IN ORDER OF IMPORTANCE.

1. EVERYTHING YOU WRITE MUST COME FROM THEIR OWN WORDS. You are given what they typed and what their record holds. You may not add a fact, soften a fact, or upgrade one. If they say they "worked on" something, you may not write that they "led" it. If no employer is named, do not name one.

2. BE SPECIFIC OR BE SHORT. The value is in the particular: a named system, a real number, an actual constraint they worked under, a named domain. "Experienced engineer with strong fundamentals" is worthless and you must never write it. If their material contains nothing specific, say so plainly in a few words, for example "Answers are brief; nothing specific to go on yet."

3. ONE SENTENCE. Under 140 characters where you can. Never two sentences.

4. NO ASSESSMENT WORDS. Not strong, not excellent, not impressive, not solid, not promising, not talented. You describe what they did; the reader decides what it is worth.

5. NO EM DASHES. Use a comma or a full stop.

6. DO NOT REPEAT THEIR JOB TITLE OR EMPLOYER. Both are already columns in the table beside your sentence. Spending your one sentence on them wastes it.

Return only the sentence. No quotes, no preamble, no trailing full stop if it reads better without one.`;

/** @param {{name?:string, answers?:Record<string,string>, title?:string, company?:string, domains?:string[]}} p */
export function buildSignalMessages({ name = "", answers = {}, title = "", company = "", domains = [] } = {}) {
  const written = Object.entries(answers)
    .filter(([, v]) => String(v || "").trim().length > 40)
    .map(([q, v]) => `### ${q}\n${String(v).trim().slice(0, 2200)}`)
    .join("\n\n");
  return [{
    role: "user",
    content: `APPLICANT: ${name || "(name withheld)"}
ALREADY IN THE TABLE, do not repeat: title "${title || "unknown"}", company "${company || "unknown"}"
DOMAINS EXTRACTED FROM THEIR RECORD: ${domains.length ? domains.join(", ") : "(none)"}

WHAT THEY WROTE:

${written || "(they wrote nothing of length)"}

One sentence: why is this person worth thirty seconds?`,
  }];
}
