// newsletter.mjs — the thesis / vision note to early and newly-onboarded users.
//
//   node newsletter.mjs <email>     send to one address now (ignores the sent-flag; for the owner test)
//   node newsletter.mjs --all       send to every ACTIVE user not yet sent (the one-time first newsletter)
//   node newsletter.mjs --cron      send to active users onboarded >= 1 day ago, not yet sent (lifecycle; run by the engine)
//
// Idempotent via email_config.thesis_sent_at (never double-sends). Skips suppressed addresses.
// One-click unsubscribe + unthreaded, via the shared email kit. User-facing copy: no mechanism.
// EMAIL_DRY_RUN=1 (lib/dry-run.mjs) renders and logs each email but sends nothing and writes no
// sent-flag, so a preview run leaves every recipient still due.

import { Resend } from "resend";
import { loadEnv, getCandidate, listNewsletterCandidates, setEmailConfig, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one physical send door
import { dripGuard, stampFor } from "./drip-guard.mjs";
import { renderThesisNewsletter, unsubUrlFor } from "./email-kit.mjs";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)
import { isDryRun } from "./lib/dry-run.mjs"; // EMAIL_DRY_RUN=1: render and log, never send

const log = (...a) => console.error("[newsletter]", ...a);
const DAY = 24 * 60 * 60 * 1000;

async function sendTo(email, { name = "", emailConfig = {}, force = false } = {}) {
  if (!force && emailConfig?.thesis_sent_at) { log(`${email}: already sent — skip`); return "skip"; }
  // Global drip-guard: opt-out + suppression + the 2-day global gap so this can't stack on another drip.
  if (!force) {
    const g = await dripGuard({ email, dripType: "thesis", candidate: { email, email_config: emailConfig } });
    if (g.decision === "skip") { log(`${email}: skip (${g.reason})`); return g.reason === "suppressed" ? "suppressed" : "skip"; }
  } // force path: suppression is enforced by the send door below
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const m = renderThesisNewsletter({ email, name });
  const unsub = unsubUrlFor(email);
  const payload = { from, to: email, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  if (isDryRun()) { log(`${email}: DRY RUN (EMAIL_DRY_RUN=1) — would send "${m.subject}"`); return "dry_run"; }
  const res = await sendGuarded({ resend, email, template: "newsletter", dedupeKey: "thesis", payload, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: already sent (idempotency) — skip`); return "skip"; }
  if (res.status === "failed") return "failed";
  try { await setEmailConfig(email, { ...(emailConfig || {}), ...stampFor("thesis") }); }
  catch (e) { log(`${email}: sent but flag-mark failed: ${e.message}`); }
  log(`${email}: sent (resend ${res.id})`);
  return "sent";
}

async function main() {
  loadEnv();
  initSentry({ name: "newsletter" });
  const arg = (process.argv[2] || "").trim();
  if (!arg) { console.error("usage: node newsletter.mjs <email> | --all | --cron"); process.exit(1); }

  if (arg !== "--all" && arg !== "--cron") {
    const email = arg.toLowerCase();
    const c = await getCandidate(email);
    const r = await sendTo(email, { name: c?.dossier?.name || "", emailConfig: c?.email_config || {}, force: true });
    console.log(`newsletter ${email}: ${r}`);
    return;
  }

  const cron = arg === "--cron";
  const cands = await listNewsletterCandidates();
  let sent = 0, skipped = 0, failed = 0, dry = 0;
  for (const c of cands) {
    if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
    try {
      const ec = c.email_config || {};
      if (ec.thesis_sent_at) { skipped++; continue; }
      if (cron && Date.now() - new Date(c.created_at).getTime() < DAY) { skipped++; continue; } // not yet a day old
      const r = await sendTo(c.email, { name: c.dossier?.name || "", emailConfig: ec });
      if (r === "sent") sent++; else if (r === "failed") failed++; else if (r === "dry_run") dry++; else skipped++;
    } catch (e) { failed++; console.error(`[newsletter] ${c.email} failed (skipped, batch continues): ${e.message}`); captureError(e, { service: "newsletter", kind: "per_record" }); }
  }
  console.log(`newsletter ${arg}: sent=${sent} skipped=${skipped} failed=${failed}${dry ? ` dry_run=${dry}` : ""} (of ${cands.length} active)`);
}

main().catch(async (e) => { console.error("[newsletter] fatal:", e.message); captureError(e, { service: "newsletter", kind: "fatal" }); await flushSentry(); process.exit(1); });
