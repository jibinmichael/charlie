// health-check.mjs — Charlie's self-monitoring canary.
//
//   node health-check.mjs
//
// Exercises Charlie's two critical, silently-breakable paths and emails an alert on any
// failure (Resend, same verified sender as the engine). Built to run on a FREQUENT cron
// (every few hours) — far more often than the daily match — so an outage surfaces in
// hours, not when a user complains.
//
//   1) build_dossier canary — a real Opus build of a fixed resume. Asserts it succeeds and
//      stays grounded (name verbatim, proof_points present). Catches the live model call
//      erroring out.
//   2) source-health probe — samples a few companies per ATS source + the remote boards and
//      asserts each source still returns parseable jobs. Catches the quiet killer: an ATS or
//      board changes its API and a whole source silently drops to zero while Charlie runs on.
//
// Exits non-zero when any check fails, so the cron run shows red too. main() never throws —
// a probe error is a failed check, not a crashed monitor. Set HEALTH_DRY_RUN=1 to skip the
// alert email (it still prints the report and sets the exit code).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import { parseEnv } from "./lib/dotenv.mjs";
import { fetchBoardJobs } from "./scan-boards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = join(here, "watchlist.json");

// Load .env.local for local runs; in prod Railway injects the env directly.
for (const f of [".env.local", ".env"]) {
  const p = join(here, f);
  if (!existsSync(p)) continue;
  for (const [name, value] of parseEnv(readFileSync(p, "utf8"))) {
    if (!process.env[name]) process.env[name] = value;
  }
}

const FETCH_TIMEOUT_MS = 12000;
const SAMPLE_PER_SOURCE = 4; // sampling a few guards against a single company simply having no open roles

// ── ATS endpoints (kept deliberately minimal). scan-jobs.mjs is the source of truth for these;
//    a drift here only ever causes a false alert, never a bad scan, so the duplication is safe. ──
const ENDPOINT = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=true`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=100`,
  recruitee: (s) => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
  kula: (s) => `https://careers.kula.ai/api/internal/ats_job_posts?accountName=${encodeURIComponent(s)}&page=1&items=99&type=ats_job_post.index`,
};
const JOBS_KEY = {
  ashby: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  greenhouse: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  lever: (d) => (Array.isArray(d) ? d : null),
  smartrecruiters: (d) => (Array.isArray(d?.content) ? d.content : null),
  recruitee: (d) => (Array.isArray(d?.offers) ? d.offers : null),
  kula: (d) => (Array.isArray(d?.data) ? d.data : null),
};

async function fetchJobsArray(source, slug) {
  const build = ENDPOINT[source];
  if (!build) return { ok: false, reason: `no probe for source "${source}"` };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(build(slug), { headers: { accept: "application/json", "User-Agent": "CharlieHealth/1.0" }, signal: c.signal });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const arr = JOBS_KEY[source](await r.json());
    if (!arr) return { ok: false, reason: "no jobs array" };
    return { ok: true, count: arr.length };
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// CHECK 1 — the build_dossier path, end to end against the live model.
async function checkDossier() {
  const resume = `Alex Morgan
Product Designer

EXPERIENCE
Lead Designer, Acme (2021-2024). Built the design system. Shipped the onboarding redesign.
Designer, Beta Co (2019-2021). Worked on the mobile app.

SKILLS: Figma, prototyping, design systems
EDUCATION: B.Des, NID 2019`;
  const t0 = Date.now();
  try {
    const { buildDossier } = await import("./dossier-build.mjs");
    const d = await buildDossier(resume);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const problems = [];
    if (d.name !== "Alex Morgan") problems.push(`name drifted: got ${JSON.stringify(d.name)} (grounding regression)`);
    if (!Array.isArray(d.proof_points) || d.proof_points.length === 0) problems.push("no proof_points (empty dossier)");
    if (typeof d.headline !== "string" || !d.headline.trim()) problems.push("missing headline");
    if (problems.length) return { name: "build_dossier", ok: false, detail: `built in ${secs}s but ${problems.join("; ")}` };
    return { name: "build_dossier", ok: true, detail: `ok in ${secs}s — name + ${d.proof_points.length} proof_points grounded` };
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const klass = e.status ? `HTTP ${e.status}` : e.error?.error?.type || e.name || "error";
    return { name: "build_dossier", ok: false, detail: `FAILED after ${secs}s (${klass}): ${(e.message || "").slice(0, 200)}` };
  }
}

// CHECK 1b — cheap Anthropic reachability (no Opus completion spent). On the days the weekly Opus
// build_dossier canary does NOT run, this still proves the key is valid + the API is up via a free
// GET /v1/models (the exact probe preflight.mjs uses), so daily coverage of "Anthropic reachable"
// never lapses. A non-2xx / timeout / network error is fail-closed (ok:false → alert).
async function checkAnthropicReachable() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { name: "anthropic", ok: false, detail: "ANTHROPIC_API_KEY not set" };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), Number(process.env.ANTHROPIC_PROBE_TIMEOUT_MS || 8000));
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: c.signal,
    });
    if (!r.ok) return { name: "anthropic", ok: false, detail: `GET /v1/models -> HTTP ${r.status}` };
    return { name: "anthropic", ok: true, detail: "reachable (GET /v1/models 200 — no Opus spent; weekly build canary runs Mon UTC / on HEALTH_FORCE_DOSSIER=1)" };
  } catch (e) {
    return { name: "anthropic", ok: false, detail: e.name === "AbortError" ? "GET /v1/models timeout (>8s)" : (e.message || String(e)).slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

// CHECK 2 — every ATS source in the watchlist still returns parseable jobs.
async function checkAtsSources() {
  let watchlist;
  try {
    watchlist = JSON.parse(readFileSync(WATCHLIST_PATH, "utf8"));
  } catch (e) {
    return [{ name: "watchlist", ok: false, detail: `could not read watchlist.json: ${e.message}` }];
  }
  const bySource = new Map();
  for (const e of watchlist) {
    const s = (e.source ?? "ashby").toLowerCase();
    if (!ENDPOINT[s]) continue;
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(e.slug);
  }
  const results = [];
  for (const [source, slugs] of bySource) {
    const sample = slugs.slice(0, SAMPLE_PER_SOURCE);
    const probes = await Promise.all(sample.map((slug) => fetchJobsArray(source, slug)));
    // Healthy = at least one sampled company returned a parseable jobs array (HTTP ok + shape).
    // That isolates a broken API (all samples error) from a company that just has no open roles.
    const resolved = probes.filter((p) => p.ok);
    const totalJobs = resolved.reduce((n, p) => n + p.count, 0);
    if (resolved.length === 0) {
      const reasons = [...new Set(probes.map((p) => p.reason))].join(", ");
      results.push({ name: `source:${source}`, ok: false, detail: `all ${sample.length} sampled companies failed (${reasons}) — API likely broke` });
    } else {
      results.push({ name: `source:${source}`, ok: true, detail: `${resolved.length}/${sample.length} resolved, ${totalJobs} jobs` });
    }
  }
  return results;
}

// CHECK 3 — the remote boards (RemoteOK / Remotive / Himalayas).
// `expected` must list exactly the boards scan-boards.mjs fetches: a source that is no longer fetched
// but still expected reports "boards down" forever, which trains the operator to ignore this check.
async function checkBoards() {
  const expected = ["remoteok", "remotive", "himalayas"];
  try {
    const { jobs, okSources } = await fetchBoardJobs(() => {});
    const missing = expected.filter((s) => !okSources.has(s));
    if (missing.length) return [{ name: "boards", ok: false, detail: `boards down: ${missing.join(", ")} (got ${jobs.length} jobs from ${[...okSources].join(", ") || "none"})` }];
    return [{ name: "boards", ok: true, detail: `all ${expected.length} boards up, ${jobs.length} jobs` }];
  } catch (e) {
    return [{ name: "boards", ok: false, detail: `board fetch threw: ${(e.message || "").slice(0, 160)}` }];
  }
}

async function sendAlert(failures, all) {
  const to = process.env.ALERT_EMAIL || process.env.CHARLIE_TO || process.env.OWNER_EMAIL || "";
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const key = process.env.RESEND_API_KEY;
  if (process.env.HEALTH_DRY_RUN === "1" || !key) {
    console.log(`alert: ${process.env.HEALTH_DRY_RUN === "1" ? "DRY RUN" : "Resend not configured"} — not sending (would alert ${to})`);
    return;
  }
  const line = (c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`;
  const subject = `⚠ Charlie health: ${failures.length} check${failures.length === 1 ? "" : "s"} failing`;
  const html =
    `<p><strong>${failures.length} Charlie health check(s) failing.</strong></p>` +
    `<p><strong>Failing:</strong></p><ul>${failures.map((c) => `<li>${line(c)}</li>`).join("")}</ul>` +
    `<p style="color:#888"><strong>Full report:</strong></p><ul style="color:#888">${all.map((c) => `<li>${line(c)}</li>`).join("")}</ul>`;
  try {
    const { data, error } = await new Resend(key).emails.send({ from, to, subject, html });
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    console.log(`alert: emailed ${failures.length} failure(s) -> ${to} (resend ${data?.id || "?"})`);
  } catch (e) {
    console.error(`alert: FAILED to send health alert: ${e.message}`); // monitor must never crash here
  }
}

async function main() {
  console.log(`[health] starting checks @ ${new Date().toISOString()}`);
  const checks = [];
  // The Opus build_dossier canary (~$0.5–1.0 Opus 4.8 + thinking) is pure monitoring of the ON-DEMAND
  // build path — a low-frequency path whose real regression risk is a deploy, not the gap between daily
  // runs. So run the full Opus build at most WEEKLY (a chosen UTC weekday, mirroring how digest.mjs
  // self-gates to Sunday) OR when forced for a deploy check (HEALTH_FORCE_DOSSIER=1). On every other day
  // substitute the FREE reachability probe above — no Opus completion spent — so daily coverage holds.
  // Real users' new-user builds still run the live Opus path regardless of this gate.
  const DOSSIER_CANARY_DAY = 1; // Monday (UTC); digest uses Sunday, so the weekly Opus build is staggered off it
  const runDossierCanary = process.env.HEALTH_FORCE_DOSSIER === "1" || new Date().getUTCDay() === DOSSIER_CANARY_DAY;
  console.log(`[health] dossier canary: ${runDossierCanary ? "Opus build (weekly/forced)" : "skipped — cheap GET /v1/models instead (no Opus spent)"}`);
  // run the checks concurrently; each already swallows its own errors into an ok:false result
  const [dossier, ats, boards] = await Promise.all([
    runDossierCanary ? checkDossier() : checkAnthropicReachable(),
    checkAtsSources(),
    checkBoards(),
  ]);
  checks.push(dossier, ...ats, ...boards);

  // Self-test hook: HEALTH_FORCE_FAIL=1 injects a synthetic failing check so you can verify
  // the alert pipeline (Resend -> your inbox) any time without waiting for a real outage.
  if (process.env.HEALTH_FORCE_FAIL === "1") {
    checks.push({ name: "self-test", ok: false, detail: "synthetic failure (HEALTH_FORCE_FAIL=1) — alert pipeline test, ignore" });
  }

  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  const failures = checks.filter((c) => !c.ok);
  console.log(`\n[health] ${checks.length - failures.length}/${checks.length} healthy`);

  if (failures.length) {
    await sendAlert(failures, checks);
    process.exitCode = 1;
  } else {
    console.log("[health] all green");
  }
}

main();
