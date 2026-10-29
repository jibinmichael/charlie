// prompts/inbound-signal.mjs — what did this person just tell us about themselves?
//
// BOTTOM-UP, ON PURPOSE. There is no list of traits to pick from, because a list I write encodes my
// assumptions about what a good candidate looks like. That is exactly how "Tier 1/2" gets into a
// mandate: somebody's private taxonomy, stated as if it were a standard. The labels are discovered
// from the corpus, normalised in a second pass, and reviewed by a human before anything is written
// to a person's record.
//
// FACTS AND TRAITS ARE DIFFERENT THINGS. Pay, notice, work mode and location have columns already.
// A trait is a description of how somebody works. Putting "expects 20 LPA" in the trait list buries
// a queryable number inside prose.
//
// EVERY LABEL CARRIES ITS QUOTE. Same cite-or-drop rule as the rest of the product: a trait we cannot
// point at is a claim about a person we cannot defend, and this one goes on a record a client reads.
//
// IT DESCRIBES WHAT THEY SAID, NOT WHAT THEY ARE. "Names the metric they moved" is a description of
// the message. "Data-driven" is a verdict on the human, and it is not available here.
//
// MODEL: Haiku 4.5, temperature 0. One call per message, about $0.0025.
// EXPECTED OUTPUT: JSON, see InboundSignal in lib/schemas/inbound-signal.mjs.
// INPUT: inbound messages after the vendor-mail quarantine in lib/inbound-corpus.mjs (recruiter
//   mailers and sales pitches share the table with real candidate replies).

export const INBOUND_SIGNAL_SYSTEM = `You read one email a person sent to a career agent, and you report what it tells us about them. You are not judging them and you are not deciding anything.

Output ONLY valid JSON, no prose, no backticks:
{
  "traits": [{ "label": string, "quote": string }],
  "facts": { "pay_expected": string|null, "notice": string|null, "work_mode": string|null,
             "location": string|null, "seeking": "open"|"not_looking"|"has_offer"|"unclear" },
  "has_work_evidence": boolean
}

TRAITS DESCRIBE THE MESSAGE, NOT THE HUMAN.
  Good: "names the metric they moved", "gives the scale of the team they led", "says what they got
         wrong", "asks about the company before the salary", "states a constraint plainly"
  Bad:  "data-driven", "strong communicator", "high potential", "impressive", "self-starter"

The first kind is checkable against the words in front of you. The second is a verdict on a person
from one email, and you are not in a position to make one.

Write each label in your own plain words. There is no list to choose from. Two to five labels for a
substantial message, zero for one that says nothing about them. Do not pad.

EVERY LABEL NEEDS ITS QUOTE, copied verbatim from the message. If you cannot copy the words that
produced a label, drop the label.

FACTS are separate and only when stated outright:
  pay_expected  their number or range, as they wrote it. null if not mentioned.
  notice        how soon they can start, as they wrote it.
  work_mode     remote, hybrid, onsite, or a constraint like "remote only".
  location      where they are or want to be.
  seeking       "open" if they say they are looking, "not_looking" if they say they are not,
                "has_offer" if they mention holding an offer, otherwise "unclear".
Never infer a fact from tone. Not stated means null.

"has_work_evidence" is true when the message contains an account of work they personally did, with
enough specifics that somebody could ask a follow-up question about it. A description of their job
title or their interests is not work evidence.

DO NOT
- Do not rate, rank, or say whether they are suitable for anything.
- Do not describe their personality, ambition, attitude or potential.
- Do not repeat their job title back as a trait.
- Do not invent a quote.

COPY RULES: lowercase labels, plain words, no em dashes.`;

export function buildInboundSignalMessages({ subject = "", body = "" }) {
  return [{
    role: "user",
    content: `## SUBJECT\n${String(subject || "(none)").slice(0, 200)}\n\n## THE MESSAGE\n${String(body || "").slice(0, 5000)}\n\nWhat does this tell us about them?`,
  }];
}

// ---------------------------------------------------------------------------
// STEP 3 — normalise the discovered labels into a master list.
//
// The discovery pass writes a label in its own words each time, so "names the metric they moved" and
// "gives a number for the outcome" are the same observation twice. This pass groups them. It is the
// only place where a vocabulary gets fixed, which is why it runs ONCE, over the whole corpus, and its
// output is read by a human before anything is scored against it.
//
// A FAMILY IS NAMED OUT OF ITS MEMBERS, never invented to sound complete. A family with one member is
// reported as a singleton rather than folded into a neighbour, because a rare signal that gets
// absorbed into a common one is how the rare thing stops being visible.
//
// MODEL: Sonnet 4.6, temperature 0. One call over the whole label set, about $0.05.

export const INBOUND_NORMALISE_SYSTEM = `You are given every trait label extracted from a corpus of emails candidates sent to a career agent. Each label was written independently, so the same observation appears many times in different words. Group them.

Output ONLY valid JSON, no prose, no backticks:
{
  "families": [{ "name": string, "meaning": string, "members": [string], "count": number }],
  "singletons": [string]
}

RULES

Name each family out of the words its members already use. Do not invent a tidy category name and
then decide what belongs in it. If the members say "names the metric they moved" and "gives the
number the thing reached", the family is about naming a number, and it is called that.

Group by WHAT WAS OBSERVED, not by subject matter. "led a team of 30" and "worked with three
designers" both report the scale of what they ran, and belong together. "led a team of 30" and
"led the AI roadmap" do not, even though both start with "led".

"meaning" is one sentence saying what a message must contain to earn this family. Somebody reading
it should be able to check a message against it without guessing.

A label that fits nothing goes in "singletons", unchanged. Do not force it. Do not create a family
of one to avoid the singleton list. A signal that only one person gave is still a signal, and
folding it into a bigger family is how it disappears.

Never create a family that is a verdict on a person: no "high performer", no "strong communicator",
no "senior mindset". Every family must describe something present in the text of a message.

"count" is the number of member labels, which you can count exactly.

COPY RULES: lowercase names, plain words, no em dashes.`;

export function buildInboundNormaliseMessages({ labels = [] }) {
  const lines = labels.map((l) => `${l.n}x  ${l.label}`).join("\n");
  return [{
    role: "user",
    content: `## EVERY LABEL, WITH HOW OFTEN IT APPEARED\n${lines}\n\nGroup these.`,
  }];
}
