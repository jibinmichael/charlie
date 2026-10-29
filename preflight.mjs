// preflight.mjs — the SYSTEM-level self-heal that runs BEFORE anything sends. Charlie's rule is
// fail CLOSED: we would rather send NOTHING than send something we're half-confident about. So the
// daily cron runs this FIRST — if we cannot PROVE the system is healthy, we send nothing and alert
// the owner. It exits non-zero (aborting the scan + scheduler in the `&&` chain) the moment any
// check fails, emailing the owner a clear reason.
//
//   node preflight.mjs                    # every check (manual use)
//   node preflight.mjs --phase=pre-scan   # system health — runs FIRST in the cron chain
//   node preflight.mjs --phase=pre-send   # pool health — runs AFTER scan-jobs, gates the send
//
// PHASES — why this is split. scan-jobs is the ONLY thing that refreshes the pool, so if the pool
// checks (2 + 3) ran before it, a pool that aged past POOL_MAX_AGE_HOURS would abort the chain
// before the scan could run — which ages the pool further: a deadlock that can never self-heal. The
// pool checks gate the SEND, not the run, so they run AFTER the scanner. This is still fail-closed —
// a pool the scanner failed to refresh blocks the send — but a merely-stale pool triggers a scan
// instead of a permanent abort.
//
// Checks (all must pass):
//   [pre-scan]
//   1. guard logic intact   — the 3 canonical leaks still BLOCK and a legit role still passes.
//   [pre-send]
//   2. job pool healthy     — loadJobPool() length > 1000.
//   3. job pool fresh        — the pool was scanned within POOL_MAX_AGE_HOURS (default 48). A
//                              stale-but-large pool means the scanner silently stopped producing
//                              fresh roles; matching off it is garbage. Fail-closed: an unknown
//                              scan-time is treated as STALE.
//   [pre-scan]
//   4. Supabase reachable   — a trivial select on candidates (limit 1) succeeds.
//   5. Anthropic reachable   — a cheap GET /v1/models proves the key is valid AND the API is up
//                              (no completion spent). We cannot compose/verify without it, so a
//                              down or unauthorized API aborts the run.
//   6. required env present  — ANTHROPIC_API_KEY + SUPABASE_SERVICE_ROLE_KEY + RESEND_API_KEY +
//                              CHARLIE_FROM all set and non-trivial (no real Anthropic call spent).
//
// Read-only except the alert email and the build stamp (see stampBuild — an observability record of
// what code this run is, never product data).

import { Resend } from "resend";
import { loadEnv, loadJobPool, loadJobPoolStats, store, saveEngineBuild } from "./charlie-store.mjs";
import { buildId, buildFiles } from "./lib/build-id.mjs"; // what code is actually running (content hash)
import { repeatDecision } from "./presend-guard.mjs";
import { reachableForRegion, languageBlocker, homeRegion } from "./quality-gate.mjs";

loadEnv();
const OWNER = process.env.WATCHDOG_TO || process.env.ALERT_EMAIL || process.env.OWNER_EMAIL || "";

const results = [];
const add = (name, ok, detail = "") => results.push({ name, ok, detail });

// ── 1) Guard logic intact ─────────────────────────────────────────────────────────────────────
// Pure, no-network assertions that the three canonical production leaks stay blocked AND a legit
// role still passes every gate. Exported so preflight.test.mjs can unit-test it without a run.
export function checkGuardLogic() {
  try {
    const sig = {
      identities: new Set(["url:boards.greenhouse.io/hackerrank/jobs/123"]),
      roleKeys: new Set(["hackerrank::software engineer"]),
      coreKeys: new Set(["hackerrank::software engineer"]),
      companies: [],
    };
    // leak A — retitled repost, SAME canonical apply_url (title-blind, id-blind) → must block on identity.
    const repeatBlocked =
      repeatDecision(
        { company: "HackerRank", title: "Backend Engineer II", apply_url: "https://boards.greenhouse.io/hackerrank/jobs/123?utm=x" },
        sig,
      )?.rule === "repeat:identity";
    // leak B — US-only-remote role is NOT reachable for an India candidate.
    const geoBlocked = reachableForRegion({ location: "United States (Remote)" }, "india") === false;
    // leak C — "fluent German required" blocks an english-only dossier.
    const langBlocked = !!languageBlocker(
      { title: "Backend Engineer", description: "You must be fluent in German. Fluent German required." },
      { preferences: { languages: ["English"] } },
    );
    // a legit role must still pass all three: fresh company, genuinely remote, no language demand.
    const legitOk =
      repeatDecision({ company: "Stripe", title: "Software Engineer", apply_url: "https://stripe.com/jobs/9" }, sig) === null &&
      reachableForRegion({ location: "Remote" }, "india") === true &&
      languageBlocker({ title: "Engineer", description: "German market experience a plus." }, { preferences: { languages: ["English"] } }) === null &&
      homeRegion({ headline: "Product Designer based in Bengaluru" }) === "india";

    const ok = repeatBlocked && geoBlocked && langBlocked && legitOk;
    return { ok, detail: ok ? "" : `repeat:${repeatBlocked} geo:${geoBlocked} lang:${langBlocked} legit:${legitOk}` };
  } catch (e) {
    return { ok: false, detail: `threw: ${e.message}` };
  }
}

// ── 4) Required env present ───────────────────────────────────────────────────────────────────
// Non-trivial = present and long enough to be a real key/value (never a real API call — preflight
// must be cheap and side-effect-free apart from the alert). Exported for the unit test.
export function checkRequiredEnv(env = process.env) {
  const REQUIRED = ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "CHARLIE_FROM"];
  const missing = [];
  for (const k of REQUIRED) {
    const v = env[k];
    // CHARLIE_FROM is an email (short); keys must be non-trivial (>= 12 chars). Any missing/blank fails.
    const min = k === "CHARLIE_FROM" ? 5 : 12;
    if (!v || String(v).trim().length < min) missing.push(k);
  }
  return { ok: missing.length === 0, detail: missing.length ? `missing/trivial: ${missing.join(", ")}` : "", missing };
}

// ── Pool freshness (pure) ─────────────────────────────────────────────────────────────────────
// Given the current time and the freshest scan signal (an ISO string or ms epoch), decide fresh vs
// stale. Fail-CLOSED: an unknown/unparseable scan-time is STALE (we can't prove the pool is fresh,
// so we abort rather than send off a maybe-stale pool). Threshold is POOL_MAX_AGE_HOURS (default 48)
// — wide enough not to false-abort a healthy daily scan (which refreshes every ~24h), tight enough
// to catch a scanner that silently stopped. Exported so it's unit-testable without a network read.
export function assessPoolFreshness(nowMs, lastScanAt, maxAgeHours = Number(process.env.POOL_MAX_AGE_HOURS || 48)) {
  const t = typeof lastScanAt === "number" ? lastScanAt : (lastScanAt ? Date.parse(lastScanAt) : NaN);
  if (!Number.isFinite(t)) return { fresh: false, detail: "no scan timestamp — treating as STALE (fail-closed)", ageHours: null };
  const ageHours = (nowMs - t) / 3.6e6;
  const fresh = ageHours <= maxAgeHours;
  const age = ageHours >= 0 ? `${ageHours.toFixed(1)}h old` : `future-dated ${Math.abs(ageHours).toFixed(1)}h`;
  return { fresh, detail: `pool scanned ${age} (max ${maxAgeHours}h)`, ageHours };
}

// Pull the freshest scan signal from whatever the scanner persists: prefer the stats.json updatedAt
// (written every scan), fall back to the max last_seen/first_seen across the pool.
function freshestScanSignal(stats, pool) {
  const candidates = [];
  const push = (v) => { const t = typeof v === "number" ? v : (v ? Date.parse(v) : NaN); if (Number.isFinite(t)) candidates.push(t); };
  if (stats) { push(stats.updatedAt); push(stats.updated_at); push(stats.scannedAt); push(stats.scanned_at); }
  if (Array.isArray(pool)) for (const j of pool) { push(j?.last_seen); push(j?.first_seen); }
  return candidates.length ? Math.max(...candidates) : null;
}

// ── Anthropic reachability parsing (pure) ─────────────────────────────────────────────────────
// Map a GET /v1/models outcome to a preflight verdict WITHOUT spending a completion. 200 → the key
// is valid and the API is up. 401/403 → a bad/blocked key (fail). Any other status or a thrown
// network/timeout error → we can't prove Anthropic is reachable, so fail-CLOSED (we can't compose
// or verify without it anyway). Exported so it's unit-testable without a live call.
export function assessAnthropicResult({ status, errorMessage } = {}) {
  if (errorMessage) return { ok: false, detail: `unreachable: ${errorMessage}` };
  if (status === 200) return { ok: true, detail: "GET /v1/models 200 (key valid, API up)" };
  if (status === 401 || status === 403) return { ok: false, detail: `auth failed (HTTP ${status}) — bad or blocked key` };
  return { ok: false, detail: `unexpected HTTP ${status} — cannot confirm reachability` };
}

async function checkPool() {
  try {
    const pool = await loadJobPool();
    const n = Array.isArray(pool) ? pool.length : 0;
    return { ok: n > 1000, detail: `pool ${n} roles` };
  } catch (e) {
    return { ok: false, detail: `load failed: ${e.message}` };
  }
}

async function checkSupabase() {
  try {
    const { error } = await store().from("candidates").select("email").limit(1);
    if (error) return { ok: false, detail: `select failed: ${error.message}` };
    return { ok: true, detail: "candidates select ok" };
  } catch (e) {
    return { ok: false, detail: `unreachable: ${e.message}` };
  }
}

// 3) Pool freshness — the pool must be recently scanned, not just large. Reads the freshest scan
// signal (stats.json updatedAt, else max last_seen/first_seen in the pool) and compares to the age
// threshold. Fail-closed on a missing/unreadable signal (unknown → STALE).
async function checkPoolFreshness(nowMs = Date.now()) {
  try {
    const stats = await loadJobPoolStats().catch(() => null);
    let pool = null;
    // Only fall back to scanning the pool for timestamps when stats gave us nothing (avoids a second
    // large download when stats.json already carries a fresh updatedAt).
    const fromStats = freshestScanSignal(stats, null);
    if (fromStats == null) { pool = await loadJobPool().catch(() => []); }
    const lastScanAt = fromStats ?? freshestScanSignal(null, pool);
    return assessPoolFreshness(nowMs, lastScanAt);
  } catch (e) {
    return { fresh: false, detail: `freshness read failed: ${e.message} — treating as STALE (fail-closed)`, ageHours: null };
  }
}

// 5) Anthropic reachability — a cheap GET /v1/models (no completion spent) proves the key is valid
// and the API is up. Short timeout (~8s); a timeout/network error is fail-closed.
async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, detail: "ANTHROPIC_API_KEY not set" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.ANTHROPIC_PROBE_TIMEOUT_MS || 8000));
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: ac.signal,
    });
    return assessAnthropicResult({ status: res.status });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout (>8s)" : (e?.message || String(e));
    return assessAnthropicResult({ errorMessage: msg });
  } finally {
    clearTimeout(timer);
  }
}

// Which checks belong to which phase. See the PHASES note in the header comment: the pool checks
// MUST run after the scanner, never before it, or a stale pool becomes unrecoverable.
const PRE_SCAN = "pre-scan";
const PRE_SEND = "pre-send";

// STAMP WHAT CODE THIS RUN IS. The engine service has no HTTP surface, so the stamp is the only way
// to ask the cron what it is running (`railway up` ships the working tree from whichever machine ran
// it). The stamp goes down HERE, in the first step of engine:run, so even a run that aborts leaves a
// record of when it started and with what code.
//
// Fingerprint, not a version constant: equal hand-bumped versions do not prove equal code. Fail SOFT
// and never throw — a monitoring write must not be able to abort a send.
async function stampBuild(phase) {
  const build = buildId();
  const files = buildFiles().length;
  console.log(`[preflight] build ${build || "UNKNOWN"} (${files} source file(s)) · node ${process.version} · phase ${phase}`);
  try {
    await saveEngineBuild({ build, files, at: new Date().toISOString(), phase, service: process.env.RAILWAY_SERVICE_NAME || "local", node: process.version });
  } catch (e) {
    console.error(`[preflight] build stamp not recorded (${e.message}) — the run continues; the watchdog will report the stamp as stale`);
  }
}

async function run(phase = "all") {
  const wants = (p) => phase === "all" || phase === p;

  if (wants(PRE_SCAN)) {
    // Before any check, so an ABORTED run still says which code aborted.
    await stampBuild(phase);

    // 4) env first — the other checks NEED some of these vars, so a clear "missing X" beats a cryptic
    //    downstream failure. Still run every check so the report lists all problems at once.
    const env = checkRequiredEnv();
    add("required env present (ANTHROPIC/SUPABASE/RESEND/CHARLIE_FROM)", env.ok, env.detail);

    const guard = checkGuardLogic();
    add("guard logic intact (repeat + geo + language block; legit passes)", guard.ok, guard.detail);

    const supa = await checkSupabase();
    add("supabase reachable (candidates select)", supa.ok, supa.detail);

    // Anthropic must be UP and the key VALID (not just present) — we can't compose or verify without it.
    const anthropic = await checkAnthropic();
    add("anthropic reachable (GET /v1/models, no completion spent)", anthropic.ok, anthropic.detail);
  }

  if (wants(PRE_SEND)) {
    // Pool checks gate the SEND, not the run. They run AFTER scan-jobs, so a stale pool makes the
    // scanner run (and usually fixes itself); only a pool the scanner FAILED to refresh blocks a send.
    const pool = await checkPool();
    add("job pool healthy (> 1000 roles)", pool.ok, pool.detail);

    const fresh = await checkPoolFreshness();
    add(`job pool fresh (scanned within ${Number(process.env.POOL_MAX_AGE_HOURS || 48)}h)`, fresh.fresh, fresh.detail);
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    console.log(`\nPREFLIGHT${phase === "all" ? "" : ` [${phase}]`}: all ${results.length} checks passed — cron may proceed.`);
    return 0;
  }

  console.log(`\nPREFLIGHT${phase === "all" ? "" : ` [${phase}]`}: ${failed.length} FAILURE(S) — ABORTING the run (fail-closed: sending nothing).`);
  await alertOwner(failed);
  return 1;
}

async function alertOwner(failed) {
  const RESEND = process.env.RESEND_API_KEY;
  const from = process.env.CHARLIE_FROM;
  if (!RESEND || !from) {
    console.error(`[preflight] cannot send alert (RESEND_API_KEY/CHARLIE_FROM missing) — aborting anyway.`);
    return;
  }
  const list = failed.map((r) => `- ${r.name}${r.detail ? `: ${r.detail}` : ""}`).join("\n");
  const passed = results.length - failed.length;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#15171C;"><p><b>Charlie preflight FAILED — the daily run was aborted before any email went out.</b></p><pre style="background:#F6F7F9;padding:12px;border-radius:8px;white-space:pre-wrap;">${list.replace(/</g, "&lt;")}</pre><p style="color:#6A6F7A;">${passed}/${results.length} passed. Fail-closed: we send nothing when we can't prove the system is healthy. Read-only canary. Nothing was changed.</p></div>`;
  try {
    const { data, error } = await new Resend(RESEND).emails.send({
      from,
      to: OWNER,
      subject: `⛔ Charlie preflight FAILED (${failed.length}) — daily run aborted`,
      html,
      text: `Charlie preflight FAILED — daily run aborted before any send.\n\n${list}\n\n${passed}/${results.length} passed. Fail-closed.`,
    });
    // Resend reports most failures (bad key, unverified sender) as { error }, not by throwing.
    if (error) throw new Error(typeof error === "string" ? error : error.message || JSON.stringify(error));
    console.log(`alert emailed to ${OWNER} (resend ${data?.id || "?"})`);
  } catch (e) {
    console.error(`[preflight] alert email failed: ${e.message}`);
  }
}

// Run only when invoked as a script (not when imported by the test).
// `--phase=pre-scan` / `--phase=pre-send`; no flag = every check (manual `npm run preflight`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const phaseArg = process.argv.find((a) => a.startsWith("--phase="))?.slice("--phase=".length) || "all";
  if (![PRE_SCAN, PRE_SEND, "all"].includes(phaseArg)) {
    console.error(`[preflight] unknown --phase=${phaseArg} (expected ${PRE_SCAN}, ${PRE_SEND}, or omit)`);
    process.exit(1);
  }
  run(phaseArg)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[preflight] fatal: ${e.message}`);
      process.exit(1);
    });
}
