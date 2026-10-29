// check-candidate.mjs — inspect one user's stored state. The fastest "is it onboarded /
// what does Charlie know" debug tool.
//
//   node scripts/check-candidate.mjs <email>
//
// Prints status, when it was last updated, the grounded name, key preferences, dossier
// size, whether a resume is on file, and recent finds. Read-only.

import { loadEnv, getCandidate, getResume, getFinds } from "../charlie-store.mjs";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("usage: node scripts/check-candidate.mjs <email>");
  process.exit(1);
}

loadEnv();

const c = await getCandidate(email);
if (!c) {
  console.log(`No candidate for ${email} (not onboarded).`);
  process.exit(0);
}
const d = c.dossier || {};
const p = d.preferences || {};
const agoMin = ((Date.now() - new Date(c.updated_at).getTime()) / 60000).toFixed(1);
const resume = await getResume(email).catch(() => null);
const finds = await getFinds(email, { limit: 5 }).catch(() => []);

console.log(`\n${email}`);
console.log(`  status:        ${c.status}`);
console.log(`  updated_at:    ${c.updated_at}  (${agoMin} min ago)`);
console.log(`  name:          ${JSON.stringify(d.name)}`);
console.log(`  headline:      ${d.headline || "(none)"}`);
console.log(`  proof_points:  ${(d.proof_points || []).length} | case_studies: ${(d.case_studies || []).length} | gaps: ${(d.gaps || []).length}`);
console.log(`  resume stored: ${resume ? `yes (${resume.length} chars)` : "no"}`);
console.log(`  preferences:`);
for (const k of ["role", "seniority", "remote", "comp_floor", "comp_currency", "dealbreakers"]) {
  if (p[k] != null) console.log(`     ${k}: ${JSON.stringify(p[k])}`);
}
console.log(`  recent finds (${finds.length}):`);
for (const f of finds) console.log(`     ${f.status.padEnd(8)} ${f.job?.title ?? "?"} @ ${f.job?.company ?? "?"} (${f.match?.score ?? "?"})`);
console.log("");
