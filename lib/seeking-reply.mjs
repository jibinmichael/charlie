// seeking-reply.mjs — what a person told us when we sent them a role.
//
// FOUR THINGS CAN COME BACK and they are not mutually exclusive. Somebody can say "yes keep them
// coming, and by the way I have an offer, but this particular role is wrong because it's onsite".
// That is one message carrying three facts, and a classifier that returns a single label throws two
// of them away.
//
// SO IT RETURNS A SET, NOT A LABEL. Each signal is independent and each is optional. Nothing here
// decides anything: it reads what they said so a human, or a deterministic writer, can act on it.
//
// PURE, AND DELIBERATELY NOT A MODEL. These writes touch consent-adjacent state — whether we may
// keep sending somebody roles. That must be reproducible and arguable in one reading, and it must
// never be able to invent an "open" that a person did not say.
//
// UNSURE IS THE DEFAULT AND IT IS SAFE. Anything unmatched sets nothing and goes to a human. The
// asymmetry that decides every close call: wrongly recording "open" means we keep mailing somebody
// who asked us to stop, and that is the one error this cannot make.

import { ownWords } from "./own-words.mjs";

/** They are looking, and we may keep sending. */
const OPEN = /\b(open|yes,? ?(please|keep|do)|keep (them |me )?(coming|posted)|still looking|actively looking|i'?m looking|mark me open|sounds good|go ahead)\b/i;

/** They are not, for now. Never inferred from silence. */
const STOP = /\b(not looking|stop sending|no longer looking|take me off|unsubscribe|remove me|not interested (in|right now|at the moment)|i'?m out|no thanks,? ?(not|i'?m))\b/i;

/**
 * They hold an offer. The most valuable sentence a candidate can send, because "she has a live
 * offer" moves a hiring manager from weeks to days.
 */
const OFFER = /\b(i (have|have got|'?ve got|got|received|am holding) (an?|another|a competing|a live) offer|offer in hand|i'?ve accepted|already accepted|signed (an )?offer|joined somewhere|i have an offer)\b/i;

/** They are telling us the role was wrong. The line after "because" is the useful part. */
const WRONG = /\b(not (the )?right|wrong (role|fit|one)|doesn'?t (fit|suit|work)|too (junior|senior|far)|not for me|i'?m not (a )?fit)\b/i;

/**
 * @param {string} body raw inbound
 * @param {string} senderEmail so their own earlier mail is not read as our quoted copy
 * @returns {{signals: string[], open: boolean, stop: boolean, offer: boolean, wrongRole: boolean,
 *            excerpt: string, needsHuman: boolean}}
 */
export function readSeekingReply(body, senderEmail = "") {
  const mine = String(ownWords(body, String(senderEmail || "").toLowerCase()) || "");
  // Their first lines that say something. A greeting is not an answer: "Hi,\n\nYes, please go ahead"
  // must be read as the yes, not as "Hi,".
  const GREETING = /^(hi|hey|hello|dear|thanks|thank you|good (morning|afternoon|evening))\b[\s,.!-]*(charlie)?[\s,.!-]*$/i;
  const said = mine.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith(">") && !GREETING.test(l)).join(" ");

  const stop = STOP.test(said);
  // A stop wins over an open. "Yes I got your mail but stop sending" is a stop, and reading it the
  // other way keeps mailing somebody who asked us not to.
  const open = !stop && OPEN.test(said);
  const offer = OFFER.test(said);
  const wrongRole = WRONG.test(said);

  const signals = [open && "open", stop && "stop", offer && "offer", wrongRole && "wrong_role"].filter(Boolean);
  return {
    signals, open, stop, offer, wrongRole,
    excerpt: said.slice(0, 200),
    // Nothing recognised, or they said something alongside it we cannot read: a person looks.
    needsHuman: signals.length === 0,
  };
}

/** 30 days from a given day, as a date string. Pure, so the caller supplies today. */
export function seekingUntil(todayISO, days = 30) {
  const d = new Date(`${String(todayISO).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
