// charlie-store.mjs — the per-user Supabase seam (backend only).
//
// The engine reads a user's dossier from `candidates` and writes that user's finds
// to `finds`, keyed by email. Everything here uses the SERVICE ROLE key and must
// only ever run server-side — never ship this key to a client.
//
// Tables (RLS enabled, no anon policies — the service role bypasses RLS):
//   candidates(email pk, dossier jsonb, email_config jsonb, status, ...)
//   finds(id pk "<email>:<job id>", email -> candidates, job, match, composed, status, ...)

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseEnv } from "./lib/dotenv.mjs"; // .env.local parsing (inline comments, quotes)
import { capKeepingRequirements } from "./lib/jd-requirements.mjs"; // the pool cap must keep a posting's requirements
import { advance, watchdogFor } from "./journey.mjs"; // pure journey model (states + transitions)
import { MATCHER_VERSION } from "./lib/matcher-version.mjs"; // version stamped on every find
import { captureError } from "./lib/sentry-node.mjs"; // a gated find written with no rule is an alert, not a null
import { retainDecision } from "./lib/digest-retention.mjs"; // fit-shaped digest rows only

/**
 * The typed Supabase service-role client. The `Database` type is generated from the LIVE
 * schema (`npm run db:types` -> lib/database.types.ts), so `tsc --checkJs` flags any query
 * against a table or column that does not exist in production. Regenerate types after any
 * migration.
 * @typedef {import("@supabase/supabase-js").SupabaseClient<import("./lib/database.types").Database>} DbClient
 */

const here = dirname(fileURLToPath(import.meta.url));

// Plain Node doesn't auto-load .env.local; pull keys from it (and .env) without
// overriding anything already set in the real environment.
export function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const p = join(here, file);
    if (!existsSync(p)) continue;
    // Standard dotenv rules (lib/dotenv.mjs): an unquoted value loses a trailing " # comment".
    for (const [name, value] of parseEnv(readFileSync(p, "utf8"))) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  }
}

// Which user this engine run is for. CHARLIE_USER_EMAIL is the key into the store;
// it falls back to CHARLIE_TO (the existing single-user notify address).
export function userEmail() {
  const e = (process.env.CHARLIE_USER_EMAIL || process.env.CHARLIE_TO || "").trim().toLowerCase();
  if (!e) throw new Error("no user email — set CHARLIE_USER_EMAIL (or CHARLIE_TO) in .env.local");
  return e;
}

/** @type {DbClient | null} */
let _client = null;
/** @returns {DbClient} the typed service-role client (schema-checked via database.types.ts) */
export function store() {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "missing Supabase backend env — set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.\n" +
        "the engine reads/writes with the SERVICE ROLE (backend only); never expose that key to a client.",
    );
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// ── tenant isolation ─────────────────────────────────────────────────────────
// EVERY query that touches per-user data MUST go through scoped(email). It binds the
// email filter to selects/updates/deletes and stamps it onto writes, so a query
// physically cannot forget to scope to one user. Calling store().from('candidates'|
// 'finds') directly outside this file is a bug. The ONE deliberate cross-tenant read
// is listActiveCandidates (clearly named + commented); 'suppressions' is a global
// do-not-send list, not per-user data.
function requireEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw new Error("tenant scope requires an email — refusing an unscoped query");
  return e;
}
function scoped(email) {
  const e = requireEmail(email);
  // The tenant-isolation seam takes the table name as a runtime argument by design, so the typed
  // client can't resolve it to a specific table (dynamic `.from(table)` yields no per-column type).
  // Opt this seam out of the schema types; direct `store().from('<literal>')` callers keep them.
  const db = /** @type {any} */ (store());
  return {
    email: e,
    // both candidates (pk) and finds (fk) carry an `email` column
    select: (table, cols = "*") => db.from(table).select(cols).eq("email", e),
    update: (table, patch) => db.from(table).update(patch).eq("email", e),
    delete: (table) => db.from(table).delete().eq("email", e),
    upsert: (table, row, opts) => db.from(table).upsert({ ...row, email: e }, opts),
  };
}

// ── candidates ───────────────────────────────────────────────────────────────
export async function upsertCandidate(email, dossier, emailConfig) {
  const row = { dossier, updated_at: new Date().toISOString() };
  if (emailConfig !== undefined) row.email_config = emailConfig;
  const { error } = await scoped(email).upsert("candidates", row, { onConflict: "email" });
  if (error) throw new Error(`candidates upsert failed: ${error.message}`);
}

// Returns the dossier object for an email, or null if the user isn't in the store.
export async function getDossier(email) {
  const { data, error } = await scoped(email).select("candidates", "dossier, status").maybeSingle();
  if (error) throw new Error(`candidates read failed: ${error.message}`);
  return data?.dossier ?? null;
}

// Full candidate row (dossier + email_config + status), or null if missing.
export async function getCandidate(email) {
  const { data, error } = await scoped(email)
    .select("candidates", "email, dossier, email_config, status, created_at, updated_at")
    .maybeSingle();
  if (error) throw new Error(`candidates read failed: ${error.message}`);
  return data ?? null;
}

// Every ACTIVE candidate with the bits the scheduled engine needs (email, dossier,
// email_config). Used by scheduler.mjs to process all users in one run. Service-role
// only; never exposed to a client. `limit` is a coarse safety cap on fan-out.
/**
 * The column each table can be paged by: unique, stable, and present.
 *
 * NOT EVERY TABLE HAS AN `id`, and four of them are the ones that matter. `candidates` is keyed by
 * `email` and is already past a thousand rows; `suppressions` by `address`; `match_verdicts` by
 * `cache_key`. Defaulting to `id` for those does not page them wrongly, it throws, which is the
 * correct half of fail-closed: a send script stops dead rather than quietly reading a partial
 * suppression list.
 *
 * Keyed to the live schema: the generated types can list an `id` on `candidates` that the database
 * does not have.
 */
const PAGE_KEY = {
  candidates: "email",
  suppressions: "address",
  match_verdicts: "cache_key",
  join_applicants: "email",
};

/**
 * Read EVERY row, not the first thousand.
 *
 * WHY THIS EXISTS AT THE SEAM. Supabase/PostgREST caps a response at 1000 rows by default and returns
 * SUCCESS. There is no error, no exception, and no signal of any kind that you are holding a fraction
 * of the table. A short read is indistinguishable from a complete one, and every caller that measured
 * `data.length` and reported a number would be reporting confidently on a subset: people silently
 * missing from a run, or already-contacted people looking never-contacted on a send list.
 *
 * WHAT MAKES THIS CLASS DIFFERENT from other silent failures is the THRESHOLD.
 * The code is correct while the table is small and becomes wrong the moment it is not, with nothing in
 * the file changing. It cannot be found by reading the diff, because there is no diff.
 *
 * FAILS CLOSED: a read error throws rather than returning what it managed to fetch, because a partial
 * answer is the whole problem.
 *
 * PAGING WITHOUT AN ORDER BY IS NOT PAGING. This is the second half of the same problem and it is
 * worse than the first, because it returns the right COUNT. Postgres gives no row-order guarantee between
 * two queries, so `.range(0,999)` then `.range(1000,1999)` can hand back overlapping windows of a
 * shifting order: some rows twice, others never, with the total still looking complete.
 *
 * So every page is ordered by `id`, which is unique and stable on every table here. A caller's own
 * `.order()` inside `narrow` still applies and is applied FIRST; this is appended as the tiebreak, so
 * sorting by score or date stays intact while the page boundary stops moving underneath it.
 *
 * @param {string} table
 * @param {string} cols
 * @param {(q: any) => any} [narrow] applied to each page's query, e.g. q => q.eq("status", "active")
 * @param {string} [orderKey] unique, stable column to page by. Defaults per table, see PAGE_KEY.
 */
export async function readAll(table, cols = "*", narrow, orderKey, client = null) {
  orderKey = orderKey || PAGE_KEY[table] || "id";
  const PAGE = 1000;
  let rows = [], from = 0;
  for (;;) {
    // `client` lets a caller that was handed a client (a router under test, a branch) page through
    // it; the default is the one service-role client, as before.
    let q = (client || store()).from(table).select(cols);
    if (narrow) q = narrow(q);
    // Appended after the caller's own ordering, so it breaks ties rather than replacing intent.
    q = q.order(orderKey, { ascending: true }).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

export async function listActiveCandidates({ limit = 1000 } = {}) {
  const { data, error } = await store()
    .from("candidates")
    .select("email, dossier, email_config, created_at")
    .eq("status", "active")
    .limit(limit);
  if (error) throw new Error(`candidates list failed: ${error.message}`);
  return data ?? [];
}

// Active candidates with signup time + email_config, for lifecycle emails (e.g. the
// day-after-signup thesis note). email_config carries our per-user send flags (thesis_sent_at).
export async function listNewsletterCandidates({ limit = 1000 } = {}) {
  const { data, error } = await store()
    .from("candidates")
    .select("email, dossier, email_config, created_at")
    .eq("status", "active")
    .limit(limit);
  if (error) throw new Error(`newsletter candidates list failed: ${error.message}`);
  return data ?? [];
}

// Upsert a draft/built dossier for a user, with an explicit status (e.g.
// 'screening' for a first draft, 'active' once a human has confirmed it). Creates
// the candidate row if it doesn't exist. Acts only on `email`.
export async function saveDossier(email, dossier, status = "screening") {
  const { error } = await scoped(email).upsert(
    "candidates",
    { dossier, status, updated_at: new Date().toISOString() },
    { onConflict: "email" },
  );
  if (error) throw new Error(`candidates upsert failed: ${error.message}`);
}

// Set ONLY a candidate's status (e.g. 'active' → 'unsubscribed' to pull a dead/test user
// out of the scanned+emailed pool, or back to 'active' on return). Dossier + email_config are
// left untouched, so it is fully reversible. Scoped to the one email via the tenant seam.
export async function setCandidateStatus(email, status) {
  const s = String(status || "").trim();
  if (!s) throw new Error("setCandidateStatus requires a status");
  const { error } = await scoped(email).update("candidates", { status: s, updated_at: new Date().toISOString() });
  if (error) throw new Error(`candidates status update failed: ${error.message}`);
}

// ── onboarding cohort gate (Onboarding v2) ───────────────────────────────────
// A candidate is in the v2 journey ONLY when their dossier carries meta.onboarding
// === "v2". Absence = v1, forever. Additive Json (the Dossier schema is passthrough),
// no migration. This is the fence between the two journeys: v1 sweeps
// `if (isV2(c)) continue`, v2 tasks select via v2Candidates().

/** True iff a candidate row/object is in the v2 onboarding cohort. Pure, no I/O. */
export function isV2(candidate) {
  return candidate?.dossier?.meta?.onboarding === "v2";
}

// True when NEW signups should be stamped into the v2 cohort. Default OFF: no user
// becomes v2 until ONBOARDING_V2 is set to `on`.
export function onboardingV2Enabled() {
  return String(process.env.ONBOARDING_V2 || "").toLowerCase() === "on";
}

// Stamp the v2 cohort marker onto a FRESH dossier in place, then return it. The dossier
// writers replace the whole column, so meta must be set before saveDossier (never a
// meta-only write). No-op unless ONBOARDING_V2 is on, so calling it at a new-user entry
// point is always safe.
export function markOnboardingCohort(dossier) {
  if (dossier && onboardingV2Enabled()) {
    dossier.meta = { ...(dossier.meta || {}), onboarding: "v2" };
  }
  return dossier;
}

// Every ACTIVE v2-cohort candidate — the mirror of the v1 sweeps' fence, so v2 tasks
// select ONLY v2 users. Reuses listActiveCandidates (already hydrates dossier).
export async function v2Candidates({ limit = 1000 } = {}) {
  return (await listActiveCandidates({ limit })).filter(isV2);
}

// ── journey state machine ─────────────────────────────────────────────────────
// The persistence + durable-timer seam for the pure model in journey.mjs. `enterState` is the
// ONLY way a user moves through the journey in production: it reads the candidate, applies the pure
// `advance` (which validates the transition and appends to history), writes the new journey back
// WITHOUT touching status (a dossier-only update — status stays whatever it was), and schedules the
// new state's max-silence watchdog on the EXISTING durable-timer table (`scheduled_tasks`), never an
// in-process setInterval — so a server restart loses no timer. The watchdog payload stamps the state
// + journey_id + entered_at so a stale timer from a prior state fires as a harmless no-op.
export async function enterState(email, toState, { at } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw new Error("enterState: email required");
  const cand = await getCandidate(e);
  if (!cand) throw new Error(`enterState: no candidate for ${e}`);
  const nowISO = at || new Date().toISOString();
  const journeyId = `j_${Date.now().toString(36)}`; // only used when starting a fresh journey
  const journey = advance(cand, toState, { at: nowISO, journeyId });

  // Dossier-only write: merge the new journey into meta and persist, preserving status.
  const dossier = { ...(cand.dossier || {}) };
  dossier.meta = { ...(dossier.meta || {}), journey };
  const { error } = await scoped(e)
    .update("candidates", { dossier, updated_at: new Date().toISOString() });
  if (error) throw new Error(`journey write failed: ${error.message}`);

  // Schedule the state's watchdog (durable). Terminal/rest states have none.
  const w = watchdogFor(toState);
  if (w) {
    await scheduleTask({
      email: e,
      kind: w.kind,
      runAt: new Date(Date.parse(nowISO) + w.after).toISOString(),
      payload: { state: toState, journey_id: journey.journey_id, entered_at: journey.entered_at },
    });
  }
  return journey;
}

// ── resumes (private Storage bucket, keyed by email) ─────────────────────────
const RESUME_BUCKET = "resumes";
const resumeKey = (email) => `${email}.txt`; // emails contain no "/"; "@"/"." are fine

// Store a raw resume for a user in the private bucket. Overwrites any prior upload.
export async function uploadResume(email, text) {
  const { error } = await store()
    .storage.from(RESUME_BUCKET)
    .upload(resumeKey(email), Buffer.from(text, "utf8"), { contentType: "text/plain; charset=utf-8", upsert: true });
  if (error) {
    throw new Error(`resume upload failed: ${error.message} (is the private "${RESUME_BUCKET}" bucket created?)`);
  }
}

// Read a user's stored resume text, or null if none was uploaded.
export async function getResume(email) {
  const { data, error } = await store().storage.from(RESUME_BUCKET).download(resumeKey(email));
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return null;
    throw new Error(`resume read failed: ${error.message}`);
  }
  return await data.text();
}

// Update just email_config on an existing candidate. Errors if the user is missing
// (never creates a row; onboarding does that). Returns the saved config.
export async function setEmailConfig(email, emailConfig) {
  const { data, error } = await scoped(email)
    .update("candidates", { email_config: emailConfig, updated_at: new Date().toISOString() })
    .select("email_config")
    .maybeSingle();
  if (error) throw new Error(`email_config update failed: ${error.message}`);
  if (!data) throw new Error(`no candidate for ${email} — onboard this address first`);
  return data.email_config;
}

// Email-threading roots (threading.mjs): the Message-ID that anchors a conversation, so later sends
// in it thread correctly. Stored under email_config.threads, keyed by conversation ("convo" for the
// direct Charlie<->user thread, or a findId for a role's own follow-ups). Best-effort.
// Merge a patch into email_config (spread-preserving, the full-replace gotcha). Best-effort.
export async function mergeEmailConfig(email, patch) {
  const c = await getCandidate(email).catch(() => null);
  const ec = { ...(c?.email_config || {}), ...(patch || {}) };
  await setEmailConfig(email, ec).catch(() => {});
  return ec;
}

export async function getThreadRoot(email, key) {
  const c = await getCandidate(email).catch(() => null);
  return c?.email_config?.threads?.[key] || null;
}
export async function setThreadRoot(email, key, messageId) {
  const c = await getCandidate(email).catch(() => null);
  const ec = { ...(c?.email_config || {}) };
  ec.threads = { ...(ec.threads || {}), [key]: messageId };
  await setEmailConfig(email, ec).catch(() => {});
}

// Hard-delete EVERYTHING for one user: their finds, their candidate row, and their stored
// resume. Email-scoped (tenant isolation) so it can only ever remove the caller's own data.
// Used by the "remove everything / start over" path. Irreversible — the caller must confirm.
export async function deleteCandidate(email) {
  const e = requireEmail(email);
  const { error: fErr } = await scoped(e).delete("finds");
  if (fErr) throw new Error(`finds delete failed: ${fErr.message}`);
  const { error: cErr } = await scoped(e).delete("candidates");
  if (cErr) throw new Error(`candidate delete failed: ${cErr.message}`);
  // best-effort: a missing resume object must not fail the whole deletion
  try { await store().storage.from(RESUME_BUCKET).remove([resumeKey(e)]); } catch { /* ignore */ }
  return true;
}

// ── join@ hiring campaign state (join_applicants) ─────────────────────────────
// Isolated from the product: a row exists only for someone who emailed join@ as an applicant. Identity
// is the lowercased mailbox. Reads THROW on a real DB error so the campaign caller can fail closed (send
// nothing) rather than act on a phantom empty. All of this is INERT until JOIN_CAMPAIGN=on.
const JOIN_TABLE = "join_applicants";

export async function getJoinApplicant(email) {
  const e = requireEmail(email).toLowerCase();
  const { data, error } = await store().from(JOIN_TABLE).select("*").eq("email", e).maybeSingle();
  if (error) throw new Error(`join_applicant read failed: ${error.message}`);
  return data ?? null;
}

// Upsert a patch onto the applicant row (email is the PK). Always stamps updated_at. A write error
// THROWS so the caller decides (and, in the campaign, does not pretend a state change happened).
export async function upsertJoinApplicant(email, patch = {}) {
  const e = requireEmail(email).toLowerCase();
  const row = { email: e, ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await store().from(JOIN_TABLE).upsert(row, { onConflict: "email" }).select().maybeSingle();
  if (error) throw new Error(`join_applicant upsert failed: ${error.message}`);
  return data ?? null;
}

// Append one turn to the bounded transcript. Read-modify-write; the inbound handler processes one reply
// at a time per address, and `cap` bounds the stored transcript so it can never grow unbounded.
export async function appendJoinTranscript(email, entry, { cap = 40 } = {}) {
  const e = requireEmail(email).toLowerCase();
  const cur = await getJoinApplicant(e);
  const prev = Array.isArray(cur?.transcript) ? cur.transcript : [];
  const next = [...prev, { role: entry.role, text: String(entry.text ?? ""), at: new Date().toISOString() }].slice(-cap);
  return upsertJoinApplicant(e, { transcript: next });
}

// Applicants in a given stage, for the sweeps (stall nudge, awaiting-verdict reminder). Service-role.
export async function listJoinApplicantsByStage(stage, { limit = 500 } = {}) {
  const { data, error } = await store().from(JOIN_TABLE).select("*").eq("stage", stage).limit(limit);
  if (error) throw new Error(`join_applicant list failed: ${error.message}`);
  return data ?? [];
}

// ── friend referrals (the bring-a-friend share loop / friend-drip) ────────────
// An append-only event log: a 'click' when a friend opens the giver's /g/<token> link, a 'signup'
// when a referred person arrives at start@ carrying the ref marker. `variant` is the share-note A/B,
// derived deterministically from the GIVER so it is stable per person and recomputable anywhere.
//
// FAIL-OPEN by contract: before the friend_referrals migration is applied, the
// insert errors and this returns null — a click still redirects and an onboarding still completes.
// The loop must never block a redirect or a send. Reads that power the A/B readout dedupe by friend.
const FRIEND_REFERRALS = "friend_referrals";

// Stable 50/50 coin-flip for the share-note A/B: a pure function of the giver's address, so the email
// render, the /g route, and the attribution all agree without storing the assignment anywhere.
export function friendVariant(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "A";
  return createHmac("sha256", "friend-ab").update(e).digest()[0] % 2 === 0 ? "A" : "B";
}

// Record one referral event. Best-effort: logs + returns null on any error (missing table included),
// never throws, so a caller in a redirect/onboarding hot path can `.catch(() => {})` and move on.
export async function recordReferralEvent({ giverEmail, variant = null, kind, friendEmail = null, refCode = null, jobId = null } = {}) {
  const g = String(giverEmail || "").trim().toLowerCase();
  if (!g || !kind) return null;
  const row = {
    giver_email: g,
    variant: variant || null,
    kind: String(kind),
    friend_email: friendEmail ? String(friendEmail).trim().toLowerCase() : null,
    ref_code: refCode || null,
  };
  if (jobId) row.job_id = String(jobId); // gift-a-role only; friend-drip rows omit it (works pre-migration)
  try {
    const { data, error } = await store().from(FRIEND_REFERRALS).insert(row).select().maybeSingle();
    if (error) { console.error(`[friend-ref] ${kind} write failed (table applied?): ${error.message}`); return null; }
    return data ?? null;
  } catch (e) {
    console.error(`[friend-ref] ${kind} write threw: ${e.message}`);
    return null;
  }
}

// The A/B readout: clicks + distinct-friend signups per variant. Dedupes signups by friend_email at
// read time (append-only writes can repeat), so "which note pulled more people in" is honest. Fails
// open to an empty readout if the table is missing.
export async function friendReferralStats() {
  try {
    const { data, error } = await store().from(FRIEND_REFERRALS).select("variant,kind,friend_email");
    if (error) return { A: { clicks: 0, signups: 0 }, B: { clicks: 0, signups: 0 } };
    const out = { A: { clicks: 0, signups: 0, _f: new Set() }, B: { clicks: 0, signups: 0, _f: new Set() } };
    for (const r of data || []) {
      const v = r.variant === "B" ? "B" : "A";
      if (r.kind === "click") out[v].clicks += 1;
      else if (r.kind === "signup" && r.friend_email && !out[v]._f.has(r.friend_email)) { out[v]._f.add(r.friend_email); out[v].signups += 1; }
    }
    return { A: { clicks: out.A.clicks, signups: out.A.signups }, B: { clicks: out.B.clicks, signups: out.B.signups } };
  } catch {
    return { A: { clicks: 0, signups: 0 }, B: { clicks: 0, signups: 0 } };
  }
}

// ── job pool (shared between the engine and the hosted chat) ──────────────────
// The scanner writes jobs.json to its own disk; the hosted chat lives on a different
// service and can't read that file. So after each scan the engine uploads the current pool
// here, and the chat downloads it for an on-demand, in-session match. One JSON object,
// overwritten each run. NOT per-user data — it's the same public pool for everyone.
const POOL_BUCKET = "job-pool";
const POOL_KEY = "latest.json";

// ── Company-insight cache ────────────────────────────────────────────────────────────────────
// The verified company block (composer.lookupCompany) runs a web_search — Charlie's single most
// expensive per-call line — and it fired once per matched user EVERY day, re-researching the same
// companies over and over. Cache the result by normalized company name with a TTL so each company
// is researched once per window instead of once per (user × day). Best-effort: a miss just does the
// lookup, a store error is swallowed. No DDL — one JSON object in the self-provisioned job-pool
// bucket, lazy-loaded once per process, write-through on each miss.
const COMPANY_CACHE_KEY = "company-cache.json";
const COMPANY_TTL_MS = Number(process.env.COMPANY_CACHE_TTL_DAYS || 30) * 864e5;
const normCompany = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let _companyCache = null;
async function loadCompanyCache() {
  if (_companyCache) return _companyCache;
  try {
    const { data, error } = await store().storage.from(POOL_BUCKET).download(COMPANY_CACHE_KEY);
    _companyCache = error ? {} : JSON.parse(await data.text());
  } catch { _companyCache = {}; }
  return _companyCache;
}
export async function getCachedCompany(name) {
  const key = normCompany(name);
  if (!key) return null;
  const c = await loadCompanyCache();
  const e = c[key];
  return e && (Date.now() - e.ts) < COMPANY_TTL_MS ? e.insight : null;
}
export async function putCachedCompany(name, insight) {
  const key = normCompany(name);
  if (!key || !insight) return;
  const c = await loadCompanyCache();
  c[key] = { insight, ts: Date.now() };
  try {
    await store().storage.from(POOL_BUCKET).upload(COMPANY_CACHE_KEY, Buffer.from(JSON.stringify(c), "utf8"), { contentType: "application/json", upsert: true });
  } catch { /* best-effort — bucket provisioned by saveJobPool */ }
}

// ── BLS wage-anchor cache ────────────────────────────────────────────────────────────────────
// The pay-vs-market block anchors the posting's stated range to a BLS OES occupational median.
// Wage data is annual, and the same (occupation × metro) repeats across many postings, so cache
// each lookup with a long TTL — one BLS call per (SOC × area) per window instead of per email.
// Same best-effort pattern as the company cache: a miss just re-fetches, a store error is swallowed.
const BLS_CACHE_KEY = "bls-cache.json";
const BLS_TTL_MS = Number(process.env.BLS_CACHE_TTL_DAYS || 180) * 864e5;
let _blsCache = null;
async function loadBlsCache() {
  if (_blsCache) return _blsCache;
  try {
    const { data, error } = await store().storage.from(POOL_BUCKET).download(BLS_CACHE_KEY);
    _blsCache = error ? {} : JSON.parse(await data.text());
  } catch { _blsCache = {}; }
  return _blsCache;
}
export async function getCachedBls(key) {
  if (!key) return null;
  const c = await loadBlsCache();
  const e = c[key];
  return e && (Date.now() - e.ts) < BLS_TTL_MS ? e.val : null;
}
export async function putCachedBls(key, val) {
  if (!key || val == null) return;
  const c = await loadBlsCache();
  c[key] = { val, ts: Date.now() };
  try {
    await store().storage.from(POOL_BUCKET).upload(BLS_CACHE_KEY, Buffer.from(JSON.stringify(c), "utf8"), { contentType: "application/json", upsert: true });
  } catch { /* best-effort — bucket provisioned by saveJobPool */ }
}

// ── market-gap research cache ──────────────────────────────────────────────────────────────────
// The weekly market-gap drop's "what the market says" enrichment (attributed web lines + a BLS pay
// anchor) is IDENTICAL for every user with the same (gap × role × region), so it is cached by that
// tuple, not by user. This is what keeps the drop's cost bounded to distinct gap-tuples instead of
// headcount. Same best-effort JSON-blob pattern + TTL as the company/BLS caches.
const MARKET_CACHE_KEY = "market-gap-cache.json";
const MARKET_TTL_MS = Number(process.env.MARKETGAP_CACHE_TTL_DAYS || 14) * 864e5;
let _marketCache = null;
async function loadMarketCache() {
  if (_marketCache) return _marketCache;
  try {
    const { data, error } = await store().storage.from(POOL_BUCKET).download(MARKET_CACHE_KEY);
    _marketCache = error ? {} : JSON.parse(await data.text());
  } catch { _marketCache = {}; }
  return _marketCache;
}
export async function getCachedMarket(key) {
  if (!key) return null;
  const c = await loadMarketCache();
  const e = c[key];
  return e && (Date.now() - e.ts) < MARKET_TTL_MS ? e.val : null;
}
export async function putCachedMarket(key, val) {
  if (!key || val == null) return;
  const c = await loadMarketCache();
  c[key] = { val, ts: Date.now() };
  try {
    await store().storage.from(POOL_BUCKET).upload(MARKET_CACHE_KEY, Buffer.from(JSON.stringify(c), "utf8"), { contentType: "application/json", upsert: true });
  } catch { /* best-effort — bucket provisioned by saveJobPool */ }
}

export async function saveJobPool(jobs) {
  const s = store();
  // self-provision the private bucket so there's no manual setup step (no-op if it exists)
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* already exists */ }
  // Slim each posting before upload: full pools (11k+ postings) blow past the storage
  // object-size limit, so cap description. The cap must clear a JD's requirements section,
  // because the daily role email's explainable fit Readout (fit-coverage.mjs) reads it to
  // decide met/partly/not-shown per requirement — a 600-char stub made every Readout mark
  // real requirements "not shown". 2500 captures the requirements for the vast majority of
  // postings while keeping the whole pool safely under the object limit (worst case ~34MB
  // for 11k jobs vs the 50MB ceiling). The pre-filter + snippet matcher still only need a
  // slice, so nothing they read regresses.
  // WHERE to trim, not whether. A blind head-slice throws away the requirements of some long postings,
  // and those reach the FIRST-ROLE path, which reads this pool object rather than the engine's full
  // jobs.json. A posting whose requirements are cut off is unscoreable by fit-coverage, so the first
  // email a new user gets would lose its fit chart. capKeepingRequirements slides the window to include them, at the same 2500 characters and so
  // at the same storage cost. Shares its predicate with fit-coverage.mjs so the two cannot disagree.
  const DESC_CAP = 2500;
  const slim = (jobs ?? []).map((j) =>
    j && typeof j.description === "string" && j.description.length > DESC_CAP ? { ...j, description: capKeepingRequirements(j.description, DESC_CAP) } : j,
  );
  // Mirror into job_pool rows (migration 20260801000000) BEFORE the blob, deliberately.
  //
  // The blob is the thing that can fail on size: tens of thousands of postings at ~3 KB each approach
  // or exceed a per-file storage ceiling (50 MB on the Supabase Free plan). When that upload fails,
  // saveJobPool throws, engine:run's &&-chain short-circuits, and the run completes having sent nothing.
  //
  // Mirroring first means the rows are already durable when that happens, so the failure is
  // recoverable instead of total. Its own errors are still swallowed: the table must never be the
  // reason a scan dies.
  const mirrored = await mirrorJobPoolRows(slim).then((n) => n, () => 0);

  // ONE BIG STRING IS THE WALL. JSON.stringify(slim) builds a single string of hundreds of MB, and V8
  // refuses any string past 512 MiB — a limit no --max-old-space-size can raise. As the pool grows the
  // failure mode is not "slow", it is "throws outright, permanently".
  //
  // JSONL avoids it: each posting is stringified alone (a few KB) and the pieces are concatenated as
  // BUFFERS, which are not subject to the string limit. Same bytes on the wire, no ceiling.
  //
  // Behind POOL_JSONL because this is the file every send reads. The READER below handles both formats
  // unconditionally, so the flag can be flipped either way at any time without a migration or a
  // coordinated deploy.
  const jsonl = String(process.env.POOL_JSONL || "").toLowerCase() === "on";
  const body = jsonl
    ? Buffer.concat(slim.map((j) => Buffer.from(JSON.stringify(j) + "\n", "utf8")))
    : Buffer.from(JSON.stringify(slim), "utf8");
  const { error } = await s.storage.from(POOL_BUCKET).upload(POOL_KEY, body, { contentType: "application/json", upsert: true });
  if (error) {
    if (poolWriteVerdict({ blobOk: false, mirroredRows: mirrored, tableReadsOn: poolTableOn() }) === "degraded") {
      console.error(`⚠ job-pool blob upload failed (${error.message}) — ${mirrored} row(s) mirrored to job_pool and POOL_TABLE=on, so the pool is still readable. The BLOB is now stale; fix the upload before turning POOL_TABLE off.`);
      return;
    }
    throw new Error(`job-pool upload failed: ${error.message}`);
  }
}

/**
 * Whether a failed blob upload is survivable. Pure, so the policy is testable without Supabase —
 * same reason `pendingBatchAction` in match-batch.mjs is pure.
 *
 *   "ok"        the blob wrote; nothing to decide.
 *   "degraded"  the blob failed, but the rows are durable AND reads are pointed at them. The run
 *               continues on a stale blob and a fresh table, and says so loudly.
 *   "fail"      anything else. Throw, and let the &&-chain stop the day.
 *
 * BOTH conditions are required for "degraded", and neither is negotiable. A populated table nobody
 * reads is not a pool. POOL_TABLE=on over an EMPTY table is worse than the throw, because the run
 * would carry on and quietly match against nothing — a silent zero dressed as a success.
 *
 * @param {{blobOk:boolean, mirroredRows:number, tableReadsOn:boolean}} o
 * @returns {"ok"|"degraded"|"fail"}
 */
export function poolWriteVerdict({ blobOk, mirroredRows, tableReadsOn }) {
  if (blobOk) return "ok";
  const rows = Number(mirroredRows);
  if (Number.isFinite(rows) && rows > 0 && tableReadsOn === true) return "degraded";
  return "fail";
}

// ── the pool as rows (migration 20260801000000) ───────────────────────────────
// The blob cannot answer "give me one posting" — every consumer downloads the whole pool. These
// functions are the row-level seam. Both are fail-open by construction: an absent table, an
// un-applied migration, or any error falls back to the blob.
export const POOL_ROW_CHUNK = 250; // ~3KB/row at the 2500-char description cap — keeps each upsert well under PostgREST's payload limit
// Exported so the parity with BOTH the migration and JOB_KEY_FIELDS is a test, not a comment. A field
// the scanner adds and this list forgets is silently dropped on the round-trip, and the matcher would
// then score a posting the pool no longer carries — see pool-table.test.mjs.
export const POOL_COLUMNS = [
  "id", "source", "company", "slug", "segment", "title", "location", "remote", "team",
  "employment_type", "compensation", "apply_url", "posted_at", "description", "first_seen", "last_seen",
];

/** POOL_TABLE=on switches READS to the table. Writes mirror regardless (see saveJobPool). */
export const poolTableOn = () => /^(on|1|true|yes)$/i.test(String(process.env.POOL_TABLE ?? "").trim());

function poolRow(j) {
  const r = {};
  for (const k of POOL_COLUMNS) r[k] = j?.[k] ?? null;
  return r;
}

/**
 * Upsert this run's pool, then delete whatever this run did not see.
 *
 * The delete is keyed on `last_seen`, which scan-jobs re-stamps on every posting it saw this run — so
 * "older than this run's stamp" is exactly "no longer on any board". It runs ONLY after every chunk
 * upserted: a partial write followed by a delete would empty the table on a transient network blip,
 * which is the fail-closed-becomes-fail-to-zero shape in a new costume.
 */
async function mirrorJobPoolRows(jobs) {
  const rows = (jobs ?? []).filter((j) => j && j.id).map(poolRow);
  if (!rows.length) return 0;
  const s = store();
  for (let i = 0; i < rows.length; i += POOL_ROW_CHUNK) {
    const { error } = await s.from("job_pool").upsert(rows.slice(i, i + POOL_ROW_CHUNK), { onConflict: "id" });
    if (error) throw new Error(`job_pool upsert failed: ${error.message}`); // caller swallows; blob already written
  }
  const stamps = rows.map((r) => r.last_seen).filter(Boolean).sort();
  const oldest = stamps[0];
  if (oldest) {
    const { error } = await s.from("job_pool").delete().lt("last_seen", oldest);
    if (error) throw new Error(`job_pool prune failed: ${error.message}`);
  }
  return rows.length;
}

/**
 * The whole pool, as rows. Paged because PostgREST caps a single select (default 1,000) and the pool
 * is 16k+ — an unpaged read would silently return the first page and every consumer would think the
 * pool shrank by 94%. Ordered by id so paging is stable across requests.
 */
/**
 * Restore the TYPES the `text` columns flattened, so a row is indistinguishable from the blob job it
 * mirrors. Migration 20260801000000 declares `remote text` and `compensation text`, so Postgres hands
 * the boolean `true` back as the string "true" and a compensation object back as serialized JSON.
 *
 * That is not cosmetic. Consumers test `remote` with STRICT equality (quality-gate.mjs
 * `job?.remote === true`, select-jobs.mjs `job.remote === false`), and "true" === true is false.
 * Without the revive every explicitly remote posting would read as NOT remote, and quality-gate drops a
 * blank-location posting unless it is flagged remote: remote roles would disappear, silently, for the
 * users who depend on them most. `remote` is also a cache-key field, so a type flip would re-score.
 *
 * The revive is deliberately NARROW, because both fields are UNIONS in the real pool:
 *   remote:       null · boolean · string (e.g. "hybrid")
 *   compensation: null · object  · string (e.g. "18-20 GBP")
 * Coercing every string would destroy genuine values, so only the two exact boolean literals and text
 * that actually parses as JSON are touched. Anything else is returned exactly as stored.
 */
export function reviveJobRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  if (out.remote === "true") out.remote = true;
  else if (out.remote === "false") out.remote = false;
  if (typeof out.compensation === "string") {
    const s = out.compensation.trim();
    // Only attempt a parse when it LOOKS like JSON, and keep the original on failure — "18-20 GBP"
    // must survive, and so must a genuine string that merely starts with a brace.
    if (s.startsWith("{") || s.startsWith("[")) {
      try { out.compensation = JSON.parse(s); } catch { /* a real string, not a serialized object */ }
    }
  }
  return out;
}

async function loadJobPoolRows() {
  const s = store();
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await s.from("job_pool").select("*").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`job_pool read failed: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data.map(reviveJobRow));
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * ONE posting, by id — the read the blob cannot do. Returns null when the table is absent or the id
 * is unknown; callers fall back to their existing pool scan, so this can never be the reason a page
 * fails to render.
 */
export async function getJobById(id) {
  if (!id) return null;
  try {
    const { data, error } = await store().from("job_pool").select("*").eq("id", String(id)).maybeSingle();
    if (error) return null;
    return data ? reviveJobRow(data) : null; // same type fidelity as the bulk read — see reviveJobRow
  } catch {
    return null;
  }
}

/**
 * ONE posting for a caller that only ever wanted one — the table if it can answer, the blob if it
 * cannot. Server routes that resolve a single role per click use this instead of downloading the
 * ENTIRE pool and running `.find()` over it.
 *
 * Table-first, blob-fallback, and NEVER an exception: a missing row, an un-applied migration, or a
 * dead table all return the same thing the pool scan would have returned. Deliberately independent of POOL_TABLE — the mirror populates the rows on every
 * scan regardless of the flag, so this fast path is correct before the flag is ever flipped, and the
 * flag stays what it is: a switch on the BULK read, not on this one.
 *
 * `opts` exists only so the tests can drive both branches without Supabase — the same reason
 * fetchBoard takes its backoff knobs (scan-jobs.mjs). Prod always uses the defaults.
 */
export async function getPoolJob(id, { byId = getJobById, all = loadJobPool } = {}) {
  if (!id) return null;
  const row = await byId(id).catch(() => null);
  if (row) return row;
  const pool = await all().catch(() => []);
  return (Array.isArray(pool) ? pool : []).find((x) => String(x?.id) === String(id)) ?? null;
}


// Semantic vectors for the pre-filter rank. Stored in the job-pool bucket as ONE compact
// base64-packed int8 blob (see lib/voyage.mjs packInt8Vectors), keyed by job id. Separate object from
// latest.json so the pool read path is unchanged and only callers that need vectors pay to load them.
const EMBED_KEY = "embeddings.json";
export async function saveJobEmbeddings(packed) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* already exists */ }
  const body = Buffer.from(JSON.stringify(packed), "utf8");
  const { error } = await s.storage.from(POOL_BUCKET).upload(EMBED_KEY, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`job embeddings upload failed: ${error.message}`);
}
export async function loadJobEmbeddings() {
  const { data, error } = await store().storage.from(POOL_BUCKET).download(EMBED_KEY);
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return null;
    throw new Error(`job embeddings read failed: ${error.message}`);
  }
  try { return JSON.parse(await data.text()); } catch { return null; }
}

// A tiny live-stats object (roles live, companies, opened today, closed since yesterday)
// the engine computes each scan and the public landing reads — true numbers, no portal shows
// them. Lives next to the pool in the same bucket.
const POOL_STATS_KEY = "stats.json";

export async function saveJobPoolStats(stats) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
  const body = Buffer.from(JSON.stringify(stats ?? {}), "utf8");
  const { error } = await s.storage.from(POOL_BUCKET).upload(POOL_STATS_KEY, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`job-pool stats upload failed: ${error.message}`);
}

export async function loadJobPoolStats() {
  const { data, error } = await store().storage.from(POOL_BUCKET).download(POOL_STATS_KEY);
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return null;
    throw new Error(`job-pool stats read failed: ${error.message}`);
  }
  try { return JSON.parse(await data.text()); } catch { return null; }
}

// ── the seen-store: id -> { first_seen, last_seen, status, closed_at } ───────────────────────
//
// The scan's memory of every job id it has ever met. It powers two things: the DISAPPEARANCE test
// ("this role vanished from a board that still answers, so it closed") and `first_seen`, which is
// the only date an undated posting has.
//
// It lives in the job-pool bucket, beside the pool itself, because the engine container has NO
// volume: a file beside the code would start empty every run, the disappearance test would have no
// history, and undated roles would be re-stamped `first_seen: now` every run and never age out. The
// local file (scan-jobs.mjs SEEN_PATH) stays as the dev path.
//
// ⚠️ THE ERROR CONTRACT IS THE POINT, AND IT IS DELIBERATELY UNLIKE loadJobPoolStats ABOVE.
// That function swallows a parse failure and returns null, because a missing stats blob costs a
// landing-page number. Here, "there is no history" and "I could not read the history" must be told
// apart by the caller, because they license opposite actions:
//
//   {}      the object does not exist -> genuinely the first run. Safe to write.
//   throws  a network error, a truncated body, a non-object -> we know NOTHING this run. The caller
//           must hold no opinion AND must not write back, or a partial read overwrites good remote
//           history with an empty store and the loss becomes permanent.
//
// Collapsing those two into "return {}" is the fail-closed-becomes-fail-to-zero shape: a guard that
// stops protecting and starts silently discarding, reporting green the whole time.
const POOL_SEEN_KEY = "seen-jobs.json";

/** Upload the seen-store. Callers PRUNE first — this object only grows. Returns the byte size written. */
export async function saveSeenJobs(seen) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
  const body = Buffer.from(JSON.stringify(seen ?? {}), "utf8");
  const { error } = await s.storage.from(POOL_BUCKET).upload(POOL_SEEN_KEY, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`seen-jobs upload failed: ${error.message}`);
  return body.length;
}

/** The seen-store, `{}` when it has never been written, THROWS on any read/parse failure (see above). */
export async function loadSeenJobs() {
  const { data, error } = await store().storage.from(POOL_BUCKET).download(POOL_SEEN_KEY);
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return {}; // first run ever
    throw new Error(`seen-jobs read failed: ${error.message}`);
  }
  const parsed = JSON.parse(await data.text()); // a throw here is a FAILED READ, never an empty store
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("seen-jobs store is not an object");
  return parsed;
}

// A rolling KPI history (one snapshot per run/day) the daily engine appends to, so
// every score/send change has a provable before/after baseline. Lives next to the pool. The
// history array is capped in stats.mjs's mergeKpiHistory; this seam is just load/save.
const KPI_KEY = "kpi.json";

export async function loadKpiHistory() {
  const { data, error } = await store().storage.from(POOL_BUCKET).download(KPI_KEY);
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return [];
    throw new Error(`kpi history read failed: ${error.message}`);
  }
  try { const j = JSON.parse(await data.text()); return Array.isArray(j) ? j : []; } catch { return []; }
}

// ── Pending batch (a slow Anthropic batch, carried to the next run) ───────────────────────────
// The Batch API documents "most complete within 1 hour; maximum 24 hours", so a slow batch is
// NORMAL. Throwing would abort engine:run's `&&` chain and give EVERY user nothing. Instead the
// batch id + the custom_id -> (email, jobId) mapping are parked here, and the next run
// collects the finished results instead of paying for a second batch. Results live 29 days.
// A storage object, not a table — no migration, and a read failure is never fatal (fail soft: the
// worst case is one re-run, not a crash).
const PENDING_BATCH_KEY = "pending-batch.json";

export async function loadPendingBatch() {
  try {
    const { data, error } = await store().storage.from(POOL_BUCKET).download(PENDING_BATCH_KEY);
    if (error) return null; // absent (the normal case) or unreadable — either way there's nothing to resume
    const j = JSON.parse(await data.text());
    return j && j.batchId && Array.isArray(j.map) ? j : null;
  } catch { return null; }
}

export async function savePendingBatch(pending) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
  const body = Buffer.from(JSON.stringify(pending ?? {}), "utf8");
  const { error } = await s.storage.from(POOL_BUCKET).upload(PENDING_BATCH_KEY, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`pending batch upload failed: ${error.message}`);
}

export async function clearPendingBatch() {
  try { await store().storage.from(POOL_BUCKET).remove([PENDING_BATCH_KEY]); } catch { /* already gone */ }
}

export async function saveKpiHistory(history) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
  const body = Buffer.from(JSON.stringify(history ?? []), "utf8");
  const { error } = await s.storage.from(POOL_BUCKET).upload(KPI_KEY, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`kpi history upload failed: ${error.message}`);
}

// ── Engine build stamp (what code the cron actually ran) ──────────────────────────────────────
// The engine is a one-shot container with no HTTP surface, so nothing else can answer "what code is
// it running?" (and `railway up` ships the working tree from whatever machine ran it).
//
// preflight.mjs (the first step of engine:run) stamps this at the start of every run, so even a run
// that aborts leaves a record of WHEN it started and WITH WHAT CODE (lib/build-id.mjs — a content
// hash, not a hand-bumped constant, because equal versions do not prove equal code).
//
// A storage object, not a table: no migration, and both sides fail SOFT. Observability must never be
// able to break the job it observes.
const ENGINE_BUILD_KEY = "engine-build.json";

export async function saveEngineBuild(record) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
  const { error } = await s.storage.from(POOL_BUCKET).upload(ENGINE_BUILD_KEY, Buffer.from(JSON.stringify(record ?? {}), "utf8"), { contentType: "application/json", upsert: true });
  if (error) throw new Error(`engine build stamp failed: ${error.message}`);
}

/** The last stamped engine run, or null if never stamped / unreadable. Never throws. */
export async function loadEngineBuild() {
  try {
    const { data, error } = await store().storage.from(POOL_BUCKET).download(ENGINE_BUILD_KEY);
    if (error) return null;
    const j = JSON.parse(await data.text());
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

// A small precomputed feed (freshest real roles + counts by function) the landing streams.
// Precomputed by the engine so the public endpoint serves a tiny JSON, never the big pool.
const POOL_FEED_KEY = "feed.json";

export async function saveJobPoolFeed(feed) {
  const s = store();
  try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
  const { error } = await s.storage.from(POOL_BUCKET).upload(POOL_FEED_KEY, Buffer.from(JSON.stringify(feed ?? {}), "utf8"), { contentType: "application/json", upsert: true });
  if (error) throw new Error(`job-pool feed upload failed: ${error.message}`);
}

// ── company hiring-momentum snapshots ────────────────────────────────────────────────────────
// The Hiring-momentum block needs a time series of per-company open-req counts to show a trend
// ("up from N a month ago"). The scanner only keeps the current pool, so we append one dated
// snapshot per scan into `company_req_snapshots(date, company, open_count)`. Best-effort by
// contract: a missing table (before the migration runs) or an error must NEVER break a scan or a
// send — it logs and no-ops, and the block simply omits the trend until history accrues.
// Backed by the company_req_snapshots table (see supabase/migrations/).
export async function saveCompanySnapshot(dateKey, counts) {
  if (!dateKey || !counts) return false;
  const rows = Object.entries(counts).map(([company, open_count]) => ({ date: dateKey, company, open_count }));
  if (!rows.length) return false;
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await store().from("company_req_snapshots").upsert(rows.slice(i, i + 500), { onConflict: "date,company" });
      if (error) throw new Error(error.message);
    }
    return true;
  } catch (err) {
    console.error(`[snapshot] company req counts not saved (${err.message}) — run the company-req-snapshots migration`);
    return false;
  }
}

// The company's open-req snapshot series since `sinceDate` (ISO), oldest first — feeds the role
// email's momentum trend sparkline. Fail-open: [] when the table is missing or empty.
export async function getCompanyHistory(company, sinceDate, { limit = 60 } = {}) {
  if (!company || !sinceDate) return [];
  try {
    const { data, error } = await store().from("company_req_snapshots")
      .select("date,open_count").eq("company", company).gte("date", sinceDate)
      .order("date", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  } catch { return []; }
}

// The most recent snapshot count for a company on or before `onOrBefore` (ISO date). Used to
// compute the month-over-month trend. Fail-open: null when the table is missing or nothing found.
export async function getCompanyReqCount(company, onOrBefore) {
  if (!company || !onOrBefore) return null;
  try {
    const { data, error } = await store().from("company_req_snapshots")
      .select("open_count,date").eq("company", company).lte("date", onOrBefore)
      .order("date", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data && data.length ? data[0].open_count : null;
  } catch { return null; }
}

// Every company's open-req count from the most recent snapshot STRICTLY BEFORE `beforeDate`.
// This is the scan's memory: without yesterday's counts, a board answering HTTP 200 + {"jobs":[]}
// (what a blocked ATS returns) is indistinguishable from a board that is honestly empty, and the
// scan records a healthy zero either way. Paged, because a snapshot is ~1k rows and PostgREST
// caps a default select. Fail-open: {} when the table is missing or there is no history yet, so
// a scan is never broken by its own diagnostics.
export async function getPreviousCompanyCounts(beforeDate) {
  if (!beforeDate) return {};
  try {
    const { data: last, error: e1 } = await store().from("company_req_snapshots")
      .select("date").lt("date", beforeDate).order("date", { ascending: false }).limit(1);
    if (e1) throw new Error(e1.message);
    if (!last || !last.length) return {};
    const date = last[0].date;
    const counts = {};
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await store().from("company_req_snapshots")
        .select("company,open_count").eq("date", date).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const r of data || []) counts[r.company] = r.open_count;
      if (!data || data.length < PAGE) break;
    }
    return counts;
  } catch (err) {
    console.error(`[scan-health] previous company counts unavailable (${err.message}) — silent-zero check skipped this run`);
    return {};
  }
}

// The scan's own health record for this run: which boards resolved but went silent, and how many
// roles that cost. Deliberately NOT part of stats.json — that object is served publicly and
// unauthenticated by /pool-stats, and this is internal diagnostics, not a landing number.
// Best-effort by contract, exactly like the pool write: never break a scan over telemetry.
const POOL_HEALTH_KEY = "scan-health.json";
export async function saveScanHealth(health) {
  if (!health) return false;
  try {
    const s = store();
    try { await s.storage.createBucket(POOL_BUCKET, { public: false }); } catch { /* exists */ }
    const body = Buffer.from(JSON.stringify(health ?? {}, null, 2), "utf8");
    const { error } = await s.storage.from(POOL_BUCKET)
      .upload(POOL_HEALTH_KEY, body, { contentType: "application/json", upsert: true });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[scan-health] health record not saved (${err.message})`);
    return false;
  }
}

export async function loadJobPoolFeed() {
  const { data, error } = await store().storage.from(POOL_BUCKET).download(POOL_FEED_KEY);
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return null;
    throw new Error(`job-pool feed read failed: ${error.message}`);
  }
  try { return JSON.parse(await data.text()); } catch { return null; }
}

export async function loadJobPool() {
  // POOL_TABLE=on reads rows instead of the 48.63 MB object. Fail-open by design: an un-applied
  // migration, an empty table, or any error falls through to the blob below, so flipping the flag can
  // never be the reason a scan or a send has no pool. An EMPTY result is treated as a miss, not as a
  // pool of zero — "the table isn't populated yet" and "there are no jobs today" must never be the
  // same answer (that is the fail-closed-becomes-fail-to-zero shape, five times over in this repo).
  if (poolTableOn()) {
    const rows = await loadJobPoolRows().catch(() => null);
    if (rows && rows.length) return rows;
  }
  const { data, error } = await store().storage.from(POOL_BUCKET).download(POOL_KEY);
  if (error) {
    if (/not.?found|does not exist|no such/i.test(error.message || "")) return [];
    throw new Error(`job-pool read failed: ${error.message}`);
  }
  try {
    return await parsePoolBlob(data);
  } catch {
    return [];
  }
}

/**
 * Read the pool blob in EITHER format, without ever holding the whole thing as one string.
 *
 * Legacy is a single JSON array; new is JSONL, one posting per line. Detected from the first
 * non-whitespace byte, so the writer's flag can flip in either direction with no migration and no
 * coordinated deploy — a reader that only understood one format would make the flag a one-way door.
 *
 * The JSONL path parses line by line, so no single string approaches V8's 512 MiB ceiling. The legacy
 * path still materialises the file, because a JSON array genuinely cannot be parsed incrementally
 * without a streaming parser; that is exactly the ceiling this exists to escape.
 *
 * A malformed LINE is skipped, not fatal: one bad posting must never cost a whole day's pool (per-record
 * isolation). A malformed ARRAY still returns [] as before.
 */
export async function parsePoolBlob(blob) {
  const head = (await blob.slice(0, 64).text()).trimStart();
  if (head.startsWith("[")) {
    const arr = JSON.parse(await blob.text()); // legacy: one array, one big string
    return Array.isArray(arr) ? arr : [];
  }
  const out = [];
  let bad = 0;
  let carry = "";
  const decoder = new TextDecoder();
  const reader = blob.stream().getReader();
  const flush = (chunkText, last = false) => {
    carry += chunkText;
    const lines = carry.split("\n");
    carry = last ? "" : lines.pop(); // the tail may be a partial line until the next chunk
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { bad++; }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    flush(decoder.decode(value, { stream: true }));
  }
  flush(decoder.decode(), true);
  if (bad) console.error(`[job-pool] skipped ${bad} malformed line(s) — the rest of the pool is intact`);
  return out;
}

// ── match verdict cache (incremental matching) ───────────────────────────────
// A memoization of the daily match verdict, keyed by cache_key (lib/match-cache-key.mjs). The key is
// derived from the person's dossier + the posting + the rubric + the model, so a key is bound to one
// exact (person, posting, rubric) by construction — there is no cross-tenant collision, which is why
// these go through store() directly rather than scoped(email). All three fail their caller's way: the
// match-batch caller wraps them so a read error scores everything and a write/prune error is swallowed
// — the cache can only make a run cheaper, never wrong. Behind the match_verdicts table + MATCH_CACHE.
// 150, not 500: getVerdicts sends its keys as a GET `.in()` filter, so the chunk rides in the URL.
// Keys are 64 hex chars, so 500 of them is a ~32 KB query string — past the gateway's URL limit, and
// every read fails with "Bad Request". The caller fails open, so that breakage is invisible: it
// silently re-scores every pair at full price until the estimate crosses MAX_RUN_COST_USD and aborts
// the whole daily send. Around 250 keys already fails; 150 keeps headroom.
// The write path (upsert) sends its rows in the BODY and is not affected by the size.
export const VERDICT_CHUNK = 150; // keep each .in()/upsert payload well under PostgREST's URL + payload limits

// Cached verdicts for the given keys, EXCLUDING any older than ttlDays (those re-score fresh so tenure/
// recency drift from the date line — deliberately not in the key — can't accumulate). Map<cache_key,output>.
export async function getVerdicts(keys, ttlDays = 7) {
  const uniq = [...new Set((keys || []).filter(Boolean))];
  if (!uniq.length) return new Map();
  const cutoff = new Date(Date.now() - Math.max(0, ttlDays) * 86400000).toISOString();
  const out = new Map();
  for (let i = 0; i < uniq.length; i += VERDICT_CHUNK) {
    const chunk = uniq.slice(i, i + VERDICT_CHUNK);
    const { data, error } = await store()
      .from("match_verdicts")
      .select("cache_key,output")
      .in("cache_key", chunk)
      .gte("scored_at", cutoff);
    if (error) throw new Error(`match_verdicts read failed: ${error.message}`);
    for (const r of data || []) out.set(r.cache_key, r.output);
  }
  return out;
}

// Upsert fresh verdicts. rows: [{ cache_key, email, output }]. scored_at is refreshed to now(), so a
// re-scored pair restarts its TTL clock. Returns the number written.
export async function putVerdicts(rows) {
  const clean = (rows || []).filter((r) => r && r.cache_key && r.email && r.output != null);
  if (!clean.length) return 0;
  let written = 0;
  for (let i = 0; i < clean.length; i += VERDICT_CHUNK) {
    const chunk = clean.slice(i, i + VERDICT_CHUNK).map((r) => ({
      cache_key: r.cache_key, email: r.email, output: r.output, scored_at: new Date().toISOString(),
    }));
    const { error } = await store().from("match_verdicts").upsert(chunk, { onConflict: "cache_key" });
    if (error) throw new Error(`match_verdicts write failed: ${error.message}`);
    written += chunk.length;
  }
  return written;
}

// Reap verdicts older than `days` (dead memoizations whose postings have long left the pool). Safe to
// call every run: one bounded DELETE with a window far beyond the read TTL, so it only removes stale rows.
export async function pruneVerdicts(days = 30) {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  const { error } = await store().from("match_verdicts").delete().lt("scored_at", cutoff);
  if (error) throw new Error(`match_verdicts prune failed: ${error.message}`);
}

// ── finds ────────────────────────────────────────────────────────────────────
// Set of find ids already HANDLED for this user. "Handled" means the email went
// out: status = 'emailed'. A find still 'new' (e.g. its send failed) is NOT
// returned here, so the next run retries it instead of skipping it.
export async function getFindIds(email) {
  const { data, error } = await scoped(email).select("finds", "id").eq("status", "emailed");
  if (error) throw new Error(`finds read failed: ${error.message}`);
  return new Set((data ?? []).map((r) => r.id));
}

// Normalized "company::title" key for semantic role dedup — so a role reposted with a new job
// id (or surfaced from a second source) isn't emailed to the same person twice.
export function roleKey(company, title) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${norm(company)}::${norm(title)}`;
}

// The set of company+title keys already EMAILED to this user (for duplicate-role prevention).
export async function getEmailedRoleKeys(email) {
  const { data, error } = await scoped(email).select("finds", "job").eq("status", "emailed");
  if (error) throw new Error(`finds read failed: ${error.message}`);
  return new Set((data ?? []).map((r) => roleKey(r.job?.company, r.job?.title)).filter((k) => k !== "::"));
}

// Normalized company name alone (for company-level cool-off and the core key).
export function companyKey(company) {
  return String(company || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Title with seniority/level noise stripped, so "Software Engineer II" and "Software Engineer"
// collapse to the same stem. NOT a synonym resolver (SDE != Software Engineer); the identity key
// below is the title-blind backstop for functional retitles.
export function titleStem(title) {
  return String(title || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(senior|sr|junior|jr|lead|principal|staff|mid|entry|associate|i|ii|iii|iv|v|1|2|3|4|5)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

// A STABLE job identity that survives a retitle + a new job id: the canonical apply_url (host+path,
// no query/tracking). Two postings of the SAME requisition almost always share an apply_url even
// when the title and the scraped id differ (the exact production repeat: a retitled repost with a
// fresh id). Falls back to company::title only when there's no url. This is the linchpin dedup
// vector — title-blind and id-blind.
export function canonicalJobIdentity(job) {
  const url = String(job?.apply_url || "").trim();
  if (url) {
    try {
      const u = new URL(url);
      const host = u.host.replace(/^www\./, "").toLowerCase();
      const path = u.pathname.replace(/\/+$/, "").toLowerCase();
      if (host && (path || host)) return `url:${host}${path}`;
    } catch { /* not a parseable url — fall through */ }
  }
  return `ct:${roleKey(job?.company, job?.title)}`;
}

// How long a find may sit at status 'new' before the repeat guard stops reading it as a prior send.
//
// 'new' is written BEFORE the physical send and flipped to 'emailed' after, so it means "in flight"
// — never "delivered". Nothing is in flight for half a day: a run takes minutes, and the on-demand
// server paths resolve in seconds. A 'new' row that outlived that window is a send that failed, was
// held, or died with the container.
//
// The window has to be longer than any single run (so today's 'new' still blocks the digest that
// runs minutes later in the same engine chain, and blocks a first-role the server sends the same
// hour) and SHORTER than the 24h cron cycle (so a failure is retried on the very next run instead of
// waiting another day). 12 hours sits between those two, with room on both sides.
export const STALE_NEW_HOURS = 12;

// Build the dedup fingerprint from raw `finds` rows. Pure (no DB) so the expiry rule below is
// unit-testable: the expiry is a rule about ROW AGE, which no test could reach if it were buried
// inside a Supabase read.
//
//   identities  — canonical apply_url identity (survives retitle + new id)  [PRIMARY]
//   roleKeys    — exact company::title
//   coreKeys    — company::titleStem (catches seniority retitles)
//   companies   — [{company, at}] of EMAILED sends, for the company cool-off backstop
//   staleNew    — ids of the expired 'new' rows that were IGNORED (for the caller's alarm)
export function signaturesFromRows(rows, { excludeId = null, excludeIds = null, now = Date.now() } = {}) {
  const identities = new Set(), roleKeys = new Set(), coreKeys = new Set(), companies = [], staleNew = [];
  const staleBefore = now - STALE_NEW_HOURS * 3600e3;
  for (const r of rows ?? []) {
    // Skip the caller's OWN in-flight find (e.g. the role match-one just persisted 'new' for dedup):
    // a sender must not treat the role it is actively sending right now as a prior repeat.
    // `excludeIds` is the same rule for a caller sending a BATCH (the weekly digest holds many 'digest'
    // finds at once): without it every item matches its own identity and the whole digest self-drops.
    if (excludeId && r.id === excludeId) continue;
    if (excludeIds && excludeIds.has(r.id)) continue;
    // An EXPIRED 'new' row is not evidence of a send, so it must not answer "already sent this
    // posting" — that answer is permanent, and a role that was prepared but never delivered would
    // never be offered. Expiring it here, at the ONE place every dedup path reads, means a crash
    // cannot skip the expiry.
    //
    // Safe against a double send because the anti-repeat backstop is NOT this status: `claimSend`
    // writes an atomic `sent_emails` row BEFORE the physical send, so a role that really went out
    // returns "duplicate" from sendGuarded even if its find never got flipped.
    //
    // Fail closed on an UNKNOWN age: a row with no created_at keeps blocking. A missed role is
    // recoverable; a repeat is not.
    if (r.status === "new" && r.created_at && Date.parse(r.created_at) < staleBefore) { staleNew.push(r.id); continue; }
    const j = r.job || {};
    identities.add(canonicalJobIdentity(j));
    const rk = roleKey(j.company, j.title); if (rk !== "::") roleKeys.add(rk);
    const ck = `${companyKey(j.company)}::${titleStem(j.title)}`; if (ck !== "::") coreKeys.add(ck);
    if (r.status === "emailed") companies.push({ company: companyKey(j.company), at: r.created_at || null });
  }
  return { identities, roleKeys, coreKeys, companies, staleNew };
}

// The full dedup fingerprint of everything already SENT to this user (emailed), plus what's queued
// (digest, and 'new' within its in-flight window — see STALE_NEW_HOURS) so a role can't leak across
// surfaces or on a retry.
export async function getEmailedRoleSignatures(email, { excludeId = null, excludeIds = null } = {}) {
  const { data, error } = await scoped(email).select("finds", "id,job,status,created_at").in("status", ["emailed", "digest", "new"]);
  if (error) throw new Error(`finds read failed: ${error.message}`);
  const sig = signaturesFromRows(data, { excludeId, excludeIds });
  // Say it out loud. An expired 'new' row is a role that was prepared and never delivered, so a
  // silent expiry would just move the invisibility one layer down.
  if (sig.staleNew.length) {
    console.error(`[finds] ${email}: ignoring ${sig.staleNew.length} find(s) stuck at 'new' for >${STALE_NEW_HOURS}h — prepared but never sent, so they no longer block a repeat: ${sig.staleNew.slice(0, 5).join(", ")}`);
  }
  return sig;
}

// How many role emails this user has been SENT since a given ISO time (for the per-day cadence cap).
export async function countEmailedSince(email, sinceISO) {
  const { data, error } = await scoped(email).select("finds", "id").eq("status", "emailed").gte("created_at", sinceISO);
  if (error) throw new Error(`emailed-count read failed: ${error.message}`);
  return (data || []).length;
}

// Full find rows for a user, newest first, optional status filter + limit.
export async function getFinds(email, { status, limit = 5 } = {}) {
  let q = scoped(email)
    .select("finds", "id, job, match, composed, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(`finds read failed: ${error.message}`);
  return data ?? [];
}

// One find by id, scoped to the user (no cross-user reads). Null if not found.
export async function getFindById(email, id) {
  const { data, error } = await scoped(email)
    .select("finds", "id, job, match, composed, status, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`finds read failed: ${error.message}`);
  return data ?? null;
}

// Statuses whose rows exist BECAUSE a gate fired. Each one must be able to say which gate, by name.
const GATED_STATUSES = new Set(["digest", "digest_sent", "closest"]);

/**
 * The one door that makes `digest_rule` impossible to omit.
 *
 * A `digest_reason` is prose ("strong profile fit, but location (Copenhagen) isn't reachable for
 * you"). The machine name of the gate that fired — `g.rule` from presend-guard.mjs — is what makes
 * the distribution of WHY roles get held back countable, so it must be recorded on every gated row.
 *
 * This is the write seam refusing to record a gated row without one. A caller that forgets gets the
 * explicit `unrecorded` sentinel AND a Sentry error, which is louder than a null and, unlike a NOT NULL
 * constraint on a jsonb key, cannot fail-to-zero the whole send.
 */
export function recordedRule(composed, status, id) {
  if (!GATED_STATUSES.has(status)) return composed ?? null;
  const rule = composed?.digest_rule;
  if (typeof rule === "string" && rule.trim()) return composed;
  captureError(new Error(`find ${id} written as '${status}' with no digest_rule — recorded as 'unrecorded'`), { service: "charlie-store", kind: "digest_rule_missing", status, id });
  return { ...(composed ?? {}), digest_rule: "unrecorded" };
}

export async function upsertFind({ email, jobId, job, match, composed, status = "new", slot = null, matcherVersion = MATCHER_VERSION, sentVariant = null }) {
  const id = `${requireEmail(email)}:${jobId}`;
  const composedOut = recordedRule(composed, status, id);

  // RETAIN FIT-SHAPED DIGEST ROWS ONLY. Enforced HERE because this is the single
  // door all three digest writers funnel through — scheduler.mjs, first-role.mjs and match-one.mjs —
  // the same reason recordedRule lives here. A fourth writer added later inherits the rule for free.
  //
  // Scope is deliberately narrow: `digest` only. `digest_sent` is a transition of a row that already
  // exists, `closest` is a different concept, and `dry_run` is used by the SEND path too, so filtering
  // it would silently drop send previews. Nothing is deleted; existing rows are untouched.
  if (status === "digest") {
    const decision = retainDecision(composedOut?.digest_rule);
    if (!decision.retain) {
      console.error(`[upsertFind] digest row not retained for ${id}: ${decision.why}`);
      return id; // callers ignore this id for digest writes; nothing downstream expects a row
    }
  }

  const base = { id, job, match, composed: composedOut, status };
  // Stamp send-time context (rank slot + matcher version) so an outcome can be attributed
  // to the decision that produced it.
  let { error } = await scoped(email).upsert(
    "finds",
    { ...base, slot, matcher_version: matcherVersion, sent_variant: sentVariant },
    { onConflict: "id" },
  );
  // Fail-safe for deploy/migration ordering: if the send-context columns don't exist yet (their
  // migration not applied), PostgREST rejects the WHOLE write. Rather than fail-to-zero on every
  // find (a silent no-send), retry once WITHOUT the new columns and warn.
  // Sends keep working; slot/matcher_version simply don't record until the migration lands.
  if (error && /column|schema cache|PGRST204|42703/i.test(`${error.message} ${error.code ?? ""}`)) {
    console.error(`[upsertFind] send-context columns missing (${error.message}); writing without slot/matcher_version until migration 20260728120100 is applied`);
    ({ error } = await scoped(email).upsert("finds", base, { onConflict: "id" }));
  }
  if (error) throw new Error(`finds upsert failed: ${error.message}`);
  return id;
}

// email-scoped on purpose: status changes are bound to the owning user, not just the
// id, so this can never flip another tenant's row even if an id were guessed.
export async function setFindStatus(email, id, status) {
  const { error } = await scoped(email).update("finds", { status }).eq("id", id);
  if (error) throw new Error(`finds status update failed: ${error.message}`);
}

// ── suppressions (do-not-send) ───────────────────────────────────────────────
// A GLOBAL do-not-send list keyed by address (not per-tenant). Populated by the
// Resend webhook on hard bounce / spam complaint, and checked before every send so
// we respect Resend's own suppression and protect deliverability thresholds.
export async function suppressAddress(address, reason) {
  const a = String(address || "").trim().toLowerCase();
  if (!a) return;
  const { error } = await store()
    .from("suppressions")
    .upsert({ address: a, reason: reason || "unknown", created_at: new Date().toISOString() }, { onConflict: "address" });
  if (error) throw new Error(`suppress failed: ${error.message}`);
}

// Remove an address from the global do-not-send list (the undo for suppressAddress — e.g. a
// deactivated test user returning). No-op if it wasn't suppressed.
export async function unsuppressAddress(address) {
  const a = String(address || "").trim().toLowerCase();
  if (!a) return;
  const { error } = await store().from("suppressions").delete().eq("address", a);
  if (error) throw new Error(`unsuppress failed: ${error.message}`);
}

export async function isSuppressed(address) {
  const a = String(address || "").trim().toLowerCase();
  if (!a) return false;
  // Fail-open: a missing table (before the migration runs) or a transient error must
  // never block the whole pipeline. Worst case we attempt a send Resend will itself
  // suppress. We log so it's visible.
  try {
    const { data, error } = await store().from("suppressions").select("address").eq("address", a).maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  } catch (e) {
    console.error(`[suppression] check skipped (${e.message}) — run the suppressions migration`);
    return false;
  }
}

// WHY an address is suppressed, or null if it isn't. isSuppressed answers "may we send?"; this
// answers "why not?", which only the inbound reply path needs. An unsubscribe means "stop sending
// me things", not "never speak to me again" — so a person who EMAILS Charlie still gets an answer.
// A hard bounce or a spam complaint is a different thing and must still block.
// Fail-closed FOR THIS PURPOSE: on any error we return null, and the caller falls back to the
// ordinary isSuppressed check, i.e. the exception is what disappears, never the protection.
export async function suppressionReason(address) {
  const a = String(address || "").trim().toLowerCase();
  if (!a) return null;
  try {
    const { data, error } = await store().from("suppressions").select("reason").eq("address", a).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.reason ?? null;
  } catch (e) {
    console.error(`[suppression] reason lookup failed for ${a}: ${e.message}`);
    return null;
  }
}

// The suppression reason for MANY addresses in one read, for the reachability alarm: which of the
// people we are actively trying to serve cannot receive anything, and why. `isSuppressed` per address
// answers "may we send?" one at a time and throws away the reason, which is why a hard-bounced
// forwarding address could silently swallow a real user's role emails and look like "no matches".
//
// Returns a Map(address -> reason) for the addresses that ARE suppressed, or **null** if the read
// failed. Null is not an empty Map on purpose: "nobody is blocked" and "I could not check" must not
// look the same to the caller, or the alarm quietly reports all-clear on a store blip. The caller
// decides what to do with each (see scheduler.mjs — it says so out loud).
export async function suppressionReasons(addresses) {
  const list = [...new Set((addresses ?? []).map((a) => String(a || "").trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return new Map();
  try {
    const { data, error } = await store().from("suppressions").select("address,reason").in("address", list);
    if (error) throw new Error(error.message);
    return new Map((data ?? []).map((r) => [String(r.address).toLowerCase(), r.reason || "unknown"]));
  } catch (e) {
    console.error(`[suppression] bulk reason lookup failed (${list.length} address(es)): ${e.message}`);
    return null;
  }
}

// ── waitlist (first contact, before a grounded profile exists) ───────────────
// Someone wrote to Charlie but no `candidates` row exists yet — the resume never arrived, so there
// is nothing to ground a profile on. Without this they are INVISIBLE: the reply goes out and
// nothing anywhere records that a real person is waiting. Reuses the existing `waitlist` table
// (unique on email); nothing else reads it, so this cannot disturb an existing consumer.
// First-contact time is preserved — a repeat write is a no-op, never a reset.
// Fail-soft: recording a contact must never break the reply we are about to send.
export async function recordFirstContact(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  try {
    const { error } = await store().from("waitlist").insert({ email: e });
    if (error) {
      if (error.code === "23505") return false; // already waiting — keep the original created_at
      throw new Error(error.message);
    }
    return true;
  } catch (err) {
    console.error(`[waitlist] first contact not recorded for ${e}: ${err.message}`);
    return false;
  }
}

// ── sent_emails (universal pre-send idempotency) ─────────────────────────────
// claimSend() atomically CLAIMS a (email, template, dedupe_key) before a send: the unique constraint
// means only the first caller wins; a retry / restart / overlapping run loses the insert and skips.
// releaseSend() undoes a claim after a FAILED send so it can be retried. Fail-open: if the table
// isn't applied yet (or a transient error), claimSend allows the send (returns true) so email is never
// silently blocked — worst case is a send without idempotency. Backed by the sent_emails migration.
export async function claimSend(email, template, dedupeKey) {
  const e = String(email || "").trim().toLowerCase();
  const key = dedupeKey == null ? "" : String(dedupeKey);
  if (!e || !template || !key) return true; // nothing to dedupe on -> allow (fail-open)
  try {
    const { data, error } = await store()
      .from("sent_emails")
      .insert({ email: e, template, dedupe_key: key })
      .select("id");
    if (error) {
      if (error.code === "23505") return false; // unique violation -> already claimed/sent
      throw new Error(error.message);
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error(`[sent_emails] claim skipped (${err.message}) — run the sent_emails migration`);
    return true; // fail-open: table missing / transient error -> allow the send
  }
}

/**
 * Record the Resend id AND what was actually said, on a claimed row after a successful send.
 *
 * THE WORDS ARE THE POINT. The Resend id alone answers "did we write to this person" and never "what
 * did we say": it is useless with a send-only API key. A follow-up or correction cannot be written
 * until somebody knows what the first email claimed, so the subject and body are filed here.
 *
 * Best-effort by design, and it stays that way. A failure to file the copy must never fail a send
 * that has already physically happened, and an older database without the columns simply ignores
 * them rather than throwing.
 */
export async function stampSend(email, template, dedupeKey, resendId, message) {
  const e = String(email || "").trim().toLowerCase();
  const key = dedupeKey == null ? "" : String(dedupeKey);
  if (!e || !template || !key) return;
  const patch = {};
  if (resendId) patch.resend_id = String(resendId);
  if (message?.subject) patch.subject = String(message.subject).slice(0, 500);
  if (message?.text) patch.body_text = String(message.text).slice(0, 20000);
  if (!Object.keys(patch).length) return;
  try {
    await store().from("sent_emails").update(patch).eq("email", e).eq("template", template).eq("dedupe_key", key);
  } catch {
    // The columns may not exist yet on an un-migrated database. Retry with the id alone rather than
    // losing the record entirely.
    if (resendId) {
      try { await store().from("sent_emails").update({ resend_id: String(resendId) }).eq("email", e).eq("template", template).eq("dedupe_key", key); } catch { /* best-effort */ }
    }
  }
}

// Release a claim after a FAILED send so a later run can re-claim + re-send.
export async function releaseSend(email, template, dedupeKey) {
  const e = String(email || "").trim().toLowerCase();
  const key = dedupeKey == null ? "" : String(dedupeKey);
  if (!e || !template || !key) return;
  try {
    await store().from("sent_emails").delete().eq("email", e).eq("template", template).eq("dedupe_key", key);
  } catch { /* best-effort */ }
}

/**
 * Asks we sent this person recently, newest last. Used by the inbound handler to tell an ANSWER
 * apart from a preference update: if we asked somebody a direct question in the last two weeks,
 * their reply belongs to that question and not to the preference writer. See lib/open-ask.mjs.
 *
 * THROWS RATHER THAN RETURNING EMPTY. An empty array means "we asked them nothing", which is the
 * precise state that made Charlie answer a careful reply with a question the person had already
 * answered. A read failure must not be able to imitate that, so it fails loudly and the caller
 * treats the error as an open ask.
 */
/**
 * The role emails we have actually sent this person, newest first.
 *
 * Feeds lib/role-in-play.mjs. Every template is returned, not just role sends, because deciding which
 * rows ARE role sends is `roleFindIdFromSend`'s job and it is pure so it can be unit-tested. Capped:
 * the role in play is the most recent one, so reading a person's whole send history to find it would
 * be a bigger query for an answer that is always near the top.
 */
export async function roleSendsFor(email, limit = 25) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return [];
  const { data, error } = await store()
    // subject + body_text come back too: they are what CHARLIE said, and lib/compose-reply.mjs needs
    // both halves of the exchange to answer "yes" in the light of what it was a yes TO. One read
    // serves role resolution and the transcript rather than two queries against the same rows.
    .from("sent_emails").select("email,dedupe_key,template,subject,body_text,sent_at")
    .eq("email", e).order("sent_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`roleSendsFor failed: ${error.message}`);
  return data || [];
}

/**
 * The last few things this person wrote to us, newest first.
 *
 * Reads `inbound_messages`, which recordInbound writes on every inbound message. It is not a memory
 * system and there is no new table: just the archive, read back.
 *
 * FAIL-SOFT, LIKE THE WRITE. `recordInbound` swallows its errors because failing to file somebody's
 * words must never stop us answering them. The read is the same bargain in reverse: if it fails we
 * answer with less context, we do not fail to answer.
 */
export async function recentTurns(email, limit = 6) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return [];
  try {
    const { data, error } = await store()
      .from("inbound_messages").select("subject,body,received_at")
      .eq("email", e).order("received_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.error(`[recent-turns] read failed for ${e}: ${err.message} — answering with less context`);
    return [];
  }
}

/**
 * Record what somebody told us when we sent them a role.
 *
 * WRITES ONLY WHAT THEY SAID. Every field is optional and a missing one is left alone, because a
 * blank here means "not asked or not answered" and must never become "no". The one thing this can
 * do that matters is stop us mailing somebody, so a `stop` is written even if nothing else parsed.
 *
 * FAIL-SOFT, LIKE THE REST OF THE INBOUND PATH. A failed write is logged and the reply still gets
 * answered: losing the record of an answer is bad, failing to answer a person is worse.
 *
 * @param {{email:string, open?:boolean, stop?:boolean, offerText?:string, until?:string|null, now?:string}} r
 */
export async function recordSeeking({ email, open = false, stop = false, offerText = "", until = null, now = null } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  const at = now || new Date().toISOString();
  const patch = {};
  if (open) { patch.seeking_status = "active_seeker"; patch.seeking_until = until; patch.seeking_confirmed_at = at; }
  // A stop clears the window as well as setting the status: leaving a live `seeking_until` behind
  // would let a later query call somebody available who has just asked us to stop.
  if (stop) { patch.seeking_status = "not_looking"; patch.seeking_until = null; patch.seeking_confirmed_at = at; }
  if (String(offerText || "").trim()) { patch.offer_status = String(offerText).slice(0, 500); patch.offer_noted_at = at; }
  if (!Object.keys(patch).length) return false;
  try {
    const { error } = await store().from("talent_pool").update(patch).eq("email", e);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[seeking] not recorded for ${e}: ${err.message}`);
    return false;
  }
}

export async function recentAsks(email, templates, sinceISO) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !Array.isArray(templates) || !templates.length) return [];
  const { data, error } = await store()
    .from("sent_emails").select("template,sent_at")
    .eq("email", e).in("template", templates).gte("sent_at", sinceISO)
    .order("sent_at", { ascending: true });
  if (error) throw new Error(`recentAsks failed: ${error.message}`);
  return data || [];
}

// A role-level send keys its sent_emails idempotency on the FIND id (`<email>:<jobId>`); other
// templates (digest, newsletter, ...) key on something else. So a dedupe_key that starts with the
// owning address is exactly the find the message was about. Pure (no DB) so it's unit-testable.
export function roleFindIdFromSend(row) {
  const email = String(row?.email || "").trim().toLowerCase();
  const key = row?.dedupe_key == null ? "" : String(row.dedupe_key);
  return email && key.startsWith(`${email}:`) ? key : null;
}

// Resolve the find id a Resend message id belongs to (role sends only), so a delivery/open
// webhook can attribute an event back to the exact role. Returns null for a non-role send or an unknown
// id. Fail-soft: never throws (the webhook stays fail-open).
export async function findIdForResend(resendId) {
  const id = String(resendId || "").trim();
  if (!id) return null;
  try {
    const { data, error } = await store().from("sent_emails").select("email,dedupe_key").eq("resend_id", id).limit(1).maybeSingle();
    if (error || !data) return null;
    return roleFindIdFromSend(data);
  } catch { return null; }
}

// ── email_events (delivery + lifecycle event log) ────────────────────────────
// Append-only log of email events. The Resend delivery webhook logs EVERY event here
// (delivered / bounced / complained / opened / ...), keyed by recipient, with the raw
// payload in meta for debugging. Fail-open: a transient error or a shape mismatch must
// never 500 the webhook or break a send — we log and move on. Service-role insert.
export async function logEmailEvent({ email, type, channel = "delivery", campaign = null, findId = null, resendId = null, meta = {} }) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr || !type) return; // email + type are NOT NULL in the table; skip a malformed event
  try {
    const { error } = await store().from("email_events").insert({
      email: addr, type, channel, campaign, find_id: findId, resend_id: resendId, meta: meta || {},
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(`[email_events] log skipped (${e.message})`);
  }
}

// ── signals (outcome-feedback event log — the flywheel) ──────────────────────
// Append-only. Best-effort: a missing table (before the migration) or a transient error
// must never break a send or a click handler. Service-role insert (RLS-bypassing), keyed
// by email. event = seen | worth | not | apply_click | applied | heard_back | interview | offer.
/**
 * How many emails of ONE template did this address get since `sinceIso`?
 *
 * Used to cap probe cadence without inventing a column: sendGuarded's idempotency already prevents
 * asking twice about the SAME role, but a person whose five applications all close in one week must
 * not receive five emails. Reads the existing sent_emails ledger.
 *
 * Fails CLOSED at 1 (i.e. "assume we already sent") on any error: if we cannot tell, stay quiet. An
 * unsent question is recoverable next run; an unwanted burst of mail is not.
 */
/**
 * The set of addresses that have ever fired a given signal.
 *
 * FOR HIDING AN ASK SOMEONE HAS ALREADY ANSWERED. The Pro block invites a reply; showing it again to
 * a person who already replied asks them for something they have given, which reads as Charlie not
 * listening, and that is the one impression this product cannot afford.
 *
 * Read ONCE per run and passed down, never per user, per role — the send loop scores every user
 * against many roles and a per-render query would multiply into hundreds of round trips for a
 * boolean that cannot change mid-run.
 *
 * FAILS OPEN to an empty set: an unreadable signals table means we show the block to everyone, which
 * is the pre-existing behaviour. Failing closed here would silently delete a section for all users on
 * an infra blip, and a vanished section is exactly the fail-to-zero shape this repo keeps shipping.
 */
export async function emailsWithSignal(event, { limit = 5000 } = {}) {
  try {
    const { data, error } = await store().from("signals").select("email").eq("event", event).limit(limit);
    if (error) throw new Error(error.message);
    return new Set((data || []).map((r) => String(r.email || "").toLowerCase()).filter(Boolean));
  } catch (err) {
    console.error(`[signals] could not read "${event}" (${err.message}) — showing the block to everyone this run`);
    return new Set();
  }
}

/**
 * Recent apply_click signals, for the outcome probe's selection pass.
 *
 * Bounded by BOTH a time window and a row cap: this feeds a pure selector that runs on every sweep,
 * and an unbounded read would grow with the product until it became the sweep's cost. Returns [] on
 * any error, which makes the sweep ask nobody rather than fail.
 */
export async function listRecentApplyClicks({ days = 45, limit = 3000 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    const { data, error } = await store()
      .from("signals")
      .select("email,job_id,created_at")
      .eq("event", "apply_click")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.error(`[apply-clicks] read failed (${err.message}) — outcome probe asks nobody this pass`);
    return [];
  }
}

export async function sentCountSince(email, template, sinceIso) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !template) return 1;
  try {
    const { count, error } = await store()
      .from("sent_emails")
      .select("*", { count: "exact", head: true })
      .eq("email", e)
      .eq("template", template)
      .gte("sent_at", sinceIso);
    if (error) throw new Error(error.message);
    return Number(count || 0);
  } catch (err) {
    console.error(`[sent-count] ${template}:${e} failed (${err.message}) — assuming already sent`);
    return 1;
  }
}

// ── inbound archive ──────────────────────────────────────────────────────────
//
// Keep what a person actually wrote. Resend delivers to a webhook rather than a mailbox, so without
// this archive an inbound message exists only for the length of one HTTP request: /inbound reads the
// body, acts on it, and nobody can read it afterwards.
//
// FAIL-OPEN, ALWAYS. This is a record, never a gate. If the write fails, the reply still goes: losing
// the archive copy of a message is a bad day, and failing to answer somebody because we could not
// file their words is worse. It swallows its own errors for exactly that reason.
export async function recordInbound({ email, subject = "", body = "", emailId = null, stage = null } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  try {
    const { error } = await store().from("inbound_messages").upsert(
      { email: e, subject: String(subject || "").slice(0, 500), body: String(body || "").slice(0, 100000), email_id: emailId || null, stage: stage || null },
      { onConflict: "email_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[inbound-archive] not stored (${err.message}) — run the inbound_messages migration`);
    return false;
  }
}

export async function recordSignal({ email, findId = null, jobId = null, event, meta = {} } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !event) return false;
  try {
    const { error } = await store().from("signals").insert({ email: e, find_id: findId, job_id: jobId, event, meta });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[signal] not recorded (${err.message}) — run the signals migration`);
    return false;
  }
}

// ── referral lookups (warm-intro finder: cache + monthly quota) ──────────────
// Best-effort like signals: a missing table (before the migration) or a transient
// error must never break the click handler or a send. Service-role, RLS-bypassing.

// Newest cached contacts for a company domain within the TTL, or null. Shared across
// users (contacts at a company don't depend on who asked) so repeats cost no quota.
export async function getReferralCache(domain, { maxAgeDays = 30 } = {}) {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  try {
    const { data, error } = await store()
      .from("referral_lookups")
      .select("contacts, company, created_at")
      .eq("domain", d)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const ageDays = (Date.now() - new Date(data.created_at).getTime()) / 864e5;
    if (ageDays > maxAgeDays) return null;
    return { contacts: Array.isArray(data.contacts) ? data.contacts : [], company: data.company || null };
  } catch (err) {
    console.error(`[referral] cache read skipped (${err.message}) — run the referrals migration`);
    return null;
  }
}

// Record a real provider search (one row == one search, for the monthly counter + cache).
export async function recordReferralLookup({ email, domain, company = null, contacts = [], chosen = null, provider = "hunter" } = {}) {
  const e = String(email || "").trim().toLowerCase();
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return false;
  try {
    const { error } = await store().from("referral_lookups").insert({ email: e || "unknown", domain: d, company, contacts, chosen, provider });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[referral] lookup not recorded (${err.message}) — run the referrals migration`);
    return false;
  }
}

// Provider searches used this calendar month (UTC) — the quota guard. Returns 0 on any error
// so a read failure never blocks a lookup (the provider's own cap is the real backstop).
export async function referralSearchesThisMonth() {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { count, error } = await store()
      .from("referral_lookups")
      .select("id", { count: "exact", head: true })
      .gte("created_at", monthStart);
    if (error) throw new Error(error.message);
    return count || 0;
  } catch (err) {
    console.error(`[referral] month count skipped (${err.message})`);
    return 0;
  }
}

// ── temporal spine: application stages (memory) + scheduled tasks (timers) ────
// Best-effort like signals/referrals: a missing table (before the migration) or a transient
// error must never break /inbound or a sweep. Service-role, RLS-bypassing.

// Set / advance an application's current stage. Keyed by find id when Charlie sent the role,
// else a stable "<email>:ext:<company|role>" key. Preserves applied_at across later advances.
export async function advanceApplication({ email, findId = null, company = null, role = null, stage = "applied", appliedAt = null, meta = null } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  // SECURITY (tenant isolation): the row id keys on findId, and on the /inbound `track@` path findId
  // is CALLER-SUPPLIED (a "ref: <email>:<jobId>" token from the email body). Only trust a findId that
  // belongs to THIS user ("<email>:..."), else a sender could pass another user's id and upsert-overwrite
  // that tenant's application row (reassign its email/stage). An untrusted findId is dropped and we fall
  // back to the derived "<email>:ext:<company|role>" key under the ACTING email — never another user's id.
  const trustedFindId = findId && String(findId).toLowerCase().startsWith(e + ":") ? String(findId) : null;
  const id = trustedFindId
    ? trustedFindId
    : `${e}:ext:${`${company || ""}|${role || ""}`.toLowerCase().replace(/[^a-z0-9|]+/g, "-").slice(0, 100)}`;
  const now = new Date().toISOString();
  const row = { id, email: e, find_id: trustedFindId, company, role, stage, stage_at: now, last_activity_at: now, updated_at: now };
  // Evidence provenance: every stage must trace to a real event (a forwarded email or a user tap).
  // getApplications refuses to surface a stage without this, so a stage can never be reported as fact
  // unless it actually happened. GROUNDING: Charlie never claims an interview/offer that didn't occur.
  if (meta) row.meta = meta;
  if (stage === "applied") row.applied_at = appliedAt || now; // only set on first apply; omitted on later advances so it's preserved
  try {
    const { error } = await store().from("applications").upsert(row, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[application] not saved (${err.message}) — run the temporal-spine migration`);
    return false;
  }
}

// All of a user's applications, newest activity first (for "where things stand" / standings).
export async function getApplications(email, { stage } = {}) {
  try {
    let q = scoped(email)
      .select("applications", "id, find_id, company, role, stage, applied_at, stage_at, last_activity_at, meta")
      .order("last_activity_at", { ascending: false });
    if (stage) q = q.eq("stage", stage);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    // GROUNDING GUARD: only surface stages backed by real evidence. "applied" needs a real applied_at
    // (a user tap or a classified confirmation); any advanced stage (interview/offer/heard_back/
    // rejected) needs meta.source (a real forwarded email that Charlie classified). A stage with
    // neither is unevidenced (e.g. stray/seed data) and is NEVER reported as fact.
    return (data ?? []).filter((a) => (a.stage === "applied" && a.applied_at) || (a.meta && a.meta.source));
  } catch (err) {
    console.error(`[application] read skipped (${err.message})`);
    return [];
  }
}

// Schedule a durable timer. `runAt` = when to fire; `kind` routes to a handler in the sweep.
export async function scheduleTask({ email, kind, runAt, payload = {} } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !kind || !runAt) return false;
  try {
    const { error } = await store().from("scheduled_tasks").insert({ email: e, kind, run_at: new Date(runAt).toISOString(), payload });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[task] not scheduled (${err.message}) — run the temporal-spine migration`);
    return false;
  }
}

// Cross-tenant read: the sweep processes due timers for ALL users (like listActiveCandidates).
export async function dueTasks({ limit = 100 } = {}) {
  try {
    const { data, error } = await store()
      .from("scheduled_tasks")
      .select("id, email, kind, run_at, payload")
      .eq("status", "pending")
      .lte("run_at", new Date().toISOString())
      .order("run_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) {
    console.error(`[task] due read skipped (${err.message})`);
    return [];
  }
}

export async function completeTask(id, status = "done") {
  try {
    const { error } = await store().from("scheduled_tasks").update({ status, done_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[task] complete failed (${err.message})`);
    return false;
  }
}

// Cancel a user's pending tasks of a kind (e.g., cancel the follow-up timer when a reply arrives).
export async function cancelTasks({ email, kind } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !kind) return false;
  try {
    const { error } = await store()
      .from("scheduled_tasks")
      .update({ status: "cancelled", done_at: new Date().toISOString() })
      .eq("email", e).eq("kind", kind).eq("status", "pending");
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[task] cancel failed (${err.message})`);
    return false;
  }
}

// ── connection identity (remote MCP) ─────────────────────────────────────────
// Per-user connection tokens are STATELESS and HMAC-SIGNED: the token carries the
// email plus a signature only the server (holding CHARLIE_TOKEN_SECRET) can make.
// The remote server derives identity by verifying the token — never from a tool
// argument, and no tokens table is needed (works for brand-new users too). Rotating
// the secret invalidates all tokens.
import { createHmac, timingSafeEqual } from "node:crypto";

function tokenSecret() {
  const s = process.env.CHARLIE_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error("CHARLIE_TOKEN_SECRET is missing or too short — set a long random string in env for the remote MCP");
  }
  return s;
}
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (email) => createHmac("sha256", tokenSecret()).update(email).digest();

// Mint a per-user connection token: base64url(email).base64url(hmac).
export function signToken(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw new Error("signToken: email required");
  return `${b64url(e)}.${b64url(sign(e))}`;
}

// Verify a token and return its email, or null if missing/forged/tampered.
export function emailForToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [ePart, sigPart] = token.split(".");
  let email;
  let sig;
  try {
    email = Buffer.from(ePart, "base64url").toString("utf8");
    sig = Buffer.from(sigPart, "base64url");
  } catch {
    return null;
  }
  const expected = sign(email);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  return email;
}

// Signed event tokens for one-click, no-login links in emails (feedback buttons, tracked
// apply). Same HMAC as connection tokens; carries a small JSON payload the server can trust:
// { e: email, f: findId, v: event, u?: destinationUrl }. base64url(json).base64url(hmac).
export function signEvent(payload) {
  const json = JSON.stringify(payload || {});
  const sig = createHmac("sha256", tokenSecret()).update(json).digest();
  return `${b64url(json)}.${b64url(sig)}`;
}

export function readEvent(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [pPart, sigPart] = token.split(".");
  let json;
  let sig;
  try {
    json = Buffer.from(pPart, "base64url").toString("utf8");
    sig = Buffer.from(sigPart, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", tokenSecret()).update(json).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// Reply-as-signal: the role email's Reply-To routes a "still chasing this one? just hit
// reply" reply to a dedicated chase+<token>@ address whose token HMAC-signs the exact (user, job).
// chaseReplyTo mints it at send; findRefFromChase parses it back on inbound. Reuses signEvent/readEvent,
// so a tampered token fails closed (readEvent -> null -> the reply is logged with a null find_id for
// manual review, never dropped). Pure + round-trippable, so the join is unit-testable.
export function chaseReplyTo({ email, jobId, from } = {}) {
  const e = String(email || "").trim().toLowerCase();
  const j = jobId == null ? "" : String(jobId);
  const domain = String(from || process.env.CHARLIE_FROM || "").split("@")[1] || "";
  if (!e || !j || !domain) return null;
  const local = `chase+${signEvent({ e, j })}`;
  // RFC 5321 caps a local-part at 64 octets and a whole address at 254. This token base64s the FULL
  // email + job id, so a real pair lands around 154 — Resend rejects the entire message with
  // 422 "Invalid `reply_to` field" and the role email never reaches the person.
  // Fail SAFE rather than fail-closed-to-sending: drop the Reply-To (losing only the chase signal,
  // which is telemetry) so the role email still goes out. A signal is never worth a send.
  // NOTE: every real pair exceeds 64, so this disables chase routing in practice. Making the feature
  // actually work needs a SHORT opaque id (a stored key, not a self-describing token) — its own build.
  if (local.length > 64 || local.length + 1 + domain.length > 254) return null;
  return `${local}@${domain}`;
}

// Parse a chase inbound local-part (`chase+<token>`) back to its find. Fail-soft: null on a non-chase
// local-part or a missing/tampered token.
export function findRefFromChase(localPart) {
  const lp = String(localPart || "");
  if (!/^chase\+/i.test(lp)) return null;
  const token = lp.slice(lp.indexOf("+") + 1);
  const p = readEvent(token);
  if (!p || !p.e || !p.j) return null;
  return { email: String(p.e), jobId: String(p.j), findId: `${p.e}:${p.j}` };
}
