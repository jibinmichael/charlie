// lib/reply-lint.mjs — the pre-send gate for a REPLY, which is a different thing from a message that
// exists to earn an answer.
//
// WHY THIS IS NOT lib/convo-lint.mjs. That lint requires EXACTLY ONE question mark and a
// costless-exit phrase in every message it checks. Those rules are correct for the interrogation
// flow, where a message exists to earn a reply. Applied to an acknowledgement they force a question
// into a message that needs none, and "reply anytime" onto the end of a two-line answer: a lint that
// MANUFACTURES scaffolding would make replies worse while reporting green.
//
// SO THE HONESTY HALF IS REUSED, NOT COPIED. `lintMessage({ conversational: false })` runs exactly
// the universal gate — non-empty, no em dash, and the manipulation blocklist (scarcity, guilt,
// streaks, fake progress). Importing it rather than duplicating the patterns is deliberate: two
// copies of a blocklist drift.
//
// THE REPLY-SPECIFIC RULES, each naming a concrete failure:
//   no-headline      a person does not put an <h1> on a reply (many email-kit templates do).
//   no-eyebrow       the ALL-CAPS letterspaced label is a masthead device.
//   preferences-menu the settings menu is never an answer to a consent grant, a dispute or a "no".
//   too-long         a one-word answer does not get a hundred words back.
//   voice-tic        "I would rather X than Y", "worth your time": a line that lands once lands; the
//                    same line three times is a format.
//
// FAIL CLOSED, WITH ONE EXPLICIT EXCEPTION. A violation drops the send, same discipline as every
// other gate here. The exception is that the person's OWN QUOTED WORDS are excluded from the word
// count: a long quote is their sentence, not Charlie's verbosity, and letting it trip the cap would
// mean the people who write most carefully are the ones who get no answer at all.

import { lintMessage } from "./convo-lint.mjs";

/** Charlie's own words, excluding anything quoted back from the person. */
export const MAX_WORDS = 70;

/**
 * Rhetorical moves that are good once and a format three times. Budget: one per reply.
 * Every pattern here recurs across the email-kit.mjs templates.
 */
export const VOICE_TICS = [
  { rule: "tic-rather", re: /\bI would rather\b/i },
  { rule: "tic-worth-your-time", re: /\bworth your time\b/i },
  { rule: "tic-come-back", re: /\bI will come back\b/i },
  { rule: "tic-nothing-needed", re: /\bNothing (?:else )?is needed from you\b/i },
  { rule: "tic-waiting", re: /\bleave you waiting\b/i },
  { rule: "tic-ask-twice", re: /\bask (?:you )?(?:again|twice)\b/i },
];

/**
 * The preferences menu. It is legitimate copy on the preference-change path and nowhere else: sent in
 * answer to a consent grant, a factual dispute or a plain "no", it tells the person they were not
 * heard. That is why this lint is applied to replies rather than to every send.
 */
const PREFERENCES_MENU = /\bpay floor\b|\bkind of role\b.*\bwhere you want to work\b/i;

/**
 * The mechanism words. User-facing copy never exposes the mechanism: no "dossier", "build",
 * "status", "screening", or "record" reaches a user.
 *
 * Scoped to replies, deliberately: `renderAskAnswerAck` in email-kit.mjs still says "it is on your
 * record now", and widening this lint to every send would drop that email rather than fix its copy.
 */
const MECHANISM = /\b(?:dossier|screening|record(?:s|ed|ing)?|status)\b/i;

/**
 * Lint one outgoing reply. PURE — no I/O.
 *
 * @param {object} o
 * @param {string} [o.subject]
 * @param {string} [o.text]   the plaintext body
 * @param {string} [o.html]   the rendered HTML (structural rules read this)
 * @param {string} [o.quote]  the person's own words, if this reply quotes them. Excluded from the
 *   word count, never from the honesty rules.
 * @param {string} [o.preheader]  the inbox-preview line, checked for mechanism words like the body
 * @returns {{ ok: boolean, violations: Array<{rule:string, kind:string, detail?:string}> }}
 */
export function lintReply({ subject = "", text = "", html = "", quote = "", preheader = "" } = {}) {
  // The universal honesty + voice gate, reused rather than reimplemented. `conversational: false`
  // is what switches OFF the one-question and costless-exit rules; see the header.
  const base = lintMessage({ subject, text, conversational: false });
  const violations = [...base.violations];

  const body = String(text || "");
  const markup = String(html || "");

  // Law 7 — an answer carries no headline and no eyebrow.
  if (/<h1[\s>]/i.test(markup)) violations.push({ rule: "no-headline", kind: "structure" });
  if (/text-transform:\s*uppercase/i.test(markup)) violations.push({ rule: "no-eyebrow", kind: "structure" });

  // Law 9 — the settings menu is never an answer.
  if (PREFERENCES_MENU.test(`${subject}\n${body}`)) violations.push({ rule: "preferences-menu", kind: "honesty" });

  // The mechanism never reaches a person.
  //
  // THE HTML IS IN THE HAYSTACK ON PURPOSE. A template returns { subject, html, text } and the
  // PREHEADER lives inside the html, so a caller has no separate field to hand over. Checking the
  // rendered markup is the only way this rule covers the inbox-preview line, which is the half a
  // copy review reads last. The explicit `preheader` argument stays for direct unit testing.
  const hay = `${subject}\n${body}\n${preheader}\n${markup}`;
  if (MECHANISM.test(hay)) {
    violations.push({ rule: "mechanism-word", kind: "voice", detail: (hay.match(MECHANISM) || [""])[0] });
  }

  // Law 3 — length is set by the incoming message. The person's own quoted words do not count
  // against Charlie's budget.
  const own = quote ? body.split(String(quote)).join(" ") : body;
  const words = own.trim() ? own.trim().split(/\s+/).length : 0;
  if (words > MAX_WORDS) violations.push({ rule: "too-long", kind: "structure", detail: `${words} words of Charlie's own (max ${MAX_WORDS})` });

  // Law 10 — ration the voice. One rhetorical move, not three.
  const tics = VOICE_TICS.filter(({ re }) => re.test(body)).map(({ rule }) => rule);
  if (tics.length > 1) violations.push({ rule: "voice-tic", kind: "voice", detail: tics.join(", ") });

  return { ok: violations.length === 0, violations };
}
