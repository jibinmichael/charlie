// lib/role-invite-reply.mjs — did they say yes, did they say no, or does a human need to read it?
//
// THE QUESTION WAS "reply yes or no", SO THE ANSWER IS USUALLY ONE WORD. That makes this classifiable
// without a model, and a deterministic classifier is the right kind here: it cannot invent an
// interest the person never expressed, and putting somebody in front of a client on a hallucinated
// yes is not a bug you can apologise your way out of.
//
// THE TRAP THIS EXISTS FOR. The invitation itself contains the words "Reply yes or no" and "would you
// like me to put you forward?". Almost every mail client quotes the message being replied to. So a
// plain search for /yes/ over the raw body matches OUR OWN COPY and reports a yes for somebody who
// wrote "no thanks". The first thing that happens here is therefore ownWords(), which cuts the thread
// at a quote attributed to us.
//
// THREE OUTCOMES, NOT TWO. "unclear" is a real answer and it is the default. A person who writes
// "yes but only if it is hybrid" has not said yes to this job, and a classifier that forces every
// reply into yes-or-no would file them as one. Unclear goes to a human, which costs a minute, and
// the alternative costs a candidate's trust.
//
// IT DECIDES NOTHING. It reports what a reply appears to say. Nobody is put in front of a client by
// this function; a person is, after reading it.

import { ownWords } from "./own-words.mjs";

/** Their answer starts the way an agreement starts. Anchored: a bare "yes" anywhere is not enough. */
const YES = /^(yes|yep|yeah|yup|sure|ok|okay|absolutely|definitely|please do|go ahead|count me in|i'?m in|interested|very interested|i am interested|i'?d like|i would like|put me forward|please put me forward|sounds good|happy to)\b/i;

/** And a refusal starts the way a refusal starts. */
const NO = /^(no|nope|nah|not interested|i'?m not interested|not right now|not at the moment|i'?ll pass|i will pass|pass|thanks but|thank you but|no thanks|no thank you|please remove|unsubscribe)\b/i;

/**
 * @param {string} body the raw inbound body
 * @param {string} senderEmail so their own earlier mail is not mistaken for our quoted copy
 * @returns {{answer: "yes"|"no"|"unclear", excerpt: string}}
 */
export function classifyInviteReply(body, senderEmail = "") {
  const mine = ownWords(body, String(senderEmail || "").toLowerCase());
  // Their first line THAT SAYS SOMETHING. People who mean yes say so first and explain after, but
  // they say hello first of all, and a greeting is not an answer: in "Hi,\n\nYes, please go ahead" the
  // answer is the second line.
  const GREETING = /^(hi|hey|hello|dear|good (morning|afternoon|evening)|thanks|thank you|hi there)\b[\s,.!-]*(charlie)?[\s,.!-]*$/i;
  const first = String(mine || "")
    .split("\n").map((l) => l.trim())
    .find((l) => l && !l.startsWith(">") && !GREETING.test(l)) || "";
  const excerpt = first.slice(0, 160);

  // A pleasantry can also sit INLINE, on the same line as the answer: "Thanks, yes please."
  // Tried second and only if the line as written says nothing, so this can only ever rescue an
  // answer that was already going to a human. It cannot change one that already reads cleanly, which
  // is what keeps "thanks but no thanks" a no rather than a stripped fragment nobody can parse.
  const LEADIN = /^(hi|hey|hello|dear|thanks|thank you)\b[\s,.!-]+(charlie\b[\s,.!-]+)?/i;
  const plain = LEADIN.test(first) && !YES.test(first) && !NO.test(first) ? first.replace(LEADIN, "") : first;

  const yes = YES.test(plain);
  const no = NO.test(plain);
  // Both, or neither, is a person to read rather than a person to file. "Yes, but not in Bengaluru"
  // opens with a yes and is not one, which is why a qualifier demotes it rather than confirming it.
  if (yes && no) return { answer: "unclear", excerpt };
  if (yes) return { answer: /\b(but|however|only if|provided|as long as|depends|if it)\b/i.test(plain) ? "unclear" : "yes", excerpt };
  if (no) return { answer: "no", excerpt };
  return { answer: "unclear", excerpt };
}
