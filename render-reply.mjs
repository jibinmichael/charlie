// render-reply.mjs — the replies Charlie sends when somebody writes back.
//
// Isolated from email-kit.mjs the same way render-campaign.mjs and render-email.mjs are: it imports
// the LOCKED presentational pieces and renders through them, so a reply can never change the shared
// design. No font, colour or spacing value is invented in this file.
//
// WHY IT EXISTS. `/inbound` classifies several different kinds of message (a consent grant, a factual
// dispute, a status update, an answer to Charlie's own question, a newsletter, a thank-you). Answering
// all of them with one generic template offering a preferences menu (`renderAck`) reads as not having
// listened. Each kind gets its own reply here.
//
// THE REGISTER IS DIFFERENT FROM EVERY OTHER TEMPLATE, ON PURPOSE.
//   - NO <h1> and NO eyebrow label. People do not put a headline on a reply. Headlines belong to
//     announcements (a role, a briefing); an answer gets a greeting and a sentence.
//   - LENGTH IS SET BY THE INCOMING MESSAGE, not by the template. Every body here is under 40 words.
//   - AT MOST ONE rhetorical move per reply. Stock lines ("I would rather X than Y", "worth your time")
//     recur across email-kit.mjs; a line that lands once lands, the same line three times is a format,
//     and the reader starts hearing the machine rather than a person.
//
// GROUNDING. Nothing in this file states a fact about a person that Charlie did not receive.
// The only per-person value any template accepts is `quote`, which is the VERBATIM span the
// classifier copied out of their own message (prompts/inbound-intent.mjs). It is never paraphrased,
// never summarised, and never used to infer anything. Templates that do not need it do not take it.
//
// WHY ONLY TWO TEMPLATES QUOTE. Quoting somebody back is the machine showing its work, and at scale
// it becomes its own tell. It earns its place in exactly two situations: an instruction that carries
// consequences (consent, where naming the scope out loud is what makes it safe to act on) and an
// error of ours (a dispute, where the quote is accountability). Everywhere else the reply just
// answers, the way a person would.
//
// THESE DELIBERATELY FAIL lib/convo-lint.mjs. That lint requires exactly one question mark and a
// costless-exit phrase in every message, which is correct for the interrogation flow, where a message
// exists to earn an answer. Applied to an acknowledgement it forces a question into a reply that
// needs none, which is the disease. lib/reply-lint.mjs is the rule set for this file.

// `para` is email-kit's LOCKED paragraph, imported rather than re-implemented. It is exported there
// precisely so callers stop hand-rolling <p style="font-family:...">: a hand-rolled copy ships a
// different typeface, and two copies of one locked shape drift.
//
// NO HEADLINE HELPER EXISTS IN THIS FILE, deliberately. A reply does not carry an <h1>,
// and a helper that is not here cannot be reached for by accident.
import { esc, emailShell, unsubUrlFor, deDash, para } from "./email-kit.mjs";
import { LIFECYCLE } from "./emails/tokens.mjs"; // LOCKED design tokens

const C = LIFECYCLE.colors;

// Their own words, shown as theirs. Only ever called with the classifier's verbatim `quote`.
const said = (t) => `<b style="color:${C.ink};font-weight:600;">${esc(t)}</b>`;

// DEFENSIVE, and required rather than clutter: fail-closed coverage in a send path is never trimmed
// for simplicity. The classifier is INSTRUCTED to return the short
// verbatim span that decided the label, and nothing enforces it. An unbounded quote would blow the
// reply's length budget and, worse, could paste an entire forwarded email back into somebody's inbox.
// Clipped on a word boundary so it never cuts a word in half.
export const QUOTE_MAX = 160;
const clip = (t) => {
  const s = String(t || "").trim().replace(/\s+/g, " ");
  if (s.length <= QUOTE_MAX) return s;
  const cut = s.lastIndexOf(" ", QUOTE_MAX);
  return s.slice(0, cut > 0 ? cut : QUOTE_MAX).trim();
};

/** First name only, and only if we actually have one. Never guessed, never initialised. */
const hi = (name) => {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first ? `Hi ${esc(first)}, ` : "";
};
const hiText = (name) => {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first ? `Hi ${deDash(first)}, ` : "";
};

// The reply shell: the locked emailShell, with no headline and no eyebrow passed into it.
const shell = ({ email, preheader, contentHtml }) =>
  emailShell({ preheader, title: "Charlie", contentHtml, unsubUrl: unsubUrlFor(email) });

/**
 * They gave permission to act on their behalf. The most valuable message this product receives.
 *
 * IT NAMES THE SCOPE AND PROMISES NOTHING ELSE. At this branch Charlie records the grant and a person
 * acts on it; no submission happens automatically. Writing "I'm putting you in front of them" would
 * be inventing an action, so the copy says only what is true: this is what I'll act on, nothing moves
 * without asking, and you'll hear back either way.
 */
export function renderConsentGrant({ email, name = "", quote = "" } = {}) {
  const q = clip(quote);
  const body = q
    ? `${hi(name)}understood, and thank you. Taking that as ${said(q)}, and that is what I will act on, nothing beyond it.`
    : `${hi(name)}understood, and thank you. That is what I will act on, and nothing beyond it.`;
  const bodyText = q
    ? `${hiText(name)}understood, and thank you. Taking that as "${deDash(q)}", and that is what I will act on, nothing beyond it.`
    : `${hiText(name)}understood, and thank you. That is what I will act on, and nothing beyond it.`;
  return {
    subject: "Understood",
    html: shell({ email, preheader: "Understood, and nothing moves without asking you first.",
      contentHtml: para(body) + para(`Nothing goes anywhere without me asking you first. I will come back to you when there is something real, including if that turns out to be nothing.`) }),
    text: `${bodyText}\n\nNothing goes anywhere without me asking you first. I will come back to you when there is something real, including if that turns out to be nothing.\n\nCharlie`,
  };
}

/**
 * They are telling us we got a fact about them wrong.
 *
 * THE PROFILE IS NOT TOUCHED AND THE COPY SAYS SO. A person correcting us about themselves is the
 * highest-signal message we get and the one we are most likely to be wrong about, so this states
 * plainly that nothing was changed and a human is checking. It does not explain how the error
 * happened: nobody has checked yet, and a guess about our own mistake is a second mistake.
 */
export function renderDispute({ email, name = "", quote = "" } = {}) {
  const q = clip(quote);
  const open = q
    ? `${hi(name)}you have told me ${said(q)}. That is mine to find, so I have not changed anything, and I have put this in front of a person to check properly.`
    : `${hi(name)}you are telling me I have a fact about you wrong. That is mine to find, so I have not changed anything, and I have put this in front of a person to check properly.`;
  const openText = q
    ? `${hiText(name)}you have told me "${deDash(q)}". That is mine to find, so I have not changed anything, and I have put this in front of a person to check properly.`
    : `${hiText(name)}you are telling me I have a fact about you wrong. That is mine to find, so I have not changed anything, and I have put this in front of a person to check properly.`;
  return {
    subject: "Checking this properly",
    html: shell({ email, preheader: "Nothing changed at my end. A person is checking.",
      contentHtml: para(open) + para(`You will hear back. Thank you for telling me.`) }),
    text: `${openText}\n\nYou will hear back. Thank you for telling me.\n\nCharlie`,
  };
}

/**
 * They told us what happened with something already in flight.
 *
 * The honest reason for wanting it is in the second line, and it is the same true sentence
 * renderAnyCalls uses: Charlie cannot see any of this. Nothing is asked of them.
 */
export function renderStatusUpdate({ email, name = "" } = {}) {
  return {
    subject: "Got it",
    html: shell({ email, preheader: "Noted, and nothing is needed from you.",
      contentHtml: para(`${hi(name)}got it, and thank you for telling me. I have no other way to find that out, so it genuinely helps.`) + para(`Nothing is needed from you now. If anything else comes back to you, at any point, I would like to know.`) }),
    text: `${hiText(name)}got it, and thank you for telling me. I have no other way to find that out, so it genuinely helps.\n\nNothing is needed from you now. If anything else comes back to you, at any point, I would like to know.\n\nCharlie`,
  };
}

/**
 * They answered something we asked.
 *
 * NO NEW QUESTION. A reply that answers you and immediately asks something else is how a person
 * learns they are being processed rather than heard. One turn, one purpose.
 */
export function renderAnswerNoted({ email, name = "" } = {}) {
  return {
    subject: "Noted",
    html: shell({ email, preheader: "Noted, and nothing else is needed from you.",
      contentHtml: para(`${hi(name)}noted, and thank you. I have got that.`) + para(`Nothing else is needed from you.`) }),
    text: `${hiText(name)}noted, and thank you. I have got that.\n\nNothing else is needed from you.\n\nCharlie`,
  };
}

/**
 * Not about their job search at all, from somebody we already know.
 *
 * renderNotJobSearch exists and is good, but it is written for a STRANGER: it explains what Charlie
 * is, which is the wrong thing to say to a person who already has a profile. This one assumes the
 * relationship, takes no offence, asks for nothing, and leaves the door open for a misread.
 */
export function renderOffTopic({ email, name = "" } = {}) {
  return {
    subject: "Left this one alone",
    html: shell({ email, preheader: "I do not think this one is for me.",
      contentHtml: para(`${hi(name)}I do not think this one is for me, so I have left it alone.`) + para(`If I have read that wrong, just say and I will take another look.`) }),
    text: `${hiText(name)}I do not think this one is for me, so I have left it alone.\n\nIf I have read that wrong, just say and I will take another look.\n\nCharlie`,
  };
}

/**
 * We are not sure what this is. The honest unknown, and the safe default for anything unclassified.
 *
 * IT NEVER SAYS "I DID NOT UNDERSTAND THAT". That phrasing puts the failure on the sender and teaches
 * them to write for the machine next time. The failure is Charlie's to hold, so the sentence is about
 * what Charlie chose to do, not about what they wrote.
 */
export function renderUnsure({ email, name = "" } = {}) {
  return {
    subject: "Passing this to a person",
    html: shell({ email, preheader: "A person is reading this one.",
      contentHtml: para(`${hi(name)}I have read this, but I would rather not guess at what you need, so I have passed it to a person instead of answering it badly.`) + para(`Nothing has changed on your side.`) }),
    text: `${hiText(name)}I have read this, but I would rather not guess at what you need, so I have passed it to a person instead of answering it badly.\n\nNothing has changed on your side.\n\nCharlie`,
  };
}
