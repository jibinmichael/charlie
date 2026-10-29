// ingest-core.mjs — shared machinery for segment ingestion jobs (yc-ingest, india-ingest).
//
// One place for the discipline every segment ingester must share: resolve each company to a live
// ATS board (verified, via resolve-ats.mjs), dedupe against the base watchlist, write a segment
// watchlist file + an unresolved queue, ping a heartbeat. Callers differ only in WHICH companies
// they feed in and which segment tag/output files they use.
//
// Shared discipline baked in here so no ingester can forget it: per-record try/catch (one bad
// company never aborts the batch), pre-skip of already-covered companies (polite probing),
// positive-confirmation acceptance (resolve-ats only returns live boards), never-drop (unresolved
// go to a queue). Node 22+ global fetch.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAts, candidateSlugs } from "./resolve-ats.mjs";
import { pingHeartbeat } from "./lib/heartbeat.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = join(here, "watchlist.json");
const HIRING_URL = "https://yc-oss.github.io/api/companies/hiring.json";

// yc-oss region strings that mean "hiring in India". South Asia is included because the feed tags
// several India-HQ companies that way; both roll up to the india segment for coverage attribution.
const INDIA_REGIONS = /^(india|south asia)$/i;

/** True if a company's `regions` array marks it as hiring in India. @param {string[]|undefined} regions */
export function isIndiaRegion(regions) {
  return Array.isArray(regions) && regions.some((r) => INDIA_REGIONS.test(String(r || "").trim()));
}

/** Run an async worker over items with a small fixed concurrency (politeness cap). Order-agnostic. */
export async function runPool(items, limit, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// Read watchlist.json and return { keys, slugs } already scanned:
//   keys  = `source:slug` set — post-resolve dedupe so an ingester never re-adds an existing board.
//   slugs = bare slug set — PRE-probe skip: if any candidate slug is already covered, don't probe
//           (discover-companies.mjs already swept most of yc-oss in; keeps the daily run light).
export function existingBoards() {
  const keys = new Set();
  const slugs = new Set();
  try {
    const base = JSON.parse(readFileSync(WATCHLIST_PATH, "utf8"));
    if (Array.isArray(base)) {
      for (const e of base) {
        if (e?.slug) slugs.add(String(e.slug).toLowerCase());
        if (e?.source && e?.slug) keys.add(`${String(e.source).toLowerCase()}:${e.slug}`);
      }
    }
  } catch {
    // no base watchlist readable -> treat everything as new (still deduped within the run below)
  }
  return { keys, slugs };
}

/** Fetch the public yc-oss hiring feed (array of company objects). Throws on any failure. */
export async function fetchHiring(timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(HIRING_URL, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("hiring feed is not an array");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a list of companies to live ATS boards, dedupe against the base watchlist + within the
 * run, and persist the segment watchlist file + unresolved queue. Pings the heartbeat at the end.
 * @param {object} o
 * @param {{name?:string,website?:string,slug?:string}[]} o.companies  companies to resolve.
 * @param {string} o.segment    provenance tag written on each resolved entry (e.g. "yc", "india").
 * @param {string} o.outFile    basename for the resolved segment watchlist (e.g. "watchlist-yc.json").
 * @param {string} o.queueFile  basename for the unresolved queue (e.g. "resolve-queue.json").
 * @param {string} [o.heartbeat] heartbeat job name to ping on a clean finish (optional).
 * @param {number} [o.concurrency] parallel resolve workers (default 10).
 * @param {string} [o.label]     log prefix (default = segment).
 * @returns {Promise<{resolved:number,alreadyCovered:number,unresolved:number,bySource:object}>}
 */
export async function resolveCompanies({ companies, segment, outFile, queueFile, heartbeat, concurrency = 10, label = segment }) {
  const { keys: existing, slugs: existingSlugs } = existingBoards();
  const seen = new Set(); // dedupe within this run by source:slug
  const resolved = [];
  const unresolved = [];
  let done = 0;
  let alreadyCovered = 0;

  await runPool(companies, concurrency, async (c) => {
    try {
      // Pre-skip: if any candidate slug already names a scanned board, this company is covered —
      // don't spend probe requests on it (keeps the daily run cheap; ATS endpoints stay polite).
      if (candidateSlugs({ slug: c.slug, website: c.website, name: c.name }).some((s) => existingSlugs.has(s))) {
        alreadyCovered++;
        return;
      }
      const hit = await resolveAts({ website: c.website, slug: c.slug, name: c.name });
      if (!hit) {
        unresolved.push({ company: c.name, website: c.website, slug: c.slug ?? null, reason: "no live ATS board found" });
        return;
      }
      const key = `${hit.source}:${hit.slug}`;
      if (existing.has(key) || seen.has(key)) return; // already scanned via base list or earlier in this run
      seen.add(key);
      // keka rows carry the tenant GUID as `identifier`; scan-jobs.mjs cannot build the feed URL
      // without it, so a keka row that loses it here is a row that silently never scans.
      resolved.push({ company: c.name, slug: hit.slug, source: hit.source, segment, ...(hit.identifier ? { identifier: hit.identifier } : {}) });
    } catch (err) {
      // one bad company never aborts the batch
      unresolved.push({ company: c.name, website: c.website, slug: c.slug ?? null, reason: `error: ${err.message}` });
    } finally {
      done++;
      if (done % 250 === 0) console.log(`${label}: processed ${done}/${companies.length} (${resolved.length} new, ${alreadyCovered} already covered)...`);
    }
  });

  resolved.sort((a, b) => a.company.localeCompare(b.company));
  writeFileSync(join(here, outFile), JSON.stringify(resolved, null, 2) + "\n");
  writeFileSync(join(here, queueFile), JSON.stringify(unresolved, null, 2) + "\n");

  const bySource = {};
  for (const e of resolved) bySource[e.source] = (bySource[e.source] || 0) + 1;
  console.log(`${label}: ${segment} segment = ${resolved.length} NEW live boards (${alreadyCovered} already covered by watchlist.json, ${unresolved.length} unresolvable) -> ${outFile}`);
  console.log(`${label}: by source ${JSON.stringify(bySource)}`);
  console.log(`${label}: ${unresolved.length} unresolved -> ${queueFile}`);

  if (heartbeat) await pingHeartbeat(heartbeat);
  return { resolved: resolved.length, alreadyCovered, unresolved: unresolved.length, bySource };
}
