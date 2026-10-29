// campaign-gate.mjs — the deterministic gates for the join@ hiring campaign. Pure + testable, no model,
// no I/O. Two things live here, and only these two are ever decided by code (everything else in the
// campaign is either conducted by the model under convo-lint or decided by a human):
//
//  1. orderGateVerdict — Case 2, "onboarded first". A person may only enter the challenge flow if they
//     actually built a dossier at start@ AND a real role reached them. FAIL-CLOSED: any missing/ambiguous
//     fact resolves to "redirect", never "ok". This is the mechanical filter the post promises.
//
//  2. parseOwnerVerdict — the human verdict, extracted from the owner's reply. The MODEL never decides
//     advance/reject; a person types it and Charlie executes it. This parser is strict on the keyword and
//     tolerant on the target (the target may instead come from the email thread the owner replied to).
//     It returns null on anything it does not clearly recognize, so an ambiguous owner reply does nothing.

/**
 * Case 2 order gate. The applicant must have actually onboarded and built a dossier at start@.
 * Anything missing or ambiguous redirects.
 *
 * WHY "A ROLE MUST HAVE REACHED THEM" IS NOT REQUIRED. Requiring it would make the gate unreachable
 * for a new applicant: role sends are cohort-limited and weekly, so an applicant could onboard,
 * write in, be told to do it in order, and loop there forever — a polite dead end that is worse
 * than a rejection because nobody finds out it is one.
 *
 * The gate's purpose is that they used the product and let it get to know them before they may
 * talk to us about it. Whether a role cleared their bar in the meantime says nothing about them.
 *
 * `hasDeliveredMatch` is still accepted and recorded by the caller, because it is useful context
 * for the human casting the verdict. It does not decide admission.
 *
 * @param {{ hasCandidate?: boolean, hasDeliveredMatch?: boolean }} facts
 * @returns {"ok"|"redirect"}
 */
export function orderGateVerdict({ hasCandidate = false } = {}) {
  if (hasCandidate === true) return "ok";
  return "redirect"; // fail-closed: no dossier, or unknown -> onboard first
}

// ── the incomplete-application gate ─────────────────────────────────────────────────────────────
//
// A serious role can't be done by someone who didn't read what they're applying for.
//
// THIS IS NOT A REJECTION, AND THAT DISTINCTION IS THE WHOLE DESIGN. The campaign's standing
// non-negotiable is that the VERDICT IS 100% HUMAN — Charlie assembles, the owner decides, the model
// never decides who passes. So this does not judge whether an answer was GOOD. It checks whether the
// two things the posting asked for were ATTEMPTED, which is a fact about the message, not an opinion
// about the person. An incomplete application is told what was asked and may simply write again.
//
// FAILS OPEN, DELIBERATELY, AND THE ASYMMETRY IS THE POINT. Anything not CLEARLY incomplete passes to
// the human. A wasted read costs the owner two minutes; a wrongly-blocked applicant is lost silently
// and forever, and never learns why. So every ambiguous case resolves to "ok".

// The posting asks for two things: what they believe Charlie is for, and how the onboarding felt.
// Touching EITHER subject is enough to count as an attempt — this is not a completeness score.
const ENGAGED_WITH_PRODUCT =
  /\b(charlie|onboard\w*|sign(ed)?[\s-]?up|your email|the email|the role you|you sent me|you asked me|the product|job seeker|the match|my dossier|the questions?)\b/i;

// A message that is only a covering note wrapped around a CV. On its own this is not disqualifying;
// it only matters alongside the absence of any engagement above.
const RESUME_FORWARD = /\b(pfa|please find (my )?attach|attached (is |my )?(resume|cv)|kindly (find|consider)|i am interested in (this|the) (role|position)|apply(ing)? for (this|the) (role|position))\b/i;

/** Their own words, minus quoted history and a signature block. */
function ownWords(body) {
  return String(body || "")
    .replace(/^\s*>.*$/gm, "")                     // quoted lines
    .replace(/^\s*(on .+ wrote:|from:|sent:|to:|subject:).*$/gim, "")
    .replace(/^\s*(--|__|thanks|regards|best|sincerely|warm regards)\b[\s\S]*$/im, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Did this message attempt the application at all?
 *
 * @param {string} body the sender's own words, already de-quoted upstream
 * @returns {"ok"|"incomplete"}
 */
export function attemptVerdict(body) {
  const text = ownWords(body);
  if (!text) return "incomplete";                 // an empty note, or an attachment with nothing said

  // Substantive on any subject -> a human reads it. Length alone is never a REASON to block, only a
  // reason to stop looking: nobody writes 400 considered characters without engaging with something.
  if (text.length >= 400) return "ok";
  if (ENGAGED_WITH_PRODUCT.test(text)) return "ok";

  // Short, says nothing about the product or the onboarding, and reads as a CV covering note.
  if (text.length < 400 && RESUME_FORWARD.test(text)) return "incomplete";

  // Very short and engaged with nothing. "Interested." / "Looking for opportunities."
  if (text.length < 120) return "incomplete";

  return "ok"; // ambiguous -> the human reads it
}

/**
 * Parse a verdict from the owner's reply. Recognizes a leading advance|reject|hold keyword, optionally
 * followed by the target applicant's email. Returns null if no clear verdict keyword is present.
 * @param {string} text
 * @returns {{ verdict: "advance"|"reject"|"hold", target: string|null }|null}
 */
/**
 * Strip an email reply's quoted original, leaving only the sender's OWN new words. Real replies quote
 * the message they answer (Gmail's "On ... wrote:" header, ">" lines, or a "----"/"____" delimiter);
 * without this the transcript stores Charlie's own quoted text back, and a verdict/answer reads wrong.
 * @param {string} text
 * @returns {string}
 */
export function stripQuotedReply(text) {
  let top = String(text ?? "");
  // the "On <date> <name> wrote:" header often wraps across lines, so let it span newlines (bounded).
  const cut = top.search(/\n\s*On\b[\s\S]{0,240}?\bwrote:|\n\s*[-_]{3,}\s*(?:\n|$)|\n\s*>/);
  if (cut > 0) top = top.slice(0, cut);
  return top
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .trim();
}

/**
 * Like stripQuotedReply, but keeps the sender's own words WHEREVER they sit — above the quote or
 * below it. It drops quoted lines and the attribution header rather than truncating at the first
 * quote marker.
 *
 * WHY BOTH EXIST. stripQuotedReply truncates at the first quote marker, which is right when you only
 * care about a short top-posted answer (a bare "approve", an owner verdict). It is WRONG when the
 * sender's words are the payload, because a bottom-posted reply
 *     On Fri, Charlie wrote:
 *     > Staff Product Designer, Bengaluru, Rs 90L
 *
 *     actually make it remote only
 * truncates to the attribution line "On Fri, Charlie wrote:" — non-empty, so a `|| body` fallback
 * never fires and the real instruction is silently lost. Use THIS one before any writeback that acts
 * on what the person said. See server/charlie-remote.ts (applyEmailChange).
 * @param {string} text
 * @returns {string}
 */
export function stripQuotedLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))                                  // quoted body
    .filter((l) => !/^\s*On\b.{0,240}\bwrote:\s*$/.test(l))           // Gmail/Apple attribution
    .filter((l) => !/^\s*[-_]{3,}\s*$/.test(l))                       // Outlook-style delimiter
    .join("\n")
    .trim();
}

export function parseOwnerVerdict(text) {
  // de-quote FIRST so the quoted "reply advance / reject / hold" instruction can never trigger a verdict;
  // then read the FIRST verdict keyword in the owner's own words. Not anchored to char 0, because real
  // replies carry greetings / stray chars / client formatting before the word. The owner is a single
  // trusted address, so a stray keyword is not a risk.
  const top = stripQuotedReply(text) || String(text ?? "");
  const m = top.match(/\b(advance|reject|hold)\b[\s:,\-]*([^\s@]+@[^\s@]+\.[^\s@]+)?/i);
  if (!m) return null;
  const verdict = m[1].toLowerCase();
  const target = m[2] ? m[2].toLowerCase().replace(/[.,;>)\]]+$/, "") : null;
  return { verdict, target };
}
