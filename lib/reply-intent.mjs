// lib/reply-intent.mjs — which reply answers which kind of message, and when to say nothing.
//
// PURE. No I/O, no model call, no clock. It maps a validated classifier result
// (lib/inbound-intent.mjs) onto one rendered reply, so the choice can be enumerated in a test
// instead of read out of a 1,800-line route handler.
//
// WHY. Without it every non-preference intent would get `renderAck`, one fixed template offering a
// preferences menu: seven different situations, one body, byte-identical.
//
// TWO PROPERTIES THAT MUST HOLD, both pinned by lib/reply-intent.test.mjs:
//
//   1. NO TWO INTENTS RENDER THE SAME BODY. That is the whole defect, expressed as a test. A future
//      edit that collapses two replies back into one fails CI rather than a person's trust.
//
//   2. AN UNKNOWN LABEL FAILS TO A HUMAN, NEVER TO SILENCE. Anything unmapped — a label a future
//      prompt invents, a value that slipped past the schema's `.catch("other")` — routes to
//      renderUnsure, which tells the person a human is reading it. The one thing this must never do
//      is drop a message quietly, because silence and "handled" are indistinguishable in an inbox.
//
// WHY `courtesy` SENDS NOTHING BUT STILL WAKES A HUMAN. A thank-you at the end of an exchange does
// not need an email; answering it with a template is what makes Charlie feel like a machine. But a MISCLASSIFIED
// courtesy would be a message nobody ever sees, and the most expensive message this product receives
// is a consent grant. So silence is only ever silence towards the USER: the owner is notified on
// every intent in this file, including this one. Nothing here can make a message vanish.

import {
  renderConsentGrant, renderDispute, renderStatusUpdate,
  renderAnswerNoted, renderOffTopic, renderUnsure,
} from "../render-reply.mjs";

/**
 * Intents whose reply quotes the person verbatim.
 *
 * Consent, because naming the scope out loud is what makes it safe to act on. A dispute, because the
 * quote is accountability for our error. Nowhere else: routine quoting is the machine showing its
 * work, and it becomes its own tell.
 */
export const QUOTING_INTENTS = ["consent_grant", "dispute"];

/**
 * The two the owner must see the same day: one is permission the business waits on, the other is us
 * being wrong about somebody to their face.
 */
export const URGENT_INTENTS = ["consent_grant", "dispute"];

const RENDERERS = {
  consent_grant: renderConsentGrant,
  dispute: renderDispute,
  status_update: renderStatusUpdate,
  answer: renderAnswerNoted,
  off_topic: renderOffTopic,
  // A question should already have been caught by lib/inbound-question.mjs upstream. If one reaches
  // here the guard missed it, so it goes to a person rather than getting an invented answer.
  question: renderUnsure,
  // A preference_change that reaches this map is one `mayWritePreferences` refused: low confidence,
  // or an unparseable classifier reply. We are not sure enough to act, so a person looks at it.
  preference_change: renderUnsure,
  other: renderUnsure,
};

/** Intents that are answered with silence towards the user. The owner is still told. */
export const SILENT_INTENTS = ["courtesy"];

/**
 * Choose the reply for one classified message.
 *
 * @param {{intent?: string, confidence?: string, quote?: string}} intent  validated classifier result
 * @param {{email: string, name?: string}} person
 * @returns {{ message: {subject:string, html:string, text:string}|null, urgent: boolean, silent: boolean, renderer: string }}
 *   `message` is null ONLY for a silent intent. The caller still notifies a human in that case.
 */
export function replyFor(intent = {}, { email, name = "" } = {}) {
  const label = String(intent?.intent || "other");
  const urgent = URGENT_INTENTS.includes(label);

  if (SILENT_INTENTS.includes(label)) {
    return { message: null, urgent, silent: true, renderer: "none" };
  }

  // Unmapped label -> renderUnsure. Never silence, never a guess.
  const render = RENDERERS[label] || renderUnsure;
  const rendererName = RENDERERS[label] ? label : "other";

  // `quote` is the classifier's VERBATIM span. It is passed ONLY to the two templates whose copy is
  // built to show it, so a future template cannot start quoting people by accident.
  const args = QUOTING_INTENTS.includes(label)
    ? { email, name, quote: String(intent?.quote || "").trim() }
    : { email, name };

  return { message: render(args), urgent, silent: false, renderer: rendererName };
}
