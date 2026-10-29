// scan-jobs.mjs — Charlie's job scanner (sourcing + freshness), multi-ATS.
//
//   node scan-jobs.mjs
//
// Reads watchlist.json, fetches each company's public job board from whichever ATS
// its "source" field names, normalizes every posting into ONE canonical shape,
// applies a freshness layer (posted-date cutoff + a disappearance test against a
// local seen-store), optionally filters to design/product roles, dedupes, and
// writes only fresh, open roles to jobs.json. No auth, no matching, no scoring.
//
// Wired sources (all public, no auth):
//   ashby          https://api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true
//   greenhouse     https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true
//   lever          https://api.lever.co/v0/postings/<slug>?mode=json
//   smartrecruiters https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=100
//   recruitee      https://<slug>.recruitee.com/api/offers/
//   kula           https://careers.kula.ai/api/internal/ats_job_posts?accountName=<slug>&...
//   workable       https://apply.workable.com/api/v1/widget/accounts/<slug>?details=true
// Workable's host may answer 429 to the scan's egress. A 429 is retried and counted separately as
// `rateLimited` (never as `notfound`), so a throttled source is visible in scan-health.json rather
// than reading as an empty board.
//
// Kula is an India-heavy ATS; its career-site feed is public/no-auth. The <slug> is the
// account name in the careers.kula.ai/<slug> URL. Its listing feed exposes no posted date,
// so Kula jobs carry posted_at=null (flagged unknown) and rely on the disappearance test
// for freshness. The feed is fetched one page deep (items=99): a company with >99 open
// roles would be truncated, which is fine for the startups currently on it.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBoardJobs } from "./scan-boards.mjs";
import { loadEnv, saveJobPool, saveJobPoolStats, loadJobPoolStats, saveJobPoolFeed, saveCompanySnapshot, getPreviousCompanyCounts, saveScanHealth, saveJobEmbeddings, loadJobEmbeddings, saveSeenJobs, loadSeenJobs } from "./charlie-store.mjs";
import { embedTexts, semanticEnabled, packInt8Vectors, unpackInt8Vectors } from "./lib/voyage.mjs";
import { summarizeScanHealth } from "./scan-health.mjs"; // tell an empty board from a board that stopped talking
import { countByCompany } from "./role-intel.mjs";
import { ATS_JOB_SCHEMAS, ATS_DETAIL_SCHEMAS } from "./lib/schemas/ats-jobs.mjs"; // boundary validation for raw ATS items + the SmartRecruiters detail document
import { pingHeartbeat } from "./lib/heartbeat.mjs"; // best-effort cron heartbeat (never fails the job)
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)
import { capKeepingRequirements, extractNiceToHave } from "./lib/jd-requirements.mjs";
import { shadowReport, logShadowReport, reachMode } from "./lib/market-reach.mjs"; // what share of the scan can any market we serve actually take

// Coarse function bucket from a job title, for the landing's "by role" breakdown. Order
// matters: check Design before Product (so "product designer" -> Design), Product before
// Engineering (so "product manager" -> Product, "software engineer" -> Engineering).
function roleFunction(title) {
  const t = String(title || "").toLowerCase();
  if (/\b(ux|ui)\b|design/.test(t)) return "Design";
  if (/data|machine learning|\bml\b|analyst|analytics|scientist/.test(t)) return "Data";
  if (/product manager|product owner|\bpm\b|head of product|product lead/.test(t)) return "Product";
  if (/engineer|developer|\bswe\b|devops|\bsre\b|backend|frontend|full.?stack|software|infrastructure|platform|security/.test(t)) return "Engineering";
  if (/sales|account executive|account manager|business development|\bbdr\b|\bsdr\b|revenue/.test(t)) return "Sales";
  if (/marketing|growth|content|\bseo\b|brand|community/.test(t)) return "Marketing";
  if (/finance|account(ant|ing)|controller|fp&a/.test(t)) return "Finance";
  if (/operations|\bops\b|recruit|people|talent|\bhr\b|support|customer success|success manager/.test(t)) return "Operations";
  return "Other";
}

// Role-agnostic by default: the scan keeps EVERY role type, because Charlie serves any
// role, and relevance is decided per-user at match time against each person's dossier (not by
// a global title gate). Set CHARLIE_ROLE_FILTER=1 to re-enable the legacy design/product title
// pass (kept only as a reversible escape hatch). NOTE: a wider, role-agnostic pool only pays
// off once a per-user pre-filter chooses the relevant slice before the maxJobsPerUser cap.
const ROLE_FILTER = process.env.CHARLIE_ROLE_FILTER === "1";

// Freshness cutoff: drop postings older than this many days (by posted_at).
const MAX_AGE_DAYS = 45;
// V8 caps a single string at 536,870,888 characters, and jobs.json is written (and read back by
// scheduler.mjs) as exactly one. Not a tuning knob — a hard runtime limit. See serializeJobsFile.
const MAX_JSON_STRING = 536_870_888;
// Same cap and same instrument the pool blob uses (charlie-store saveJobPool). Env-overridable
// because the ONE lever that keeps this file under the ceiling should not need a deploy.
const JOBS_DESC_CAP = Number(process.env.JOBS_DESC_CAP || 2500);

// Fetch many boards at once (hundreds of companies), but stay polite.
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 12000;
// A 429/503 is the host saying "come back slower", not "no such board". Retrying is the HTTP
// contract; recording a 429 as `notfound` would make a live source read as empty behind a green
// scan. Bounded on purpose — 3 retries over ~8s worst case per board, and only rate-limit statuses
// retry, so a genuine 404 still costs exactly one request.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 1200;
// Cap for OUR OWN blind backoff only — the wait we invent when the host names no Retry-After.
// An explicit Retry-After is honoured up to the budget below, never clamped to this.
const RATE_LIMIT_MAX_WAIT_MS = 8000;
// Total time one board may spend waiting out a throttle, across every retry.
//
// WHY NOT CLAMP. Clamping an explicit `Retry-After` to 8s does not protect the scan, it guarantees the
// retries are wasted: a host that says "come back in 60s" is knocked on again at 8s, 8s and 8s,
// answers 429 every time, and the board is written off without ever waiting the time it asked for.
// Honouring the ask up to a budget keeps the original protection (no board can stall the scan) while
// making compliance possible at all. 90s is one board's worst case out of a ~1,300-board run.
const RATE_LIMIT_BUDGET_MS = 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const here = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = join(here, "watchlist.json");
// Segment feeds appended by ingestion jobs (yc-ingest.mjs) and merged onto the curated watchlist
// at load. These are runtime-derived (re-generated each cron run), not committed to the repo.
// watchlist-workday.json is CURATED and hand-verified, unlike the yc/india feeds which their
// ingesters regenerate every run. It lives in its own file for exactly that reason: discover-
// companies.mjs rewrites watchlist.json, and a Workday entry carries two fields (dc, site) that no
// existing resolver knows how to reproduce, so it must never be at the mercy of a regeneration.
const WATCHLIST_SEGMENT_PATHS = [join(here, "watchlist-yc.json"), join(here, "watchlist-india.json"), join(here, "watchlist-workday.json"), join(here, "watchlist-eightfold.json")];
const OUT_PATH = join(here, "jobs.json");
const SEEN_PATH = join(here, "seen-jobs.json"); // id -> { first_seen, last_seen, status, closed_at }

/**
 * Drop seen-store entries that can no longer change any answer. The store is append-only otherwise
 * and grows by megabytes; the `job-pool` bucket's practical object ceiling is ~50 MB, so an unpruned
 * store is a scheduled outage.
 *
 * ONLY two things are dropped, and both are provably inert:
 *   1. closed longer ago than MAX_AGE_DAYS — the pool itself drops anything that old, so the entry
 *      cannot affect a date, a count, or the disappearance test.
 *   2. not seen on any board for longer than MAX_AGE_DAYS — we have no evidence it still exists,
 *      and if it comes back it is genuinely new to us.
 *
 * An OPEN entry seen recently is never dropped whatever its age: `first_seen` is the only date an
 * undated posting has, and discarding it would silently re-date a long-lived role as brand new.
 * An entry with an unreadable/absent
 * timestamp is KEPT, not dropped: pruning on missing data is how a size guard becomes data loss.
 *
 * Pure + exported so the bound is testable without the store or a scan.
 */
export function pruneSeen(seen, { nowMs = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  const cutoff = nowMs - maxAgeDays * 86400000;
  const fresh = (iso) => {
    const t = Date.parse(iso || "");
    return !Number.isFinite(t) || t > cutoff; // unparseable -> treated as fresh, i.e. KEPT
  };
  const out = {};
  let dropped = 0;
  for (const [id, e] of Object.entries(seen || {})) {
    if (!e || typeof e !== "object") { dropped++; continue; }
    if (e.status === "closed" && !fresh(e.closed_at)) { dropped++; continue; }
    if (!fresh(e.last_seen)) { dropped++; continue; }
    out[id] = e;
  }
  return { seen: out, dropped };
}

// Every source with an ENDPOINT entry must be listed here, or its boards fetch and contribute
// roles while staying invisible in the funnel report (the stat increments are `if (stat[source])`).
const SOURCES = ["ashby", "greenhouse", "lever", "smartrecruiters", "recruitee", "kula", "workable", "keka", "workday", "amazon", "eightfold"];

// Titles we keep when ROLE_FILTER is on (loose first pass). "design" already
// covers product designer / design engineer; ux/ui use word boundaries.
const ROLE_PATTERNS = [/design/i, /founding/i, /product manager/i, /\bux\b/i, /\bui\b/i];

function matchesRole(title) {
  if (!title) return false;
  return ROLE_PATTERNS.some((re) => re.test(title));
}

// Age in days from an ISO posted_at. null if missing or unparseable (unknown).
function ageDays(postedAt, nowMs) {
  if (!postedAt) return null;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / (1000 * 60 * 60 * 24);
}

// Decode the HTML entities a board returns encoded (Greenhouse ships its job
// `content` as an escaped HTML string). &amp; last so we don't double-decode.
function decodeEntities(s) {
  if (!s || typeof s !== "string") return s;
  return s
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
}

// Minimal HTML -> plain text (no dependency). Good enough for a description preview.
function stripHtml(html) {
  if (!html || typeof html !== "string") return null;
  const text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

// Recruitee stamps dates as "YYYY-MM-DD HH:MM:SS UTC" — normalize to ISO.
function recruiteeDate(s) {
  if (!s || typeof s !== "string") return s ?? null;
  const m = s.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/);
  return m ? `${m[1]}T${m[2]}Z` : s;
}

// ── per-ATS endpoints + how to find the jobs array in each response ──────────
const ENDPOINT = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=true`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=100`,
  recruitee: (s) => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
  kula: (s) =>
    `https://careers.kula.ai/api/internal/ats_job_posts?accountName=${encodeURIComponent(s)}&page=1&items=99&type=ats_job_post.index`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}?details=true`,
  // Keka is India-native. Two keys: the subdomain <s>.keka.com and the tenant GUID (entry.identifier),
  // discovered once via the careers-shell handshake and stored on the watchlist entry.
  keka: (s, entry) => `https://${encodeURIComponent(s)}.keka.com/careers/api/embedjobs/default/active/${encodeURIComponent(entry?.identifier || "")}`,
  // Workday. THREE keys, not one: the tenant <s>, the datacenter <entry.dc> (wd1/wd3/wd5/...) and the
  // career-site slug <entry.site>. None is guessable — NVIDIA's site is "NVIDIAExternalCareerSite",
  // Salesforce's is "External_Career_Site" — but all three are discoverable without a browser, which
  // is why this source is reachable at all: the tenant host publishes its own site slug in
  // /robots.txt (`Allow: /NVIDIAExternalCareerSite/`), so the triple is read, never guessed.
  //
  // Unlike every sibling above this is a POST with a JSON body and it pages 20 at a time — both
  // handled in fetchBoard's workday branch, which is the only place in this file that deviates from
  // "one GET per board".
  workday: (s, entry) =>
    `https://${encodeURIComponent(s)}.${encodeURIComponent(entry?.dc || "wd1")}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(s)}/${encodeURIComponent(entry?.site || "External")}/jobs`,
  // Amazon. ONE employer behind a keyless GET, so unlike every sibling the slug is a constant and
  // the thing that varies is the market: `entry.market` carries an ISO-3166 alpha-3 code and the
  // amazon branch in fetchBoard walks AMAZON_MARKETS itself. `offset` is the third build() argument
  // — every other source ignores it, because they page in the body (workday) or not at all.
  //
  // The bracketed key is literal: `normalized_country_code[]`. The unbracketed spelling is accepted and then IGNORED, returning all 10,000 hits as
  // though no filter were applied.
  amazon: (s, entry, offset = 0) =>
    `https://www.amazon.jobs/en/search.json?${new URLSearchParams({
      "normalized_country_code[]": entry?.market || "USA",
      result_limit: String(AMAZON_PAGE),
      offset: String(offset),
      sort: "recent",
    })}`,
  // Eightfold is a PLATFORM: one deployment per employer, each on its own host with its own `domain`
  // query param, so an entry carries both (`host`, `domain`) the way Workday carries `dc`/`site`.
  // `num` is the page size; the list omits every description (see DETAIL_ENDPOINT below).
  eightfold: (s, entry, offset = 0) =>
    `https://${entry?.host || `${s}.eightfold.ai`}/api/apply/v2/jobs?${new URLSearchParams({
      domain: entry?.domain || "",
      start: String(offset),
      num: String(EIGHTFOLD_PAGE),
      query: "",
    })}`,
};
const JOBS_KEY = {
  ashby: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  greenhouse: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  lever: (d) => (Array.isArray(d) ? d : null),
  smartrecruiters: (d) => (Array.isArray(d?.content) ? d.content : null),
  recruitee: (d) => (Array.isArray(d?.offers) ? d.offers : null),
  // Only externally-visible, listed postings (skip internal-only and unlisted drafts).
  kula: (d) => (Array.isArray(d?.data) ? d.data.filter((j) => j && j.listed !== false && j.kind !== "internal") : null),
  workable: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  keka: (d) => (Array.isArray(d) ? d : null), // the active-jobs feed is a top-level JSON array
  workday: (d) => (Array.isArray(d?.jobPostings) ? d.jobPostings : null),
  amazon: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  eightfold: (d) => (Array.isArray(d?.positions) ? d.positions : null),
};

// Workday paging + politeness. `limit` above 20 makes Workday return an EMPTY jobPostings array with
// no error (verified against the live API), so 20 is a vendor ceiling, not a tuning knob — do not
// raise it. WORKDAY_MAX_PER_BOARD bounds a single board's contribution so one 18,000-role employer
// (CVS Health) cannot eat the whole nightly run; when it truncates, fetchBoard SAYS SO in the scan
// log rather than silently capping (no silent caps).
const WORKDAY_PAGE = 20;
const WORKDAY_MAX_PER_BOARD = Number(process.env.WORKDAY_MAX_PER_BOARD || 400);

// ── Amazon paging + markets ──────────────────────────────────────────────────
// `result_limit` above 100 makes amazon.jobs return an EMPTY jobs array with no error — a vendor
// ceiling, not a tuning knob, and the same silent-zero
// shape as WORKDAY_PAGE above. Do not raise it.
//
// ISO-3166 alpha-3, which is what this feed speaks. Amazon is a large source of India roles.
//
// GBR IS DELIBERATELY ABSENT. quality-gate.mjs has US_PLACE, INDIA, CA_PLACE and AU_PLACE and no UK
// equivalent, so `classifyPlace("London, England, GBR")` returns "other" while CAN and AUS return
// "ca" and "au". A UK role therefore cannot reach any user, and fetching them would be work whose
// output is provably unreachable. Add "GBR" here the same day a UK region lands in quality-gate.mjs.
//
// The per-market cap keeps one employer from eating the nightly run. It bounds IN-MARKET roles, and
// a truncated market SAYS SO in the log — never a silent cap.
const AMAZON_PAGE = 100;
const AMAZON_MARKETS = ["USA", "IND", "AUS", "CAN"];
const AMAZON_MAX_PER_MARKET = Number(process.env.AMAZON_MAX_PER_MARKET || 600);

// Eightfold pages via start/num. `num` is CAPPED AT 10 SERVER-SIDE — asking for 50 or 100 returns 10
// (verified against hsbc, count 1368). That matters more than it looks: the pager stops on a short
// page, so a PAGE constant of 100 would read the first 10 rows as "board exhausted" and silently
// take 10 roles from a 1,368-role board. Deep paging itself works (start=200 returns fresh rows).
//
// GEO NOTE: results are ordered by the REQUESTER's location. Probed from India the first pages are
// all India; from Railway's US egress they will be US-weighted. Paging deep is what makes the pull
// representative rather than local, which is the other reason the per-board cap is not tiny.
const EIGHTFOLD_PAGE = 10;
const EIGHTFOLD_MAX_PER_BOARD = Number(process.env.EIGHTFOLD_MAX_PER_BOARD || 300);

// ── Workday country filter ───────────────────────────────────────────────────
// Ask each board only for the countries Charlie actually serves, instead of pulling the world and
// throwing most of it away at the geo gate. This roughly halves the requests while letting more boards
// be covered in full, because the per-board cap bounds in-market roles rather than global ones.
// Every posting we do pull is in a market a real user can be in.
//
// The country list is exactly quality-gate.mjs's REGION_PLACE keys — india, us, ca, au. Adding a
// market means adding a pattern HERE and a REGION_PLACE entry THERE; neither alone is enough. The UK
// is deliberately absent: homeRegion() classifies a UK candidate as "other", so a UK role can never
// be reachable by anyone and pulling those roles would be pure waste.
const WORKDAY_MARKET_COUNTRY = {
  us: /^united states( of america)?$/i,
  in: /^india$/i,
  ca: /^canada$/i,
  au: /^australia$/i,
};

// Pull the country leaves out of a Workday facets tree, with the facet PARAMETER that owns each one.
// The parameter name is per-tenant and there are at least seven of them in the live watchlist
// (`locationCountry`, `Country`, `locations`, `Location_Country`, `locationHierarchy1`,
// `Country___Territory`, and one 70-character custom field), so it MUST be read from the response.
// Hardcoding any single name silently filters nothing on most boards — a fail-to-zero waiting to
// happen, which is why the tests assert against several real parameter names.
/**
 * The identity of a BOARD, for the watchlist dedupe: everything that changes the URL it is fetched
 * from. Pure and exported so the "two boards on one tenant are two boards" rule is a test rather
 * than a comment: a source:slug key would silently discard a board that shares a slug with an
 * already-seen one.
 *
 * Absent fields collapse to "", so for every source whose slug alone determines the endpoint this
 * is effectively source:slug.
 */
/**
 * Serialize the pool for jobs.json, with descriptions capped so the result cannot exceed the one
 * hard limit in this file that is not ours to raise.
 *
 * THE CLIFF. `JSON.stringify` builds ONE string, and V8 caps a string at 536,870,888 characters.
 * Uncapped and pretty-printed, a posting is ~7 KB, so the write throws `RangeError: Invalid string
 * length` at roughly 77,000 postings — a size a large watchlist reaches. `readFileSync` in
 * scheduler.mjs hits the identical ceiling on the way back.
 *
 * That failure is the worst shape this repo has: the write sits outside every try/catch, so the
 * RangeError reaches main().catch, exits 1, and engine:run's && chain drops scheduler, digest and
 * newsletter. A silent zero-email night reported as a crash nobody reads.
 *
 * THE CAP is the same instrument the pool blob already uses (charlie-store saveJobPool): 2,500
 * characters via capKeepingRequirements, which slides the window to keep the REQUIREMENTS section
 * rather than blindly head-slicing — that is what fit-coverage reads to build the readout. jobs.json
 * keeping more than the pool is not a guarantee; surviving the write is.
 *
 * Deliberately NOT wrapped in a try/catch: if this cannot be written the send SHOULD stop. The fix
 * is to not reach the ceiling, not to swallow hitting it.
 */
export function serializeJobsFile(jobs, { cap = JOBS_DESC_CAP } = {}) {
  const capped = (jobs ?? []).map((j) => {
    if (!j || typeof j.description !== "string") return j;
    // KEEP THE BONUS SECTION BEFORE THE CAP EATS IT. Nearly every posting exceeds this cap, and a
    // nice-to-have section appears in roughly 40% of FULL descriptions. capKeepingRequirements
    // preserves REQUIREMENTS, and bonuses sit after them, so bonuses are exactly what falls off the end.
    //
    // Extracted from the UNCAPPED text, stored as a few hundred characters of its own. Raising the cap
    // instead would roughly triple a pool already near half of V8's single-string ceiling; this
    // adds single-digit MB and costs no model call. Empty string when the posting has none, which is
    // most of them — we never guess a bonus an employer did not write.
    const nice = extractNiceToHave(j.description);
    const out = j.description.length > cap ? { ...j, description: capKeepingRequirements(j.description, cap) } : { ...j };
    if (nice) out.nice_to_have = nice;
    return out;
  });
  return JSON.stringify(capped, null, 2) + "\n";
}

function writeJobsFile(path, jobs) {
  const body = serializeJobsFile(jobs);
  writeFileSync(path, body);
  const mb = (Buffer.byteLength(body) / 1048576).toFixed(1);
  const headroom = ((1 - body.length / MAX_JSON_STRING) * 100).toFixed(0);
  console.log(`  jobs.json:           ${mb} MB for ${jobs.length} posting(s), ${headroom}% under the ${(MAX_JSON_STRING / 1048576).toFixed(0)} MiB string ceiling`);
  // Loud well before it matters. A scan that quietly approaches the ceiling is a scan that will one
  // night cross it and take the whole send with it.
  if (body.length > MAX_JSON_STRING * 0.6) {
    console.log(`⚠⚠ jobs.json is within 40% of the V8 string ceiling — lower JOBS_DESC_CAP (currently ${JOBS_DESC_CAP}) or move this file off a single JSON string`);
  }
}

export function boardKey(e) {
  const part = (v) => String(v ?? "").toLowerCase();
  return [part(e?.source), part(e?.slug), part(e?.dc), part(e?.site), part(e?.host), part(e?.domain)].join(":");
}

export function workdayCountryFacets(facets) {
  const out = {};
  const walk = (nodes, param, inLocationGroup) => {
    for (const n of nodes || []) {
      const p = n?.facetParameter || param;
      const d = String(n?.descriptor || "");
      const isLocationGroup = /^(locations?|country|countries)$/i.test(d);
      if (Array.isArray(n?.values) && n.values.length) walk(n.values, p, inLocationGroup || isLocationGroup);
      else if ((inLocationGroup || isLocationGroup) && n?.id && d) out[d] = { id: n.id, param: p, count: n.count ?? 0 };
    }
  };
  walk(facets, null, false);
  return out;
}

// -> { param, ids[], counted } for the markets this board actually has, or null when the board
// exposes no country facet at all (such boards are fetched unfiltered).
export function workdayMarketFilter(facets) {
  const leaves = workdayCountryFacets(facets);
  const picked = [];
  let counted = 0;
  let param = null;
  for (const [name, info] of Object.entries(leaves)) {
    if (!Object.values(WORKDAY_MARKET_COUNTRY).some((re) => re.test(name.trim()))) continue;
    // All ids must belong to ONE parameter — Workday ORs ids inside a single facet array (verified
    // against NVIDIA: US 1418 + India 209 + UK 34 requested together returns exactly 1661).
    if (param && info.param !== param) continue;
    param = info.param;
    picked.push(info.id);
    counted += info.count;
  }
  return picked.length ? { param, ids: picked, counted } : null;
}

// ── per-posting DETAIL endpoints ─────────────────────────────────────────────
// Some ATS list endpoints carry no job description at all. SmartRecruiters is the big one: its
// /postings response has title, location, department and nothing else (verified against the live
// API — there is no `jobAd` or `description` key on a list item), so without a detail fetch those
// jobs sit in the matchable pool with no JD.
//
// That is not a cosmetic gap. A job with no description can still be SCORED (the matcher reads the
// title) and SENT, but it can never carry a fit chart, because `jdIsScoreable` needs text and
// `computeCoverage` has nothing to score coverage against. The recipient gets a role email with no
// fit meter and no gap chart, and the reason is invisible: it reads as "the posting was too vague".
//
// The JD IS available, one call per posting, on the detail endpoint (~7k chars including a
// `qualifications` section, which is exactly the requirement signal the fit chart and the knockout
// floor both need). Keyless and free, so this costs $0 in API spend — it buys the descriptions with
// HTTP requests, not money.
const DETAIL_ENDPOINT = {
  smartrecruiters: (slug, jobId) =>
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(jobId)}`,
  // Workday's list response carries no description either, and its detail document is addressed by
  // the posting's own `externalPath` ("/job/US-NC-Remote/Networking-…_JR2022381") rather than an id.
  // The path already contains its own slashes and must NOT be percent-encoded as one segment.
  workday: (slug, externalPath, entry) =>
    `https://${encodeURIComponent(slug)}.${encodeURIComponent(entry?.dc || "wd1")}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(slug)}/${encodeURIComponent(entry?.site || "External")}${String(externalPath || "")}`,
  // Eightfold's list returns `job_description: ""` on EVERY row — verified, not assumed. Without this
  // hydration every Eightfold posting would be dropped by the pool's no-description guard, and the
  // whole source would read as "answered, but everything aged out".
  eightfold: (slug, jobId, entry) =>
    `https://${entry?.host || `${slug}.eightfold.ai`}/api/apply/v2/jobs/${encodeURIComponent(jobId)}?${new URLSearchParams({ domain: entry?.domain || "" })}`,
};
// Deliberately lower than FETCH_CONCURRENCY: this fans out per POSTING, not per board, so a single
// large board can issue hundreds of requests. Slow and polite beats fast and 429'd.
const DETAIL_CONCURRENCY = 4;

// ── per-ATS extractors: map each source's fields, fall back to null, never
//    invent. Each returns { jobId, ...canonical fields } and the shared
//    normalize() wraps it into the exact canonical shape. ──────────────────────
function extractAshby(job) {
  const location = job.location ?? job.locationName ?? null;
  let remote = null;
  if (typeof job.isRemote === "boolean") remote = job.isRemote;
  else if (location && /remote/i.test(location)) remote = true;
  const plain = typeof job.descriptionPlain === "string" && job.descriptionPlain.trim() ? job.descriptionPlain.trim() : null;
  return {
    jobId: job.id ?? job.jobId,
    title: job.title ?? null,
    location, remote,
    team: job.team ?? job.department ?? job.departmentName ?? null,
    employment_type: job.employmentType ?? job.employmentTypeName ?? null,
    compensation: job.compensation ?? job.compensationTierSummary ?? null,
    apply_url: job.applyUrl ?? job.jobUrl ?? null,
    posted_at: job.publishedAt ?? job.publishedDate ?? null,
    description: plain ?? stripHtml(job.descriptionHtml ?? job.description ?? null),
  };
}

function extractGreenhouse(job) {
  const location = job.location?.name ?? null;
  let remote = null;
  if (location && /remote/i.test(location)) remote = true;
  else if (Array.isArray(job.offices) && job.offices.some((o) => /remote/i.test(o?.name ?? o?.location ?? ""))) remote = true;
  return {
    jobId: job.id,
    title: job.title ?? null,
    location, remote,
    team: job.departments?.[0]?.name ?? null,
    employment_type: null, // not exposed by the greenhouse board API
    compensation: null,
    apply_url: job.absolute_url ?? null,
    posted_at: job.first_published ?? job.updated_at ?? null,
    description: stripHtml(decodeEntities(job.content ?? null)),
  };
}

function extractLever(job) {
  const cat = job.categories ?? {};
  const location = cat.location ?? (Array.isArray(cat.allLocations) ? cat.allLocations[0] : null) ?? null;
  let remote = null;
  if (typeof job.workplaceType === "string") remote = /remote/i.test(job.workplaceType);
  else if (location && /remote/i.test(location)) remote = true;
  let compensation = null;
  if (job.salaryRange && (job.salaryRange.min || job.salaryRange.max)) {
    const { min, max, currency } = job.salaryRange;
    compensation = `${min ?? "?"}-${max ?? "?"} ${currency ?? ""}`.trim();
  }
  const plain = typeof job.descriptionPlain === "string" && job.descriptionPlain.trim() ? job.descriptionPlain.trim() : null;
  return {
    jobId: job.id,
    title: job.text ?? null,
    location, remote,
    team: cat.team ?? cat.department ?? null,
    employment_type: cat.commitment ?? null,
    compensation,
    apply_url: job.hostedUrl ?? job.applyUrl ?? null,
    posted_at: typeof job.createdAt === "number" ? new Date(job.createdAt).toISOString() : null,
    description: plain ?? stripHtml(job.description ?? job.descriptionHtml ?? null),
  };
}

function extractSmartRecruiters(job, slug) {
  const loc = job.location ?? {};
  const built = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
  const location = loc.fullLocation ?? (built || null);
  let remote = null;
  if (loc.remote === true) remote = true;
  else if (loc.hybrid === true) remote = "hybrid";
  else if (typeof loc.remote === "boolean") remote = false;
  return {
    jobId: job.id ?? job.uuid,
    title: job.name ?? null,
    location, remote,
    team: job.department?.label ?? job.function?.label ?? null,
    employment_type: job.typeOfEmployment?.label ?? null,
    compensation: null, // not in the postings list endpoint
    apply_url: job.id ? `https://jobs.smartrecruiters.com/${slug}/${job.id}` : null,
    posted_at: job.releasedDate ?? null,
    // The JD is absent from the list endpoint and is attached by hydrateDescriptions() from the
    // detail endpoint before we get here. Still null when that fetch failed or was skipped — the
    // pool guard in main() then drops the job rather than pooling one nothing can score.
    description: smartRecruitersDescription(job),
  };
}

// Assemble the SmartRecruiters JD from the detail endpoint's `jobAd.sections`. Order is deliberate,
// not cosmetic: the real role text and its requirements come FIRST so they survive the 2500-char
// pool cap (capKeepingRequirements looks for a requirement signal, and `qualifications` is where
// "3+ years of professional experience" actually lives). Company boilerplate goes last because it
// is the part that can be lost without changing what the role asks for. Sections are HTML, so each
// goes through the same stripHtml every other source's description already uses. Returns null when
// there is nothing — never a fabricated or partial JD.
const SR_SECTION_ORDER = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"];
export function smartRecruitersDescription(job) {
  const sections = job?.jobAd?.sections;
  if (!sections || typeof sections !== "object") return null;
  const parts = [];
  for (const key of SR_SECTION_ORDER) {
    const text = sections[key]?.text;
    if (typeof text === "string" && text.trim()) parts.push(stripHtml(text));
  }
  const joined = parts.join("\n\n").trim();
  return joined || null;
}

function extractRecruitee(job) {
  const built = [job.city, job.country].filter(Boolean).join(", ");
  const location = job.location ?? (built || null);
  let remote = null;
  if (job.remote === true) remote = true;
  else if (job.hybrid === true) remote = "hybrid";
  else if (job.on_site === true) remote = false;
  else if (location && /remote/i.test(location)) remote = true;
  let compensation = null;
  if (job.salary && (job.salary.min || job.salary.max)) {
    compensation = `${job.salary.min ?? "?"}-${job.salary.max ?? "?"} ${job.salary.currency ?? ""}`.trim();
  }
  return {
    jobId: job.id ?? job.guid,
    title: job.title ?? null,
    location, remote,
    team: job.department ?? null,
    employment_type: job.employment_type_code ?? null,
    compensation,
    apply_url: job.careers_apply_url ?? job.careers_url ?? null,
    posted_at: recruiteeDate(job.published_at ?? job.created_at ?? null),
    description: stripHtml(job.description ?? null),
  };
}

function extractKula(job, slug) {
  const aj = job.ats_job ?? {};
  const offices = Array.isArray(aj.offices) ? aj.offices : [];
  const office = offices[0] ?? null;
  const location = office?.location ?? office?.name ?? null;
  const wp = String(aj.workplace ?? office?.workplace ?? "").toLowerCase();
  let remote = null;
  if (wp === "remote" || office?.remote === true) remote = true;
  else if (wp === "hybrid") remote = "hybrid";
  else if (wp === "office" || office?.remote === false) remote = false;
  return {
    jobId: job.id,
    title: job.title ?? null,
    location, remote,
    team: aj.ats_department?.name ?? null,
    employment_type: aj.employment_type ?? null,
    compensation: null, // not exposed by the listing feed
    apply_url: job.id != null ? `https://careers.kula.ai/${slug}/${job.id}` : null,
    posted_at: null, // listing feed carries no date — freshness via the disappearance test
    description: stripHtml(aj.job_description ?? null),
  };
}

// Workable's public widget endpoint (?details=true) returns the full job incl. description and a
// `telecommuting` remote flag, so it slots into the same one-call pattern as ashby/greenhouse.
// Exported so scan-jobs.test.mjs can assert the id-collision fix below without running the scan.
export function extractWorkable(job) {
  const loc = Array.isArray(job.locations) && job.locations.length ? job.locations[0] : null;
  const built = [job.city ?? loc?.city, job.state ?? loc?.region, job.country ?? loc?.country].filter(Boolean).join(", ");
  const location = built || null;
  let remote = null;
  if (job.telecommuting === true) remote = true;
  else if (Array.isArray(job.locations) && job.locations.some((l) => l?.telecommuting === true || /remote/i.test(`${l?.city ?? ""} ${l?.region ?? ""}`))) remote = true;
  else if (location && /remote/i.test(location)) remote = true;
  else if (job.telecommuting === false) remote = false;
  // A Workable multi-location role ships as SEPARATE feed rows that SHARE one shortcode, so keying by
  // shortcode alone would keep only the last and collapse a four-city role into one. Disambiguate the id with a
  // stable per-city suffix so each city survives (and geo-matching can send the right one to the
  // right person). Stable across runs (same shortcode+city -> same id); no city -> bare shortcode.
  const base = job.shortcode ?? job.id;
  const cityKey = String(job.city ?? loc?.city ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const jobId = base != null && cityKey ? `${base}-${cityKey}` : (base ?? null);
  return {
    jobId,
    title: job.title ?? null,
    location, remote,
    team: job.department ?? job.function ?? null,
    employment_type: job.employment_type ?? null,
    compensation: null, // not exposed by the widget endpoint
    apply_url: job.application_url ?? job.url ?? job.shortlink ?? null,
    posted_at: job.published_on ?? job.created_at ?? null,
    description: stripHtml(decodeEntities(job.description ?? null)),
  };
}

// Keka's public active-jobs feed: a flat JSON array. jobLocations is an array of place objects;
// apply link is <slug>.keka.com/careers/jobdetails/<id>. India-native, so most rows are India.
function extractKeka(job, slug) {
  const locs = Array.isArray(job.jobLocations) ? job.jobLocations : [];
  const l0 = locs[0] ?? null;
  const location = l0
    ? (typeof l0 === "string" ? l0 : ([l0.city, l0.state, l0.countryName || l0.country].filter(Boolean).join(", ") || l0.name || l0.locationName || null))
    : null;
  const hay = `${location || ""} ${job.jobType || ""}`.toLowerCase();
  let remote = null;
  if (/remote/.test(hay) || job.isRemote === true) remote = true;
  else if (/hybrid/.test(hay)) remote = "hybrid";
  return {
    jobId: job.id,
    title: job.title ?? null,
    location, remote,
    team: job.departmentName ?? null,
    employment_type: typeof job.jobType === "string" ? job.jobType : null, // Keka sends a numeric code otherwise
    compensation: job.salaryRangeFormat || (typeof job.salaryRange === "string" ? job.salaryRange : null) || null,
    apply_url: job.id != null ? `https://${slug}.keka.com/careers/jobdetails/${job.id}` : null,
    posted_at: job.publishedOn ?? null,
    description: stripHtml(job.description ?? null),
  };
}

// Workday. Almost everything worth having is on the DETAIL document (attached as `__detail` by
// hydrateDescriptions), not the list item, so this extractor is written to degrade honestly when the
// detail fetch failed: no description -> the pool guard drops the posting, which is the correct
// outcome for a role that could never carry a fit chart.
//
// LOCATION IS THE CAREFUL PART. The list item's `locationsText` is unusable in two distinct ways:
// it collapses multi-site roles to "5 Locations", and on US-state tenants it emits bare codes like
// "IN - Crawfordsville" (Indiana) that are indistinguishable from "IN - Bangalore" (India) — the
// ambiguity documented at length in quality-gate.mjs. So we prefer the detail document's own
// `location` + `country.descriptor` and join them into a string that names the country in WORDS
// ("Crawfordsville, United States of America"). That is the employer's own answer, it is decodable
// by the geo gate without guessing, and it is the reason this source can be trusted at send time.
// If the country is absent we fall back to the raw text and let the geo gate fail closed on it.
export function extractWorkday(job) {
  const d = job.__detail ?? null;
  const raw = typeof job.locationsText === "string" ? job.locationsText : null;
  const country = d?.country?.descriptor ?? null;
  const city = typeof d?.location === "string" ? d.location : null;
  // "5 Locations" is a count, not a place — never pass it off as one.
  const cityIsReal = city && !/^\s*\d+\s+locations?\s*$/i.test(city);
  const location = country ? [cityIsReal ? city : null, country].filter(Boolean).join(", ") : (cityIsReal ? city : raw);
  const hay = `${location || ""} ${raw || ""} ${d?.timeType || ""}`.toLowerCase();
  let remote = null;
  if (/\bremote\b/.test(hay)) remote = true;
  else if (/\bhybrid\b/.test(hay)) remote = "hybrid";
  // The req id (bulletFields[0], e.g. "JR2022381") is the employer's own stable handle for the
  // posting and survives a retitle; externalPath is the fallback so an id always exists.
  const reqId = (Array.isArray(job.bulletFields) && job.bulletFields[0]) || d?.jobReqId || null;
  return {
    jobId: reqId ?? job.externalPath ?? null,
    title: job.title ?? null,
    location,
    remote,
    team: null, // Workday exposes no department on either document
    employment_type: typeof d?.timeType === "string" ? d.timeType : null,
    compensation: null, // not exposed; left null rather than guessed (see role-reqs.mjs comp note)
    apply_url: job.__base && job.externalPath ? `${job.__base}${job.externalPath}` : null,
    // startDate is a real ISO-ish date. `postedOn` is a RELATIVE string ("Posted Today") and is
    // deliberately never parsed — an unknown date is neither fresh nor stale here (scan-jobs' own
    // rule), which is safer than inventing a timestamp from prose.
    posted_at: typeof d?.startDate === "string" ? d.startDate : null,
    description: stripHtml(decodeEntities(d?.jobDescription ?? null)),
  };
}

// Amazon. The list endpoint already carries the full JD, so — unlike Workday and SmartRecruiters —
// there is no per-posting detail fetch and no DETAIL_ENDPOINT entry.
export function extractAmazon(job) {
  // `normalized_location` is Amazon's own rendering ("Bengaluru, Karnataka, IND") and is preferred
  // over stitching city+code ourselves. Both end in the alpha-3 country code, which classifyPlace
  // and the geo gate read as a country token rather than a US state — the same distinction the
  // Workday block comment in quality-gate.mjs exists for.
  const location = job.normalized_location || [job.city, job.country_code].filter(Boolean).join(", ") || null;
  const hay = `${location || ""} ${job.title || ""}`.toLowerCase();
  let remote = null;
  if (/\b(virtual|remote)\b/.test(hay)) remote = true;
  else if (/\bhybrid\b/.test(hay)) remote = "hybrid";
  // basic_qualifications is a separate field carrying the requirements the JD body often omits, and
  // fit-coverage reads requirements out of the description — so it is appended rather than dropped.
  const description = [job.description, job.basic_qualifications].filter((s) => typeof s === "string" && s.trim()).join("\n\n") || null;
  // "July 31, 2026" parses cleanly. An unparseable date stays null: scan-jobs' standing rule is that
  // an unknown date is neither fresh nor stale, which beats inventing a timestamp.
  const t = job.posted_date ? Date.parse(job.posted_date) : NaN;
  return {
    // id_icims is the employer's stable handle and survives a retitle; the UUID `id` does not.
    jobId: job.id_icims ?? job.id ?? null,
    title: job.title ?? null,
    location,
    remote,
    team: null, // the feed's business_category is an internal cost-centre grouping, not a team
    employment_type: null,
    compensation: null, // not exposed; left null rather than guessed
    apply_url: job.job_path ? `https://www.amazon.jobs${job.job_path}` : null,
    posted_at: Number.isFinite(t) ? new Date(t).toISOString() : null,
    description: stripHtml(decodeEntities(description)),
  };
}

// Eightfold: one deployment per employer. `location` is "City,Country" with no space after the comma
// (verified: "Mumbai,India"), and `t_create` is unix SECONDS — treating it as ms would date every
// posting to 1970 and the freshness cutoff would drop the entire source.
//
// The JD normally arrives via the detail hydration (DETAIL_ENDPOINT.eightfold -> applyDetail). The
// list's job_description is empty for most postings but populated by some tenants, so this reads
// whichever copy is there and hydration fills the rest.
export function extractEightfold(job, slug, entry) {
  const rawLoc = typeof job.location === "string" ? job.location : (Array.isArray(job.locations) ? job.locations[0] : null);
  // "Mumbai,India" -> "Mumbai, India" so classifyPlace and the geo gate read the country token the
  // same way they do for every other source.
  const location = typeof rawLoc === "string" && rawLoc ? rawLoc.split(",").map((x) => x.trim()).filter(Boolean).join(", ") : null;
  const flex = `${job.work_location_option || ""} ${job.location_flexibility || ""}`.toLowerCase();
  let remote = null;
  if (/remote/.test(flex)) remote = true;
  else if (/hybrid/.test(flex)) remote = "hybrid";
  else if (/onsite|on-site/.test(flex)) remote = false;
  const secs = Number(job.t_create);
  return {
    jobId: job.id ?? job.ats_job_id ?? null,
    title: job.name ?? job.posting_name ?? null,
    location, remote,
    team: job.department ?? job.business_unit ?? null,
    employment_type: null, // Eightfold does not state one on either document
    compensation: null,    // nor a salary field
    apply_url: job.canonicalPositionUrl ?? (job.id != null && entry?.host ? `https://${entry.host}/careers/job/${job.id}` : null),
    posted_at: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null,
    description: stripHtml(decodeEntities(job.job_description ?? null)),
  };
}

const EXTRACT = {
  ashby: extractAshby,
  greenhouse: extractGreenhouse,
  lever: extractLever,
  smartrecruiters: extractSmartRecruiters,
  recruitee: extractRecruitee,
  kula: extractKula,
  workable: extractWorkable,
  keka: extractKeka,
  workday: extractWorkday,
  amazon: extractAmazon,
  eightfold: extractEightfold,
};

// Wrap any source's extracted fields into the exact canonical shape.
function normalize(source, slug, company, job, now, segment) {
  const ex = EXTRACT[source](job, slug);
  return {
    id: `${source}:${slug}:${ex.jobId ?? "unknown"}`, // stable, namespaced
    source,
    company,
    slug,
    segment: segment ?? null, // provenance tag ("yc", "india", ...) so per-segment counters can attribute

    title: ex.title ?? null,
    location: ex.location ?? null,
    remote: ex.remote ?? null,
    team: ex.team ?? null,
    employment_type: ex.employment_type ?? null,
    compensation: ex.compensation ?? null,
    apply_url: ex.apply_url ?? null,
    posted_at: ex.posted_at ?? null,
    description: ex.description ?? null,
    first_seen: now,
  };
}

// Fetch one board. Returns { ok, jobs } or { ok:false, reason }.
// `opts` exists only so the tests can shrink the backoff; prod always uses the module constants.
export async function fetchBoard(entry, { retries = RATE_LIMIT_RETRIES, baseMs = RATE_LIMIT_BASE_MS, maxWaitMs = RATE_LIMIT_MAX_WAIT_MS, budgetMs = RATE_LIMIT_BUDGET_MS } = {}) {
  const source = (entry.source ?? "ashby").toLowerCase();
  const slug = entry.slug;
  const build = ENDPOINT[source];
  if (!build) return { ok: false, reason: `unknown source "${source}"` };
  if (!slug) return { ok: false, reason: "missing slug" };

  // Workday is the ONE source that is a POST with a JSON body and pages 20 at a time. Everything
  // else stays a single GET, byte-identical to before.
  const isWorkday = source === "workday";
  const isAmazon = source === "amazon";
  const isEightfold = source === "eightfold";
  // Set once the country filter for this board is known; until then requests go out unfiltered.
  let appliedFacets = {};
  // Amazon reuses the entry to carry the market being paged; the branch below reassigns it per
  // market, exactly as appliedFacets is reassigned once Workday's facet tree has been read.
  let currentEntry = entry;
  const initFor = (offset) =>
    isWorkday
      ? {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Mozilla/5.0" },
          body: JSON.stringify({ appliedFacets, limit: WORKDAY_PAGE, offset, searchText: "" }),
        }
      : { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } };

  // One attempt. Returns a terminal result, or { retryAfterMs } meaning "the host asked us to slow
  // down" — the only case the caller retries.
  const attemptOnce = async (offset = 0) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(build(slug, currentEntry, offset), { ...initFor(offset), signal: controller.signal });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after"));
        // Reported RAW, deliberately un-clamped. The caller owns the budget decision, and it cannot
        // make an honest one if the number reaching it has already been quietly reduced to 8s.
        return { rateLimited: true, status: res.status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null };
      }
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const data = await res.json();
      const jobs = JOBS_KEY[source](data);
      if (!jobs) return { ok: false, reason: "no jobs array in response" };
      // `facets` rides along for Workday's country filter (below). Every other source leaves it
      // undefined and nothing reads it, so this return is unchanged for them.
      return { ok: true, jobs, facets: data?.facets };
    } catch (err) {
      return { ok: false, reason: err.name === "AbortError" ? "timeout" : err.message };
    } finally {
      clearTimeout(timer);
    }
  };

  // One page, with the shared rate-limit retry. Returns the same terminal shape attemptOnce does.
  const pageWithRetry = async (offset) => {
    let spentMs = 0; // total time already waited on this board, across attempts
    for (let attempt = 0; ; attempt++) {
      const r = await attemptOnce(offset);
      if (!r.rateLimited) return r; // terminal: ok, or a real failure
      // What the host asked for, or our own backoff when it named nothing. maxWaitMs bounds only the
      // invented one — an explicit ask is honoured in full, and the budget below is what stops it.
      const askedMs = r.retryAfterMs ?? Math.min(baseMs * 2 ** attempt, maxWaitMs);
      const overBudget = spentMs + askedMs > budgetMs;
      if (attempt >= retries || overBudget) {
        // Still throttled. Reported as its OWN outcome, never as "not found" — see the rateLimited
        // counter in main(). A board that IS there and IS answering must not read as absent.
        // The reason records what the host actually asked for: "gave up after 25s" and "was told to
        // wait 10 minutes" are different problems, and the health record must tell them apart.
        const asked = r.retryAfterMs ? `, host asked ${Math.round(r.retryAfterMs / 1000)}s` : "";
        const budget = overBudget ? `, over ${Math.round(budgetMs / 1000)}s budget` : "";
        return { ok: false, reason: `HTTP ${r.status} (rate limited after ${attempt + 1} attempts${asked}${budget})`, rateLimited: true };
      }
      spentMs += askedMs;
      await sleep(askedMs);
    }
  };

  // ── Amazon paging ───────────────────────────────────────────────────────────
  // One employer, five markets, one keyless GET each. Walks 100 at a time per market until that
  // market runs dry or hits AMAZON_MAX_PER_MARKET.
  //
  // FAIL OPEN PER MARKET, deliberately: a market that errors keeps whatever the others returned
  // rather than losing the employer entirely — the same posture as the Workday branch below, and the
  // reason is the same. Half of Amazon is strictly better than none of it. Only a TOTAL failure
  // (nothing from any market) is reported as the board not answering, so a genuine outage still
  // shows up as a failure instead of a suspiciously small success.
  if (isAmazon) {
    const all = [];
    const perMarket = [];
    let lastFail = null;
    for (const market of AMAZON_MARKETS) {
      currentEntry = { ...(entry || {}), market };
      let got = 0;
      let truncated = false;
      for (let offset = 0; offset < AMAZON_MAX_PER_MARKET; offset += AMAZON_PAGE) {
        const r = await pageWithRetry(offset);
        if (!r.ok) { lastFail = r; break; }
        for (const p of r.jobs) if (p && typeof p === "object") all.push(p);
        got += r.jobs.length;
        if (r.jobs.length < AMAZON_PAGE) break;      // short page = this market is exhausted
        if (got >= AMAZON_MAX_PER_MARKET) { truncated = true; break; }
      }
      perMarket.push(`${market}:${got}${truncated ? "+" : ""}`);
      // Never cap silently — a truncated market is a coverage decision the log has to admit to.
      if (truncated) console.log(`  … amazon ${market} truncated at AMAZON_MAX_PER_MARKET=${AMAZON_MAX_PER_MARKET}; this market has more`);
    }
    if (!all.length) return lastFail || { ok: false, reason: "no jobs in any market" };
    console.log(`  · amazon pulled ${all.length} in-market role(s) (${perMarket.join(" ")})`);
    return { ok: true, jobs: all };
  }

  // ── Eightfold paging ────────────────────────────────────────────────────────
  // start/num, same shape as Amazon. Fail-open per page for the same reason: a page that fails after
  // we already hold postings keeps what we have rather than discarding the board, and a truncation
  // is logged rather than silently applied.
  if (isEightfold) {
    const all = [];
    let truncated = false;
    let lastFail = null;
    for (let offset = 0; offset < EIGHTFOLD_MAX_PER_BOARD; offset += EIGHTFOLD_PAGE) {
      const r = await pageWithRetry(offset);
      if (!r.ok) { lastFail = r; break; }
      for (const p of r.jobs) if (p && typeof p === "object") all.push(p);
      if (r.jobs.length < EIGHTFOLD_PAGE) break;        // short page = board exhausted
      if (all.length >= EIGHTFOLD_MAX_PER_BOARD) { truncated = true; break; }
    }
    if (!all.length) return lastFail || { ok: false, reason: "no jobs" };
    if (truncated) console.log(`  … eightfold:${slug} truncated at EIGHTFOLD_MAX_PER_BOARD=${EIGHTFOLD_MAX_PER_BOARD}; this board has more`);
    if (lastFail) console.log(`  ⚠ eightfold:${slug} page failed (${lastFail.reason}) — keeping ${all.length} already fetched`);
    return { ok: true, jobs: all };
  }

  if (!isWorkday) return pageWithRetry(0);

  // ── Workday paging ──────────────────────────────────────────────────────────
  // Walk 20 at a time until the board runs dry or the per-board cap is hit. A page that FAILS after
  // we already have postings is not fatal: we keep what we have and say how far we got, because
  // half a board is strictly better than none and matches this file's fail-open-per-board posture.
  // Each posting carries the base URL it came from so the extractor can build an apply link without
  // re-deriving the host.
  const base = `https://${slug}.${entry?.dc || "wd1"}.myworkdayjobs.com/${entry?.site || "External"}`;

  // One probe page, unfiltered, purely to read the board's facet tree. Its postings are DISCARDED —
  // they are the global set and would re-enter below under the filter anyway. One extra request per
  // board saves many more, so this pays for itself many times over.
  //
  // FAIL OPEN, DELIBERATELY: a board with no country facet is fetched unfiltered rather than
  // contributing nothing. Filtering is an efficiency and coverage win, never a precondition for a board working.
  const probe = await pageWithRetry(0);
  if (!probe.ok) return probe; // the board genuinely did not answer
  const filter = workdayMarketFilter(probe.facets);
  if (filter) {
    appliedFacets = { [filter.param]: filter.ids };
    console.log(`  · workday:${slug} filtered to ${filter.ids.length} in-market countries (${filter.counted} roles) via ${filter.param}`);
  } else {
    console.log(`  · workday:${slug} exposes no country facet — pulling unfiltered (today's behaviour)`);
  }

  const all = [];
  let truncated = false;
  for (let offset = 0; offset < WORKDAY_MAX_PER_BOARD; offset += WORKDAY_PAGE) {
    const r = await pageWithRetry(offset);
    if (!r.ok) {
      if (!all.length) return r; // first page failed -> the board genuinely did not answer
      console.log(`  ⚠ workday:${slug} page at offset ${offset} failed (${r.reason}) — keeping ${all.length} already fetched`);
      break;
    }
    for (const p of r.jobs) {
      if (p && typeof p === "object") p.__base = base;
      all.push(p);
    }
    if (r.jobs.length < WORKDAY_PAGE) break; // short page = end of the board
    if (all.length >= WORKDAY_MAX_PER_BOARD) { truncated = true; break; }
  }
  // Never cap silently. A truncated board is a coverage
  // decision the log has to admit to, otherwise "we scanned CVS" reads as "we scanned all of CVS".
  if (truncated) console.log(`  … workday:${slug} truncated at WORKDAY_MAX_PER_BOARD=${WORKDAY_MAX_PER_BOARD}; this board has more`);
  return { ok: true, jobs: all };
}

// Fetch ONE posting's detail document. Returns the parsed JSON, or null on any failure.
//
// FAILS OPEN, PER POSTING, ON PURPOSE. This is an enrichment pass over data we already have: a
// posting whose detail fetch times out keeps its null description and is then dropped by the pool
// guard in main(). So a flaky detail endpoint can only ever leave us where we already are — it can never take away a job that currently works, and it
// can never abort the scan. Rate limiting gets the same treatment as a board (429/503 -> back off
// and retry) because being throttled is not the same as having no description.
async function fetchPostingDetail(source, slug, jobId, { retries = RATE_LIMIT_RETRIES, baseMs = RATE_LIMIT_BASE_MS, maxWaitMs = RATE_LIMIT_MAX_WAIT_MS, entry = null } = {}) {
  const build = DETAIL_ENDPOINT[source];
  if (!build || !slug || !jobId) return null;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(build(slug, jobId, entry), { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: controller.signal });
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        clearTimeout(timer);
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, maxWaitMs) : baseMs * 2 ** attempt);
        continue;
      }
      if (!res.ok) return null;
      // BOUNDARY: validate the detail document before trusting it. This is its own
      // external integration point, separate from the list endpoint's raw item. On failure we log
      // the posting id + the offending field and skip that record — the posting stays un-hydrated
      // and the pool guard drops it. Never crash the batch.
      const detailSchema = ATS_DETAIL_SCHEMAS[source];
      if (!detailSchema) return null; // a detail endpoint with no schema is not trusted
      const parsed = detailSchema.safeParse(await res.json());
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.log(`  ⚠ skip malformed ${source}:${slug} detail ${jobId}: ${issue?.path?.join(".") || "(root)"} ${issue?.message || "invalid"}`);
        return null;
      }
      return parsed.data;
    } catch {
      return null; // timeout / network / bad JSON — treated as "no description", never fatal
    } finally {
      clearTimeout(timer);
    }
  }
}

// Attach the per-posting JD for sources whose list endpoint omits it. Mutates each raw job in place
// (adding `jobAd`) so the existing extractor picks it up with no change to the normalize pipeline.
// No-op for every other source, so this is byte-identical for ashby/greenhouse/lever/etc.
export async function hydrateDescriptions(entry, jobs) {
  const source = (entry?.source ?? "ashby").toLowerCase();
  if (!DETAIL_ENDPOINT[source] || !Array.isArray(jobs) || !jobs.length) return { attempted: 0, hydrated: 0 };

  // Which postings are worth a round trip. For every source but Workday: all of them, exactly as
  // before. For Workday: only the titles that can survive the role filter in main() anyway.
  //
  // This is a cost control, not a behaviour change — main() drops a non-matching title at line
  // `ROLE_FILTER && !matchesRole(...)` whether or not we spent a request hydrating it, so the pooled
  // set is identical either way. It matters because Workday fans out per POSTING across boards that
  // are an order of magnitude larger than any other source: hydrating every title on 68 boards is
  // tens of thousands of requests a night, and hydrating only the matching ones is a small fraction
  // of that. Kept deliberately narrow — if ROLE_FILTER is off, nothing is pre-filtered.
  const targets =
    source === "workday" && ROLE_FILTER ? jobs.filter((j) => matchesRole(j?.title ?? "")) : jobs;
  if (!targets.length) return { attempted: 0, hydrated: 0 };

  let hydrated = 0;
  await mapWithConcurrency(targets, DETAIL_CONCURRENCY, async (raw) => {
    // Workday addresses its detail document by externalPath; every other source by an id.
    const jobId = source === "workday" ? raw?.externalPath : (raw?.id ?? raw?.uuid);
    if (!jobId) return;
    const detail = await fetchPostingDetail(source, entry.slug, jobId, { entry });
    if (applyDetail(source, raw, detail)) hydrated++;
  });
  return { attempted: targets.length, hydrated };
}

/**
 * Copy the JD off a detail document onto the raw list row, where that source's extractor will find it.
 *
 * PURE AND EXPORTED ON PURPOSE. Each source names this field differently, and getting the name wrong
 * is invisible: nothing throws, `hydrated` just stays 0, every posting keeps its empty description,
 * and the pool guard drops the source as "answered, but everything aged out" (e.g. looking for
 * `jobAd` on Eightfold, whose document carries `job_description` instead). A field-name mapping that fails silently needs a unit test, and
 * a unit test needs a function that does not fetch.
 *
 * Returns true when a description was actually attached — the caller's `hydrated` counter, which is
 * what makes the next such breakage legible in the scan log instead of silent.
 */
export function applyDetail(source, raw, detail) {
  if (!raw || !detail) return false;
  // Workday hands the whole posting document to extractWorkday, not just a JD string.
  if (source === "workday") {
    if (!detail.jobPostingInfo) return false;
    raw.__detail = detail.jobPostingInfo;
    return true;
  }
  // Eightfold: same field name on both documents. The list row carries it too, but it is empty for
  // most postings and truncated on most of the rest. The detail copy wins whenever it has one, which is the same semantic every other hydrated source has.
  if (source === "eightfold") {
    const jd = typeof detail.job_description === "string" ? detail.job_description.trim() : "";
    if (!jd) return false;
    raw.job_description = jd;
    return true;
  }
  // SmartRecruiters, and the default for any future source whose detail doc names it `jobAd`.
  if (!detail.jobAd) return false;
  raw.jobAd = detail.jobAd;
  return true;
}

// Run an async mapper over items with a small fixed concurrency, preserving order.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function main() {
  let watchlist;
  try {
    watchlist = JSON.parse(readFileSync(WATCHLIST_PATH, "utf8"));
    if (!Array.isArray(watchlist)) throw new Error("watchlist.json must be an array");
  } catch (err) {
    console.error(`could not read watchlist.json: ${err.message}`);
    process.exit(1);
  }

  // Merge in any segment feeds (e.g. watchlist-yc.json). Missing/broken feed = skipped, never
  // fatal — the curated watchlist alone is a valid scan. The shared dedupe below de-collides any
  // company that appears in both a feed and the base list (same source:slug -> one board fetch).
  for (const p of WATCHLIST_SEGMENT_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const seg = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(seg)) {
        watchlist = watchlist.concat(seg);
        console.log(`+ merged ${seg.length} entries from ${p.split("/").pop()}`);
      }
    } catch (err) {
      console.error(`could not read ${p.split("/").pop()} (skipping): ${err.message}`);
    }
  }

  // Safety dedupe: one board per ENDPOINT (first wins — the curated base list precedes feeds), so a
  // company present in both is fetched once.
  //
  // The key must be everything that changes the URL, not just source:slug. On every source but two,
  // the slug IS the endpoint. Workday is not like that:
  // one tenant hosts SEVERAL boards that differ only by `dc`/`site`, and they are frequently
  // different employers — `slihrms/Careers` is AtkinsRealis while `slihrms/Linxon` is Linxon, and
  // `harriscomputer/1` is Harris Computer while `harriscomputer/Altera` is Altera Digital Health.
  // Under a source:slug key the second of each pair would be dropped here, before any fetch, and the
  // scan-health `attempted` count would never know it existed: a watchlist entry that reads as present
  // and is silently never fetched.
  //
  // Eightfold gets the same treatment for the same reason (`host`/`domain` are its endpoint).
  const seenBoards = new Set();
  watchlist = watchlist.filter((e) => {
    if (seenBoards.has(boardKey(e))) return false;
    seenBoards.add(boardKey(e));
    return true;
  });

  // seen-store: persists across runs to power the disappearance test.
  //
  // Remote (the job-pool bucket) is the real store, because charlie-engine has no volume and
  // SEEN_PATH dies with the container. The local file is the dev path, used when Supabase is not
  // configured at all.
  //
  // `seenWritable` is the guard, and it governs the WRITE, not the read. A failed read leaves us
  // knowing nothing; writing that nothing back would replace good remote history with an empty
  // store and make a transient error permanent. So a failed read forfeits this run's write instead.
  // An ABSENT store (first run ever) is not a failed read and stays writable.
  loadEnv(); // idempotent; only fills vars that are unset. Needed before store() on a local run.
  const remoteSeen = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL);
  let seen = {};
  let seenWritable = true;
  if (remoteSeen) {
    try {
      seen = await loadSeenJobs();
      console.log(`seen-store: loaded ${Object.keys(seen).length} id(s) from the job-pool bucket`);
    } catch (e) {
      // FAIL OPEN, loudly. No history means no opinion: the disappearance test below iterates the
      // store, so an empty one closes nothing (it cannot conclude "every job I ever saw vanished").
      seen = {};
      seenWritable = false;
      console.log(`⚠ seen-store: read FAILED (${e.message}) — holding no opinion on disappearance, and NOT writing back this run`);
    }
  } else if (existsSync(SEEN_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(SEEN_PATH, "utf8"));
      if (parsed && typeof parsed === "object") seen = parsed;
    } catch {
      seen = {};
    }
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // fetch every board concurrently (order preserved for deterministic processing)
  const fetched = await mapWithConcurrency(watchlist, FETCH_CONCURRENCY, async (entry) => {
    const result = await fetchBoard(entry).catch((e) => ({ ok: false, reason: e.message }));
    // Enrichment, inside the same concurrency slot so it overlaps with other boards rather than
    // serialising after every board has landed. Never allowed to fail the board it belongs to.
    if (result.ok) await hydrateDescriptions(entry, result.jobs).catch(() => {});
    return { entry, result };
  });

  // per-source observability
  const stat = {};
  // attempted/resolved/notfound tell "board answered" from "board refused"; fetched/kept tell
  // "refused" (resolved:0) from "answered empty" (fetched:0) from "answered but everything aged out"
  // (fetched>0, kept:0). reasons samples WHY a board wasn't found. This whole object is persisted to
  // the job-pool bucket (health.bySource) so a source landing 0 (e.g. a host blocking our egress)
  // is legible next run instead of vanishing into stdout.
  // rateLimited is counted SEPARATELY from notfound: "the board refused to talk to us right now" and
  // "there is no such board" are different failures with different fixes, and collapsing them makes
  // an outage look like an empty source. notfound still increments too, so the funnel totals are
  // consistent; rateLimited is the extra discrimination.
  // stale/unknownDate are counted per source for the same reason noDesc is: `kept` is counted off the
  // FINAL deduped pool, so `fetched - kept` silently mixes the freshness drop with within-run id
  // collisions, and the two have opposite fixes ("raise MAX_AGE_DAYS" vs "dedupe is eating boards").
  // With stale recorded, dedupe is the remainder: fetched - noDesc - stale - kept.
  SOURCES.forEach((s) => (stat[s] = { attempted: 0, resolved: 0, notfound: 0, rateLimited: 0, fetched: 0, kept: 0, noDesc: 0, stale: 0, unknownDate: 0, reasons: {} }));

  let jobsFound = 0;
  let jobsSkippedInvalid = 0;
  let jobsNoDescription = 0; // pooled nothing can score -> dropped by the pool guard below
  let roleMatched = 0;
  let staleDropped = 0;
  let unknownDate = 0;
  const resolvedBoards = new Set(); // `${source}:${slug}` for boards that resolved this run
  const resolvedCompanies = new Map(); // company -> `${source}:${slug}`, resolved boards only (scan-health)
  const seenThisRun = new Set();
  const byId = new Map();

  /**
   * SLIM ON THE WAY IN, NOT ON THE WAY OUT.
   *
   * If `byId` held every posting with its FULL description for the entire run and the cap were
   * applied only at write time, the run would carry ten to twenty times the text it ever keeps
   * (nearly every posting exceeds the 2,500 cap) and can exhaust a 4GB heap on large boards.
   *
   * The nice-to-have MUST be extracted first, because it is read off the UNCAPPED text and bonuses
   * sit after the requirements, which is exactly what the cap removes. Extracting here rather than at
   * serialize time changes nothing about the output and everything about the peak.
   *
   * Both writers still cap, which is then a no-op rather than a duplicate. Leave them: they are the
   * guarantee, and this is the optimisation.
   */
  const slim = (j) => {
    if (!j || typeof j.description !== "string" || j.description.length <= JOBS_DESC_CAP) return j;
    const nice = j.nice_to_have || extractNiceToHave(j.description);
    j.description = capKeepingRequirements(j.description, JOBS_DESC_CAP);
    if (nice) j.nice_to_have = nice;
    return j;
  };

  for (const { entry, result } of fetched) {
    const company = entry.company ?? entry.slug ?? "unknown";
    const slug = entry.slug;
    const source = (entry.source ?? "ashby").toLowerCase();
    if (stat[source]) stat[source].attempted++;

    if (!result.ok) {
      if (stat[source]) {
        stat[source].notfound++;
        if (result.rateLimited) stat[source].rateLimited++;
        const why = result.reason ?? "not found";
        stat[source].reasons[why] = (stat[source].reasons[why] || 0) + 1;
      }
      console.log(`⚠ ${company} (${slug ?? "?"}) — ${result.reason ?? "not found"} on ${source}`);
      continue;
    }

    if (stat[source]) { stat[source].resolved++; stat[source].fetched += result.jobs.length; }
    resolvedBoards.add(`${source}:${slug}`);
    // Which company each RESOLVED board speaks for. A resolved board that yields nothing is the
    // only case the silent-zero check can speak to; a board that failed already printed a ⚠.
    resolvedCompanies.set(company, `${source}:${slug}`);
    console.log(`✓ ${company} (${source}) — ${result.jobs.length} jobs`);

    for (const raw of result.jobs) {
      jobsFound++;
      // Boundary: validate the raw ATS item before trusting it. A structurally broken item is
      // logged (source:slug + id + first issues) and skipped — never normalized into the pool.
      const atsSchema = ATS_JOB_SCHEMAS[source];
      if (atsSchema) {
        const parsed = atsSchema.safeParse(raw);
        if (!parsed.success) {
          jobsSkippedInvalid++;
          const rid = raw?.id ?? raw?.jobId ?? raw?.shortcode ?? "unknown";
          console.log(`  ⚠ skip malformed ${source}:${slug} job ${rid}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`);
          continue;
        }
      }
      const normalized = normalize(source, slug, company, raw, now, entry.segment);
      const id = normalized.id;
      seenThisRun.add(id);

      // upsert into the seen-store (present on a board now = open).
      if (!seen[id]) seen[id] = { first_seen: now, last_seen: now, status: "open" };
      else {
        seen[id].last_seen = now;
        seen[id].status = "open";
        delete seen[id].closed_at; // reappeared
      }

      // POOL GUARD — a job with no description can never be honestly sent, so it never enters the
      // pool. `jdIsScoreable` needs text, so computeCoverage returns thin and the fit chart is
      // hidden; the matcher meanwhile scores happily off the title alone, so a description-less role
      // could clear the bar and reach inboxes with no fit meter and no gap chart. Hydration above recovers the SmartRecruiters ones; this drops
      // whatever is still empty (a failed detail fetch, or the handful of lever/keka strays).
      //
      // Deliberately placed AFTER the seen-store upsert, exactly like the stale drop: the store
      // records that the board still lists this posting (that is what powers the disappearance
      // test). Skipping earlier would make a live-but-undescribed job look closed.
      if (!String(normalized.description || "").trim()) {
        jobsNoDescription++;
        if (stat[source]) stat[source].noDesc++;
        continue;
      }

      // role filter (loose first pass)
      if (ROLE_FILTER && !matchesRole(normalized.title)) continue;
      roleMatched++;

      // posted-date cutoff
      const age = ageDays(normalized.posted_at, nowMs);
      if (age === null) {
        normalized.posted_at_unknown = true; // do not assume fresh OR stale
        unknownDate++;
        if (stat[source]) stat[source].unknownDate++;
      } else if (age > MAX_AGE_DAYS) {
        staleDropped++;
        if (stat[source]) stat[source].stale++;
        continue; // too old — never surface
      }

      normalized.first_seen = seen[id].first_seen;
      normalized.last_seen = seen[id].last_seen;
      byId.set(id, slim(normalized)); // dedupe within the run, slimmed so the run fits in memory
    }
  }

  // ── supplementary remote boards (RemoteOK / Remotive / Himalayas) ───────────
  // Merge in remote-first postings, but the ATS-direct copy wins: dedup by company+title,
  // and only keep a board posting when Charlie doesn't already have that role from a board.
  const normTxt = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const contentKey = (j) => `${normTxt(j.company)}|${normTxt(j.title)}`;
  const contentKeys = new Set([...byId.values()].map(contentKey));
  let boardKept = 0, boardDup = 0, boardStale = 0;
  let boardTotal = 0;
  try {
    const { jobs: boardJobs, okSources } = await fetchBoardJobs((m) => console.log(m));
    boardTotal = boardJobs.length;
    for (const bj of boardJobs) {
      if (!bj.id || !bj.title) continue;
      seenThisRun.add(bj.id);
      if (!seen[bj.id]) seen[bj.id] = { first_seen: now, last_seen: now, status: "open" };
      else { seen[bj.id].last_seen = now; seen[bj.id].status = "open"; delete seen[bj.id].closed_at; }

      if (ROLE_FILTER && !matchesRole(bj.title)) continue;
      const age = ageDays(bj.posted_at, nowMs);
      if (age === null) bj.posted_at_unknown = true;
      else if (age > MAX_AGE_DAYS) { boardStale++; continue; }

      const k = contentKey(bj);
      if (contentKeys.has(k)) { boardDup++; continue; } // ATS-direct or earlier board wins
      contentKeys.add(k);
      bj.first_seen = seen[bj.id].first_seen;
      bj.last_seen = seen[bj.id].last_seen;
      byId.set(bj.id, slim(bj));
      boardKept++;
    }
    // only boards that responded count as "resolved" (so a transient outage never false-closes)
    for (const s of okSources) resolvedBoards.add(`${s}:${s}`);
  } catch (e) {
    console.log(`⚠ remote boards skipped: ${e.message}`);
  }

  // disappearance test: an id in the store NOT seen this run, whose board DID
  // resolve, has disappeared = closed. id is "<source>:<slug>:<jobid>"; the board
  // key is the first two segments. Boards that failed to resolve are skipped so a
  // transient error never false-closes their jobs.
  let newlyClosed = 0;
  let stillOpen = 0;
  for (const [id, e] of Object.entries(seen)) {
    if (e.status === "open" && !seenThisRun.has(id)) {
      const parts = id.split(":");
      const boardKey = `${parts[0]}:${parts[1]}`;
      if (resolvedBoards.has(boardKey)) {
        e.status = "closed";
        e.closed_at = now;
        newlyClosed++;
      }
    }
    if (e.status === "open") stillOpen++;
  }

  // Prune BEFORE either write, so the local file and the bucket hold the same bounded object.
  const { seen: prunedSeen, dropped: seenDropped } = pruneSeen(seen, { nowMs });
  writeFileSync(SEEN_PATH, JSON.stringify(prunedSeen, null, 2) + "\n");
  const seenBytes = statSync(SEEN_PATH).size;
  console.log(`  seen-store:          ${Object.keys(prunedSeen).length} id(s), ${(seenBytes / 1048576).toFixed(1)} MB (pruned ${seenDropped} past ${MAX_AGE_DAYS}d)`);
  const kept = [...byId.values()];
  // Per-source kept, counted off the FINAL deduped pool (so a within-run id collision counts once).
  for (const j of kept) if (stat[j.source]) stat[j.source].kept++;
  writeJobsFile(OUT_PATH, kept);

  // Share the fresh pool so the hosted chat can match a new user in-session (the chat lives
  // on a different service and can't read this file). Append-only + best-effort: any failure
  // here must NEVER fail the scan, which is the engine's real job.
  try {
    loadEnv();
    if (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) {
      await saveJobPool(kept);
      console.log(`shared ${kept.length} roles to the job pool (chat can match in-session)`);

      // Persist the seen-store so the NEXT run has a history to work from. Best-effort like every
      // other write in this block: a failed upload must never fail the scan. `seenWritable` is
      // false only when THIS run's read failed, in which case `prunedSeen` is a store built from
      // nothing and uploading it would erase the real one.
      if (!seenWritable) {
        console.log("⚠ seen-store: skipping the write-back (this run's read failed, so its history is not real)");
      } else {
        try {
          const bytes = await saveSeenJobs(prunedSeen);
          console.log(`seen-store: wrote ${Object.keys(prunedSeen).length} id(s), ${(bytes / 1048576).toFixed(1)} MB to the job-pool bucket`);
        } catch (e) {
          console.log(`⚠ seen-store: write failed (${e.message}) — next run falls back to no history, which closes nothing`);
        }
      }

      // Semantic vectors for the pre-filter rank. Fail-open + INCREMENTAL: embed only jobs
      // new since last scan, prune vanished ones, store as one compact int8 blob. No key / any error
      // -> skip; the pre-filter falls back to lexical ranking. Never fails the scan or the pool share.
      try {
        if (semanticEnabled()) {
          const dim = Number(process.env.VOYAGE_DIM || 512);
          const prevMap = unpackInt8Vectors(await loadJobEmbeddings());
          const need = kept.filter((j) => j.id && !prevMap.has(j.id));
          let embedded = 0;
          if (need.length) {
            const texts = need.map((j) => `${j.title || ""}\n${(j.description || "").slice(0, 8000)}`);
            const vecs = await embedTexts(texts, { dim, inputType: "document" });
            if (vecs) need.forEach((j, i) => { if (vecs[i]) { prevMap.set(j.id, vecs[i]); embedded++; } });
          }
          const keptIds = new Set(kept.map((j) => j.id));
          const entries = [...prevMap].filter(([id]) => keptIds.has(id)).map(([id, vec]) => ({ id, vec }));
          if (entries.length) {
            await saveJobEmbeddings({ ...packInt8Vectors(dim, entries), model: process.env.VOYAGE_MODEL || "voyage-3.5-lite" });
            console.log(`embedded ${embedded} new roles; ${entries.length}/${kept.length} pool roles have vectors`);
          }
        } else {
          console.log("semantic vectors skipped (VOYAGE_API_KEY unset — lexical rank only)");
        }
      } catch (e) {
        console.log(`[voyage] scan-embed skipped: ${e?.message} (lexical rank unaffected)`);
      }
      // live, TRUE landing stats — real counts from this scan, never invented
      // Per-segment coverage (yc/india/base) — roles + companies by provenance tag,
      // so the KPI board can watch each segment's contribution over time.
      const segCount = {};
      const segCos = {};
      for (const j of kept) {
        const seg = j.segment || "base";
        segCount[seg] = (segCount[seg] || 0) + 1;
        (segCos[seg] ||= new Set()).add(j.company || "?");
      }
      const coverageBySegment = Object.fromEntries(Object.keys(segCount).map((s) => [s, { roles: segCount[s], companies: segCos[s].size }]));

      // Last run's segment coverage, read BEFORE saveJobPoolStats below overwrites stats.json —
      // read it after and we would compare this run against itself and always find nothing wrong.
      // Fail-open: diagnostics never break a scan, so a stats read error is a null, not a throw.
      const previousSegments = await loadJobPoolStats()
        .then((s) => s?.coverageBySegment || null)
        .catch(() => null);

      const stats = {
        roles: kept.length,
        companies: new Set(kept.map((j) => j.company).filter(Boolean)).size,
        opened24h: kept.filter((j) => j.first_seen && nowMs - Date.parse(j.first_seen) <= 86400000).length,
        closedYesterday: newlyClosed,
        coverageBySegment,
        updatedAt: now,
      };
      await saveJobPoolStats(stats);
      console.log(`shared live stats: ${stats.roles} live · ${stats.companies} cos · ${stats.opened24h} opened/24h · ${stats.closedYesterday} closed`);

      // live feed for the landing: the freshest REAL roles + a by-function breakdown
      const dateOf = (j) => (j.posted_at && !j.posted_at_unknown ? j.posted_at : j.first_seen);
      const freshest = kept
        .map((j) => ({ title: j.title, company: j.company, ts: dateOf(j), location: j.location || null }))
        .filter((r) => r.title && r.company && r.ts && !Number.isNaN(Date.parse(r.ts)))
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        .slice(0, 40);
      const fnCounts = {};
      for (const j of kept) { const f = roleFunction(j.title); fnCounts[f] = (fnCounts[f] || 0) + 1; }
      const byFunction = Object.entries(fnCounts)
        .filter(([k]) => k !== "Other")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([label, count]) => ({ label, count }));
      await saveJobPoolFeed({ freshest, byFunction, updatedAt: now });
      console.log(`shared live feed: ${freshest.length} fresh roles · ${byFunction.length} functions`);

      // Daily per-company open-req snapshot → powers the role email's hiring-momentum trend.
      // Best-effort: a missing table (before the migration lands) just no-ops (fail-open).
      const dateKey = new Date(nowMs).toISOString().slice(0, 10);
      const todayCounts = countByCompany(kept);

      // ── scan health: boards that resolved, yielded 0, and had roles last time ──────────────
      // A blocked ATS answers 200 with {"jobs":[]}, so it is counted as resolved and prints
      // "✓ <co> — 0 jobs". Only the previous snapshot can tell that apart from an honest empty
      // board. Read it BEFORE writing today's, or today's row is the one we compare against.
      const previousCounts = await getPreviousCompanyCounts(dateKey);
      const health = summarizeScanHealth({ previousCounts, todayCounts, resolvedBoards: resolvedCompanies, poolSize: kept.length, at: now, previousSegments, todaySegments: coverageBySegment });
      if (!health.hadPrevious) {
        console.log("— scan health —\n  no previous snapshot yet; silent-zero check starts next run");
      } else if (health.silentZeroBoards) {
        // Loud on purpose: a blocked board can otherwise hide a whole source's roles for days.
        console.error(`\n⚠⚠ SCAN HEALTH: ${health.silentZeroBoards} board(s) resolved but went silent — ${health.lostRoles} roles lost vs the last scan`);
        for (const z of health.silentZeros.slice(0, 20)) console.error(`   ${z.company} (${z.board}) — had ${z.had}, now 0`);
        if (health.silentZeros.length > 20) console.error(`   …and ${health.silentZeros.length - 20} more`);
        console.error("   a resolved board yielding nothing is a refusal, not an empty board — check egress/blocking for the sources above\n");
      } else {
        console.log("— scan health —\n  no silent zeros: every board that had roles last scan still yields roles");
      }

      // A collapsed segment is a DIFFERENT failure from a silent board: those companies were never
      // asked, so no ⚠ was printed and the silent-zero check above cannot see them. Separate line,
      // separate wording — folding them together would hide which of the two actually happened.
      if (!health.hadPreviousSegments) {
        console.log("  no previous segment coverage yet; segment-collapse check starts next run");
      } else if (health.segmentCollapses.length) {
        console.error(`\n⚠⚠ SCAN HEALTH: ${health.segmentCollapses.length} segment(s) contributed nothing — ${health.lostSegmentRoles} roles lost vs the last scan`);
        for (const s of health.segmentCollapses) console.error(`   segment "${s.segment}" — had ${s.had}, now 0`);
        console.error("   a segment at zero means its feed file was missing and those boards were never fetched — check the ingest that writes it\n");
      } else {
        console.log("  no segment collapse: every segment that had roles last scan still has roles");
      }

      // Persist the per-source funnel alongside the silent-zero record. With it, "workable resolved 3, fetched 110, kept 31" vs
      // "resolved 0, reasons {HTTP 403: 3}" is readable off the bucket next run — no more guessing
      // whether a source that lands 0 was refused, empty, or aged out.
      health.bySource = { ...stat, remote: { fetched: boardTotal, kept: boardKept, dup: boardDup, stale: boardStale } };
      // The whole-run funnel, persisted for the same reason bySource is: printed totals are thrown
      // away, so "how much does the 45-day cutoff actually cost us" must be answerable off the bucket.
      // `remoteKept` rides along because `pooled` counts the FINAL pool, which the supplementary remote
      // boards were merged into — without it the arithmetic would charge the ATS funnel for roles it
      // never fetched, and the dedupe remainder would read low by exactly that many.
      health.funnel = { fetched: jobsFound, invalid: jobsSkippedInvalid, noDesc: jobsNoDescription, stale: staleDropped, unknownDate, pooled: kept.length, remoteKept: boardKept, maxAgeDays: MAX_AGE_DAYS };
      await saveScanHealth(health);

      if (await saveCompanySnapshot(dateKey, todayCounts)) console.log(`snapshot: per-company open-req counts for ${dateKey}`);
    }
  } catch (e) {
    console.log(`⚠ job-pool share skipped: ${e.message}`);
  }

  // ── observability ──────────────────────────────────────────────────────────
  const totalAttempted = Object.values(stat).reduce((n, s) => n + s.attempted, 0);
  const totalResolved = Object.values(stat).reduce((n, s) => n + s.resolved, 0);

  console.log("\n— per source (attempted / resolved / not-found · fetched / kept) —");
  for (const s of SOURCES) {
    if (!stat[s].attempted) continue;
    const rs = Object.entries(stat[s].reasons || {});
    const why = rs.length ? `  — ${rs.map(([r, n]) => `${n}×${r}`).join(", ")}` : "";
    console.log(`  ${s.padEnd(16)} ${stat[s].attempted} / ${stat[s].resolved} / ${stat[s].notfound} · fetched ${stat[s].fetched} / kept ${stat[s].kept}${why}`);
  }

  console.log("\n— funnel (scan) —");
  console.log(`boards attempted:      ${totalAttempted}`);
  console.log(`boards resolved:       ${totalResolved}`);
  console.log(`total fetched:         ${jobsFound}`);
  console.log(`  skipped malformed:   ${jobsSkippedInvalid} (failed schema validation)`);
  console.log(`  dropped no JD:       ${jobsNoDescription} (no description -> unscoreable, could never carry a fit chart)`);
  console.log(`after role filter:     ${roleMatched}  (${ROLE_FILTER ? "design/product" : "off"})`);
  console.log(`  dropped as stale:    ${staleDropped} (>${MAX_AGE_DAYS}d)`);
  console.log(`  posted_at unknown:   ${unknownDate} (kept, flagged)`);
  console.log(`after freshness:       ${kept.length}  -> jobs.json`);
  console.log("— remote boards (supplementary) —");
  console.log(`  fetched:             ${boardTotal}  (RemoteOK / Remotive / Himalayas)`);
  console.log(`  kept (net-new):      ${boardKept}`);
  console.log(`  dropped as dup:      ${boardDup}  (ATS-direct or board already had it)`);
  console.log(`  dropped as stale:    ${boardStale} (>${MAX_AGE_DAYS}d)`);
  console.log("— freshness store (disappearance test) —");
  console.log(`  seen this run:       ${seenThisRun.size}`);
  console.log(`  newly closed:        ${newlyClosed}`);
  console.log(`  still open:          ${stillOpen}`);
  // MARKET REACH — SHADOW ONLY. Measures how much of what we just wrote is reachable by NO market we
  // serve. It deletes nothing: `enforce` is a separate, human-made decision taken after reading a real
  // report, because a filter that deletes at scan time removes a role from EVERYONE at once and can
  // silence many users while every check reports green.
  const _reachMode = reachMode();
  if (_reachMode !== "off") {
    try {
      logShadowReport(shadowReport(kept), _reachMode);
    } catch (e) {
      console.error(`[market-reach] shadow report failed (scan unaffected): ${e.message}`);
    }
  }

  console.log("\nnext: node pre-filter.mjs  ->  node match-jobs.mjs");

  // heartbeat: this ATS poll completed cleanly. If it stops running, the external monitor alerts.
  await pingHeartbeat("ats_poll");
}

// Run the scan only when executed directly (node scan-jobs.mjs) — importing this module (e.g. from
// scan-jobs.test.mjs to unit-test extractWorkable) must NOT kick off a live scan.
if (import.meta.url === `file://${process.argv[1]}`) {
  initSentry({ name: "scan-jobs" });
  main().catch(async (e) => {
    captureError(e, { service: "scan-jobs", kind: "fatal" });
    await flushSentry();
    process.exit(1);
  });
}
