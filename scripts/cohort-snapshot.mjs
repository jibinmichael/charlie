// cohort-snapshot.mjs — write a timestamped snapshot of every candidate's status, email_config and
// dossier to disk. READ-ONLY against the database; it sends nothing and changes nothing.
//
// Take one before a bulk status change (scripts/pause-cohort.mjs) or a dossier rebuild: it is the
// record a restore reads. Restoring is a separate, deliberate step (pause-cohort.mjs --restore); there
// is no write-back here.
//
//   node --env-file=.env.local scripts/cohort-snapshot.mjs [--out <path>]
//
// Default output: snapshots/candidates-<ISO>.json (contains personal data; keep it out of git).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, listNewsletterCandidates, getCandidate } from "../charlie-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const outArg = args.indexOf("--out");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = outArg >= 0 ? args[outArg + 1] : join(HERE, "..", "snapshots", `candidates-${stamp}.json`);

  const cands = await listNewsletterCandidates();
  // listNewsletterCandidates filters on status but does not select the column, so each candidate is
  // re-read through getCandidate. Without it every snapshot row would record a null status and a
  // restore would do nothing.
  const rows = [];
  for (const c of cands) {
    const full = await getCandidate(c.email).catch(() => null);
    rows.push({
      email: c.email,
      status: full?.status ?? null,
      created_at: c.created_at ?? null,
      email_config: c.email_config ?? null,
      dossier: c.dossier ?? null,
    });
  }
  const missing = rows.filter((r) => r.status == null).map((r) => r.email);
  if (missing.length) console.error(`WARNING: ${missing.length} row(s) captured with a null status — restore cannot help them: ${missing.slice(0, 5).join(", ")}`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ takenAt: new Date().toISOString(), count: rows.length, rows }, null, 2));

  const byStatus = {};
  for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] || 0) + 1;
  console.log(`snapshot: ${rows.length} candidate(s) -> ${out}`);
  console.log(`status: ${JSON.stringify(byStatus)}`);
}

main().catch((e) => {
  console.error(`[cohort-snapshot] fatal: ${e.message}`);
  process.exit(1);
});
