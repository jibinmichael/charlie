// announce-referral.mjs — the "what's new: warm-intro finder" announcement.
//
//   node announce-referral.mjs <email>   send to one address now (ignores the flag; owner test)
//   node announce-referral.mjs --all      send to every ACTIVE user not yet sent (the one-time blast)
//
// runReferralAnnounceSweep() is called by the always-on server on an interval: it dribbles the
// announcement to users onboarded ~24h to 4 days ago who haven't been sent yet (the onboarder
// sequence). The 24h–4d window sits AFTER the welcome + the what's-new (gmail-filter) email so
// new users get a spaced drip, not a burst, and it EXCLUDES the current backlog (all older than
// 4 days) so the sweep never re-blasts existing users, those get it via `--all`. Idempotent via
// email_config.referral_announce_sent_at. Skips suppressed. One-click unsubscribe, unthreaded.

import { Resend } from "resend";
import { getCandidate, listNewsletterCandidates, setEmailConfig, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one physical send door
import { dripGuard, stampFor } from "./drip-guard.mjs";
import { renderReferralAnnounce, unsubUrlFor } from "./email-kit.mjs";

const log = (...a) => console.error("[announce-referral]", ...a);
const MIN = 60 * 1000;

async function sendTo(email, { name = "", emailConfig = {}, force = false } = {}) {
  if (!force && emailConfig?.referral_announce_sent_at) return "skip";
  // Global drip-guard: opt-out + suppression + the 2-day global gap so this can't stack on another drip.
  if (!force) {
    const g = await dripGuard({ email, dripType: "referral", candidate: { email, email_config: emailConfig } });
    if (g.decision === "skip") { log(`${email}: skip (${g.reason})`); return g.reason === "suppressed" ? "suppressed" : "skip"; }
  } // force path: suppression is enforced by the send door below
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const m = renderReferralAnnounce({ email, name });
  const unsub = `<${unsubUrlFor(email)}>`;
  const payload = { from, to: email, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": unsub, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  const res = await sendGuarded({ resend, email, template: "referral", dedupeKey: "v1", payload, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: already sent (idempotency) — skip`); return "skip"; }
  if (res.status === "failed") return "failed";
  try { await setEmailConfig(email, { ...(emailConfig || {}), ...stampFor("referral") }); }
  catch (e) { log(`${email}: sent but flag-mark failed: ${e.message}`); }
  log(`${email}: sent (resend ${res.id})`);
  return "sent";
}

// Server-called: send to users onboarded 24h–4d ago, not yet sent. Best-effort, never throws.
export async function runReferralAnnounceSweep({ minMinutes = 24 * 60, maxMinutes = 4 * 24 * 60 } = {}) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
      try {
        const ec = c.email_config || {};
        if (ec.referral_announce_sent_at) continue;
        const age = now - new Date(c.created_at).getTime();
        if (age < minMinutes * MIN || age > maxMinutes * MIN) continue;
        await sendTo(c.email, { name: c.dossier?.name || "", emailConfig: ec });
      } catch (e) { log(`[referral] ${c.email} failed (skipped, batch continues): ${e.message}`); }
    }
  } catch (e) { log(`sweep skipped: ${e.message}`); }
}

async function main() {
  const { loadEnv } = await import("./charlie-store.mjs");
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (!arg) { console.error("usage: node announce-referral.mjs <email> | --all"); process.exit(1); }
  if (arg !== "--all") {
    const email = arg.toLowerCase();
    const c = await getCandidate(email);
    console.log(`announce-referral ${email}: ${await sendTo(email, { name: c?.dossier?.name || "", emailConfig: c?.email_config || {}, force: true })}`);
    return;
  }
  const cands = await listNewsletterCandidates();
  let sent = 0, skipped = 0, failed = 0;
  for (const c of cands) {
    if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
    const ec = c.email_config || {};
    if (ec.referral_announce_sent_at) { skipped++; continue; }
    const r = await sendTo(c.email, { name: c.dossier?.name || "", emailConfig: ec });
    if (r === "sent") sent++; else if (r === "failed") failed++; else skipped++;
  }
  console.log(`announce-referral --all: sent=${sent} skipped=${skipped} failed=${failed} (of ${cands.length} active)`);
}

// run as CLI only (not when imported by the server for runReferralAnnounceSweep)
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[announce-referral] fatal:", e.message); process.exit(1); });
