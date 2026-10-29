// pause-cohort.mjs — pause every ACTIVE candidate who is not in ROLE_COHORT, by flipping
// `candidates.status` to 'paused'. Dry by default: it prints exactly who it would touch and writes
// nothing unless you pass --apply.
//
//   node --env-file=.env.local scripts/pause-cohort.mjs                          # dry run
//   node --env-file=.env.local scripts/pause-cohort.mjs --apply                  # flip them
//   node --env-file=.env.local scripts/pause-cohort.mjs --restore <snap.json>    # dry run the undo
//   node --env-file=.env.local scripts/pause-cohort.mjs --restore <snap.json> --apply
//
// WHY STATUS AND NOT THE SUPPRESSION LIST. `listActiveCandidates` / `listNewsletterCandidates` both
// filter status='active' (charlie-store.mjs), so a non-active status removes a person from the daily
// role cron, the digest, the newsletter, the market-read sweep and every other drip — which is exactly
// "stop the automated email". The inbound reply gate (server/charlie-remote.ts) reads ONLY the
// suppression table and never status, so a paused person who writes in still gets a reply. Suppression
// would block that reply, and would put fictional rows into the bounce/complaint record that protects
// the sending domain. Nothing here touches `suppressions`.
//
// UNDO: --restore reads a snapshot from scripts/cohort-snapshot.mjs and puts each row's ORIGINAL status
// back, rather than assuming everyone paused was previously 'active'.
//
// DRIFT: a paused person who emails a fresh resume re-enters onboarding, which saves status 'active'
// (email-onboard.mjs). That re-engagement is intended, so the paused set can drift; re-run this
// script (dry first) to see and re-apply.

import { readFileSync } from "node:fs";
import { loadEnv, listNewsletterCandidates, getCandidate, setCandidateStatus } from "../charlie-store.mjs";
import { inRoleCohort, roleCohortSize } from "../lib/role-cohort.mjs";

const PAUSED = "paused";

// Flip a list of { email, status } with per-record isolation: one bad row never aborts the batch.
async function applyAll(rows) {
  let ok = 0;
  for (const r of rows) {
    try {
      await setCandidateStatus(r.email, r.status);
      ok++;
    } catch (e) {
      console.error(`  FAILED ${r.email}: ${e.message}`);
    }
  }
  return ok;
}

async function restore(path, apply) {
  const snap = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(snap?.rows) ? snap.rows : [];
  if (!rows.length) throw new Error(`no rows in ${path}`);

  const changes = [];
  for (const r of rows) {
    const cur = await getCandidate(r.email).catch(() => null);
    const was = r.status ?? null;
    if (!cur || !was) continue;
    if ((cur.status ?? null) !== was) changes.push({ email: r.email, status: was, from: cur.status ?? null });
  }

  console.log(`snapshot: ${path} (${rows.length} row(s), taken ${snap.takenAt || "?"})`);
  console.log(`rows whose status differs from the snapshot: ${changes.length}\n`);
  for (const c of changes) console.log(`  ${c.email}: ${c.from} -> ${c.status}`);
  if (!apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to restore these.`);
    return;
  }
  console.log(`\nrestored ${await applyAll(changes)}/${changes.length}`);
}

async function pause(apply) {
  const size = roleCohortSize();
  if (!size) {
    console.error("ROLE_COHORT is empty — refusing to run. With no cohort configured this would pause EVERY user.");
    process.exit(1);
  }

  const cands = await listNewsletterCandidates(); // status='active' only
  const targets = cands.filter((c) => !inRoleCohort(c.email)).map((c) => ({ email: c.email, status: PAUSED }));

  console.log(`ROLE_COHORT: ${size} address(es) configured`);
  console.log(`active candidates: ${cands.length}`);
  console.log(`in cohort (stay active): ${cands.length - targets.length}`);
  console.log(`to pause: ${targets.length}\n`);
  for (const t of targets) console.log(`  ${t.email}`);

  if (!apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to set status='${PAUSED}'.`);
    return;
  }
  console.log(`\npaused ${await applyAll(targets)}/${targets.length}`);
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ri = args.indexOf("--restore");
  if (ri >= 0) {
    const path = args[ri + 1];
    if (!path) throw new Error("--restore needs a snapshot path");
    return restore(path, apply);
  }
  return pause(apply);
}

main().catch((e) => {
  console.error(`[pause-cohort] fatal: ${e.message}`);
  process.exit(1);
});
