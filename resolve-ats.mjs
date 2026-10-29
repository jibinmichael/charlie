// resolve-ats.mjs — turn a company (slug/website/name) into its live ATS board {source, slug}.
//
//   import { resolveAts } from "./resolve-ats.mjs";
//   const hit = await resolveAts({ name: "Acme", website: "https://acme.com", slug: "acme" });
//   // -> { source: "greenhouse", slug: "acme" } | null   (also accepts a bare website string)
//
// APPROACH — combined + VERIFIED. Two ways to get candidate slugs, one acceptance rule:
//   1. facts probe: derive candidate slugs from the company's own facts (YC slug, website domain
//      label, name) and probe the keyless ATS endpoints.
//   2. careers mine: if (1) finds nothing, fetch the company's careers page and read ATS board
//      hosts out of the HTML — this recovers the EXACT slug (e.g. "9-mothers", "paradigmai") that
//      slug-guessing can't reconstruct.
// Every candidate from either source is ACCEPTED ONLY IF probing its endpoint returns >= 1 live
// posting. Positive confirmation is the single gate, so a resolved {source, slug} is always a
// live, scannable board — zero false positives, whichever way the candidate was found.
//
// Why both: facts-probe alone resolves few net-new companies (most keyless-reachable YC companies are
// already on watchlist.json via discover-companies.mjs); careers-mine reads exact slugs facts-probe
// can't guess. Accepting scraped slugs WITHOUT probing emits false positives (404 "boards"); the probe
// is what keeps every result real.
//
// Sources probed (keyless/public, already wired in scan-jobs.mjs's ENDPOINT map):
//   ashby · greenhouse · lever · smartrecruiters · recruitee · workable · kula
// keka is deliberately NOT here: it needs the tenant-GUID careers-shell handshake (scripts/
// discover-keka.mjs), which a bare slug probe can't do. kula is slug-only, so it belongs here.
// (Workday hosts are recognized in careers HTML but NOT probed — no keyless list endpoint; they
//  need the dedicated Workday reader, so they are ignored here rather than emitted unverified.)
//
// Politeness + fail-closed: bounded timeouts, every fetch failure caught, candidate/path counts
// capped, no retry on the careers fetch. Unresolvable -> null (caller queues it, never drops it).

const PROBE_TIMEOUT_MS = Number(process.env.RESOLVE_ATS_TIMEOUT_MS || 8000);
const HTML_TIMEOUT_MS = Number(process.env.RESOLVE_ATS_HTML_TIMEOUT_MS || 8000);
const MAX_CANDIDATES = Number(process.env.RESOLVE_ATS_MAX_CANDIDATES || 4);

// Keyless ATS endpoints + how to find the jobs array in each response. Byte-identical to
// scan-jobs.mjs / discover-companies.mjs so a resolved slug scans with zero translation.
const ENDPOINT = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=true`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=100`,
  recruitee: (s) => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}?details=true`,
  // Kula is slug-only (accountName=<slug>), so unlike keka it needs no GUID handshake and drops
  // straight into the verified probe. India-native, so india-ingest can see kula boards.
  kula: (s) => `https://careers.kula.ai/api/internal/ats_job_posts?accountName=${encodeURIComponent(s)}&page=1&items=99&type=ats_job_post.index`,
};
const JOBS_KEY = {
  ashby: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  greenhouse: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  lever: (d) => (Array.isArray(d) ? d : null),
  smartrecruiters: (d) => (Array.isArray(d?.content) ? d.content : null),
  recruitee: (d) => (Array.isArray(d?.offers) ? d.offers : null),
  workable: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  // Skip internal-only / unlisted drafts — byte-identical to scan-jobs.mjs so a resolved slug scans.
  kula: (d) => (Array.isArray(d?.data) ? d.data.filter((j) => j && j.listed !== false && j.kind !== "internal") : null),
};
const SOURCES = Object.keys(ENDPOINT);

// Generic words that would cause false-positive board matches — never probe these as slugs.
const STOP = new Set(
  "app apps jobs job careers career home get the and for inc llc labs co com io ai hq go team work hire hiring tech data cloud api dev www embed job_board en".split(" "),
);

// Careers-page paths to try (careers-mine). Kept short — this only runs for companies facts-probe
// missed, and each path is a real fetch. Homepage last (some link the board from the root).
const CAREERS_PATHS = ["/careers", "/jobs", "/join", "/"];

// ATS host patterns for careers-mine. Each capture group is the slug as the ENDPOINT expects it.
const HOST_PATTERNS = [
  { source: "greenhouse", re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/gi },
  { source: "lever", re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/gi },
  { source: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/gi },
  { source: "recruitee", re: /(?:https?:)?\/\/([a-z0-9-]+)\.recruitee\.com/gi },
  { source: "smartrecruiters", re: /(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/gi },
];

/**
 * Derive candidate ATS slugs from a company's own facts (YC slug, website domain label, name).
 * @param {{ slug?: string, website?: string, name?: string }} company
 * @returns {string[]}  up to MAX_CANDIDATES normalized, deduped, non-generic candidate slugs.
 */
export function candidateSlugs(company) {
  const out = [];
  const add = (s) => {
    s = String(s || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
    if (s && s.length >= 3 && !STOP.has(s) && !out.includes(s)) out.push(s);
  };
  add(company?.slug);
  try {
    const host = new URL(company.website).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    add(label);
    add(label.replace(/^(get|join|try|use|go|the)/, "")); // getlago -> lago
  } catch {
    /* no/invalid website */
  }
  add(String(company?.name || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * Pull {source, slug} candidates out of careers-page HTML (deduped, generic slugs dropped).
 * @param {string} html
 * @returns {{ source: string, slug: string }[]}
 */
export function extractHostSlugs(html) {
  const text = String(html || "");
  const out = [];
  const seen = new Set();
  for (const { source, re } of HOST_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const slug = (m[1] || "").trim();
      const key = `${source}:${slug}`;
      if (!slug || STOP.has(slug.toLowerCase()) || seen.has(key)) continue;
      seen.add(key);
      out.push({ source, slug });
    }
  }
  return out;
}

// Fetch one ATS endpoint as JSON with a bounded timeout. Any failure -> null (treated as no board).
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Is this a live board? (source+slug returns >= 1 posting). The single acceptance gate.
async function boardIsLive(source, slug) {
  const data = await fetchJson(ENDPOINT[source](slug));
  if (!data) return false;
  const jobs = JOBS_KEY[source](data);
  return !!(jobs && jobs.length >= 1);
}

// ── Keka: the two-step probe every other source doesn't need ─────────────────
// Keka's jobs feed is addressed by tenant GUID, not by slug, so a bare slug probe structurally
// cannot see it — which is why keka sits outside ENDPOINT above despite being a large India source.
// Without this step an Indian company on Keka would resolve to NOTHING and be queued as "no live ATS
// board found", indistinguishable from a company with no board at all.
//
// The handshake: fetch the careers
// shell, read the GUID the page embeds in its own asset paths, then confirm the feed returns
// postings. Same acceptance bar as every other source — >= 1 live posting, never an unverified slug.
//
// Two requests instead of one, so it runs ONLY after the cheap single-GET sources all miss.
const KEKA_GUID = /\/ats\/documents\/([a-f0-9-]{36})\//i;
async function probeKeka(slug) {
  const shell = await fetchHtml(`https://${encodeURIComponent(slug)}.keka.com/careers`);
  const guid = shell && KEKA_GUID.exec(shell)?.[1];
  if (!guid) return null;
  const data = await fetchJson(`https://${encodeURIComponent(slug)}.keka.com/careers/api/embedjobs/default/active/${encodeURIComponent(guid)}`);
  const jobs = Array.isArray(data) ? data : null; // the active-jobs feed is a top-level array
  // `identifier` is the GUID scan-jobs.mjs needs to build the same URL later. A keka row without it
  // is a row that can never be scanned, so it rides on the hit rather than being rediscovered.
  return jobs && jobs.length >= 1 ? { source: "keka", slug, identifier: guid, jobCount: jobs.length } : null;
}

// Probe one slug across all sources in parallel. Returns the hit with the most postings, or null.
async function probeSlug(slug) {
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const data = await fetchJson(ENDPOINT[source](slug));
      if (!data) return null;
      const jobs = JOBS_KEY[source](data);
      return jobs && jobs.length >= 1 ? { source, slug, jobCount: jobs.length } : null;
    }),
  );
  const hits = results.filter(Boolean).sort((a, b) => b.jobCount - a.jobCount);
  if (hits.length) return hits[0];
  // Only now spend the extra round trip. A single-GET source winning is the common case and its
  // cost is unchanged; keka is asked exactly when the answer would otherwise have been "nothing".
  return probeKeka(slug);
}

// Fetch one careers-page URL as HTML (single attempt, bounded). Returns final-URL + body, or "".
async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = res.url || url; // a redirect can land ON the board host itself
    if (!res.ok) return finalUrl;
    return `${finalUrl}\n${await res.text()}`;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// careers-mine: read ATS hosts out of the careers pages, probe-confirm each. First live board wins.
async function resolveViaCareers(website) {
  let base;
  try {
    let u = String(website || "").trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    const parsed = new URL(u);
    base = `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
  const tried = new Set();
  for (const path of CAREERS_PATHS) {
    const html = await fetchHtml(`${base}${path}`);
    if (!html) continue;
    for (const { source, slug } of extractHostSlugs(html)) {
      const key = `${source}:${slug}`;
      if (tried.has(key)) continue;
      tried.add(key);
      if (await boardIsLive(source, slug)) return { source, slug };
    }
  }
  return null;
}

/**
 * Resolve a company to its live ATS board, verified by probe (>=1 posting).
 * @param {{ slug?: string, website?: string, name?: string } | string} company
 *   a company object, or a bare website string (the `resolveAts(websiteUrl)` shape).
 * @returns {Promise<{ source: string, slug: string } | null>}  a CONFIRMED board, or null.
 */
export async function resolveAts(company) {
  const co = typeof company === "string" ? { website: company } : company || {};
  // 1. facts probe — cheap, catches the common case.
  for (const slug of candidateSlugs(co)) {
    const hit = await probeSlug(slug);
    // `identifier` only exists for keka (its tenant GUID). Spread conditionally so every other
    // source returns exactly { source, slug } — the resolve-ats tests assert exact objects.
    if (hit) return { source: hit.source, slug: hit.slug, ...(hit.identifier ? { identifier: hit.identifier } : {}) };
  }
  // 2. careers mine — recovers exact slugs facts-probe can't guess.
  if (co.website) {
    const hit = await resolveViaCareers(co.website);
    if (hit) return hit;
  }
  return null;
}
