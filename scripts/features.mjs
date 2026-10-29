// scripts/features.mjs — usage rate of each in-email feature (affordance). READ-ONLY, $0.
//
//   node --env-file=.env.local scripts/features.mjs           real users only
//   node --env-file=.env.local scripts/features.mjs --all     include the owner's account
//   node --env-file=.env.local scripts/features.mjs --days 30 window (default 30)
//
// scripts/engagement.mjs answers "is this working for a PERSON" (sent vs acted, per user). This
// answers "is this working as a FEATURE": every affordance is a link or a reply that records a signal,
// and they are listed side by side.
//
// Each feature that rides inside a role email is divided by the number of role emails that could
// have carried it, so a feature live for a week compares fairly with one live for months.

import { loadEnv } from "../charlie-store.mjs";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const OWNER = new Set([String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean));
const ALL = process.argv.includes("--all");
const DAYS = Number(process.argv[process.argv.indexOf("--days") + 1]) || 30;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
);

// Every affordance, with what it MEANS — not the event name, which tells a reader nothing.
// `perRole` marks the ones that ride inside a role email and therefore share its denominator.
const FEATURES = [
  { event: "apply_click", perRole: true, what: "Tapped through to actually apply" },
  { event: "position_ask", perRole: true, what: "Asked how to position for the role" },
  { event: "worth", perRole: true, what: "Said the role was worth seeing" },
  { event: "not", perRole: true, what: "Said it was not" },
  { event: "role_click", perRole: true, what: "Opened a role a friend gifted them" },
  { event: "role_check", perRole: true, what: "Asked for their fit on a gifted role" },
  { event: "share_whatsapp", perRole: true, what: "Shared a role on WhatsApp" },
  { event: "share_email", perRole: true, what: "Shared a role by email" },
  { event: "pro_interest", perRole: false, what: "Replied wanting Pro" },
  { event: "represent_interest", perRole: false, what: "Replied yes to being represented" },
];

const since = new Date(Date.now() - DAYS * 86400000).toISOString();
const real = (e) => ALL || !OWNER.has(String(e || "").toLowerCase());

const { data: sigs, error } = await db.from("signals").select("email,event,job_id,created_at").gte("created_at", since).limit(20000);
if (error) throw new Error(`signals read failed: ${error.message}`);
const { data: sent } = await db.from("sent_emails").select("email,template,sent_at").gte("sent_at", since).limit(20000);

const roleTemplates = new Set(["role", "first-role", "first-closest", "recovered-role", "role-picks"]);
const roleSends = (sent || []).filter((r) => real(r.email) && roleTemplates.has(r.template)).length;
const people = new Set((sent || []).filter((r) => real(r.email)).map((r) => r.email));

const rows = FEATURES.map((f) => {
  const hits = (sigs || []).filter((s) => s.event === f.event && real(s.email));
  return { ...f, n: hits.length, users: new Set(hits.map((s) => s.email)).size };
}).sort((a, b) => b.n - a.n);

console.log(`\nFEATURE USE — last ${DAYS} days${ALL ? " (owner included)" : ""}`);
console.log(`${roleSends} role emails to ${people.size} people\n`);
console.log(`  ${"what they did".padEnd(42)} ${"times".padStart(6)} ${"people".padStart(7)} ${"per role email".padStart(15)}`);
console.log(`  ${"-".repeat(42)} ${"-".repeat(6)} ${"-".repeat(7)} ${"-".repeat(15)}`);
for (const r of rows) {
  const rate = r.perRole && roleSends ? `${((100 * r.n) / roleSends).toFixed(1)}%` : "—";
  const zero = r.n === 0 ? "   (never used)" : "";
  console.log(`  ${r.what.padEnd(42)} ${String(r.n).padStart(6)} ${String(r.users).padStart(7)} ${rate.padStart(15)}${zero}`);
}

// Summary: apply clicks versus every other in-email affordance combined.
const apply = rows.find((r) => r.event === "apply_click")?.n || 0;
const others = rows.filter((r) => r.event !== "apply_click" && r.perRole).reduce((t, r) => t + r.n, 0);
console.log(`\n  apply clicks: ${apply}   ·   every other in-email affordance combined: ${others}`);
if (apply + others === 0) {
  console.log(`  Nothing was clicked in this window. Widen it with --days before reading anything into that.`);
} else if (others === 0) {
  console.log(`  Only apply is used. On this window the role email alone is the product, and the rest is decoration.`);
} else {
  console.log(`  ${((100 * others) / (apply + others)).toFixed(0)}% of in-email actions were something OTHER than apply.`);
}
console.log(`\n  A feature reading 0 that shipped days ago is not yet evidence — check when its flag went on.\n`);
