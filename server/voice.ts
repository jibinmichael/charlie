// server/voice.ts — the voice-verification router: the dashboard API and the live call path: GET /voice/session/:token, POST /voice/session/:token/start, POST /voice/llm (the
// custom LLM endpoint ElevenLabs calls every turn), POST /webhooks/elevenlabs (the post-call
// transcript). The per-turn logic lives in voice/live.mjs; this file binds it to HTTP.
//
// DARK BY DEFAULT. Every route answers 404 while VOICE_VERIFICATION is off, read at call time.
//
// ONE SECRET, NO ACCOUNTS. The dashboard lives at /hq/<secret> on the site and presents that
// secret as a Bearer to /voice/api/*. A missing VOICE_DASHBOARD_SECRET refuses everything (503);
// a wrong one is 401 after a constant-time compare. Whoever holds the secret sees candidate
// transcripts, which is why it is one long random string and not a password somebody chose.
//
// THIS FILE HOLDS THE KEYS; THE SITE HOLDS NONE. The dashboard never touches Supabase or Anthropic
// directly. Everything reads and writes through voice/store.mjs and voice/plan.mjs.
//
// EVERY INPUT IS A SCHEMA (lib/schemas/vv-dashboard.mjs). Every mutation is the same function the
// scripts use, so the dashboard cannot do anything a reviewed CLI cannot.
// @ts-ignore — express ships no types here, same as charlie-remote.ts
import express from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
// @ts-ignore — plain ESM JS
import { signEvent, readEvent } from "../charlie-store.mjs";
// @ts-ignore — plain ESM JS
import * as liveMod from "../voice/live.mjs";
// @ts-ignore — plain ESM JS
import { consentTexts, consentStatus, recordConsent } from "../voice/consent.mjs";
// @ts-ignore — plain ESM JS
import { StartInput, LlmRequest, ElevenLabsWebhook } from "../lib/schemas/vv-live.mjs";
// @ts-ignore — plain ESM JS
import * as storeMod from "../voice/store.mjs";
// @ts-ignore — plain ESM JS
import { listTalentPool } from "../lib/talent-pool.mjs"; // the board's real roster, read-only, outside voice/
// @ts-ignore — plain ESM JS
import { askBoard } from "../voice/ask.mjs"; // Level 1 of ask the board
// @ts-ignore — plain ESM JS
import { AskInput } from "../lib/schemas/vv-ask.mjs";
// @ts-ignore — plain ESM JS
import * as pipelineMod from "../voice/pipeline.mjs"; // kicked by the webhook, swept by the server
// @ts-ignore — plain ESM JS
import { captureError } from "../lib/sentry-node.mjs";
// @ts-ignore — plain ESM JS
import * as planMod from "../voice/plan.mjs";
// @ts-ignore — plain ESM JS
import * as renderMod from "../voice/render-package.mjs";
// @ts-ignore — plain ESM JS
import { CONTROLLER_VERSION } from "../voice/controller.mjs";
// @ts-ignore — plain ESM JS
import { VV_EXTRACT_PROMPT_VERSION } from "../voice/extract.mjs";
// @ts-ignore — plain ESM JS
import { JobInput, ApproveInput, CandidateInput, ReviewInput, DISAGREEMENT_REASONS, PoolPerson } from "../lib/schemas/vv-dashboard.mjs";
// @ts-ignore — plain ESM JS
import { STATUSES, COVERAGE_BANDS, INSUFFICIENT_REASONS, NOT_ASSESSED_REASONS, STATUS_LANGUAGE, COVERAGE_LANGUAGE } from "../voice/statuses.mjs";
// @ts-ignore — plain ESM JS
import { extractResumeText, MAX_ATTACHMENT_BYTES, ALLOWED_EXT } from "./resume-extract.mjs";
// @ts-ignore — plain ESM JS
import { EVALUATOR_VERSION } from "../voice/evaluate.mjs";

type Request = any; type Response = any; type NextFunction = any; type Router = any;

// The .mjs modules carry JSDoc for their own readers; TypeScript infers over-narrow types from
// their defaults (`questions = []` becomes never[]). Runtime shapes are enforced by the Zod schemas
// at every boundary, so this file treats the modules as untyped, the way charlie-remote.ts does.
const store: any = storeMod;
const { parseMandate, generatePlan, approvePlan, checkChain } = planMod as any;
const { buildPackage } = renderMod as any;
const { beginConversation, runTurn, sseAnswer, jsonAnswer, offersEndCall, conversationIdFrom, reconcileTranscript, TROUBLE_LINE, FIRST_MESSAGE_VAR } = liveMod as any;
const consent: any = { consentTexts, consentStatus, recordConsent };

/** Seconds after which a conversation with no ended_at is no longer treated as live (the budget plus a margin). */
const LIVE_MARGIN_SECONDS = 180;

const ELEVENLABS_API = "https://api.elevenlabs.io";

/**
 * The provider call the start route makes: mint a conversation token for the one private agent.
 * Injectable so the tests never reach the network. The token is handed to the browser and never
 * held; the conversation id is the server-side binding (the conversation id, not the token, identifies the session).
 */
export async function mintConversationToken({ agentId, apiKey }: { agentId: string; apiKey: string }): Promise<{ token: string; conversation_id: string }> {
  const r = await fetch(`${ELEVENLABS_API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, { headers: { "xi-api-key": apiKey } });
  if (!r.ok) throw new Error(`elevenlabs token: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (!j?.token || !j?.conversation_id) throw new Error("elevenlabs token: response had no token or conversation_id");
  return { token: String(j.token), conversation_id: String(j.conversation_id) };
}

/**
 * ElevenLabs-Signature: `t=<unix seconds>,v0=<hex hmac-sha256 of "<t>.<raw body>">`. Constant-time
 * compare, and a timestamp older than 30 minutes is refused (a replay of a valid signature).
 */
export function verifyElevenLabsSignature(req: Request, secret: string, now = Date.now()): boolean {
  if (!secret || !req.rawBody) return false;
  const header = String(req.headers["elevenlabs-signature"] || "");
  const parts = Object.fromEntries(header.split(",").map((kv: string) => kv.split("=").map((x) => x.trim())).filter((kv: string[]) => kv.length === 2));
  const t = parts.t, v0 = parts.v0;
  if (!t || !v0 || !/^\d+$/.test(t)) return false;
  if (Math.abs(now / 1000 - Number(t)) > 30 * 60) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${req.rawBody.toString("utf8")}`).digest("hex");
  const a = Buffer.from(v0), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function llmBearerOk(req: Request): "ok" | "unconfigured" | "bad" {
  const secret = String(process.env.VOICE_LLM_BEARER || "").trim();
  if (!secret) return "unconfigured";
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ""));
  if (!m) return "bad";
  const a = Buffer.from(m[1].trim()), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

export function voiceEnabled(): boolean {
  return /^(on|1|true|yes)$/i.test(String(process.env.VOICE_VERIFICATION || "").trim());
}

export function linkBase(): string {
  return String(process.env.VOICE_APP_ORIGIN || process.env.CHARLIE_SITE_URL || "https://example.com").replace(/\/$/, "");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function bearerOk(req: Request): "ok" | "unconfigured" | "bad" {
  const secret = String(process.env.VOICE_DASHBOARD_SECRET || "").trim();
  if (!secret) return "unconfigured";
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ""));
  if (!m) return "bad";
  const a = Buffer.from(m[1].trim()), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler, log: (m: string) => void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e: any) {
    // The detail stays in our log under an id; the browser gets the id only.
    const id = randomUUID().slice(0, 8);
    log(`[voice-api] ${id} ${req.method} ${req.path}: ${e?.message || e}`);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong", id });
  }
};

function bad(res: Response, issues: any) {
  return res.status(400).json({ error: "invalid input", issues: issues.map((i: any) => `${i.path.join(".")}: ${i.message}`) });
}

export function voiceRouter({ makeClient = () => new Anthropic(), log = (m: string) => console.error(m), mintToken = mintConversationToken, now = () => Date.now(), kickPipeline }: { makeClient?: () => any; log?: (m: string) => void; mintToken?: typeof mintConversationToken; now?: () => number; kickPipeline?: (sessionId: string) => void } = {}): Router {
  // The post-call pipeline, kicked the moment a transcript lands so a tester sees the
  // evaluation within about a minute. Fire-and-forget after the webhook has been acknowledged;
  // the ten-minute sweep in charlie-remote.ts picks up anything this misses.
  const kick = kickPipeline ?? ((sessionId: string) => {
    pipelineMod.runPipelineForSession({ store, client: makeClient(), sessionId, log }).catch((e: any) => captureError(e, { kind: "voice-pipeline", session: sessionId }));
  });
  const r = express.Router();

  r.use("/voice", (_req: Request, res: Response, next: NextFunction) => {
    if (!voiceEnabled()) return res.status(404).json({ error: "not found" });
    next();
  });

  // The bearer check reads only headers, so it runs BEFORE the body is parsed: an unauthenticated
  // caller never makes the server buffer a 15 MB body.
  r.use("/voice/api", (req: Request, res: Response, next: NextFunction) => {
    const v = bearerOk(req);
    if (v === "unconfigured") return res.status(503).json({ error: "dashboard secret not configured" });
    if (v === "bad") return res.status(401).json({ error: "unauthorized" });
    next();
  });

  // The dashboard API parses its own JSON: a mandate file arrives as base64, so the limit is the
  // 10 MB file (MAX_ATTACHMENT_BYTES) plus base64 overhead. The global 1 MB parser skips this path.
  r.use("/voice/api", express.json({ limit: "15mb" }));

  // ── meta: the vocabulary, so no client keeps a copy of it ──────────────────

  r.get("/voice/api/meta", wrap(async (_req, res) => {
    res.json({
      statuses: STATUSES, coverage_bands: COVERAGE_BANDS,
      insufficient_reasons: INSUFFICIENT_REASONS, not_assessed_reasons: NOT_ASSESSED_REASONS,
      disagreement_reasons: DISAGREEMENT_REASONS,
      status_language: STATUS_LANGUAGE, coverage_language: COVERAGE_LANGUAGE,
      versions: { controller: CONTROLLER_VERSION, extractor: VV_EXTRACT_PROMPT_VERSION, evaluator: EVALUATOR_VERSION },
      mandate_file_types: ALLOWED_EXT, mandate_file_max_bytes: MAX_ATTACHMENT_BYTES,
    });
  }, log));

  /** The results-table row for one session: status per plan item in plan order, must-haves answered, reviewed. */
  async function sessionSummary(session: any, planItems: any[]) {
    const signals: any[] = await store.listSignals(session.id);
    const byItem = new Map(signals.map((s) => [s.plan_item_id, s]));
    const items = [...planItems].sort((a, b) => a.priority - b.priority).map((it) => {
      const s = byItem.get(it.id);
      return { ref: it.ref, kind: it.kind, establishes: it.evidence_contract?.establishes ?? "", status: s?.status ?? null, coverage_band: s?.coverage_band ?? null };
    });
    const mustHaves = items.filter((i) => i.kind === "hard_requirement" || i.kind === "hr_fact");
    const answered = mustHaves.filter((i) => i.status && i.status !== "not_assessed" && i.status !== "insufficient").length;
    const review = await store.latestReview(session.id);
    return { items, must_haves: { answered, total: mustHaves.length }, evaluated: signals.length > 0, reviewed: Boolean(review) };
  }

  // ── ask the board: a question becomes a rule over the columns (Level 1) ──────
  r.post("/voice/api/ask", express.json({ limit: "16kb" }), wrap(async (req, res) => {
    const input = AskInput.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: "a question of 2 to 500 characters is required" });
    // A refusal is an answer, not an error: 200 with ok false and the reason, so the board shows it.
    const out = await askBoard({ client: makeClient(), question: input.data.question, log });
    res.json(out);
  }, log));

  // ── the talent pool: the board's real roster, read-only ───────────────────
  // Every row is validated on the way out and a row that does not fit is skipped and counted,
  // never crashed on and never patched up. Numbers are sent as numbers; the board formats them.
  r.get("/voice/api/pool", wrap(async (req, res) => {
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 2000));
    const rows: any[] = await listTalentPool({ client: store.client(), limit });
    const people: any[] = [];
    let skipped = 0;
    for (const row of rows) {
      const candidate = {
        id: `tp:${row.id}`, email: String(row.email || "").toLowerCase(), name: row.full_name ?? null, phone: row.phone ?? null,
        linkedin_url: row.linkedin_url ?? null, portfolio_url: row.portfolio_url ?? null,
        current_title: row.current_title ?? null, current_company: row.current_company ?? null,
        previous_title: row.previous_title ?? null, previous_company: row.previous_company ?? null, headline: row.headline ?? null,
        total_years: row.total_years == null ? null : Number(row.total_years), roles_count: row.roles_count ?? null, current_tenure_months: row.current_tenure_months ?? null,
        seniority: row.seniority ?? null, role_family: row.role_family ?? null, city: row.city ?? null, country: row.country ?? null,
        willing_to_relocate: row.willing_to_relocate ?? null, work_mode_pref: row.work_mode_pref ?? null,
        notice_period_raw: row.notice_period_raw ?? null, notice_days: row.notice_days ?? null, seeking_status: row.seeking_status ?? null, available_from: row.available_from ?? null,
        comp_current: row.comp_current == null ? null : Number(row.comp_current), comp_expected: row.comp_expected == null ? null : Number(row.comp_expected), comp_currency: row.comp_currency ?? null,
        mobility_profile: row.mobility_profile ?? null, top_skills: Array.isArray(row.top_skills) ? row.top_skills : [], domains: Array.isArray(row.domains) ? row.domains : [],
        consent_process: Boolean(row.consent_process), consent_share: Boolean(row.consent_share), consent_pool: Boolean(row.consent_pool),
        source_form: row.source_form ?? null, source_role: row.source_role ?? null, applied_at: row.applied_at ?? null,
        completeness: row.completeness ?? null, enriched_at: row.enriched_at ?? null,
      };
      const ok = PoolPerson.safeParse(candidate);
      if (!ok.success) { skipped++; log(`[voice-pool] row ${row.id} skipped: ${ok.error.issues.slice(0, 2).map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`); continue; }
      people.push(ok.data);
    }
    res.json({ people, total: rows.length, skipped });
  }, log));

  // ── jobs ───────────────────────────────────────────────────────────────────

  r.get("/voice/api/jobs", wrap(async (_req, res) => {
    const mandates: any[] = await store.listMandates();
    const sessions: any[] = await store.listSessionsForDashboard();
    const out = [];
    for (const m of mandates) {
      const plans: any[] = await store.listPlansForMandate(m.id);
      const latest = plans[0] || null;
      const approved = plans.find((p) => p.status === "approved") || null;
      const planIds = new Set(plans.map((p) => p.id));
      out.push({ ...m, latest_plan: latest, approved_plan: approved, calls: sessions.filter((s) => planIds.has(s.plan_id)).length });
    }
    res.json({ jobs: out });
  }, log));

  r.post("/voice/api/jobs", wrap(async (req, res) => {
    const ok = JobInput.safeParse(req.body);
    if (!ok.success) return bad(res, ok.error.issues);
    const b = ok.data;
    let jdText: string = b.jd_text || "";
    let source = b.role;
    if (!jdText && b.jd_file) {
      const ext = String(b.jd_file.name).split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED_EXT.includes(ext)) return res.status(400).json({ error: `mandate file must be one of ${ALLOWED_EXT.join(", ")}` });
      const buf = Buffer.from(b.jd_file.base64, "base64");
      if (buf.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: "mandate file is too large" });
      const ex = await extractResumeText(buf, b.jd_file.name);
      if (!ex?.ok || String(ex.text || "").trim().length < 40) return res.status(422).json({ error: "could not read text from that file; paste the mandate as text instead" });
      jdText = String(ex.text);
      source = b.jd_file.name;
    }
    const client = makeClient();
    const { matrix, dropped: matrixDropped } = await parseMandate({ client, jd: jdText, sourceName: source });
    const { plan, dropped, chain } = await generatePlan({ client, matrix, questions: b.questions, sessionBudgetSeconds: b.session_budget_seconds, jdText });
    const mandate: any = await store.saveMandate({ client: b.client, role: b.role, contact_email: b.contact_email, jd_text: jdText, hr_questions: b.questions, next_step_text: b.next_step_text, parsed: matrix, dropped: matrixDropped });
    const refMap = await store.saveRequirements(mandate.id, matrix);
    plan.mandate_id = mandate.id;
    plan.version = await store.nextPlanVersion(mandate.id);
    await store.savePlan(plan, refMap);
    res.status(201).json({ mandate, plan, dropped, matrixDropped, chain });
  }, log));

  r.get("/voice/api/jobs/:id", wrap(async (req, res) => {
    const mandate: any = await store.getMandate(String(req.params.id));
    const plans: any[] = await store.listPlansForMandate(mandate.id);
    const sessions: any[] = (await store.listSessionsForDashboard()).filter((s: any) => plans.some((p) => p.id === s.plan_id));
    const latest = plans[0] ? await store.loadPlan(plans[0].id) : null;
    const chain = latest ? checkChain(latest.plan, { jdText: mandate.jd_text, questions: Array.isArray(mandate.hr_questions) ? mandate.hr_questions : [] }) : null;
    const planItemsById = new Map<string, any[]>();
    const withSummary = [];
    for (const s of sessions) {
      if (!planItemsById.has(s.plan_id)) planItemsById.set(s.plan_id, (await store.loadPlan(s.plan_id)).plan.items);
      const c = s.candidate_id ? await store.getVvCandidateById(s.candidate_id) : null;
      withSummary.push({ ...s, who: s.kind === "test" ? s.tester_email : c?.email ?? null, name: c?.name_as_given ?? null, summary: await sessionSummary(s, planItemsById.get(s.plan_id) || []) });
    }
    res.json({ mandate, plans, plan: latest?.plan ?? null, chain, sessions: withSummary });
  }, log));

  r.post("/voice/api/jobs/:id/plans/:planId/approve", wrap(async (req, res) => {
    const ok = ApproveInput.safeParse(req.body);
    if (!ok.success) return bad(res, ok.error.issues);
    const { plan, mandate }: any = await store.loadPlan(String(req.params.planId));
    if (plan.mandate_id !== String(req.params.id)) return res.status(404).json({ error: "plan is not on this job" });
    const questions = Array.isArray(mandate.hr_questions) ? mandate.hr_questions : [];
    try {
      const approved = await approvePlan(plan, { by: ok.data.by, jdText: mandate.jd_text, questions, persist: store.persistApproval, override: ok.data.override });
      res.json({ plan: approved });
    } catch (e: any) {
      res.status(409).json({ error: String(e?.message || e) });
    }
  }, log));

  // ── candidates and test sessions: mint the link ─────────────────────────────

  r.post("/voice/api/jobs/:id/candidates", wrap(async (req, res) => {
    const ok = CandidateInput.safeParse(req.body);
    if (!ok.success) return bad(res, ok.error.issues);
    const b = ok.data;
    const plans: any[] = await store.listPlansForMandate(String(req.params.id));
    const approved = plans.find((p) => p.status === "approved");
    if (!approved) return res.status(409).json({ error: "this job has no approved plan" });

    let candidate: any = null;
    let session: any;
    if (b.kind === "candidate") {
      candidate = await store.upsertVvCandidate({ email: b.email, name_as_given: b.name });
      await store.saveCvText(candidate.id, b.cv_text);
      session = await store.createSession({ kind: "candidate", candidate_id: candidate.id, plan_id: approved.id });
    } else {
      session = await store.createSession({ kind: "test", tester_email: b.tester_email, plan_id: approved.id });
      if (b.label) await store.mergeConditions(session.id, { label: b.label });
      if (b.cv_text) await store.saveTestCvText(session.id, b.cv_text); // a persona's CV, so contradictions can be checked against it
      if (b.label || b.cv_text) session = await store.getSession(session.id);
    }
    const token = signEvent({ vv: session.id, k: session.kind });
    const expires_at = new Date(Date.now() + b.expires_in_days * 86400_000).toISOString();
    await store.insertInvitation({ session_id: session.id, token_hash: sha256(token), expires_at });
    await store.insertEvent({ session_id: session.id, kind: session.kind, type: "session.invited", payload: { kind: session.kind, expires_at, via: "dashboard" } });
    res.status(201).json({ session, candidate, link: `${linkBase()}/v/${token}`, expires_at });
  }, log));

  // ── calls ──────────────────────────────────────────────────────────────────

  r.get("/voice/api/calls", wrap(async (_req, res) => {
    const sessions: any[] = await store.listSessionsForDashboard();
    const mandates: any[] = await store.listMandates();
    const planToMandate = new Map<string, any>();
    for (const m of mandates) for (const p of await store.listPlansForMandate(m.id) as any[]) planToMandate.set(p.id, { role: m.role, client: m.client, mandate_id: m.id, plan_version: p.version });
    const out = [];
    const planItemsById = new Map<string, any[]>();
    for (const s of sessions) {
      const c = s.candidate_id ? await store.getVvCandidateById(s.candidate_id) : null;
      if (!planItemsById.has(s.plan_id)) planItemsById.set(s.plan_id, (await store.loadPlan(s.plan_id)).plan.items);
      out.push({ ...s, who: s.kind === "test" ? s.tester_email : c?.email ?? null, name: c?.name_as_given ?? null, job: planToMandate.get(s.plan_id) ?? null, summary: await sessionSummary(s, planItemsById.get(s.plan_id) || []) });
    }
    res.json({ calls: out });
  }, log));

  r.get("/voice/api/calls/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    const session: any = await store.getSession(id);
    const candidate = session.candidate_id ? await store.getVvCandidateById(session.candidate_id) : null;
    const { plan, mandate }: any = await store.loadPlan(session.plan_id);
    const conversations: any[] = await store.listConversations(id);
    const turns: any[] = [];
    for (const c of conversations) turns.push(...(await store.listTurns(c.id) as any[]).map((t: any) => ({ ...t, conversation_id: c.id })));
    const signals: any[] = await store.listSignals(id);
    const evidence: any[] = await store.listEvidence(id);
    const contradictions: any[] = await store.listContradictions(id);
    const consents: any[] = await store.listConsents(id);
    const report: any = await store.latestReport(id);
    const review: any = await store.latestReview(id);
    const events: any[] = await store.listEvents(id);
    let pkg = report?.package ?? null;
    if (!pkg && signals.length) {
      pkg = buildPackage({ session, plan, mandate, candidate, signals, evidence, contradictions, turns, conversations, consents, cursor: session.cursor || {}, extractorVersion: VV_EXTRACT_PROMPT_VERSION, controllerVersion: CONTROLLER_VERSION });
    }
    // The CV as text, the record the human reads beside the transcript: the candidate's, or the persona's on a test session.
    const cv_text = await store.readText(candidate?.cv_ref ?? session.conditions?.cv_ref ?? null);
    res.json({ session, candidate, mandate: { id: mandate.id, role: mandate.role, client: mandate.client }, plan, conversations, turns, signals, evidence, contradictions, consents, package: pkg, report_version: report?.version ?? null, review, cv_text, events: events.map((e: any) => ({ type: e.type, at: e.at, payload: e.payload })) });
  }, log));

  r.delete("/voice/api/calls/:id", wrap(async (req, res) => {
    const out = await store.deleteSession(String(req.params.id));
    res.json({ deleted: true, ...out });
  }, log));

  // ── eval: the ground-truth row ─────────────────────────────────────────────

  r.post("/voice/api/calls/:id/review", wrap(async (req, res) => {
    const ok = ReviewInput.safeParse(req.body);
    if (!ok.success) return bad(res, ok.error.issues);
    const id = String(req.params.id);
    const session: any = await store.getSession(id);
    if (session.kind === "test") return res.status(409).json({ error: "a test session has no review: nothing is released about a person" });
    const signals: any[] = await store.listSignals(id);
    const byId = new Map(signals.map((s) => [s.id, s]));
    const per_signal = [];
    for (const row of ok.data.per_signal) {
      const s = byId.get(row.signal_id);
      if (!s) return res.status(400).json({ error: `signal ${row.signal_id} is not on this call` });
      const agrees = s.status === row.human_status;
      if (!agrees && !row.disagreement_reason) return res.status(400).json({ error: `signal ${row.signal_id}: a disagreement needs a reason` });
      per_signal.push({ signal_id: row.signal_id, charlie_status: s.status, human_status: row.human_status, agrees, disagreement_reason: agrees ? null : row.disagreement_reason, note: row.note, evaluator_version: s.evaluator_version });
    }
    const review = await store.insertReview({ session_id: id, report_version: ok.data.report_version, reviewer: ok.data.reviewer, per_signal, evidence_lift: ok.data.evidence_lift });
    let transition = null;
    if (session.state === "awaiting_review") transition = await store.transitionSession(id, "review.recorded", { reviewer: ok.data.reviewer });
    res.status(201).json({ review, transition });
  }, log));

  // ── learning: open disagreements, by reason and by job ─────────────────────

  r.get("/voice/api/learning", wrap(async (_req, res) => {
    const reviews: any[] = await store.listAllReviews();
    const sessions: any[] = await store.listSessionsForDashboard();
    const mandates: any[] = await store.listMandates();
    const planToRole = new Map<string, string>();
    for (const m of mandates) for (const p of await store.listPlansForMandate(m.id) as any[]) planToRole.set(p.id, m.role);
    const sessionRole = new Map(sessions.map((s) => [s.id, planToRole.get(s.plan_id) ?? "(unknown job)"]));
    const open: any[] = [];
    const by_reason: Record<string, { count: number; jobs: Record<string, number>; versions: Record<string, number> }> = {};
    let reviewed = 0, agreed = 0;
    for (const rv of reviews) {
      for (const row of rv.per_signal || []) {
        reviewed++;
        if (row.agrees) { agreed++; continue; }
        const role = sessionRole.get(rv.session_id) ?? "(unknown job)";
        const reason = row.disagreement_reason || "unspecified";
        open.push({ session_id: rv.session_id, role, signal_id: row.signal_id, charlie_status: row.charlie_status, human_status: row.human_status, reason, note: row.note ?? null, evaluator_version: row.evaluator_version ?? null, recorded_at: rv.recorded_at, reviewer: rv.reviewer });
        const b = (by_reason[reason] ||= { count: 0, jobs: {}, versions: {} });
        b.count++;
        b.jobs[role] = (b.jobs[role] || 0) + 1;
        const v = row.evaluator_version || "unknown";
        b.versions[v] = (b.versions[v] || 0) + 1;
      }
    }
    res.json({ totals: { reviewed, agreed, disagreed: reviewed - agreed }, by_reason, open });
  }, log));

  

  // ═══ the live path ═════════════════════════════════════════════════════════

  /**
   * The signed link → the session it names, or a refusal. The token is an HMAC event
   * ({ vv: session id, k: kind }); its hash must also be an invitation row that is neither expired
   * nor revoked. The session, plan and mandate come back together because every live route needs
   * all three.
   */
  async function resolveInvitation(token: string): Promise<{ ok: true; session: any; invitation: any; plan: any; mandate: any; candidate: any } | { ok: false; status: number; error: string }> {
    const ev = readEvent(String(token || ""));
    if (!ev || typeof ev !== "object" || !ev.vv) return { ok: false, status: 401, error: "this link is not one Charlie made" };
    const invitation = await store.findInvitationByHash(sha256(String(token)));
    if (!invitation || invitation.session_id !== ev.vv) return { ok: false, status: 404, error: "this link is not known" };
    if (invitation.revoked_at) return { ok: false, status: 410, error: "this link has been withdrawn" };
    if (new Date(invitation.expires_at).getTime() < now()) return { ok: false, status: 410, error: "this link has expired" };
    const session = await store.getSession(invitation.session_id);
    const { plan, mandate } = await store.loadPlan(session.plan_id);
    const candidate = session.candidate_id ? await store.getVvCandidateById(session.candidate_id) : null;
    return { ok: true, session, invitation, plan, mandate, candidate };
  }

  const isLive = (c: any, budget: number) => !c.ended_at && now() - new Date(c.started_at).getTime() < (budget + LIVE_MARGIN_SECONDS) * 1000;
  const DONE_STATES = new Set(["completed", "transcript_ready", "evidence_ready", "evaluated", "blocked", "awaiting_review", "reviewed", "reported", "abandoned"]);
  const CLOSED_STATES = new Set(["declined", "unreachable", "expired"]);

  // The candidate page's bodies are small; the router owns them so the global parser is not involved.
  r.use("/voice/session", express.json({ limit: "64kb" }));

  /** What the candidate page shows before and after the call. Never the secret, never another person's data. */
  r.get("/voice/session/:token", wrap(async (req, res) => {
    const v = await resolveInvitation(String(req.params.token));
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    const { session, invitation, plan, mandate } = v;
    if (!invitation.opened_at) await store.markInvitationOpened(invitation.id);
    const conversations: any[] = await store.listConversations(session.id);
    // Where the conversation is, for the page's own progress line: which question Charlie is on,
    // and how many of the plan's questions have been opened. Read from the cursor, never decided here.
    const items = [...plan.items].sort((a: any, b: any) => a.priority - b.priority);
    const cursor = session.cursor && session.cursor.phase ? session.cursor : null;
    const opened = cursor ? Object.keys(cursor.items || {}).length : 0;
    const current = cursor && cursor.phase === "items" ? items[cursor.itemIndex] : null;
    res.json({
      kind: session.kind, state: session.state,
      progress: { opened, total: items.length, now: current ? current.evidence_contract?.establishes ?? null : null, done: cursor?.phase === "done" },
      role: mandate.role, client: mandate.client, next_step_text: mandate.next_step_text,
      budget_seconds: plan.session_budget_seconds, minutes: Math.max(1, Math.round(plan.session_budget_seconds / 60)),
      // The pool scope is not offered: the pilot is standalone and nothing leaves the hiring team.
      consents: consent.consentTexts(session.kind).filter((c: any) => c.scope !== "pool"),
      consented: consent.consentStatus(await store.listConsents(session.id), session.kind).ok,
      live: conversations.some((c) => isLive(c, plan.session_budget_seconds)),
      done: DONE_STATES.has(session.state), closed: CLOSED_STATES.has(session.state),
      expires_at: invitation.expires_at,
    });
  }, log));

  /**
   * Start (or resume) the call. Records consent on first start, refuses a second start while a
   * conversation is live, mints the provider token, binds the provider conversation id to the
   * session before the browser connects, and returns the first line for the agent to speak.
   */
  r.post("/voice/session/:token/start", wrap(async (req, res) => {
    const ok = StartInput.safeParse(req.body || {});
    if (!ok.success) return bad(res, ok.error.issues);
    const v = await resolveInvitation(String(req.params.token));
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    const { session, plan, mandate } = v;
    if (CLOSED_STATES.has(session.state)) return res.status(409).json({ error: "this conversation is closed" });
    if (DONE_STATES.has(session.state)) return res.status(409).json({ error: "this conversation has already happened" });

    if (session.state === "invited") {
      const offered = new Set(consent.consentTexts(session.kind).map((c: any) => c.scope));
      for (const c of ok.data.consents) {
        if (!offered.has(c.scope)) continue;
        await consent.recordConsent(store, { session, scope: c.scope, text_version: c.text_version, granted: c.granted, user_agent: ok.data.user_agent });
      }
      const st = consent.consentStatus(await store.listConsents(session.id), session.kind);
      if (!st.ok) return res.status(403).json({ error: "consent is required before the call", missing: st.missing });
      const t = await store.transitionSession(session.id, "consent.recorded", { via: "page" });
      if (!t.ok) return res.status(409).json({ error: t.reason });
    }

    const conversations: any[] = await store.listConversations(session.id);
    if (conversations.some((c) => isLive(c, plan.session_budget_seconds))) return res.status(409).json({ error: "this conversation is already live somewhere else" });

    const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
    const agentId = String(process.env.ELEVENLABS_AGENT_ID || "").trim();
    if (!apiKey || !agentId) return res.status(503).json({ error: "the voice provider is not configured" });
    let minted: { token: string; conversation_id: string };
    try { minted = await mintToken({ agentId, apiKey }); } catch (e: any) {
      log(`[voice-live] mint failed for session ${session.id}: ${e?.message || e}`);
      return res.status(502).json({ error: "the call could not be started; please try again in a moment" });
    }

    await store.upsertConversation({ session_id: session.id, provider_conversation_id: minted.conversation_id });
    const conversation = await store.getConversationByProviderId(minted.conversation_id);
    const resuming = session.state === "in_progress";
    const t = await store.transitionSession(session.id, resuming ? "conversation.resumed" : "conversation.started", { conversation_id: conversation.id });
    if (!t.ok) return res.status(409).json({ error: t.reason });
    const fresh = await store.getSession(session.id);
    const elapsed = liveMod.elapsedSeconds(conversations, now());
    const first = await beginConversation({ store, session: fresh, plan, mandate, resuming, elapsed });
    res.json({ token: minted.token, conversation_id: minted.conversation_id, agent_id: agentId, first_message: first.firstMessage, first_message_var: FIRST_MESSAGE_VAR, budget_seconds: plan.session_budget_seconds, resuming });
  }, log));

  /**
   * The custom LLM endpoint. The bearer is checked before the body is read. A request that cannot
   * be tied to a live session gets TROUBLE_LINE, scripted, and no model is called. Everything else
   * is one runTurn(). The stream is written whole: the line is linted before a byte leaves.
   */
  r.use("/voice/llm", (req: Request, res: Response, next: NextFunction) => {
    const v = llmBearerOk(req);
    if (v === "unconfigured") return res.status(503).json({ error: "custom llm bearer not configured" });
    if (v === "bad") return res.status(401).json({ error: "unauthorized" });
    next();
  });
  r.use("/voice/llm", express.json({ limit: "1mb" }));
  r.post(["/voice/llm", "/voice/llm/chat/completions", "/voice/llm/v1/chat/completions"], wrap(async (req, res) => {
    const parsed = LlmRequest.safeParse(req.body);
    const streaming = parsed.success ? parsed.data.stream !== false : true;
    const speak = (text: string, endCall = false) => {
      if (!streaming) return res.json(jsonAnswer({ text }));
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.end(sseAnswer({ text, endCall }));
    };
    if (!parsed.success) { log(`[voice-live] llm request unparseable: ${parsed.error.issues.slice(0, 3).map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`); return speak(TROUBLE_LINE); }
    const body = parsed.data;
    const providerId = conversationIdFrom(body.messages);
    if (!providerId) { log("[voice-live] llm request carried no conversation id in its system message"); return speak(TROUBLE_LINE); }
    const conversation = await store.getConversationByProviderId(providerId);
    if (!conversation) { log(`[voice-live] llm request for unknown conversation ${providerId}`); return speak(TROUBLE_LINE); }
    const session = await store.getSession(conversation.session_id);
    if (session.state !== "in_progress" && session.state !== "completed") { log(`[voice-live] llm request for session ${session.id} in state ${session.state}`); return speak(TROUBLE_LINE); }
    const { plan, mandate } = await store.loadPlan(session.plan_id);
    const candidate = session.candidate_id ? await store.getVvCandidateById(session.candidate_id) : null;
    const conversations = await store.listConversations(session.id);
    const client = String(process.env.VOICE_WRITER_MODEL || "").trim() ? makeClient() : null;
    const turn = await runTurn({ store, client, session, plan, mandate, candidate, conversation, conversations, messages: body.messages, now: now(), log });
    speak(turn.text, turn.end && offersEndCall(body.tools));
  }, log));

  /**
   * The post-call webhook. Signature first, then the raw payload is stored before anything is read
   * from it, then the canonical transcript is written once: a replay for a conversation that already
   * has one is acknowledged and changes nothing. An unknown conversation is acknowledged too, so the
   * provider never disables the webhook over a session that was deleted.
   */
  r.use("/webhooks/elevenlabs", (_req: Request, res: Response, next: NextFunction) => (voiceEnabled() ? next() : res.status(404).json({ error: "not found" })));
  r.use("/webhooks/elevenlabs", express.json({ limit: "4mb", verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
  r.post("/webhooks/elevenlabs", wrap(async (req, res) => {
    if (!verifyElevenLabsSignature(req, String(process.env.ELEVENLABS_WEBHOOK_SECRET || "").trim(), now())) return res.status(401).json({ error: "bad signature" });
    const parsed = ElevenLabsWebhook.safeParse(req.body);
    if (!parsed.success) { log(`[voice-webhook] unparseable body (skipped): ${parsed.error.issues.slice(0, 3).map((i: any) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`); return res.json({ ok: true, skipped: "unparseable" }); }
    const { type, data } = parsed.data;
    const conversation = await store.getConversationByProviderId(data.conversation_id);
    if (!conversation) { log(`[voice-webhook] ${type} for unknown conversation ${data.conversation_id} (skipped)`); return res.json({ ok: true, skipped: "unknown conversation" }); }
    const session = await store.getSession(conversation.session_id);
    if (type !== "post_call_transcription") {
      const ref = await store.saveRawPayload(data.conversation_id, type, req.body);
      await store.insertEvent({ session_id: session.id, kind: session.kind, type: "conversation.webhook", payload: { type, ref, kind: session.kind } });
      return res.json({ ok: true, stored: true });
    }
    if (conversation.transcript_hash) return res.json({ ok: true, duplicate: true });
    const ref = await store.saveRawPayload(data.conversation_id, type, req.body);
    await store.updateConversation(conversation.id, { raw_payload_ref: ref });
    const events: any[] = await store.listEvents(session.id);
    const { turns, hash, unmatchedAgentLines } = reconcileTranscript({ transcript: data.transcript || [], events });
    const written = await store.writeTurns(conversation.id, turns);
    const startUnix = Number(data.metadata?.start_time_unix_secs);
    const duration = Number(data.metadata?.call_duration_secs);
    const endedAt = Number.isFinite(startUnix) && Number.isFinite(duration) ? new Date((startUnix + duration) * 1000).toISOString() : new Date(now()).toISOString();
    await store.updateConversation(conversation.id, { ended_at: endedAt, end_reason: String(data.metadata?.termination_reason || data.status || "ended").slice(0, 120), transcript_hash: hash });
    let transition = null;
    if (session.state === "completed" || session.state === "abandoned") {
      transition = await store.transitionSession(session.id, "transcript.received", { conversation_id: conversation.id, turns: written, unmatched_agent_lines: unmatchedAgentLines });
      if (transition?.ok) setImmediate(() => kick(session.id));
    }
    else if (session.state === "in_progress") transition = await store.transitionSession(session.id, "conversation.dropped", { conversation_id: conversation.id, turns: written, unmatched_agent_lines: unmatchedAgentLines });
    res.json({ ok: true, turns: written, transition });
  }, log));

  return r;
}
