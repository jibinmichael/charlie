// watchdog.mjs — the end-to-end + HONESTY canary. Charlie's failures aren't usually crashes, they're
// quiet untruths (a claimed interview that never happened, an uncited proof point, an em dash slipping
// into a send). This runs the checks that catch those BEFORE a user sees them, and emails the owner a
// report the moment anything is off. Uptime is table stakes; staying honest is the moat, so most of
// these checks assert honesty, not liveness.
//
//   node watchdog.mjs           # run once, print the report
//   node watchdog.mjs --cron    # run in the engine cron; email the owner only if something failed
//
// Read-only except for the alert email. Never mutates product data.

import { Resend } from "resend";
import { loadEnv, loadJobPool, canonicalJobIdentity, roleKey, loadEngineBuild } from "./charlie-store.mjs";
import { buildId } from "./lib/build-id.mjs"; // content hash of the running code (the cron has no /healthz)
import { homeRegion, reachableForRegion, languageBlocker } from "./quality-gate.mjs";
import { dailySendVerdict } from "./lib/daily-send-verdict.mjs"; // pure, unit-tested: did the send actually deliver?
import { unreachableCohort, unreachableDetail, routingAddress } from "./lib/unreachable-cohort.mjs"; // pure: who we serve but cannot reach
import { flagFingerprint } from "./lib/env-parity.mjs"; // hash of the config BOTH services share, for cross-service parity
import { repeatDecision } from "./presend-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import * as kit from "./email-kit.mjs";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs"; // a WARN line reaches a log; only Sentry reaches a person
import { heartbeatEnvKey } from "./lib/heartbeat.mjs";

loadEnv();
// captureError below is a NO-OP for Sentry unless this runs first: lib/sentry-node.mjs guards the
// send on an `_inited` flag, so without it the cohort-orphan alert degrades to a console.error that
// nobody reads. Every cron entry point initialises Sentry the same way.
initSentry({ name: "watchdog" });
const OWNER = process.env.WATCHDOG_TO || process.env.ALERT_EMAIL || process.env.OWNER_EMAIL || "";
const HEALTHZ = process.env.HEALTHZ_URL || "https://api.example.com/healthz";
/** @type {import("@supabase/supabase-js").SupabaseClient<import("./lib/database.types").Database>} */
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EM_DASH = /—/;
const results = [];
const add = (name, ok, detail = "") => results.push({ name, ok, detail });
// A WARNING is a real finding that must NOT change the exit code. watchdog is the last command in
// engine:run, so its exit status becomes the CONTAINER's: a failing config check would otherwise make
// the platform report a fully successful send as crashed. Reserve the non-zero exit for integrity
// breaches (a leak reached a user, evidence is missing), and warn for "configured wrong, nothing broken".
const warn = (name, ok, detail = "") => results.push({ name, ok, detail, warnOnly: true });

// ── HONESTY CHECKS (the ones that protect the moat) ───────────────────────────────────────────
// 1) No application stage may exist without evidence. "applied" needs a real applied_at; any advanced
//    stage (interview/offer/heard_back/rejected) needs meta.source. A stage without evidence is a
//    fabricated one, so the watchdog fails loudly if such a row ever exists.
async function checkApplicationEvidence() {
  const { data, error } = await s.from("applications").select("id,email,company,stage,applied_at,meta");
  if (error) return add("applications: evidence", false, `read failed: ${error.message}`);
  const bad = (data || []).filter((a) => !((a.stage === "applied" && a.applied_at) || (a.meta && a.meta.source)));
  add("applications: every stage has evidence", bad.length === 0, bad.length ? `${bad.length} unevidenced: ${bad.slice(0, 5).map((a) => `${a.company}:${a.stage}`).join(", ")}` : "");
}

// 2) Every dossier proof point must cite a source (resume/link/conversation). An uncited claim is an
//    invented one. Samples active candidates.
async function checkDossierSources() {
  const { data, error } = await s.from("candidates").select("email,dossier").eq("status", "active").limit(50);
  if (error) return add("dossiers: proof sources", false, `read failed: ${error.message}`);
  const offenders = [];
  for (const c of data || []) {
    const pps = Array.isArray(c.dossier?.proof_points) ? c.dossier.proof_points : [];
    if (pps.some((p) => p && p.claim && !p.source)) offenders.push(c.email);
  }
  add("dossiers: every proof point cites a source", offenders.length === 0, offenders.length ? `uncited in: ${offenders.slice(0, 5).join(", ")}` : "");
}

// ── RENDER CHECKS: no user-facing email ships an em dash or loses its unsubscribe ─────────────
function checkRenders() {
  const email = "watchdog@example.com";
  const cases = [
    ["welcome", () => kit.renderWelcome({ email, name: "Sam", ask: "remote, a city, or either?", strength: "shipped the checkout redesign" })],
    ["convoReply", () => kit.renderConvoReply({ email, changedText: "your pay floor", strength: "led the design system", ask: "the level you're targeting: senior, staff, lead?" })],
    ["digest", () => kit.renderWeeklyDigest({ email, name: "Sam", items: [{ role: "Designer", company: "Acme", location: "Remote", applyUrl: "https://x", note: "a fit for your profile" }] })],
    ["checkin", () => kit.renderCheckInNudge({ email, name: "Sam", company: "Acme", role: "Designer", boards: 1000 })],
    ["profile-nudge", () => kit.renderProfileNudge({ email, name: "Sam", headline: "designer, 5 yrs", missing: ["seniority"] })],
    ["track-ack", () => kit.renderTrackAck({ email, outcome: "applied", company: "Acme" })],
    ["missing-resume", () => kit.renderMissingResume({ email })],
  ];
  for (const [name, fn] of cases) {
    try {
      const m = fn();
      if (!m || !m.html || !m.text) { add(`render:${name}`, false, "missing html/text"); continue; }
      if (EM_DASH.test(m.html) || EM_DASH.test(m.text)) { add(`render:${name} no em dash`, false, "em dash present"); continue; }
      if (!/\/unsubscribe\?/.test(m.html)) { add(`render:${name} unsubscribe`, false, "no unsubscribe link"); continue; }
      add(`render:${name}`, true);
    } catch (e) {
      add(`render:${name}`, false, `threw: ${e.message}`);
    }
  }
}

// ── PRE-SEND GUARD (repeat + geo + language) ─────────────────────────────────────────────────────
// 6) Guard self-test: the known leak shapes MUST stay blocked. If someone weakens the guard logic,
//    this fails loudly before the next send goes out.
function checkGuardSelfTest() {
  try {
    const sig = { identities: new Set(["url:x/1"]), roleKeys: new Set(["acme::engineer"]), coreKeys: new Set(["acme::engineer"]), companies: [] };
    const repeatBlocked = !!repeatDecision({ company: "Acme", title: "Backend Engineer II", apply_url: "https://x/1?y=2" }, sig);
    const geoBlocked = reachableForRegion({ location: "United States (Remote)" }, "india") === false;
    const langBlocked = !!languageBlocker({ title: "Eng", description: "Fluent German required." }, { preferences: { languages: ["English"] } });
    const legitOk = repeatDecision({ company: "Fresh", title: "Designer", apply_url: "https://z/9" }, sig) === null
      && reachableForRegion({ location: "Remote" }, "india") === true
      && languageBlocker({ title: "Eng", description: "German market a plus." }, { preferences: { languages: ["English"] } }) === null;
    const ok = repeatBlocked && geoBlocked && langBlocked && legitOk;
    add("guard: repeat + geo + language still block (and legit still sends)", ok, ok ? "" : `repeat:${repeatBlocked} geo:${geoBlocked} lang:${langBlocked} legit:${legitOk}`);
  } catch (e) { add("guard: self-test", false, e.message); }
}

// 7) Post-hoc backstop: over roles EMAILED in the last 7 days, no user may have received the same
//    role twice (repeat), or a role that isn't reachable / needs a language they lack (eligibility).
async function checkSentIntegrity() {
  // Scan the REAL last 7 days of sends: if a foreign or repeated role reached a real user in the
  // last week, the owner hears about it, full stop.
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  // The owner's inbox is a test bench (deliberate US roundups, repeated test sends) — never a real
  // leak. Judge REAL users only, else the watchdog cries wolf every run.
  const MINE = new Set([OWNER.toLowerCase(), String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean));
  const { data: cands, error } = await s.from("candidates").select("email,dossier").eq("status", "active").limit(80);
  if (error) return add("sent integrity", false, `read failed: ${error.message}`);
  // Everything is SCANNED (nothing hidden), but the check only FAILS on a leak newer than
  // GUARD_FIX_SINCE. Older leaks are reported in the detail (visible, honest) and age out of the
  // window; they must not red-alert the owner forever (alert fatigue is the real danger). A single
  // NEW leak means a regression, and the owner hears about it.
  const FIX_SINCE = process.env.GUARD_FIX_SINCE || "2026-07-05T00:00:00Z";
  let repeats = 0, inelig = 0, newRepeats = 0, newInelig = 0; const rD = [], eD = [];
  for (const c of cands || []) {
    if (MINE.has(String(c.email).toLowerCase())) continue;
    const { data: finds } = await s.from("finds").select("job,created_at").eq("email", c.email).eq("status", "emailed").gte("created_at", since);
    const seenId = new Set(), seenRk = new Set(); const region = homeRegion(c.dossier);
    // Out-of-market: a candidate classified "other" (outside India+US) is not sent ANY role — the
    // scheduler drops them before scoring and sends one honest note instead. Auditing their
    // geo-eligibility here would flag earlier India sends as "ineligible", turning a healthy run red on
    // unactionable history. Skip them: there is nothing to audit.
    if (region === "other") continue;
    for (const f of finds || []) {
      const j = f.job || {}; const isNew = (f.created_at || "") >= FIX_SINCE;
      const id = canonicalJobIdentity(j), rk = roleKey(j.company, j.title);
      if (seenId.has(id) || (rk !== "::" && seenRk.has(rk))) { repeats++; if (isNew) newRepeats++; if (rD.length < 5) rD.push(`${isNew ? "NEW " : ""}${c.email}: ${j.company}/${j.title}`); }
      seenId.add(id); if (rk !== "::") seenRk.add(rk);
      if (!reachableForRegion(j, region) || languageBlocker(j, c.dossier)) { inelig++; if (isNew) newInelig++; if (eD.length < 5) eD.push(`${isNew ? "NEW " : ""}${c.email}: ${j.company} (${j.location || "?"})`); }
    }
  }
  const detail = (total, nu, ex) => `${nu} NEW since fix, ${total - nu} historical (aging out)${total ? `: ${ex.join(", ")}` : ""}`;
  add("no NEW repeat reached a user (7d; historical shown)", newRepeats === 0, detail(repeats, newRepeats, rD));
  add("no NEW ineligible role reached a user: geo/language (7d; historical shown)", newInelig === 0, detail(inelig, newInelig, eD));
}

// ── DID THE DAILY SEND ACTUALLY DELIVER? ──────────────────────────────────────────────────────
// Every other check in this file answers "is what we sent CORRECT?". This one answers "did we send
// AT ALL?" — a run can die on the cost ceiling, crash, or have every message refused at the door
// while every correctness check stays green. A check that can only pass is not a check.
//
// Two failures, each with an unambiguous signature in the data:
//
//   NOTHING PREPARED       zero `finds` created today. The run died before it scored anything (the
//                          cost-ceiling abort). With active users and a stocked pool this cannot
//                          happen legitimately — the scheduler writes a find for every role it
//                          routes, to a solo send OR to the digest.
//
//   PREPARED, NOT DELIVERED  finds created today are still 'new' or 'send_failed'. The scheduler
//                          writes a find as 'new' BEFORE the send and flips it to 'emailed' after, so
//                          either leftover is a send that was attempted and refused.
//
// Deliberately NOT "zero role emails today": an all-digest day (nobody clears the bar) is legitimate
// and would cry wolf. The leftover row is the honest signal — it means we TRIED and failed.
//
// --cron only: a manual local run at any hour must not red-alert on a day the cron has not run yet.
//
// STUCK = both shapes of "prepared but never delivered". 'send_failed' is what scheduler.mjs writes
// when a send throws (so the role is not burned for the person — see charlie-store STALE_NEW_HOURS);
// 'new' is what a run that died before reaching its own catch leaves behind.
const STUCK_STATUSES = ["new", "send_failed"];
async function checkDailySendDelivered() {
  if (!process.argv.includes("--cron")) return;
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const { count: active, error: aErr } = await s.from("candidates").select("email", { count: "exact", head: true }).eq("status", "active");
  if (aErr) return warn("daily send delivered", false, `could not read candidates: ${aErr.message}`);
  // Exclude 'dry_run' rows. A preview writes finds but sends nothing, so counting them as `prepared`
  // would let an operator's manual EMAIL_DRY_RUN mask a real aborted cron on the same day.
  //
  // COUNTED, NOT LISTED: fetching rows stops at Supabase's 1000-row default without erroring, so a
  // big day would silently cap and this check would report on a fraction of the day while sounding
  // certain.
  const { count: prepared, error: fErr } = await s.from("finds").select("status", { count: "exact", head: true }).gte("created_at", dayStart).neq("status", "dry_run");
  if (fErr) return warn("daily send delivered", false, `could not read finds: ${fErr.message}`);
  const { count: stuck, error: sErr } = await s.from("finds").select("status", { count: "exact", head: true }).gte("created_at", dayStart).neq("status", "dry_run").in("status", STUCK_STATUSES);
  if (sErr) return warn("daily send delivered", false, `could not read stuck finds: ${sErr.message}`);
  const v = dailySendVerdict({ active: active || 0, prepared: prepared || 0, stuck: stuck || 0 });
  add("daily send delivered", v.ok, v.detail);
}

// ── CAN THE PEOPLE WE SERVE ACTUALLY RECEIVE MAIL? ────────────────────────────────────────────
// The complement of checkDailySendDelivered. That one asks "did what we prepared go out?"; this asks
// "is there someone we never even prepare for, because their address is blocked?".
//
// scheduler.mjs drops suppressed recipients BEFORE scoring, which also removes them from the coverage
// denominator, so `silent_no_send` can never fire for them. A user whose `email_config.notify` points
// at a hard-bounced address would receive nothing while every run reports success. The scheduler
// names them in its own log and to Sentry; this is the independent check, so it still fires on a day
// the cron never ran.
//
// A FAILURE, not a warning: a person we accepted and are actively serving is receiving nothing. That is
// the same family as "prepared but not delivered", which this file already treats as a failure.
async function checkCohortReachable() {
  const { data: cands, error: cErr } = await s.from("candidates").select("email,status,email_config,created_at").eq("status", "active");
  if (cErr) return warn("cohort reachable", false, `could not read candidates: ${cErr.message}`);
  const routing = (cands || []).map((c) => routingAddress(c));
  const { data: sup, error: sErr } = await s.from("suppressions").select("address,reason").in("address", routing.length ? routing : ["-"]);
  // A read error is NOT all-clear. Warn rather than fail: we cannot prove a breach, and we must not
  // turn a healthy send into a CRASHED container on a transient Supabase error.
  if (sErr) return warn("cohort reachable", false, `could not read suppressions: ${sErr.message}`);
  const suppressed = new Map((sup || []).map((r) => [String(r.address).toLowerCase(), r.reason || "unknown"]));
  // Every active candidate is in the send pool (there is no allowlist), so the question worth
  // alarming on is: can the people we serve actually receive mail?
  const bad = unreachableCohort({ candidates: cands || [], suppressed });
  add(
    "every active user can actually receive mail",
    bad.length === 0,
    bad.length ? `${bad.length} of ${(cands || []).length} unreachable: ${unreachableDetail(bad)}` : `${(cands || []).length} active user(s), all reachable`,
  );
  if (bad.length) {
    captureError(
      new Error(`${bad.length} active user(s) cannot receive mail — ${unreachableDetail(bad)}`),
      { service: "watchdog", kind: "unreachable_cohort", count: bad.length },
    );
  }
}

// ── LIVENESS ──────────────────────────────────────────────────────────────────────────────────
let serverBuild = null; // filled by checkHealthz, compared by checkBuildParity below
async function checkHealthz() {
  try {
    const r = await fetch(HEALTHZ, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    serverBuild = j.build ?? null;
    add("server /healthz", r.ok && !!j.version, r.ok ? `version ${j.version}${j.build ? ` · build ${j.build}` : " · build UNKNOWN (pre-fingerprint deploy)"}` : `status ${r.status}`);
    checkFlagParity(j);
  } catch (e) { add("server /healthz", false, e.message); }
}

// WHAT CODE IS THE CRON RUNNING? The engine is a one-shot container with no HTTP surface, so
// preflight.mjs stamps a content hash of the running source at the start of every run (charlie-store
// saveEngineBuild); this reads it back and compares it to the server's.
//
// WARNINGS, not failures, all three: these are deploy-state facts, not user-facing integrity breaches,
// and a rolling deploy legitimately has the two services differ for a minute. Making them failures
// would turn ordinary deploys into CRASHED containers, which is how an exit code stops meaning anything.
async function checkBuildParity() {
  const local = buildId();
  const stamp = await loadEngineBuild();
  if (!stamp?.build) {
    return warn("build: the cron stamped what code it ran", false, "no engine build stamp found — either preflight has not run since this shipped, or the stamp write failed");
  }
  const ageH = stamp.at ? (Date.now() - Date.parse(stamp.at)) / 3600e3 : NaN;
  // Stale means the engine has not started a run in over a day. Inside engine:run this cannot fire
  // (preflight stamped minutes ago); run by hand, it is how you see that the cron stopped.
  warn(
    "build: the engine ran within the last 26h",
    Number.isFinite(ageH) && ageH <= 26,
    `last engine run ${stamp.at || "unknown"} (${Number.isFinite(ageH) ? `${ageH.toFixed(1)}h ago` : "unparseable"}) · build ${stamp.build} · ${stamp.files} file(s)`,
  );
  // The parity that matters: flag drift between the two services is invisible while their code is
  // also unverifiable.
  warn(
    "build: engine and server run the same code",
    !!serverBuild && serverBuild === stamp.build,
    serverBuild
      ? serverBuild === stamp.build
        ? `both on ${stamp.build}`
        : `DIVERGED — engine ${stamp.build}, server ${serverBuild}${local === stamp.build ? " (engine matches this tree)" : local === serverBuild ? " (server matches this tree)" : " (neither matches this tree)"}`
      : "server /healthz reports no build — cannot compare",
  );
}


// DO THE TWO SERVICES AGREE ON THE CONFIG THEY SHARE? A flag set on one service and not the other
// (or a secret like CHARLIE_TOKEN_SECRET missing from the engine) breaks things silently, because
// nothing else knows they are meant to agree.
//
// This runs inside the engine, so it can only see its OWN variables. The server publishes a hash of the
// shared non-secret set on /healthz (lib/env-parity.mjs, derived from the import graph — not a list
// anyone has to maintain), and we compare hashes. A mismatch proves disagreement without either service
// seeing the other's variables; `scripts/env-parity.mjs` is what then names the offending var, and this
// detail says so rather than leaving an operator to go looking.
//
// A WARNING: config drift is not a user-facing integrity breach, and watchdog's exit code becomes the
// container's status. Also unavoidable during a rolling deploy.
function checkFlagParity(healthz) {
  if (!healthz?.flags) {
    return warn("config: both services agree on the shared flags", false, "server /healthz reports no flag hash (pre-parity deploy) — cannot compare");
  }
  let mine;
  try { mine = flagFingerprint(); } catch (e) { return warn("config: both services agree on the shared flags", false, `could not fingerprint this service's config: ${e.message}`); }
  const same = mine.hash === healthz.flags;
  warn(
    "config: both services agree on the shared flags",
    same,
    same
      ? `both on ${mine.hash} (${mine.vars} shared non-secret var(s))`
      : `DIVERGED — engine ${mine.hash} (${mine.vars} var(s)), server ${healthz.flags} (${healthz.flagVars ?? "?"} var(s)). Run \`node scripts/env-parity.mjs\` to see WHICH var differs.`,
  );
}
async function checkPool() {
  try {
    const pool = await loadJobPool();
    add("job pool is stocked", Array.isArray(pool) && pool.length > 1000, `pool ${pool?.length ?? 0} roles`);
  } catch (e) { add("job pool is stocked", false, e.message); }
}

// ── Is the depth question ready to arm? ─────────────────────────────────────────────────────────
//
// The question email is built and DARK. The honest answer to "when do I turn it on" is not a date and
// not an auto-arm: it is a COUNT that nobody can see unless something surfaces it. The sweep logs its
// dry run every 12h, but platform logs are lost on every deploy.
//
// So this reports readiness into the watchdog mail. It is a WARNING-class line, never a failure: an
// unarmed feature is not an integrity breach, and a monitoring line must never make a healthy run
// look crashed (the exit-code rule above).
//
// IT DOES NOT ARM ANYTHING. A gate that acts on a number no human has read is exactly the risk; a
// person reads the dry output, then sets DEPTH_QUESTION=on.
async function checkDepthQuestionReady() {
  try {
    const { listActiveCandidates, getFinds } = await import("./charlie-store.mjs");
    const { storedCoverages, questionFor, depthQuestionMode } = await import("./depth-question.mjs");
    const people = await listActiveCandidates();
    let ready = 0;
    let sample = "";
    for (const p of people) {
      const finds = await getFinds(p.email, { status: "digest", limit: 12 }).catch(() => []);
      const q = questionFor(storedCoverages(finds));
      if (!q) continue;
      ready++;
      if (!sample) sample = `e.g. "${q.gap}" (${q.count} of ${q.total})`;
    }
    const mode = depthQuestionMode();
    warn(
      "depth question: people with a real question waiting",
      mode !== "off" || ready === 0, // once armed, or while nobody is ready, this is simply quiet
      `${ready} of ${people.length} ready · DEPTH_QUESTION=${mode}${sample ? ` · ${sample}` : ""}`,
    );
  } catch (e) {
    warn("depth question: people with a real question waiting", true, `not measured (${e.message})`);
  }
}

// ── Observability config ────────────────────────────────────────────────────────────────────
// A heartbeat that was never configured is INVISIBLE: lib/heartbeat.mjs treats a missing env var as
// a silent no-op (no log, no warning), which is correct — monitoring must never break the job it
// watches — but it means "nobody set this up" and "everything is fine" look identical.
//
// This lives in the WATCHDOG, deliberately not in preflight. preflight aborts the `&&` chain, so a
// missing monitoring URL there could kill the daily send. A monitoring gap must never block a send.
// The watchdog runs after the send behind `;` and can only report.
//
// yc_ingest and india_ingest matter most: both jobs are fail-open by design (they always exit 0), so
// the heartbeat is their ONLY failure signal. Their coverage can decay to zero with no other symptom.
const HEARTBEAT_JOBS = [
  ["match_send", "the daily role send stopped running"],
  ["coverage", "an active user got NOTHING (no role, no digest)"],
  ["ats_poll", "the ATS scanner stopped producing roles"],
  ["yc_ingest", "YC ingestion stopped — fail-open job, no other failure signal"],
  ["india_ingest", "India ingestion stopped — fail-open job, no other failure signal"],
];
// These are WARNINGS, not failures: a missing monitor URL means we would not SEE a future problem,
// it does not mean one happened. They still surface in the log and the owner alert.
function checkHeartbeatConfig() {
  const dark = HEARTBEAT_JOBS.filter(([job]) => !process.env[heartbeatEnvKey(job)]);
  warn(
    "observability: every heartbeat has a monitor URL",
    dark.length === 0,
    dark.length ? `${dark.length} dark — ${dark.map(([job, lost]) => `${heartbeatEnvKey(job)} (${lost})`).join("; ")}` : `${HEARTBEAT_JOBS.length} configured`,
  );
  // Sentry is the backstop for silent_no_send; without it that event reaches nothing but a log.
  warn("observability: SENTRY_DSN set (error reports reach a human)", !!process.env.SENTRY_DSN, process.env.SENTRY_DSN ? "" : "unset — captureError degrades to console.error only");
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
checkHeartbeatConfig();
await checkApplicationEvidence();
await checkDossierSources();
checkRenders();
checkGuardSelfTest();
await checkSentIntegrity();
await checkDailySendDelivered();
await checkCohortReachable();
await checkHealthz();
await checkBuildParity(); // AFTER checkHealthz — it compares against the build /healthz reported
await checkPool();
await checkDepthQuestionReady();

// Split the two: a FAILURE is an integrity breach (exit non-zero, which becomes the container's
// status). A WARNING is a config gap — reported and emailed, but it must never make a healthy run
// look crashed.
const failed = results.filter((r) => !r.ok && !r.warnOnly);
const warned = results.filter((r) => !r.ok && r.warnOnly);
for (const r of results) console.log(`${r.ok ? "PASS" : r.warnOnly ? "WARN" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
console.log(
  `\n${failed.length ? `WATCHDOG: ${failed.length} FAILURE(S)` : `WATCHDOG: all ${results.length - warned.length} checks passed`}` +
    (warned.length ? ` · ${warned.length} WARNING(S) (config gaps — not a failure)` : ""),
);

if (failed.length && (process.argv.includes("--cron") || process.argv.includes("--alert"))) {
  const RESEND = process.env.RESEND_API_KEY;
  if (RESEND && OWNER) {
    const list = failed.map((r) => `- ${r.name}${r.detail ? `: ${r.detail}` : ""}`).join("\n");
    // Warnings ride along for context when an alert is already going out, but never trigger one on
    // their own — a standing config gap would otherwise email every single day until fixed.
    const warnList = warned.length ? `\n\nWarnings (config gaps, not failures):\n${warned.map((r) => `- ${r.name}${r.detail ? `: ${r.detail}` : ""}`).join("\n")}` : "";
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#15171C;"><p><b>Charlie watchdog: ${failed.length} check(s) failed.</b></p><pre style="background:#F6F7F9;padding:12px;border-radius:8px;white-space:pre-wrap;">${(list + warnList).replace(/</g, "&lt;")}</pre><p style="color:#6A6F7A;">${results.length - failed.length - warned.length}/${results.length - warned.length} passed. Read-only canary. Nothing was changed.</p></div>`;
    try {
      const { data, error } = await new Resend(RESEND).emails.send({ from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to: OWNER, subject: `⚠ Charlie watchdog: ${failed.length} failing`, html, text: `Charlie watchdog: ${failed.length} failed.\n\n${list}${warnList}\n\n${results.length - failed.length - warned.length}/${results.length - warned.length} passed.` });
      // Resend reports most failures (bad key, unverified sender) as { error }, not by throwing.
      if (error) throw new Error(typeof error === "string" ? error : error.message || JSON.stringify(error));
      console.log(`alert emailed to ${OWNER} (resend ${data?.id || "?"})`);
    } catch (e) { console.error(`alert email failed: ${e.message}`); }
  }
}
// Flush before exiting. process.exit() is immediate, and Sentry batches — a one-shot cron that
// reports and then exits can drop the event it just captured, which would leave the alert just as
// unheard as the WARN line it replaced. Best-effort and capped, so it can never hang the container.
await flushSentry();
process.exit(failed.length ? 1 : 0);
