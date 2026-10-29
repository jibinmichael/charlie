// campaign-stall.mjs — the one nudge for an applicant who answered, was asked a question, and stopped.
//
//   node --env-file=.env.local campaign-stall.mjs         # DRY RUN, lists who would be nudged
//   node --env-file=.env.local campaign-stall.mjs --send  # sends
//
// WHY THIS EXISTS. An applicant who answers onboarding, is sent the challenge question and then goes
// quiet otherwise sits in `challenge` forever: nothing else follows up, and the owner is only asked
// for a verdict once someone reaches `verdict_review`.
//
// EXACTLY ONE NUDGE, EVER. The dedupe key is `stall:<email>` with no date in it, so sendGuarded's
// sent_emails claim makes a second nudge physically impossible no matter how often the sweep runs.
// That is deliberate: this is a hiring conversation with a person, and chasing somebody twice about
// a job they have decided against is worse than losing them.
//
// IT NEVER ADVANCES ANYBODY. It sends one email and writes nothing to `stage`, `turns` or `verdict`.
// The verdict stays 100% human, and a nudge that quietly moved
// someone forward would be the loop deciding a hire on a timeout.
//
// INERT UNLESS JOIN_CAMPAIGN=on, like every other part of this loop.

import { Resend } from "resend";
import { loadEnv, listJoinApplicantsByStage } from "./charlie-store.mjs";
import { renderCampaignStall } from "./render-campaign.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";

const log = (...a) => console.error("[campaign-stall]", ...a);

/** Hours of silence before a nudge. Read at CALL time so it is tunable without a redeploy. */
export function stallHours() {
  const n = Number(process.env.JOIN_STALL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 36;
}
export const campaignOn = () => String(process.env.JOIN_CAMPAIGN || "").toLowerCase() === "on";

/**
 * Who is genuinely stalled: mid-challenge, silent longer than the window.
 *
 * PURE, so the rule is testable without a mailbox. `now` is injected for the same reason.
 * A row with no `last_msg_at` is NOT nudged — we cannot tell how long they have been quiet, and
 * guessing means possibly chasing somebody who wrote an hour ago.
 */
export function stalledApplicants(rows, { now = Date.now(), hours = 36 } = {}) {
  const cutoff = now - hours * 3600 * 1000;
  return (rows || []).filter((r) => {
    if (!r || r.stage !== "challenge") return false;      // only mid-conversation
    if (r.verdict) return false;                           // already judged by a human
    const last = Date.parse(r.last_msg_at || "");
    if (!Number.isFinite(last)) return false;              // unknown silence is not evidence of silence
    return last < cutoff;
  });
}

/** Best-effort sweep. Never throws, never advances anyone, at most one nudge per person ever. */
export async function runCampaignStallSweep({ send = true } = {}) {
  try {
    if (!campaignOn()) return { skipped: "JOIN_CAMPAIGN is not on" };
    if (!process.env.RESEND_API_KEY) return { skipped: "no RESEND_API_KEY" };
    const rows = await listJoinApplicantsByStage("challenge");
    const due = stalledApplicants(rows, { hours: stallHours() });
    if (!due.length) return { nudged: 0, considered: rows.length };
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.CHARLIE_FROM;
    if (!from) return { skipped: "CHARLIE_FROM is not set" };
    let nudged = 0;
    for (const r of due) {
      try {
        const m = renderCampaignStall({ email: r.email });
        const res = await sendGuarded({
          resend, email: r.email, template: "join:stall",
          dedupeKey: `stall:${r.email}`, // no date: exactly one nudge, forever
          payload: { from, to: r.email, subject: m.subject, html: m.html, text: m.text, replyTo: process.env.JOIN_ADDRESS || "join@mail.example.com" },
          log,
        });
        if (res?.status === "sent") { nudged++; log(`nudged ${r.email} (silent since ${r.last_msg_at})`); }
        else log(`${r.email}: ${res?.status} (already nudged, or suppressed)`);
      } catch (e) {
        // Per-record isolation: one bad row never aborts the batch.
        log(`${r.email} failed, continuing: ${e.message}`);
      }
    }
    return { nudged, considered: rows.length, due: due.length };
  } catch (e) {
    log(`sweep skipped: ${e.message}`);
    return { skipped: e.message };
  }
}

async function main() {
  loadEnv();
  const send = process.argv.includes("--send");
  const rows = await listJoinApplicantsByStage("challenge");
  const due = stalledApplicants(rows, { hours: stallHours() });
  console.error(`\nat stage=challenge: ${rows.length} · silent > ${stallHours()}h: ${due.length}\n`);
  for (const r of due) console.error(`  ${r.email}  turns=${r.turns}  silent since ${String(r.last_msg_at).slice(0, 19)}`);
  if (!send) { console.error(`\nDRY RUN. Nothing sent. Re-run with --send.\n`); return; }
  const res = await runCampaignStallSweep();
  console.error(`\n${JSON.stringify(res)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[campaign-stall] fatal:", e.message); process.exit(1); });
