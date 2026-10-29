// india-ingest.mjs — daily: grow Charlie's India coverage into a tracked segment.
//
//   node india-ingest.mjs
//
// Two inputs, one resolver:
//   1. yc-oss hiring.json filtered to regions India / South Asia (rides the feed yc-ingest fetches),
//   2. a CURATED VC-portfolio seed list at data/india-seed.json ({name, website, slug?}).
// Each company -> resolveAts (combined+verified) -> {segment:"india"} -> watchlist-india.json, a
// SEPARATE file scan-jobs.mjs loads alongside watchlist.json. Rides the existing Keka/Kula/big-3
// readers — zero new ingestion code. Unresolved -> resolve-queue-india.json (never dropped).
//
// SCOPE: YC-India alone is small (~50 companies, most already covered), so most India breadth comes
// from the curated list in data/india-seed.json, which needs no code change to grow. Many India
// startups use ATSes Charlie doesn't read (Darwinbox is excluded by design; Freshteam/Zoho
// unsupported), which caps keyless resolution.
//
// Discipline: both inputs pass through Zod (validated at the boundary); per-record isolation +
// never-drop live in ingest-core; heartbeat "india_ingest" + Sentry here; FAIL-OPEN — main() always
// exits 0 so an India-feed hiccup can never block the daily send.
//
// Kill switch: set INDIA_INGEST=0 to skip entirely. Node 22+ global fetch.

import "./lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHiring, resolveCompanies, isIndiaRegion } from "./ingest-core.mjs";
import { YcCompany } from "./lib/schemas/yc-companies.mjs";
import { IndiaSeed } from "./lib/schemas/india-seed.mjs";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(here, "data", "india-seed.json");

const FEED_TIMEOUT_MS = Number(process.env.INDIA_FEED_TIMEOUT_MS || 20000);
const RESOLVE_CONCURRENCY = Number(process.env.INDIA_RESOLVE_CONCURRENCY || 10);

// Read + validate the curated seed list. Missing/malformed file is non-fatal (just no seed rows).
function readSeed() {
  if (!existsSync(SEED_PATH)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  } catch (err) {
    console.error(`india-ingest: could not parse data/india-seed.json (skipping seed): ${err.message}`);
    return [];
  }
  const parsed = IndiaSeed.safeParse(raw);
  if (!parsed.success) {
    console.error(`india-ingest: data/india-seed.json failed validation (skipping seed): ${parsed.error.issues.map((i) => i.message).slice(0, 3).join("; ")}`);
    return [];
  }
  return parsed.data;
}

async function main() {
  if (process.env.INDIA_INGEST === "0") {
    console.log("india-ingest: disabled (INDIA_INGEST=0), skipping");
    return;
  }

  // Source 1: yc-oss hiring feed, filtered to India-region. Feed failure is non-fatal — fall back
  // to the curated seed alone rather than aborting.
  let ycIndia = [];
  try {
    const raw = await fetchHiring(FEED_TIMEOUT_MS);
    let malformed = 0;
    for (const item of raw) {
      const parsed = YcCompany.safeParse(item);
      if (!parsed.success) {
        malformed++;
        continue;
      }
      if (parsed.data.website && isIndiaRegion(parsed.data.regions)) ycIndia.push(parsed.data);
    }
    console.log(`india-ingest: ${ycIndia.length} India-region YC companies with a website (${malformed} malformed skipped)`);
  } catch (err) {
    console.error(`india-ingest: could not fetch YC hiring feed (using seed only): ${err.message}`);
    captureError(err, { service: "india-ingest", kind: "feed-fetch" });
  }

  // Source 2: the curated VC-portfolio seed list.
  const seed = readSeed();
  console.log(`india-ingest: ${seed.length} curated seed companies`);

  // Merge (dedupe by website so a seed company already in the YC-India set isn't probed twice).
  const byWebsite = new Map();
  for (const c of [...ycIndia, ...seed]) {
    const key = String(c.website || "").trim().toLowerCase().replace(/\/+$/, "");
    if (key && !byWebsite.has(key)) byWebsite.set(key, c);
  }
  const companies = [...byWebsite.values()];

  if (companies.length === 0) {
    console.log("india-ingest: no India companies to resolve (empty feed + empty seed); nothing to do");
    return;
  }

  await resolveCompanies({
    companies,
    segment: "india",
    outFile: "watchlist-india.json",
    queueFile: "resolve-queue-india.json",
    heartbeat: "india_ingest",
    concurrency: RESOLVE_CONCURRENCY,
    label: "india-ingest",
  });
}

initSentry({ name: "india-ingest" });
main()
  .catch(async (e) => {
    // Fatal but FAIL-OPEN: report, then exit 0 so the daily send chain is never blocked.
    console.error(`india-ingest: fatal (non-blocking): ${e.message}`);
    captureError(e, { service: "india-ingest", kind: "fatal" });
    await flushSentry();
  })
  .finally(() => process.exit(0));
