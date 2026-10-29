// send-market-report.mjs — operator tool: send the grounded "State of Your Market" briefing
// (market-report.mjs -> render-market-report.mjs) to one person. SENDS REAL EMAIL unless --dry.
//
// GUARDED: the physical send routes through lib/send-guard.mjs (sendGuarded) — suppression +
// sent_emails idempotency + the one Resend door. This is a lifecycle-style letter, not a
// role match, so it does not run preSendGuard (that gate is role-email specific); it is the same
// shape as the other lifecycle sends, which also go through sendGuarded.
//
//   node --env-file=.env.local scripts/send-market-report.mjs --for <dossierEmail> [--to <recipient>] [--dry] [--force]
//
//   --for    whose dossier + live market the briefing is about (required)
//   --to     who receives it (default: the --for address). For a test to yourself, use a +alias
//            you control (e.g. you+market@example.com) — a suppressed address is never sent to.
//   --dry    build + print the subject and the headline numbers, DO NOT send
//   --force  clear a prior idempotency claim and re-send (a deliberate operator re-send)
//
// Read-only against the pool + dossier; the ONLY side effect is the send itself.

import { Resend } from "resend";
import { loadEnv } from "../charlie-store.mjs";
import { buildMarketReport } from "../market-report.mjs";
import { renderMarketReport } from "../render-market-report.mjs";
import { unsubUrlFor } from "../email-kit.mjs";
import { sendGuarded } from "../lib/send-guard.mjs";

loadEnv();

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || "").trim() : null; };
const forEmail = (arg("--for") || "").toLowerCase();
const to = (arg("--to") || forEmail).toLowerCase();
const DRY = argv.includes("--dry");
const FORCE = argv.includes("--force");

if (!forEmail) {
  console.error("usage: node --env-file=.env.local scripts/send-market-report.mjs --for <email> [--to <recipient>] [--dry] [--force]");
  process.exit(1);
}

const report = await buildMarketReport(forEmail);
const { subject, html } = renderMarketReport(report, { email: to });

const f = report.funnel;
console.error(`briefing for ${forEmail}  ->  ${to}`);
console.error(`  ${f.scanned} scanned · ${f.inField} in field · ${f.addressable} reachable · standout: ${report.standout?.company || "-"}`);
console.error(`  subject: "${subject}"`);

if (DRY) { console.error("DRY RUN — nothing sent."); process.exit(0); }

const resend = new Resend(process.env.RESEND_API_KEY);
const unsubUrl = unsubUrlFor(to);
const payload = {
  from: process.env.CHARLIE_FROM || "charlie@mail.example.com",
  to,
  subject,
  html,
  headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
};

// Idempotency is namespaced by BOTH the recipient and whose report it is, so a test send to your own
// alias never blocks the real send to the person the briefing is about.
const dedupeKey = `market/${forEmail}`;
const sent = await sendGuarded({
  resend,
  email: to,
  template: "market-report",
  dedupeKey,
  payload,
  to,
  idempotencyKey: `market-report/${to}/${forEmail}`,
  force: FORCE,
  log: console.error,
});

if (sent.status === "suppressed") { console.error(`${to} is on the suppression list — not sent. Use a +alias you control.`); process.exit(1); }
if (sent.status === "duplicate") { console.error(`already sent to ${to} for ${forEmail} (idempotency) — use --force to re-send.`); process.exit(1); }
if (sent.status === "failed") { console.error("send error:", typeof sent.error === "string" ? sent.error : JSON.stringify(sent.error)); process.exit(1); }
console.log(`SENT to ${to} | "${subject}" | resend ${sent.id || "-"}`);
