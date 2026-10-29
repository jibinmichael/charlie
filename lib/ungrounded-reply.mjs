// lib/ungrounded-reply.mjs — who gets asked again, and who gets told this is not the place.
//
// THE FAILURE THIS PREVENTS. A real person writes to start@ saying they want in, the dossier build
// grounds nothing from the message, and /inbound replies "Not the right address, I think." They are
// turned away on first contact, and nothing records that it happened.
//
// The tempting inference is: "no attachment at all -> the body was prose that grounds nothing: a sales
// pitch, a pitch deck link, a newsletter". That is true of spam. It is equally true of somebody who
// wrote what they WANT instead of where they WORKED -- and those two people need opposite replies. An
// attachment is the only thing separating them, and plenty of real people send none.
//
// THE RULE: a FIRST-TIME writer is never told this is the wrong address. The worst case of asking a
// spammer one question is that they ignore it. The worst case of declining a real person is losing
// them on first contact.
//
// The decline survives for someone who has written before and STILL grounds nothing, because at that
// point they have been asked and the ask did not work.
//
// Pure and deterministic on purpose: this is a branch that decides whether a human hears "tell me
// more" or "go away", and it should be readable in one screen and testable without a mail server.

/** @typedef {"missing_resume"|"tell_me_more"|"not_job_search"} UngroundedReply */

/**
 * @param {object} o
 * @param {boolean} o.triedToSendADoc  an attachment was present but nothing could be extracted
 * @param {boolean} o.isFirstContact   we had never heard from this address before this message
 * @returns {UngroundedReply}
 */
export function replyForUngrounded({ triedToSendADoc, isFirstContact } = {}) {
  // They tried to give us a document and it would not extract. That is our problem, not theirs, and
  // it is true whether or not we have met them. Ask for a readable one.
  if (triedToSendADoc) return "missing_resume";
  // First time we have heard from them: ASK. Never decline.
  if (isFirstContact) return "tell_me_more";
  // They have written before, been asked, and still nothing here can be grounded.
  return "not_job_search";
}

/** True when this reply declines the person rather than asking them for something. */
export function isDecline(reply) {
  return reply === "not_job_search";
}
