// discover-companies.mjs — company discovery by ATS slug-probe.
//
//   node discover-companies.mjs
//
// Generates OUR OWN watchlist by probing a license-clean company list (yc-oss/api, a
// public mirror of YC's own company facts) against the exact public ATS endpoints the
// scanner already calls. For each company we derive candidate slugs (YC slug, website
// domain label, name) and probe the 5 ATSes; any board that returns a valid jobs array
// with >=1 posting is a confirmed hit. This sidesteps the CC-BY-NC license on ready-made
// slug dumps — the list is ours, built from facts + our own probes.
//
// Output: merges confirmed {company, slug, source} into watchlist.json (the scanner's
// input, unchanged), backing up the prior file to watchlist.pre-discovery.json. Also writes
// discovered.json for review. Both are local outputs and are not committed.

import "./lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WATCHLIST = join(here, "watchlist.json");
const DISCOVERED = join(here, "discovered.json");
const BACKUP = join(here, "watchlist.pre-discovery.json");

const YC_URL = "https://yc-oss.github.io/api/companies/all.json";
const CONCURRENCY = 25;
const TIMEOUT_MS = 6000;
const MAX_CANDIDATES = 4;

const SOURCES = ["ashby", "greenhouse", "lever", "smartrecruiters", "recruitee", "workable"];
const ENDPOINT = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=true`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=100`,
  recruitee: (s) => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}?details=true`,
};
const JOBS_KEY = {
  ashby: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  greenhouse: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  lever: (d) => (Array.isArray(d) ? d : null),
  smartrecruiters: (d) => (Array.isArray(d?.content) ? d.content : null),
  recruitee: (d) => (Array.isArray(d?.offers) ? d.offers : null),
  workable: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
};

// generic words that would cause false-positive board matches — never probe these as slugs
const STOP = new Set("app apps jobs job careers career home get the and for inc llc labs co com io ai hq go team work hire hiring tech data cloud api dev www".split(" "));

function candidates(co) {
  const out = [];
  const add = (s) => {
    s = String(s || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
    if (s && s.length >= 3 && !STOP.has(s) && !out.includes(s)) out.push(s);
  };
  add(co.slug);
  try {
    const host = new URL(co.website).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    add(label);
    add(label.replace(/^(get|join|try|use|go|the)/, "")); // getlago -> lago
  } catch { /* bad url */ }
  add(String(co.name || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  return out.slice(0, MAX_CANDIDATES);
}

async function fetchJSON(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Probe one slug across all 5 ATSes in parallel. Returns the best hit {source, jobCount} or null.
async function probeSlug(slug) {
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const data = await fetchJSON(ENDPOINT[source](slug));
      if (!data) return null;
      const jobs = JOBS_KEY[source](data);
      return jobs && jobs.length >= 1 ? { source, jobCount: jobs.length } : null;
    }),
  );
  const hits = results.filter(Boolean).sort((a, b) => b.jobCount - a.jobCount);
  return hits[0] ?? null;
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const tick = () => { done++; if (done % 250 === 0) console.error(`  …probed ${done}/${items.length}`); };
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
      tick();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function main() {
  // Curated non-YC seed (license-clean facts: name + website), probed the same way as YC.
  const SEED = join(here, "seed-companies.json");
  const seed = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")).filter((c) => c.website) : [];
  let pool;
  if (process.env.SEED_ONLY) {
    pool = seed;
    console.error(`SEED_ONLY: probing ${pool.length} non-YC seed companies across ${SOURCES.length} ATSes…`);
  } else {
    console.error("fetching yc-oss company list…");
    const all = await fetchJSON(YC_URL);
    if (!Array.isArray(all)) { console.error("could not load yc list"); process.exit(1); }
    const active = all.filter((c) => c.website && c.status !== "Inactive" && c.status !== "Dead");
    pool = [...active, ...seed];
    console.error(`probing ${pool.length} companies (${active.length} active YC + ${seed.length} seed) across ${SOURCES.length} ATSes…`);
  }

  const found = await mapWithConcurrency(pool, CONCURRENCY, async (co) => {
    for (const slug of candidates(co)) {
      const hit = await probeSlug(slug);
      if (hit) return { company: co.name, slug, source: hit.source, jobCount: hit.jobCount };
    }
    return null;
  });

  const discovered = found.filter(Boolean);
  writeFileSync(DISCOVERED, JSON.stringify(discovered, null, 2) + "\n");

  // merge into the existing watchlist, dedup by `${source}:${slug}`
  const existing = existsSync(WATCHLIST) ? JSON.parse(readFileSync(WATCHLIST, "utf8")) : [];
  writeFileSync(BACKUP, JSON.stringify(existing, null, 2) + "\n");
  const seen = new Set(existing.map((e) => `${e.source}:${e.slug}`));
  let added = 0;
  const merged = [...existing];
  for (const d of discovered) {
    const key = `${d.source}:${d.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ company: d.company, slug: d.slug, source: d.source });
    added++;
  }
  merged.sort((a, b) => String(a.company).localeCompare(String(b.company)));
  writeFileSync(WATCHLIST, JSON.stringify(merged, null, 2) + "\n");

  // report
  const bySource = {};
  for (const d of discovered) bySource[d.source] = (bySource[d.source] || 0) + 1;
  const jobsSum = discovered.reduce((n, d) => n + d.jobCount, 0);
  console.error("\n— discovery —");
  console.error(`companies probed:     ${pool.length}`);
  console.error(`confirmed boards:     ${discovered.length}  (hit rate ${(100 * discovered.length / pool.length).toFixed(1)}%)`);
  console.error(`  by source:          ${JSON.stringify(bySource)}`);
  console.error(`postings on hits:     ${jobsSum}  (all roles, pre-filter)`);
  console.error(`new entries added:    ${added}`);
  console.error(`watchlist: ${existing.length} -> ${merged.length}  (backup: watchlist.pre-discovery.json)`);
}

main();
