// announce-checkin.mjs — a proactive "how's it going?" check-in to users who've actually received
// roles, so the silent majority gives us signal and the active users tell us if the picks are right.
//
//   node announce-checkin.mjs --dry     show who is eligible and which opener they'd get (no send)
//   node announce-checkin.mjs <email>   send to one address now (owner test; ignores the flag)
//   node announce-checkin.mjs --all     send to every eligible user not yet checked in
//
// Eligible = active, not suppressed, not an owner account, and has received at least one role email
// (nothing to give feedback on otherwise). `applied` opener for users who've clicked through to
// apply. Idempotent via email_config.checkin_sent_at. Tap answers record to `signals` through the
// existing /e/ endpoint (no backend change); replies route to /inbound where Charlie acknowledges.

import { Resend } from "resend";
import { loadEnv, getCandidate, setEmailConfig, isV2, readAll } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one physical send door
import { renderCheckin, unsubUrlFor } from "./email-kit.mjs";
import { createClient } from "@supabase/supabase-js";

const log = (...a) => console.error("[announce-checkin]", ...a);
const OWNER = new Set([String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean)); // the operator is never in the audience

// Build the eligible list from the DB: served (>=1 emailed find), active, non-owner. Attach the
// `applied` flag (any apply_click signal) and the person's name.
async function eligibleUsers() {
  /** @type {import("@supabase/supabase-js").SupabaseClient<import("./lib/database.types").Database>} */
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [{ data: cands }, { data: finds }, { data: signals }] = await Promise.all([
    readAll("candidates", "email, dossier, status, email_config").then((data) => ({ data })),
    readAll("finds", "id, status").then((data) => ({ data })),
    readAll("signals", "email, event").then((data) => ({ data })),
  ]);
  const emailed = {};
  for (const f of finds || []) if (f.status === "emailed") { const e = String(f.id || "").split(":")[0]; emailed[e] = (emailed[e] || 0) + 1; }
  const appliedSet = new Set((signals || []).filter((s) => s.event === "apply_click").map((s) => s.email));
  return (cands || [])
    .filter((c) => c.status === "active" && !OWNER.has(c.email) && (emailed[c.email] || 0) > 0 && !isV2(c)) // v1 sweep — v2 cohort fenced out
    .map((c) => ({
      email: c.email,
      name: firstName(c.dossier?.name),
      applied: appliedSet.has(c.email),
      sent: emailed[c.email] || 0,
      emailConfig: c.email_config || {},
    }));
}

function firstName(full) {
  const tok = String(full || "").trim().split(/\s+/)[0] || "";
  if (!tok) return "";
  return tok === tok.toUpperCase() ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : tok;
}

async function sendTo(email, { name = "", applied = false, emailConfig = {}, force = false } = {}) {
  if (!force && emailConfig?.checkin_sent_at) return "skip";
  const m = renderCheckin({ email, name, applied });
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const unsub = `<${unsubUrlFor(email)}>`;
  const dkey = `checkin-${new Date().toISOString().slice(0, 10)}`; // date-scoped: blocks same-day doubles, allows a future check-in
  const payload = { from, to: email, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": unsub, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  const res = await sendGuarded({ resend, email, template: "checkin", dedupeKey: dkey, payload, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: already sent (idempotency) — skip`); return "skip"; }
  if (res.status === "failed") return "failed";
  try { await setEmailConfig(email, { ...(emailConfig || {}), checkin_sent_at: new Date().toISOString() }); }
  catch (e) { log(`${email}: sent but flag-mark failed: ${e.message}`); }
  log(`${email}: sent (${applied ? "active" : "silent"}, resend ${res.id})`);
  return "sent";
}

async function main() {
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (!arg) { console.error("usage: node announce-checkin.mjs --dry | <email> | --all"); process.exit(1); }

  if (arg === "--dry") {
    const users = await eligibleUsers();
    console.log(`eligible for check-in: ${users.length} users (served, active, not suppressed)\n`);
    for (const u of users) console.log(`  ${(u.name || "(no name)").padEnd(16)} ${u.applied ? "active" : "silent"}  sent:${u.sent}  ${u.email}  ${u.emailConfig.checkin_sent_at ? "ALREADY-SENT" : ""}`);
    return;
  }
  if (arg !== "--all") {
    const email = arg.toLowerCase();
    const c = await getCandidate(email);
    const applied = false; // owner test defaults to the silent opener
    console.log(`announce-checkin ${email}: ${await sendTo(email, { name: firstName(c?.dossier?.name), applied, emailConfig: c?.email_config || {}, force: true })}`);
    return;
  }
  const users = await eligibleUsers();
  let sent = 0, skipped = 0, failed = 0;
  for (const u of users) {
    try {
      const r = await sendTo(u.email, { name: u.name, applied: u.applied, emailConfig: u.emailConfig });
      if (r === "sent") sent++; else if (r === "failed") failed++; else skipped++;
    } catch (e) { failed++; console.error(`[checkin] ${u.email} failed (skipped, batch continues): ${e.message}`); }
  }
  console.log(`announce-checkin --all: sent=${sent} skipped=${skipped} failed=${failed} (of ${users.length} eligible)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[announce-checkin] fatal:", e.message); process.exit(1); });
