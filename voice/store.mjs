// voice/store.mjs — every read and write for the vv_* tables: mandate, plan, candidate, session,
// invitation, consent, conversation, turns, events, evidence/signals/reports, and the deletion cascade.
//
// ONE CLIENT. Built on store() from charlie-store.mjs so there is still one Supabase client and one
// place the service-role key is read. Nothing else in voice/ imports @supabase/supabase-js.
//
// NOTHING HERE TOUCHES candidates, finds, talent_pool, or any non-vv_ table.
//
// FAIL LOUD, NOT OPEN. Elsewhere code fails open when a table is missing; that exists for
// the role mailer, where a missing side table must not stop a send. Here a missing table means the
// verification cannot be recorded, and recording is the product, so every call throws.
import { store } from "../charlie-store.mjs";
import { transition } from "./session.mjs";

let _override = null;
/** TEST ONLY: swap the Supabase client for an in-memory fake (voice/__tests__/fake-db.mjs). */
export function _setClientForTests(client) { _override = client; }
const db = () => /** @type {any} */ (_override || store());
/** The Supabase client the store is using: the injected fake under test, the service-role client otherwise. */
export const client = () => db();

/** Every vv_ table, in the order a session's data is deleted. Used by the cascade and by its test. */
export const VV_SESSION_TABLES = ["vv_disputes", "vv_reviews", "vv_reports", "vv_signals", "vv_contradictions", "vv_evidence", "vv_turns", "vv_conversations", "vv_consents", "vv_invitations", "vv_events", "vv_sessions"];

function must({ data, error }, what) {
  if (error) throw new Error(`voice/store ${what}: ${error.message}`);
  return data;
}

// ── mandate ──────────────────────────────────────────────────────────────────

/** Insert the mandate with its parsed matrix and what the quote check dropped. Returns the row. */
export async function saveMandate({ client = null, role, contact_email, jd_text, hr_questions = [], next_step_text = null, parsed, dropped = [] }) {
  const row = { client, role, contact_email: String(contact_email).toLowerCase(), jd_text, hr_questions, next_step_text, parsed, dropped, status: "parsed" };
  const data = must(await db().from("vv_mandates").insert(row).select("*").single(), "saveMandate");
  return data;
}

/** One vv_requirements row per matrix entry. Returns a map ref -> requirement id. */
export async function saveRequirements(mandateId, matrix) {
  const rows = [];
  const push = (bucket, kind, items) =>
    (items || []).forEach((it, index) =>
      rows.push({
        mandate_id: mandateId,
        ref: `${bucket}:${index}`,
        kind,
        text: it.requirement || it.phrase || "",
        quote: it.quote || "",
        evidence_needed: it.evidence_needed || null,
        observable: it.observable || null,
      }));
  push("hard", "hard", matrix.hard);
  push("preferred", "preferred", matrix.preferred);
  push("capabilities", "capability", matrix.capabilities);
  push("ambiguous", "ambiguous", matrix.ambiguous);
  if (!rows.length) return {};
  const data = must(await db().from("vv_requirements").insert(rows).select("id, ref"), "saveRequirements");
  return Object.fromEntries(data.map((r) => [r.ref, r.id]));
}

// ── plan ─────────────────────────────────────────────────────────────────────

/** Next version number for a mandate's plans. */
export async function nextPlanVersion(mandateId) {
  const data = must(await db().from("vv_plans").select("version").eq("mandate_id", mandateId).order("version", { ascending: false }).limit(1), "nextPlanVersion");
  return (data[0]?.version || 0) + 1;
}

/**
 * Insert a draft plan and its items. `refToRequirementId` links matrix items; question and intent
 * items keep requirement_id null. Returns the plan id.
 */
export async function savePlan(plan, refToRequirementId = {}) {
  if (!plan.mandate_id) throw new Error("savePlan: plan.mandate_id is required");
  if (plan.status !== "draft") throw new Error("savePlan: only a draft can be inserted; approval goes through persistApproval");
  const head = {
    id: plan.id,
    mandate_id: plan.mandate_id,
    version: plan.version,
    status: "draft",
    session_budget_seconds: plan.session_budget_seconds,
    consent_text_version: plan.consent_text_version,
    flagged: plan.flagged || [],
    override_reason: null,
  };
  must(await db().from("vv_plans").insert(head), "savePlan (plan)");
  const items = plan.items.map((it) => ({
    id: it.id,
    plan_id: plan.id,
    requirement_id: refToRequirementId[it.ref] || null,
    ref: it.ref,
    kind: it.kind,
    priority: it.priority,
    budget_seconds: it.budget_seconds,
    evidence_contract: it.evidence_contract,
  }));
  must(await db().from("vv_plan_items").insert(items), "savePlan (items)");
  return plan.id;
}

/** Load a plan with its items and its mandate (jd_text and hr_questions, for the chain check). */
export async function loadPlan(planId) {
  const head = must(await db().from("vv_plans").select("*").eq("id", planId).single(), "loadPlan (plan)");
  const items = must(await db().from("vv_plan_items").select("*").eq("plan_id", planId).order("priority"), "loadPlan (items)");
  const mandate = must(await db().from("vv_mandates").select("*").eq("id", head.mandate_id).single(), "loadPlan (mandate)");
  const plan = {
    id: head.id,
    mandate_id: head.mandate_id,
    version: head.version,
    status: head.status,
    session_budget_seconds: head.session_budget_seconds,
    consent_text_version: head.consent_text_version,
    flagged: head.flagged || [],
    override_reason: head.override_reason ?? null,
    approved_by: head.approved_by ?? null,
    approved_at: head.approved_at ?? null,
    consent_text_version: head.consent_text_version ?? null,
    items: items.map((r) => ({
      id: r.id, requirement_id: r.requirement_id, ref: r.ref, kind: r.kind,
      priority: r.priority, budget_seconds: r.budget_seconds, evidence_contract: r.evidence_contract,
    })),
  };
  return { plan, mandate };
}

/**
 * The `persist` for voice/plan.mjs approvePlan. Marks the mandate's current approved plan
 * superseded (the one change the trigger allows), then approves this one. Items are never touched:
 * the trigger would refuse, and there is nothing to change.
 */
export async function persistApproval(approved) {
  must(
    await db().from("vv_plans").update({ status: "superseded" }).eq("mandate_id", approved.mandate_id).eq("status", "approved").neq("id", approved.id),
    "persistApproval (supersede)",
  );
  must(
    await db().from("vv_plans").update({
      status: "approved",
      approved_by: approved.approved_by,
      approved_at: approved.approved_at,
      override_reason: approved.override_reason,
      consent_text_version: approved.consent_text_version,
    }).eq("id", approved.id).eq("status", "draft"),
    "persistApproval (approve)",
  );
  const check = must(await db().from("vv_plans").select("status").eq("id", approved.id).single(), "persistApproval (verify)");
  if (check.status !== "approved") throw new Error(`persistApproval: plan ${approved.id} is ${check.status}, not approved (was it still a draft?)`);
  return approved.id;
}

// ── candidate ────────────────────────────────────────────────────────────────

/** One row per person, keyed by lowercased email. Never touches `candidates`. */
export async function upsertVvCandidate({ email, name_as_given = null, cv_ref = null }) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw new Error("upsertVvCandidate: email is required");
  return must(await db().from("vv_candidates").upsert({ email: e, name_as_given, cv_ref }, { onConflict: "email" }).select("*").single(), "upsertVvCandidate");
}

export async function getVvCandidateById(id) {
  const data = must(await db().from("vv_candidates").select("*").eq("id", id).limit(1), "getVvCandidateById");
  return data[0] || null;
}

export async function getVvCandidate(email) {
  const e = String(email || "").trim().toLowerCase();
  const data = must(await db().from("vv_candidates").select("*").eq("email", e).limit(1), "getVvCandidate");
  return data[0] || null;
}

// ── session ──────────────────────────────────────────────────────────────────

/**
 * Create a session in `invited`. The kind rule is enforced here AND by the migration's check
 * constraint: a test session has a tester and no candidate; a candidate session the reverse.
 */
export async function createSession({ kind, candidate_id = null, tester_email = null, plan_id }) {
  if (!plan_id) throw new Error("createSession: plan_id is required");
  if (kind === "test") {
    if (candidate_id || !tester_email) throw new Error("createSession: a test session has tester_email and no candidate_id");
  } else if (kind === "candidate") {
    if (!candidate_id || tester_email) throw new Error("createSession: a candidate session has candidate_id and no tester_email");
  } else {
    throw new Error(`createSession: unknown kind "${kind}"`);
  }
  const plan = must(await db().from("vv_plans").select("status").eq("id", plan_id).single(), "createSession (plan)");
  if (plan.status !== "approved") throw new Error(`createSession: plan ${plan_id} is ${plan.status}, not approved`);
  const row = { kind, candidate_id, tester_email: tester_email ? String(tester_email).toLowerCase() : null, plan_id, state: "invited", cursor: {}, conditions: {}, version: 1 };
  return must(await db().from("vv_sessions").insert(row).select("*").single(), "createSession");
}

export async function getSession(id) {
  return must(await db().from("vv_sessions").select("*").eq("id", id).single(), "getSession");
}

/**
 * Apply one event through the pure state machine and persist the result, with the event logged.
 * @returns {Promise<{ok:true, state:string} | {ok:false, reason:string}>}
 */
export async function transitionSession(id, event, payload = {}) {
  const s = await getSession(id);
  const r = transition(s, event);
  if (!r.ok) return r;
  const patch = { state: r.state };
  if (event === "conversation.started" && !s.started_at) patch.started_at = new Date().toISOString();
  if (event === "session.completed") patch.completed_at = new Date().toISOString();
  must(await db().from("vv_sessions").update(patch).eq("id", id), "transitionSession");
  await insertEvent({ session_id: id, kind: s.kind, type: event, payload: { ...payload, from: s.state, to: r.state, kind: s.kind } });
  return r;
}

/**
 * Write the controller's cursor. Optimistic: `expectedVersion` must match or the write is refused
 * and the caller falls back to the scripted line. Never retried here.
 * @returns {Promise<{ok:true, version:number} | {ok:false, reason:string}>}
 */
export async function writeCursor(id, cursor, expectedVersion) {
  const data = must(
    await db().from("vv_sessions").update({ cursor, version: expectedVersion + 1 }).eq("id", id).eq("version", expectedVersion).select("version"),
    "writeCursor",
  );
  if (!data.length) return { ok: false, reason: `stale cursor write for session ${id} (expected version ${expectedVersion})` };
  return { ok: true, version: data[0].version };
}

export async function mergeConditions(id, patch) {
  const s = await getSession(id);
  must(await db().from("vv_sessions").update({ conditions: { ...(s.conditions || {}), ...patch } }).eq("id", id), "mergeConditions");
}

/** Sessions for candidate-level metrics. ALWAYS kind = candidate; test sessions are listed by listTestSessions. */
export async function listCandidateSessions({ state = null, limit = 500 } = {}) {
  let q = db().from("vv_sessions").select("*").eq("kind", "candidate").limit(limit);
  if (state) q = q.eq("state", state);
  return must(await q, "listCandidateSessions");
}

export async function listTestSessions({ state = null, limit = 500 } = {}) {
  let q = db().from("vv_sessions").select("*").eq("kind", "test").limit(limit);
  if (state) q = q.eq("state", state);
  return must(await q, "listTestSessions");
}

// ── invitation, consent, conversation, turns, events ─────────────────────────

export async function insertInvitation({ session_id, token_hash, expires_at, sent_at = null }) {
  return must(await db().from("vv_invitations").insert({ session_id, token_hash, expires_at, sent_at }).select("*").single(), "insertInvitation");
}

export async function findInvitationByHash(token_hash) {
  const data = must(await db().from("vv_invitations").select("*").eq("token_hash", token_hash).limit(1), "findInvitationByHash");
  return data[0] || null;
}

export async function markInvitationOpened(id) {
  must(await db().from("vv_invitations").update({ opened_at: new Date().toISOString() }).eq("id", id), "markInvitationOpened");
}

export async function insertConsent({ session_id, scope, text_version, granted, user_agent = null }) {
  return must(await db().from("vv_consents").insert({ session_id, scope, text_version, granted, user_agent }).select("*").single(), "insertConsent");
}

export async function listConsents(session_id) {
  return must(await db().from("vv_consents").select("*").eq("session_id", session_id), "listConsents");
}

/** Idempotent on the provider's conversation id: a second start or a replayed webhook is a no-op. */
export async function upsertConversation({ session_id, provider_conversation_id }) {
  return must(
    await db().from("vv_conversations").upsert({ session_id, provider_conversation_id, started_at: new Date().toISOString() }, { onConflict: "provider_conversation_id", ignoreDuplicates: true }).select("*"),
    "upsertConversation",
  );
}

export async function getConversationByProviderId(provider_conversation_id) {
  const data = must(await db().from("vv_conversations").select("*").eq("provider_conversation_id", provider_conversation_id).limit(1), "getConversationByProviderId");
  return data[0] || null;
}

export async function updateConversation(id, patch) {
  must(await db().from("vv_conversations").update(patch).eq("id", id), "updateConversation");
}

export async function listConversations(session_id) {
  return must(await db().from("vv_conversations").select("*").eq("session_id", session_id).order("started_at"), "listConversations");
}

/** The canonical transcript. Idempotent on (conversation_id, seq). */
export async function writeTurns(conversation_id, turns) {
  const rows = turns.map((t) => ({ ...t, conversation_id }));
  if (!rows.length) return 0;
  must(await db().from("vv_turns").upsert(rows, { onConflict: "conversation_id,seq" }), "writeTurns");
  return rows.length;
}

export async function listTurns(conversation_id) {
  return must(await db().from("vv_turns").select("*").eq("conversation_id", conversation_id).order("seq"), "listTurns");
}

export async function insertEvent({ session_id, kind, type, payload = {} }) {
  return must(await db().from("vv_events").insert({ session_id, kind, type, payload }).select("*").single(), "insertEvent");
}

export async function listEvents(session_id) {
  return must(await db().from("vv_events").select("*").eq("session_id", session_id).order("at"), "listEvents");
}

// ── evidence, signals, reports, reviews ──────────────────────────────────────

export async function insertEvidence(items) {
  if (!items.length) return 0;
  must(await db().from("vv_evidence").insert(items), "insertEvidence");
  return items.length;
}

export async function listEvidence(session_id) {
  return must(await db().from("vv_evidence").select("*").eq("session_id", session_id), "listEvidence");
}

export async function insertContradictions(session_id, rows) {
  if (!rows.length) return 0;
  must(await db().from("vv_contradictions").insert(rows.map((r) => ({ ...r, session_id }))), "insertContradictions");
  return rows.length;
}

/** Replaces the session's signals for a re-run under a new version: delete then insert. */
export async function replaceSignals(session_id, signals) {
  must(await db().from("vv_signals").delete().eq("session_id", session_id), "replaceSignals (delete)");
  if (!signals.length) return 0;
  must(await db().from("vv_signals").insert(signals.map((s) => ({ ...s, session_id }))), "replaceSignals (insert)");
  return signals.length;
}

export async function listSignals(session_id) {
  return must(await db().from("vv_signals").select("*").eq("session_id", session_id), "listSignals");
}

export async function nextReportVersion(session_id) {
  const data = must(await db().from("vv_reports").select("version").eq("session_id", session_id).order("version", { ascending: false }).limit(1), "nextReportVersion");
  return (data[0]?.version || 0) + 1;
}

export async function insertReport({ session_id, version, package: pkg }) {
  return must(await db().from("vv_reports").insert({ session_id, version, package: pkg }).select("*").single(), "insertReport");
}

export async function insertReview({ session_id, report_version, reviewer, per_signal, evidence_lift = {} }) {
  return must(await db().from("vv_reviews").insert({ session_id, report_version, reviewer, per_signal, evidence_lift }).select("*").single(), "insertReview");
}

export async function latestReview(session_id) {
  const data = must(await db().from("vv_reviews").select("*").eq("session_id", session_id).order("recorded_at", { ascending: false }).limit(1), "latestReview");
  return data[0] || null;
}

// ── dashboard reads and the CV object ───────────────────────────────────────

export const VV_BUCKET = "voice-verification";

/** Private bucket for CVs, raw webhook payloads, audio. Created once; a second call is a no-op. */
export async function ensureBucket() {
  const { data } = await db().storage.getBucket(VV_BUCKET);
  if (data) return VV_BUCKET;
  const { error } = await db().storage.createBucket(VV_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) throw new Error(`ensureBucket: ${error.message}`);
  return VV_BUCKET;
}

/** Store a CV as text under cv/<candidate id>.txt and return the ref. */
export async function saveCvText(candidateId, text) {
  await ensureBucket();
  const path = `cv/${candidateId}.txt`;
  const { error } = await db().storage.from(VV_BUCKET).upload(path, new Blob([String(text)], { type: "text/plain" }), { upsert: true });
  if (error) throw new Error(`saveCvText: ${error.message}`);
  must(await db().from("vv_candidates").update({ cv_ref: path }).eq("id", candidateId), "saveCvText (ref)");
  return path;
}

/** Store a raw provider payload (a webhook body) verbatim under conversations/<provider id>/<name>.json and return the ref. */
export async function saveRawPayload(providerConversationId, name, payload) {
  await ensureBucket();
  const path = `conversations/${providerConversationId}/${name}.json`;
  const { error } = await db().storage.from(VV_BUCKET).upload(path, new Blob([JSON.stringify(payload)], { type: "application/json" }), { upsert: true });
  if (error) throw new Error(`saveRawPayload: ${error.message}`);
  return path;
}

/** A CV attached to a TEST session (a persona), under cv/session-<id>.txt, its ref in conditions.cv_ref (jsonb, no schema change). */
export async function saveTestCvText(sessionId, text) {
  await ensureBucket();
  const path = `cv/session-${sessionId}.txt`;
  const { error } = await db().storage.from(VV_BUCKET).upload(path, new Blob([String(text)], { type: "text/plain" }), { upsert: true });
  if (error) throw new Error(`saveTestCvText: ${error.message}`);
  await mergeConditions(sessionId, { cv_ref: path });
  return path;
}

/** Read a stored text object back; null when there is none or it cannot be read. */
export async function readText(path) {
  if (!path) return null;
  const { data, error } = await db().storage.from(VV_BUCKET).download(path);
  if (error || !data) return null;
  return typeof data === "string" ? data : await data.text();
}

export async function getMandate(id) {
  return must(await db().from("vv_mandates").select("*").eq("id", id).single(), "getMandate");
}

export async function listMandates({ limit = 200 } = {}) {
  return must(await db().from("vv_mandates").select("id, client, role, contact_email, status, created_at, next_step_text").order("created_at", { ascending: false }).limit(limit), "listMandates");
}

export async function listPlansForMandate(mandateId) {
  return must(await db().from("vv_plans").select("id, version, status, session_budget_seconds, approved_by, approved_at, created_at, flagged").eq("mandate_id", mandateId).order("version", { ascending: false }), "listPlansForMandate");
}

export async function listSessionsForDashboard({ limit = 500 } = {}) {
  return must(await db().from("vv_sessions").select("id, kind, candidate_id, tester_email, plan_id, state, started_at, completed_at, created_at, conditions").order("created_at", { ascending: false }).limit(limit), "listSessionsForDashboard");
}

export async function listContradictions(session_id) {
  return must(await db().from("vv_contradictions").select("*").eq("session_id", session_id), "listContradictions");
}

export async function latestReport(session_id) {
  const data = must(await db().from("vv_reports").select("*").eq("session_id", session_id).order("version", { ascending: false }).limit(1), "latestReport");
  return data[0] || null;
}

export async function listAllReviews({ limit = 2000 } = {}) {
  return must(await db().from("vv_reviews").select("*").order("recorded_at", { ascending: false }).limit(limit), "listAllReviews");
}

// ── deletion ─────────────────────────────────────────────────────────────────

/**
 * Delete one session and everything under it, explicitly, table by table, then verify nothing is
 * left. The migration's FK cascade would do the same; doing it here means the test can prove which
 * tables were touched and a missing cascade in the database cannot leave a row behind unnoticed.
 * Storage objects referenced by the session's conversations are removed first; a failure there
 * throws, because a deletion that silently leaves a recording is not a deletion.
 */
export async function deleteSession(id, { bucket = "voice-verification" } = {}) {
  const convs = must(await db().from("vv_conversations").select("id, raw_payload_ref, audio_ref").eq("session_id", id), "deleteSession (conversations)");
  const objects = convs.flatMap((c) => [c.raw_payload_ref, c.audio_ref]).filter(Boolean);
  if (objects.length) {
    const { error } = await db().storage.from(bucket).remove(objects);
    if (error) throw new Error(`deleteSession: storage removal failed for session ${id}: ${error.message}`);
  }
  const convIds = convs.map((c) => c.id);
  for (const t of ["vv_disputes", "vv_reviews", "vv_reports", "vv_signals", "vv_contradictions", "vv_evidence"]) must(await db().from(t).delete().eq("session_id", id), `deleteSession (${t})`);
  if (convIds.length) must(await db().from("vv_turns").delete().in("conversation_id", convIds), "deleteSession (turns)");
  must(await db().from("vv_conversations").delete().eq("session_id", id), "deleteSession (conversations)");
  must(await db().from("vv_consents").delete().eq("session_id", id), "deleteSession (consents)");
  must(await db().from("vv_invitations").delete().eq("session_id", id), "deleteSession (invitations)");
  must(await db().from("vv_events").delete().eq("session_id", id), "deleteSession (events)");
  must(await db().from("vv_sessions").delete().eq("id", id), "deleteSession (session)");
  const left = must(await db().from("vv_sessions").select("id").eq("id", id), "deleteSession (verify)");
  if (left.length) throw new Error(`deleteSession: session ${id} still exists after delete`);
  return { conversations: convIds.length, objects: objects.length };
}

/** The candidate's cascade: every session, then the person. Verifies zero rows remain. */
export async function deleteVvCandidate(email) {
  const c = await getVvCandidate(email);
  if (!c) return { found: false, sessions: 0 };
  const sessions = must(await db().from("vv_sessions").select("id").eq("candidate_id", c.id), "deleteVvCandidate (sessions)");
  for (const s of sessions) await deleteSession(s.id);
  if (c.cv_ref) {
    const { error } = await db().storage.from("voice-verification").remove([c.cv_ref]);
    if (error) throw new Error(`deleteVvCandidate: CV removal failed: ${error.message}`);
  }
  must(await db().from("vv_candidates").delete().eq("id", c.id), "deleteVvCandidate (candidate)");
  const left = must(await db().from("vv_candidates").select("id").eq("id", c.id), "deleteVvCandidate (verify)");
  if (left.length) throw new Error(`deleteVvCandidate: ${email} still exists after delete`);
  return { found: true, sessions: sessions.length };
}
