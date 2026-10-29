// yc-ingest.mjs — daily: turn YC's "who's hiring" list into scannable watchlist entries.
//
//   node yc-ingest.mjs
//
// Pulls the public yc-oss hiring feed and resolves each company to its live ATS board via
// resolveAts (combined + verified: confirm >= 1 posting, no false positives), writing
// the resolved {company, slug, source, segment:"yc"} entries to watchlist-yc.json — a SEPARATE
// file scan-jobs.mjs loads alongside the hand-curated watchlist.json. The committed, human-edited
// watchlist.json is never mutated by this cron.
//
// India-region companies are EXCLUDED here and handled by india-ingest.mjs (segment:"india"), so a
// company is never tagged both "yc" and "india". The heavy lifting lives in
// ingest-core.mjs, shared with india-ingest.
//
// SCOPE: discover-companies.mjs already sweeps the full YC list into the watchlist, so this job's
// marginal yield is NEW live boards not yet on the list. Workday-hosted boards are not reachable
// here (no keyless list endpoint to probe); the Workday reader in scan-jobs.mjs covers those.
//
// Discipline: the external feed passes through a Zod schema before use;
// per-record isolation + never-drop live in ingest-core; heartbeat "yc_ingest" + Sentry here;
// FAIL-OPEN — main() always exits 0 so a YC hiccup can never block the daily send.
//
// Kill switch: set YC_INGEST=0 to skip entirely. Node 22+ global fetch.

import "./lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import { fetchHiring, resolveCompanies, isIndiaRegion } from "./ingest-core.mjs";
import { YcCompany } from "./lib/schemas/yc-companies.mjs";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs";

const FEED_TIMEOUT_MS = Number(process.env.YC_FEED_TIMEOUT_MS || 20000);
const RESOLVE_CONCURRENCY = Number(process.env.YC_RESOLVE_CONCURRENCY || 10);

async function main() {
  if (process.env.YC_INGEST === "0") {
    console.log("yc-ingest: disabled (YC_INGEST=0), skipping");
    return;
  }

  let raw;
  try {
    raw = await fetchHiring(FEED_TIMEOUT_MS);
  } catch (err) {
    // Feed unreachable is non-fatal: keep any prior watchlist-yc.json, report, exit clean.
    console.error(`yc-ingest: could not fetch YC hiring feed: ${err.message}`);
    captureError(err, { service: "yc-ingest", kind: "feed-fetch" });
    return;
  }

  // Boundary validation: skip malformed items; exclude India-region (india-ingest owns them).
  const companies = [];
  let malformed = 0;
  for (const item of raw) {
    const parsed = YcCompany.safeParse(item);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    if (parsed.data.website && !isIndiaRegion(parsed.data.regions)) companies.push(parsed.data);
  }
  console.log(`yc-ingest: ${raw.length} feed items, ${companies.length} non-India with a website, ${malformed} malformed (skipped)`);

  await resolveCompanies({
    companies,
    segment: "yc",
    outFile: "watchlist-yc.json",
    queueFile: "resolve-queue.json",
    heartbeat: "yc_ingest",
    concurrency: RESOLVE_CONCURRENCY,
    label: "yc-ingest",
  });
}

initSentry({ name: "yc-ingest" });
main()
  .catch(async (e) => {
    // Fatal but FAIL-OPEN: report, then exit 0 so the daily send chain is never blocked.
    console.error(`yc-ingest: fatal (non-blocking): ${e.message}`);
    captureError(e, { service: "yc-ingest", kind: "fatal" });
    await flushSentry();
  })
  .finally(() => process.exit(0));
