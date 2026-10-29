// evidence-record.mjs — put a person's own words about their work onto their own record.
//
// ONE FUNCTION, TWO CALLERS. /inbound calls it the moment a reply lands; the reconciliation
// (scripts/evidence-reconcile.mjs) uses the same rules to find replies that never reached a record.
// Two implementations would drift invisibly.
//
// WHERE THE WORDS GO. `candidates.dossier.answers`, the question→answer map `lib/form-answers.mjs`
// already reads to decide who has told us about their work. No new column: it is an answer, filed as
// an answer.
//
// IT NEVER OVERWRITES AND NEVER SUMMARISES. The key names the date and the question asked. An
// existing key is left alone, so a duplicate webhook delivery cannot double-file and a re-run adds
// nothing. The text is stored exactly as the person wrote it.
//
// A PERSON WHO ANSWERS TWICE KEEPS BOTH. The key carries the reply's position for that day, so a
// second, different reply is never counted as already-present and dropped.
//
// THE STATUS TRAP. saveDossier(email, dossier) defaults status to "screening". Passing the person's
// existing status back is not optional: dropping it flips an active person out of
// listActiveCandidates and silently ends their daily email.

import { getCandidate, saveDossier } from "../charlie-store.mjs";
import { ownWords } from "./own-words.mjs";

/**
 * The asks whose replies are a person describing their own work.
 *
 * EVERY ASK TEMPLATE'S SUBJECT MUST BE IN HERE. A missing subject means answers arrive and are never
 * filed, and scripts/evidence-reconcile.mjs cannot see the gap because it reads this same pattern. A
 * check cannot catch what it shares a blind spot with.
 *
 * lib/evidence-record.test.mjs renders each ask template and asserts its subject matches, so adding
 * an ask without adding it here fails CI rather than losing people's answers.
 */
export const EVIDENCE_SUBJECTS = /send me the evidence|things i am missing about you|one thing would help|breaking the silence/i;

/** Is this inbound mail a reply to one of those asks? */
export const isEvidenceReply = (subject) => EVIDENCE_SUBJECTS.test(String(subject || ""));

/**
 * Replies to the client-status mails, which need their OWN branch rather than the evidence one.
 *
 * These people applied to one role through a form. They are not enrolled in the matching product, so
 * the ordinary fall-through reply — renderAck, offering to change their pay floor and promising to
 * email them roles — describes a relationship they do not have, to their face. Routing their replies
 * to a human mailbox instead would mean nothing files them, so /inbound gives them their own branch.
 *
 * Two subjects, from renderClientStatus's two shapes. emails/templates.test.mjs renders both and
 * asserts they match, so an edit to the subject line cannot quietly stop the filing.
 */
export const CLIENT_STATUS_SUBJECTS = /application is with the hiring team|are looking at your application/i;

/** Is this inbound mail a reply to a client-status mail? */
export const isClientStatusReply = (subject) => CLIENT_STATUS_SUBJECTS.test(String(subject || ""));

/**
 * Replies to "Has <company> been in touch?" — an answer about where a real application has got to.
 *
 * THIS NEEDS ITS OWN BRANCH FOR THE SAME REASON THE CLIENT-STATUS ONE DOES, and for a sharper one:
 * `renderAskAnswerAck`, which is what an open ask otherwise gets, says "I am taking the shape of your
 * background to the hiring side, WITHOUT YOUR NAME ON IT". For this cohort that sentence is false.
 * Their name is on a board a named client reads. Answering a status question with it would be a
 * second wrong reply sent to fix a first one.
 */
export const CHECKIN_SUBJECTS = /been in touch\?/i;

/** Is this inbound mail an answer to the "has anyone been in touch" question? */
export const isCheckinReply = (subject) => CHECKIN_SUBJECTS.test(String(subject || ""));

/** The dossier key for a reply. `n` is its position among that person's replies to the same ask that day. */
export const answerKey = ({ at, subject }, n = 0) =>
  `Sent to Charlie ${at} — asked: ${String(subject || "").replace(/^(re|fwd):\s*/i, "").trim()}${n ? ` (${n + 1})` : ""}`;

/** Below this a reply is an acknowledgement, not an account of anything. */
export const MIN_CHARS = 80;

/**
 * File one reply onto the person's record.
 *
 * @returns {Promise<{ok:boolean, reason?:string, key?:string, chars?:number}>}
 *   Never throws for an ordinary miss — the caller is an inbound webhook and must still answer the
 *   person even when filing cannot happen.
 */
export async function recordOwnWords({ email, subject, body, receivedAt }) {
  const addr = String(email || "").toLowerCase().trim();
  if (!addr) return { ok: false, reason: "no sender address" };

  const own = ownWords(String(body || ""), addr);
  if (own.length < MIN_CHARS) return { ok: false, reason: `under ${MIN_CHARS} chars of their own words` };

  const c = await getCandidate(addr);
  if (!c) return { ok: false, reason: "no candidate row" };

  const dossier = c.dossier && typeof c.dossier === "object" ? { ...c.dossier } : {};
  const answers = { ...(dossier.answers || {}) };
  const at = String(receivedAt || new Date().toISOString()).slice(0, 10);

  // Already filed? Then this is a duplicate delivery of the same words, not a second answer.
  if (Object.values(answers).some((v) => String(v).trim() === own)) {
    return { ok: true, reason: "already on the record", key: null, chars: own.length };
  }
  // A genuinely different reply on the same day gets the next position rather than colliding.
  let n = 0;
  while (answers[answerKey({ at, subject }, n)]) n++;
  const key = answerKey({ at, subject }, n);

  answers[key] = own;
  dossier.answers = answers;
  await saveDossier(addr, dossier, c.status); // c.status, always
  return { ok: true, key, chars: own.length };
}
