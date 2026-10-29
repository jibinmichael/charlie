// send-profile-nudge.mjs — email onboarded users whose profile is missing high-signal details
// (target role, seniority, pay floor, location, or name) a warm, OPTIONAL invitation to fill the
// gaps, so their matches get sharper. Grounded: references only their real resume headline.
// SENDS REAL EMAIL with --to or --send.
//
//   node scripts/send-profile-nudge.mjs                 # DRY RUN: list who'd get it + what's missing
//   node scripts/send-profile-nudge.mjs --to <email>    # send ONE (a real send, for eyeballing)
//   node scripts/send-profile-nudge.mjs --send          # fire to the whole incomplete cohort
//
// Excludes the owner (OWNER_EMAIL) and anyone already complete. Respects suppressions.

import { Resend } from "resend";
import { loadEnv, mergeEmailConfig, readAll } from "../charlie-store.mjs";
import { renderProfileNudge, unsubUrlFor } from "../email-kit.mjs";
import { dripGuard, stampFor } from "../drip-guard.mjs";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const ONE = (() => { const i = argv.indexOf("--to"); return i >= 0 ? (argv[i + 1] || "").trim().toLowerCase() : null; })();

// the owner's address (OWNER_EMAIL) — never nudged
const MINE = new Set([String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean));

/** @type {import("@supabase/supabase-js").SupabaseClient<import("../lib/database.types").Database>} */
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const data = await readAll("candidates", "email,dossier,email_config,status");
const error = null;
if (error) { console.error(error.message); process.exit(1); }

// what's genuinely missing for a candidate (drives the personalized asks)
const SENIORITY_IN_ROLE = /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|mid[- ]?level|entry|head|director|vp|chief|founding)\b/i;
function missingFor(d) {
  const p = (d && d.preferences) || {};
  const m = [];
  if (!p.role) m.push("role");
  // only ask seniority if it isn't already implied by the role title (e.g. "Senior Product Designer")
  if (!p.seniority && !(p.role && SENIORITY_IN_ROLE.test(p.role))) m.push("seniority");
  if (p.comp_floor == null) m.push("pay");
  if (!p.remote) m.push("location");
  if (!d?.name) m.push("name");
  return m;
}

const cohort = [];
for (const c of data) {
  const d = c.dossier || {};
  const missing = missingFor(d);
  const to = c.email_config?.notify || c.email;
  const skip = ONE ? c.email.toLowerCase() !== ONE : (MINE.has(c.email.toLowerCase()) || missing.length === 0);
  if (skip) continue;
  cohort.push({ email: c.email, to, name: d.name || "", headline: d.headline || "", missing, candidate: c });
}

if (!cohort.length) { console.log(ONE ? `No match for ${ONE} (or nothing missing).` : "No incomplete candidates to nudge."); process.exit(0); }

console.log(`${SEND || ONE ? "SENDING" : "DRY RUN"} — ${cohort.length} recipient(s):\n`);
const resend = new Resend(process.env.RESEND_API_KEY);
const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";

for (const c of cohort) {
  const m = renderProfileNudge({ email: c.email, name: c.name, headline: c.headline, missing: c.missing });
  if (!m) { console.log(`- ${c.email}: nothing missing after render, skipped`); continue; }
  console.log(`- ${c.email}  (name: ${c.name || "MISSING"}) → asks: ${c.missing.join(", ")}`);
  if (SEND || ONE) {
    // The one deterministic drip gate: opt-out, global min-gap (no drip stacks), per-type cooldown,
    // already-satisfied (nothing missing → skip), then suppression. Fail closed on skip.
    const g = await dripGuard({ email: c.email, dripType: "profile", candidate: c.candidate, now: Date.now() });
    if (g.decision === "skip") { console.log(`    skip (${g.reason})`); continue; }
    const { data: sent, error: e } = await resend.emails.send({ from, to: c.to, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": `<${unsubUrlFor(c.email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    if (e) console.log(`    SEND FAILED: ${e.message || JSON.stringify(e)}`);
    else {
      // Stamp AFTER a real send so the cooldown + global ledger block a re-nudge. Best-effort.
      await mergeEmailConfig(c.email, stampFor("profile", new Date().toISOString())).catch(() => {});
      console.log(`    sent → ${c.to} | resend ${sent.id} | subject "${m.subject}"`);
    }
  } else {
    console.log(`    subject: "${m.subject}"`);
  }
}
if (!SEND && !ONE) console.log(`\n(dry run — re-run with --to <email> to test one, or --send to fire the cohort)`);
