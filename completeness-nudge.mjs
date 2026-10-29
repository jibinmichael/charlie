// completeness-nudge.mjs — nudge users who aren't getting roles (usually thin input) to enrich
// their profile, so Charlie can find them something.
//
//   node completeness-nudge.mjs <email>   send one now (ignores cadence; owner test)
//   node completeness-nudge.mjs --dry      list who WOULD be nudged, send nothing
//
// runCompletenessNudgeSweep() is called by the always-on server on an interval. A user is
// nudged only if: active, NOT suppressed, has received ZERO role emails so far (no emailed
// finds), and is due for the next nudge. Cadence is 7 / 14 / 30 days after onboarding, at most
// THREE nudges total, then it stops forever. The instant a role clears their bar (an emailed
// find appears), nudging stops. Idempotent + spaced via email_config.completeness_nudge_count
// (+ completeness_last_at as a min-gap guard). One-click unsubscribe, unthreaded.

import { Resend } from "resend";
import { getCandidate, listNewsletterCandidates, setEmailConfig, mergeEmailConfig, getFindIds, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one send door
import { renderCompletenessNudge, unsubUrlFor } from "./email-kit.mjs";
import { dripGuard, stampFor } from "./drip-guard.mjs";

const log = (...a) => console.error("[completeness-nudge]", ...a);
const DAY = 24 * 60 * 60 * 1000;
const THRESHOLDS = [7, 14, 30]; // days after onboarding for nudge 1, 2, 3
// OFF UNLESS SOMEBODY TURNS IT ON (COMPLETENESS_NUDGE).
//
// The nudge itself is well-guarded (zero roles sent, a 5 day gap, a completeness check, the drip
// guard). The risk is that the SET of people it can reach — everyone at status `active` — changes
// underneath it silently as the pool grows. A flag makes turning it on a deliberate decision.
const ENABLED = String(process.env.COMPLETENESS_NUDGE || "off").toLowerCase();
const isOn = () => ENABLED === "on";
const isDry = () => ENABLED === "dry";

const MIN_GAP_DAYS = 5;         // never two nudges within this window (belt + suspenders)

async function sendTo(email, { name = "", candidate = null, count = 0, force = false } = {}) {
  const emailConfig = candidate?.email_config || {};
  // The one deterministic gate every drip passes: suppression, cooldown/no-double-send, opt-out, and
  // "profile already complete → nothing to nudge". Skipped only for the owner CLI test (`force`).
  if (!force) {
    const g = await dripGuard({ email, dripType: "completeness", candidate: candidate || { email, email_config: emailConfig } });
    if (g.decision === "skip") { log(`${email}: skip (${g.reason})`); return g.reason; }
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const last = count >= THRESHOLDS.length - 1; // the 3rd (final) nudge
  const m = renderCompletenessNudge({ email, name, last });
  const dkey = `n${count}`; // each of the 3 nudges (count 0/1/2) is a distinct claim
  const payload = {
    from, to: email, subject: m.subject, html: m.html, text: m.text,
    headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
  const res = await sendGuarded({ resend, email, template: "nudge", dedupeKey: dkey, payload, log });
  if (res.status === "suppressed") { return "suppressed"; }
  if (res.status === "duplicate") { log(`${email}: nudge ${count + 1} already sent (idempotency) — skip`); return "skip"; }
  if (res.status === "failed") { return "failed"; }
  const data = { id: res.id };
  // Stamp AFTER a successful send: the per-type ledger (last_gap_drip_at, via stampFor) so the guard's
  // cooldown blocks any resend, plus the existing count/last_at cadence flags. Missing this stamp is a
  // real double-send risk, so it's best-effort-logged but always attempted.
  try {
    const nowIso = new Date().toISOString();
    await setEmailConfig(email, { ...(emailConfig || {}), completeness_nudge_count: count + 1, completeness_last_at: nowIso, ...stampFor("completeness", nowIso) });
  } catch (e) {
    log(`${email}: sent but flag-mark failed: ${e.message}`);
    // fall back to a merge (spread-preserving) so at least the cooldown stamp lands
    await mergeEmailConfig(email, { completeness_nudge_count: count + 1, ...stampFor("completeness") }).catch(() => {});
  }
  log(`${email}: nudge ${count + 1}/3 sent (resend ${data?.id})`);
  return "sent";
}

// true if this candidate is due for their next completeness nudge right now.
function dueForNudge(c, now) {
  const ec = c.email_config || {};
  const count = ec.completeness_nudge_count || 0;
  if (count >= THRESHOLDS.length) return false;                 // already had all 3
  const ageDays = (now - new Date(c.created_at).getTime()) / DAY;
  if (ageDays < THRESHOLDS[count]) return false;                // not time for the next one
  if (ec.completeness_last_at && (now - new Date(ec.completeness_last_at).getTime()) < MIN_GAP_DAYS * DAY) return false;
  // Collision guard: if the event-driven chat drip asked a gap-question recently (reply/onboarding),
  // don't also fire the timed nudge in the same window — the two would talk over each other.
  if (ec.last_gap_drip_at && (now - new Date(ec.last_gap_drip_at).getTime()) < MIN_GAP_DAYS * DAY) return false;
  return true;
}

// Server-called sweep. Best-effort, never throws.
export async function runCompletenessNudgeSweep({ log = console.error } = {}) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    // Fail closed on the flag: an unset COMPLETENESS_NUDGE means off, not on.
    if (!isOn() && !isDry()) return;
    if (isDry()) log(`[completeness-nudge] COMPLETENESS_NUDGE=dry — selecting and logging, sending nothing`);
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
      // This nudge exists to say "you aren't getting roles yet, here's what would help", which is
      // true for every active candidate who has not yet been emailed a role.
      try {
        if (!dueForNudge(c, now)) continue;
        // only nudge people who genuinely aren't getting roles yet
        const emailed = await getFindIds(c.email).catch(() => new Set());
        if (emailed.size > 0) continue; // a role already cleared their bar — leave them alone
        await sendTo(c.email, { name: c.dossier?.name || "", candidate: c, count: c.email_config?.completeness_nudge_count || 0 });
      } catch (e) { log(`[nudge] ${c.email} failed (skipped, batch continues): ${e.message}`); }
    }
  } catch (e) { log(`sweep skipped: ${e.message}`); }
}

async function main() {
  const { loadEnv } = await import("./charlie-store.mjs");
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (arg === "--dry") {
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
      const emailed = await getFindIds(c.email).catch(() => new Set());
      const due = dueForNudge(c, now) && emailed.size === 0;
      const ageDays = ((now - new Date(c.created_at).getTime()) / DAY).toFixed(1);
      console.log(`${due ? "WOULD NUDGE" : "skip      "}  ${c.email}  age:${ageDays}d  roles:${emailed.size}  count:${c.email_config?.completeness_nudge_count || 0}`);
    }
    return;
  }
  if (!arg) { console.error("usage: node completeness-nudge.mjs <email> | --dry"); process.exit(1); }
  const email = arg.toLowerCase();
  const c = await getCandidate(email);
  // owner CLI test: ignores cadence (force), same as before this always-sent
  console.log(`completeness-nudge ${email}: ${await sendTo(email, { name: c?.dossier?.name || "", candidate: c, count: c?.email_config?.completeness_nudge_count || 0, force: true })}`);
}

// run as CLI only (not when imported by the server for the sweep)
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[completeness-nudge] fatal:", e.message); process.exit(1); });
