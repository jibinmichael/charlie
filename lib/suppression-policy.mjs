// lib/suppression-policy.mjs — may an INBOUND reply go to a suppressed address?
//
// Charlie suppresses an address for several different reasons, and `isSuppressed` deliberately does
// not distinguish them: for an OUTBOUND send ("here is a role you might like") the reason is
// irrelevant — suppressed is suppressed. The inbound reply path is the one place where it matters.
//
// Replying to someone who just emailed YOU is not unsolicited mail; their message is the consent.
// An unsubscribe means "stop sending me things", not "never speak to me again". Email is Charlie's
// only surface, so treating an unsubscribe as a total block makes it a ONE-WAY DOOR: a person
// writing in to ask for a second chance meets silence, and silence is indistinguishable from a bug.
//
// A hard bounce is different (the mailbox is dead, sending damages deliverability) and so is a spam
// complaint (they actively objected). Those still block.
//
// WHITELIST, not blacklist — fail closed. Only reasons that literally begin with
// "unsubscribe" open the door. An unrecognised, misspelled, or future reason keeps blocking, so
// adding a new suppression kind can never silently start mailing people by default.
const REPLYABLE = /^unsubscribe/i;

/**
 * @param {string|null|undefined} reason a `suppressions.reason` value, or null when not suppressed.
 * @returns {boolean} true when an inbound reply may still go out despite the suppression.
 */
export function mayReplyDespiteSuppression(reason) {
  return typeof reason === "string" && REPLYABLE.test(reason.trim());
}
