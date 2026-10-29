// confirm-sweep.mjs — closes the VIP loop. Finds people who were INVITED and have now FINISHED their
// dossier (computeMissing → empty) but haven't been welcomed yet, and sends the one-time "you're in"
// confirmation card. Fail-closed and idempotent: gated on `vip_confirmed_at` (no double-send) and the
// suppression list. Runs on the server's 30-min sweep, next to the completeness nudge.

import { listActiveCandidates, mergeEmailConfig, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one send door
import { unsubUrlFor } from "./email-kit.mjs";
import { computeMissing } from "./render-invite.mjs";
import { renderConfirmation } from "./render-confirmation.mjs";
import { Resend } from "resend";

export async function runConfirmationSweep({ log = console.error } = {}) {
  const cands = await listActiveCandidates().catch(() => []);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  let sent = 0;
  for (const c of cands) {
    if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
    try {
      const ec = c.email_config || {};
      if (!ec.vip_invited_at) continue;                       // only people we invited
      if (ec.vip_confirmed_at) continue;                      // already welcomed → no double-send
      if (computeMissing(c.dossier || {}).length) continue;   // dossier not finished yet
      const to = ec.notify || c.email;
      const unsubUrl = unsubUrlFor(c.email);
      const payload = { from, to, subject: "You’re in \u{1F389}", html: renderConfirmation({ unsubUrl }), headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
      // Through the one send door: suppression plus sent_emails idempotency.
      const res = await sendGuarded({ resend, email: c.email, template: "confirm", dedupeKey: "v1", payload, to, log });
      if (res.status === "suppressed" || res.status === "duplicate") continue;
      if (res.status === "failed") { log(`[confirm] ${c.email} send failed`); continue; }
      await mergeEmailConfig(c.email, { vip_confirmed_at: new Date().toISOString() });
      sent++;
      log(`[confirm] ${c.email} → welcomed to the Club`);
      // NO INSTANT ROLE. Sending a role here would be a second serving track; there is only one, the
      // weekly hand-started run. The confirmation sends; the role waits for that run.
    } catch (e) { log(`[confirm] ${c.email} error: ${e.message}`); }
  }
  if (sent) log(`[confirm] sweep sent ${sent} confirmation(s)`);
  return sent;
}
