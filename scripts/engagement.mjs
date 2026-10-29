// scripts/engagement.mjs — per-user engagement scoreboard. Read-only.
//
//   node scripts/engagement.mjs            real users only (excludes OWNER_EMAIL)
//   node scripts/engagement.mjs --all      include the owner account too
//
// Joins what Charlie SENT (the `finds` table: role emails + digests) with what each user DID (the
// `signals` table: apply-clicks, worth/not, applied, interview).

import { loadEnv, readAll } from "../charlie-store.mjs";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const OWNER = new Set([String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean));
const includeOwner = process.argv.includes("--all");
/** @type {import("@supabase/supabase-js").SupabaseClient<import("../lib/database.types").Database>} */
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const [{ data: cands }, { data: finds }, { data: signals }] = await Promise.all([
  readAll("candidates", "email, dossier, status, created_at").then((data) => ({ data })),
  readAll("finds", "id, composed, status").then((data) => ({ data })),
  readAll("signals", "email, event, created_at").then((data) => ({ data })),
]);

// per-user rollups
const F = {}; // sends
for (const f of finds || []) {
  const e = String(f.id || "").split(":")[0];
  F[e] = F[e] || { emailed: 0, digest: 0 };
  if (f.status === "emailed") F[e].emailed++;
  else if (f.status === "digest_sent") F[e].digest++;
}
const S = {}; // actions
for (const s of signals || []) {
  S[s.email] = S[s.email] || { events: {}, last: null };
  S[s.email].events[s.event] = (S[s.email].events[s.event] || 0) + 1;
  if (!S[s.email].last || s.created_at > S[s.email].last) S[s.email].last = s.created_at;
}

const rows = (cands || [])
  .filter((c) => includeOwner || !OWNER.has(c.email))
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

let engaged = 0, totalApply = 0, totalEmailed = 0;
console.log(`\nENGAGEMENT SCOREBOARD  (${rows.length} ${includeOwner ? "" : "real "}users)\n`);
console.log(`  ${"user".padEnd(30)} ${"joined".padEnd(11)} ${"sent".padEnd(5)} ${"digest".padEnd(7)} ${"applied".padEnd(8)} actions / last`);
console.log(`  ${"-".repeat(92)}`);
for (const c of rows) {
  const name = (c.dossier?.name || c.email.split("@")[0]).slice(0, 18);
  const f = F[c.email] || { emailed: 0, digest: 0 };
  const s = S[c.email] || { events: {}, last: null };
  const apply = s.events.apply_click || 0;
  const acted = Object.keys(s.events).length > 0;
  if (acted) engaged++;
  totalApply += apply;
  totalEmailed += f.emailed;
  const actionStr = acted
    ? Object.entries(s.events).map(([k, v]) => `${k}:${v}`).join(" ") + `  (${String(s.last).slice(0, 10)})`
    : "— silent —";
  console.log(`  ${name.padEnd(30)} ${String(c.created_at).slice(0, 10).padEnd(11)} ${String(f.emailed).padEnd(5)} ${String(f.digest).padEnd(7)} ${String(apply).padEnd(8)} ${actionStr}`);
}
console.log(`  ${"-".repeat(92)}`);
console.log(`\n  ${engaged}/${rows.length} users have taken ANY action  ·  ${totalApply} total apply-clicks  ·  ${totalEmailed} role emails sent`);
console.log(`  ${rows.length - engaged} users are silent (sent roles, no recorded click) — the ones to check in with.\n`);
