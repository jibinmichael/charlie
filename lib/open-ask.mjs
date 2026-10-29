// lib/open-ask.mjs — did we ask this person a specific question and are we still waiting on it?
//
//
// A REPLY TO A QUESTION IS NOT A PREFERENCE UPDATE. Asks sent by hand-run scripts (a named role with direct
// questions, a check-in) leave a sent_emails row under their template name. Without a check here, /inbound would
// treat the answer as a preference update and reply with a question the person has already answered.
//
// FAIL CLOSED, AND DELIBERATELY BLUNT. Inside the window, ANY inbound from someone with an open ask
// is treated as an answer: no preference writing, no generated advice, a short honest acknowledgement
// and a human reads it. That occasionally routes an unrelated message to a person who did not strictly
// need to see it; the other error, answering somebody's careful reply with a question they have already
// answered, costs their trust.

/**
 * Templates that ask a question and expect a written answer back.
 *
 * `lib/ask-registry.test.mjs` reads every send script, finds the template name each one sends under, and
 * fails CI when a script whose copy contains a question is missing from here, because a stale list does not
 * fail on its own: it quietly stops recognising answers.
 *
 * A NUDGE OR A REMINDER COUNTS: a reply to a reminder is an answer just as much as a reply to the original.
 */
export const ASK_TEMPLATES = [
  "studio-ask",
  "studio-remind",
  "years-ask",
  "pool-gaps-ask",
  "evidence-ask",
  "ux-permission",
  "ux-yes-noted",
  "any-calls",
  // The same question as any-calls, asked of people on a client board, with a second one after it
  // ("where has it got to?").
  "client-checkin",
  "reply-correction",
  // A role offered to somebody already in the pool, answerable with one word ("reply yes or no").
  "role-invite",
  // The consented-pool mailer: one role, and two questions in the footer (are you still looking, do
  // you have an offer). A reply is an ANSWER to those, never a preference update.
  "role-match",
  // One role put to one person with the reason it was them, and three questions (looking,
  // interested, may I take the next step). A reply is an ANSWER to those. It has its own branch in
  // /inbound because the generic acknowledgement tells a person who declined that their background
  // is going to the hiring side.
  "role-intent",
  // The questions that follow a yes to role-intent, one per must-have the record is silent on. The
  // answers are the evidence a submission stands on, so /inbound files them on the person's own
  // record before it acknowledges anything.
  "role-questions",
  // "Where this stands": holding what they gave us while the company's side is quiet. It asks
  // nothing, but a reply to it must not be answered with the questions mail's acknowledgement, so
  // it is registered and has its own branch.
  "role-hold",
];

/** How long after the ask an inbound message is read as its answer. */
export const ASK_WINDOW_DAYS = 14;

/**
 * @param {string} email
 * @param {{ recentAsks: (email: string, templates: string[], sinceISO: string) => Promise<Array<{template:string,sent_at:string}>> }} deps
 * @returns {Promise<{open: boolean, template: string|null, asked_at: string|null, reason: string}>}
 */
export async function openAskFor(email, deps) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) return { open: false, template: null, asked_at: null, reason: "no address" };
  if (typeof deps?.recentAsks !== "function") {
    // A missing dependency must not silently mean "no open ask": fail closed and let a human read it.
    return { open: true, template: null, asked_at: null, reason: "cannot check, so assume an ask is open and let a human read it" };
  }
  const since = new Date(Date.now() - ASK_WINDOW_DAYS * 864e5).toISOString();
  let rows = [];
  try {
    rows = (await deps.recentAsks(addr, ASK_TEMPLATES, since)) || [];
  } catch {
    return { open: true, template: null, asked_at: null, reason: "ask lookup failed, so assume an ask is open" };
  }
  if (!rows.length) return { open: false, template: null, asked_at: null, reason: "no ask sent in the window" };
  const latest = rows.slice().sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0];
  return { open: true, template: latest.template, asked_at: latest.sent_at, reason: `answered ${latest.template}` };
}
