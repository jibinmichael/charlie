// lib/send-guard.mjs — the ONE door to resend.emails.send for every user-facing email.
//
//   import { sendGuarded } from "./lib/send-guard.mjs";
//   const r = await sendGuarded({ resend, email, template: "role", dedupeKey: findId, payload,
//                                 idempotencyKey: `find-alert/${findId}`, log });
//   // r.status: "sent" | "suppressed" | "duplicate" | "failed"
//
// Every user-facing sender (role: scheduler/first-role/send-finding; lifecycle: digest, newsletter,
// announce-*, invite/confirm/whatsnew/completeness, founder-note) routes its send through here, so
// the three protections live in exactly ONE place and CANNOT be forgotten (a grep for `resend.emails.send` outside owner-only canaries proves zero bypasses):
//
//   1. SUPPRESSION (do-not-send)  — never email a bounced/complained address (`isSuppressed`).
//   2. IDEMPOTENCY (sent_emails)  — atomic claim on (email, template, dedupeKey); a retry / restart /
//      overlapping run loses the claim and skips, so a send can never be doubled. On a failed send
//      the claim is released so a later run can retry; on success the Resend id is stamped.
//   3. The physical send          — resend.emails.send(payload, { idempotencyKey }) (Resend's own
//      key is a second belt on top of the sent_emails suspenders).
//
// NOT here: selection/quality gating (repeat / geo / language / liveness / fit). That is
// `preSendGuard` (presend-guard.mjs), which runs earlier — before compose — on the job+dossier.
// send-guard is the final physical door; callers must still pass a role through preSendGuard first.
//
// Fail-closed on send, fail-open on infra: a suppression/idempotency INFRA error never silently
// blocks a legit email (the underlying store fns fail-open), but a genuine suppression or duplicate
// always stops the send. deps are injectable for testing; default to the real charlie-store seam.

import { isSuppressed as _isSuppressed, claimSend as _claimSend, stampSend as _stampSend, releaseSend as _releaseSend } from "../charlie-store.mjs";
import { leakLint } from "./leak-lint.mjs";

/**
 * @param {object} o
 * @param {{emails:{send:Function}}} o.resend  a configured Resend client.
 * @param {string} o.email     the user/candidate email — the sent_emails idempotency key owner.
 * @param {string} o.template  logical template name (e.g. "role", "digest", "checkin").
 * @param {string} o.dedupeKey unique within (email, template) — findId, week key, "v1", etc.
 * @param {object} o.payload   the exact object handed to resend.emails.send (from/to/subject/html/…).
 * @param {string} [o.to]      recipient address for the suppression check (default payload.to).
 * @param {string} [o.idempotencyKey] Resend's own idempotency key (belt on top of sent_emails).
 * @param {(...a:any[])=>void} [o.log]
 * @param {boolean} [o.force]  operator re-send: release any prior idempotency claim first so a
 *   `--force` run actually re-sends (suppression is STILL enforced — force never emails a bounced
 *   address). Default false.
 * @param {object} [o.deps]    { isSuppressed, claimSend, stampSend, releaseSend } — injectable for tests.
 * @returns {Promise<{status:"sent"|"suppressed"|"duplicate"|"failed", id?:string, error?:any}>}
 */
export async function sendGuarded({ resend, email, template, dedupeKey, payload, to, idempotencyKey, force = false, log = console.error, deps } = {}) {
  const { isSuppressed = _isSuppressed, claimSend = _claimSend, stampSend = _stampSend, releaseSend = _releaseSend } = deps || {};
  const recipient = to || payload?.to || email;
  const label = `${template}:${email}`;

  // 1) suppression — a bounced/complained address gets nothing, ever (even on force).
  if (recipient && (await isSuppressed(recipient))) {
    log(`[send-guard] ${label}: recipient ${recipient} suppressed (bounce/complaint) — skip`);
    return { status: "suppressed" };
  }

  // 1b) LEAK CHECK — no internal identifier reaches an inbox, from any template, ever.
  //
  // A template that prints a dossier column ("your pay currency, home_place, ...") is a leak that
  // lib/convo-lint.mjs cannot see, because it only runs on model-generated replies. Every render
  // function passes through here, so this is where the check belongs.
  //
  // BEFORE THE IDEMPOTENCY CLAIM, deliberately. Claiming first would burn the dedupe key on a message
  // that never went, and the corrected version would then be silently skipped as a duplicate.
  //
  // FAIL CLOSED. A hit is not sent. The deny list is our own schema vocabulary rather than a
  // snake_case ban, precisely so a trip means a bug and not somebody's quoted job description, which
  // is what makes refusing to send the right response instead of a new source of silence.
  const leak = leakLint({ text: payload?.text || "", subject: payload?.subject || "", html: payload?.html || "" });
  if (!leak.ok) {
    log(`[send-guard] ${label}: BLOCKED, internal identifier in the copy: ${leak.hits.map((h) => `${h.token} (${h.kind})`).join(", ")}`);
    for (const h of leak.hits) log(`[send-guard]   ...${h.context}...`);
    return { status: "leak_blocked", hits: leak.hits };
  }

  // 2) idempotency — atomically claim before sending; loser of the race skips. `force` clears a
  //    prior claim first so a deliberate operator re-send is not swallowed as a duplicate.
  if (force) await releaseSend(email, template, dedupeKey);
  if (!(await claimSend(email, template, dedupeKey))) {
    log(`[send-guard] ${label}: already sent (idempotency ${dedupeKey}) — skip`);
    return { status: "duplicate" };
  }

  // 3) physical send — release the claim on ANY failure so the next run can retry.
  // On a deliberate operator re-send (force), skip Resend's OWN 24h idempotency key: we already
  // released the internal claim, so the caller means "send this again", but Resend keeps the key for
  // 24h and 409s a re-send whose body changed ("idempotency key ... body was modified"). Non-force
  // sends keep the key as the second belt on top of the sent_emails suspenders.
  const idem = force ? undefined : idempotencyKey;
  try {
    const { data, error } = await resend.emails.send(payload, idem ? { idempotencyKey: idem } : undefined);
    if (error) {
      await releaseSend(email, template, dedupeKey);
      log(`[send-guard] ${label}: send FAILED ${typeof error === "string" ? error : JSON.stringify(error)}`);
      return { status: "failed", error };
    }
    // File a copy of what was said, not just that something was. See stampSend.
    await stampSend(email, template, dedupeKey, data?.id, { subject: payload?.subject, text: payload?.text });
    return { status: "sent", id: data?.id };
  } catch (err) {
    await releaseSend(email, template, dedupeKey);
    log(`[send-guard] ${label}: send threw ${err?.message || err}`);
    return { status: "failed", error: err };
  }
}
