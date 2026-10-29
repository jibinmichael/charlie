// voice/pipeline.mjs — the post-call pipeline. NO SEND. NO CANDIDATE CONTACT.
//
// A session whose canonical transcript has arrived (transcript_ready) becomes a report:
//   extract (one model call per plan item, under a cost cap) → validate (cite-or-drop) →
//   evaluate (deterministic) → render (the ReportPackage) → reported (test) or awaiting_review
//   (candidate). Each stage is a state-machine event, so a run that dies mid-way resumes at the
//   stage it reached, and a session already reported at these versions is a no-op.
//
// WHO DECIDES WHAT. The model only copies evidence out (voice/extract.mjs); everything it returns
// passes voice/evidence-validate.mjs, which drops any quote that is not verbatim in a turn. The
// statuses come from voice/evaluate.mjs, which is arithmetic over that evidence. Nothing here
// writes a sentence about a person; the package's prose is the fixed sentences in
// voice/statuses.mjs. A failed extraction on one item leaves that item `insufficient
// (extraction)` and the rest of the session proceeds (per-record isolation).
//
// COST. The extractor's usage is added up as it goes and the loop stops at
// VOICE_MAX_PIPELINE_COST_USD; items not reached read `insufficient (cap)` with the cap as the
// reason. The estimate uses list prices for the extractor model and is a guard, not a bill.
import { extractItem, VV_EXTRACT_PROMPT_VERSION } from "./extract.mjs";
import { validateEvidence } from "./evidence-validate.mjs";
import { evaluateSession, EVALUATOR_VERSION } from "./evaluate.mjs";
import { buildPackage } from "./render-package.mjs";
import { CONTROLLER_VERSION } from "./controller.mjs";
import { pingHeartbeat } from "../lib/heartbeat.mjs";
import { captureError } from "../lib/sentry-node.mjs";

export const PIPELINE_VERSION = "2026-09-23.1";

/** The stages a session can be picked up at, and what the pipeline still owes it. */
export const RESUMABLE_STATES = ["transcript_ready", "evidence_ready", "evaluated", "blocked"];

// Approximate list prices, USD per million tokens, for the extractor model (Sonnet class). Used
// only to stop the loop at the cap; the real bill is the provider's.
export const USD_PER_MILLION = { input: 3, output: 15 };
export function usageCostUsd(usage) {
  if (!usage) return 0;
  const inTok = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  return (inTok * USD_PER_MILLION.input + outTok * USD_PER_MILLION.output) / 1e6;
}

export function capFromEnv() {
  const n = Number(process.env.VOICE_MAX_PIPELINE_COST_USD);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

async function loadTurns(store, sessionId) {
  const conversations = await store.listConversations(sessionId);
  const turns = [];
  for (const c of conversations) turns.push(...(await store.listTurns(c.id)).map((t) => ({ ...t, conversation_id: c.id })));
  return { conversations, turns };
}

/** The extraction stage's own memory, read back from its event so a resumed run keeps it. */
async function extractionMemo(store, sessionId) {
  const events = await store.listEvents(sessionId);
  const e = [...events].reverse().find((x) => x.type === "evidence.extracted");
  return { failures: new Set(e?.payload?.failures || []), capHit: new Set(e?.payload?.cap_hit || []), costUsd: Number(e?.payload?.cost_usd || 0) };
}

/**
 * Run the pipeline for one session, from whatever stage it is at.
 * @param {{store:object, client:object|null, sessionId:string, maxCostUsd?:number, log?:Function}} p
 * @returns {Promise<{ok:boolean, sessionId:string, state:string, skipped?:string, version?:number, cost_usd?:number, failures?:string[], cap_hit?:string[], blocked?:string}>}
 */
export async function runPipelineForSession({ store, client, sessionId, maxCostUsd = capFromEnv(), log = console.error }) {
  let session = await store.getSession(sessionId);
  if (!session) return { ok: false, sessionId, state: "missing", skipped: "missing" };

  // Idempotent on session and version: a report at these versions means nothing is owed.
  const prior = await store.latestReport(sessionId);
  if (prior?.package?.versions?.extractor === VV_EXTRACT_PROMPT_VERSION && prior?.package?.versions?.evaluator === EVALUATOR_VERSION) {
    return { ok: true, sessionId, state: session.state, skipped: "already_reported", version: prior.version };
  }
  if (!RESUMABLE_STATES.includes(session.state)) return { ok: true, sessionId, state: session.state, skipped: "state" };

  const { plan, mandate } = await store.loadPlan(session.plan_id);
  const candidate = session.candidate_id ? await store.getVvCandidateById(session.candidate_id) : null;
  const { conversations, turns } = await loadTurns(store, sessionId);
  const memo = await extractionMemo(store, sessionId);

  // ── extract + validate ────────────────────────────────────────────────────────────────────
  if (session.state === "transcript_ready") {
    const failures = new Set();
    const capHit = new Set();
    let costUsd = 0;
    let inserted = 0;
    const items = [...plan.items].sort((a, b) => a.priority - b.priority);
    for (const item of items) {
      if (costUsd >= maxCostUsd) { capHit.add(item.id); continue; }
      const itemTurns = turns.filter((t) => t.plan_item_id === item.id);
      try {
        const r = await extractItem({ client, item, turns: itemTurns, log });
        if (!r.ok) { failures.add(item.id); log(`[vv-pipeline] ${sessionId} item ${item.ref}: extraction ${r.reason}${r.detail ? ` (${r.detail})` : ""}`); continue; }
        costUsd += usageCostUsd(r.usage);
        const { items: rows, dropped } = validateEvidence(r.output, { item, sessionId, turns: itemTurns, extractorVersion: VV_EXTRACT_PROMPT_VERSION });
        if (dropped.length) log(`[vv-pipeline] ${sessionId} item ${item.ref}: dropped ${dropped.length} (cite-or-drop)`);
        if (rows.length) { await store.insertEvidence(rows); inserted += rows.length; }
      } catch (e) {
        failures.add(item.id);
        log(`[vv-pipeline] ${sessionId} item ${item.ref}: ${e?.message || e}`);
      }
    }
    const t = await store.transitionSession(sessionId, "evidence.extracted", { items: inserted, failures: [...failures], cap_hit: [...capHit], cost_usd: Number(costUsd.toFixed(4)), pipeline_version: PIPELINE_VERSION });
    if (!t.ok) return { ok: false, sessionId, state: session.state, skipped: t.reason };
    memo.failures = failures; memo.capHit = capHit; memo.costUsd = costUsd;
    session = await store.getSession(sessionId);
  }

  // ── evaluate ──────────────────────────────────────────────────────────────────────────────
  if (session.state === "evidence_ready" || session.state === "blocked") {
    const evidence = await store.listEvidence(sessionId);
    // CV facts are not extracted yet (no CV-fact extractor exists); contradictions run between turns only.
    const ev = evaluateSession({ plan, cursor: session.cursor || {}, evidence, cvFacts: [], extractionFailures: memo.failures, capHitItems: memo.capHit, conditionsByItem: session.conditions?.items || {} });
    if (ev.blocked) {
      if (session.state !== "blocked") await store.transitionSession(sessionId, "signals.blocked", { error: ev.error, pipeline_version: PIPELINE_VERSION });
      return { ok: false, sessionId, state: "blocked", blocked: ev.error, cost_usd: memo.costUsd };
    }
    if (ev.contradictions.length) await store.insertContradictions(sessionId, ev.contradictions);
    await store.replaceSignals(sessionId, ev.signals);
    const t = await store.transitionSession(sessionId, "signals.computed", { signals: ev.signals.length, contradictions: ev.contradictions.length, pipeline_version: PIPELINE_VERSION });
    if (!t.ok) return { ok: false, sessionId, state: session.state, skipped: t.reason };
    session = await store.getSession(sessionId);
  }

  // ── render ────────────────────────────────────────────────────────────────────────────────
  if (session.state === "evaluated") {
    const [signals, evidence, contradictions, consents] = await Promise.all([
      store.listSignals(sessionId), store.listEvidence(sessionId), store.listContradictions(sessionId), store.listConsents(sessionId),
    ]);
    const pkg = buildPackage({ session, plan, mandate, candidate, signals, evidence, contradictions, turns, conversations, consents, cursor: session.cursor || {}, extractorVersion: VV_EXTRACT_PROMPT_VERSION, controllerVersion: CONTROLLER_VERSION });
    const version = await store.nextReportVersion(sessionId);
    await store.insertReport({ session_id: sessionId, version, package: pkg });
    const t = await store.transitionSession(sessionId, "report.rendered", { version, pipeline_version: PIPELINE_VERSION });
    if (!t.ok) return { ok: false, sessionId, state: session.state, skipped: t.reason, version };
    return { ok: true, sessionId, state: t.state, version, cost_usd: memo.costUsd, failures: [...memo.failures], cap_hit: [...memo.capHit] };
  }

  return { ok: true, sessionId, state: session.state, skipped: "state" };
}

/**
 * Every session the pipeline owes something to, each in its own try/catch. Heartbeat on a clean
 * pass; a failed session is reported and the sweep continues.
 */
export async function runPipelineSweep({ store, client, log = console.error, heartbeat = pingHeartbeat, maxCostUsd = capFromEnv() }) {
  const sessions = [];
  for (const state of RESUMABLE_STATES) {
    sessions.push(...(await store.listTestSessions({ state })), ...(await store.listCandidateSessions({ state })));
  }
  const summary = { seen: sessions.length, done: 0, failed: 0, skipped: 0, results: [] };
  for (const s of sessions) {
    try {
      const r = await runPipelineForSession({ store, client, sessionId: s.id, maxCostUsd, log });
      summary.results.push(r);
      if (r.skipped) summary.skipped++; else if (r.ok) summary.done++; else summary.failed++;
    } catch (e) {
      summary.failed++;
      summary.results.push({ ok: false, sessionId: s.id, state: s.state, error: String(e?.message || e) });
      captureError(e, { kind: "voice-pipeline", session: s.id });
      log(`[vv-pipeline] ${s.id}: ${e?.message || e}`);
    }
  }
  if (summary.failed === 0) await heartbeat("voice-pipeline");
  else await heartbeat("voice-pipeline", { fail: true });
  return summary;
}
