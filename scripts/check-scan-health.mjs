// scripts/check-scan-health.mjs — after a daily scan: did any job source go silent?
// READ-ONLY (downloads two job-pool objects).
//
//   node scripts/check-scan-health.mjs     (reads .env.local itself)
//
// The engine writes a durable health record (job-pool/scan-health.json): boards that answered but
// returned zero roles after returning some last run ("silent zeros"), and segments whose feed file was
// missing so their boards were never fetched. The alarm is a tripwire on the transition from "had
// roles" to "has none", so a source already at zero on the first run has no baseline and stays silent.
// The per-board reason (HTTP status, timeout, empty list) is only in that run's stdout log.
import "../lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — set them in .env.local or the environment");
  process.exit(1);
}
const sb = createClient(url, key);
const dl = async (k) => {
  const { data, error } = await sb.storage.from("job-pool").download(k);
  if (error) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
};

const health = await dl("scan-health.json");
const stats = await dl("stats.json");

console.log("\n════ SCAN HEALTH ════");
if (!health) {
  console.log("no scan-health.json yet — the engine has not completed a run since the check shipped.");
  console.log(`(last pool stats: ${stats?.updatedAt ?? "unknown"})`);
} else {
  console.log(`run at:    ${health.at}`);
  console.log(`pool size: ${health.poolSize}`);

  // Boards that ANSWERED and said nothing, having said something last time.
  if (!health.hadPrevious) console.log("\nsilent-zero check: NO BASELINE (first run) — 'no findings' here means 'no evidence', not 'all clear'");
  else if (health.silentZeroBoards) {
    console.log(`\n⚠  ${health.silentZeroBoards} board(s) resolved but went silent — ${health.lostRoles} roles lost vs the previous run`);
    console.log(`   by source: ${JSON.stringify(health.bySource)}`);
    for (const z of (health.silentZeros || []).slice(0, 15)) console.log(`   ${z.company} (${z.board}) — had ${z.had}, now 0`);
  } else console.log("\nsilent zeros: none — every board that had roles last run still yields roles");

  // Segments that were never ASKED (feed file missing => merge skipped => no ⚠ anywhere).
  if (!health.hadPreviousSegments) console.log("segment check:     NO BASELINE — same caveat");
  else if ((health.segmentCollapses || []).length) {
    console.log(`\n⚠  ${health.segmentCollapses.length} segment(s) contributed nothing — ${health.lostSegmentRoles} roles lost`);
    for (const s of health.segmentCollapses) console.log(`   segment "${s.segment}" — had ${s.had}, now 0`);
    console.log("   => its feed file was missing, so those boards were never fetched. Check the ingest that writes it.");
  } else console.log("segment collapse: none");
}

console.log("\n════ SEGMENTS (live) ════");
console.log(JSON.stringify(stats?.coverageBySegment ?? null));
if (stats && !stats.coverageBySegment?.yc) console.log("note: no `yc` segment — watchlist-yc.json was absent this run (yc-ingest feed hiccup).");
if (stats && !stats.coverageBySegment?.india) console.log("note: no `india` segment — expected while data/india-seed.json is [].");

console.log("\n════ WHAT TO DO NEXT ════");
console.log("Read the run's per-board log lines for any source flagged above:");
console.log("  '✓ <company> (<ats>) — 0 jobs'  => board answered 200 with an EMPTY list (possibly blocked/refused).");
console.log("  '⚠ <company> — HTTP 403/429/...' => refused outright; the status names the reason.");
console.log("  '⚠ <company> — timeout'          => too slow from the scan host, not blocked.");
console.log("  no line for the board at all     => it was never fetched (watchlist/segment problem, not the ATS).");
