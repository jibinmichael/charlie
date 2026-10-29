// lib/qualify/wiring.mjs — the Qualify & Submit agent's real dependencies, built from Charlie's existing parts.
// lib/qualify/agent.mjs takes these as `deps`, so its tests run with fakes and this file is the only place the
// agent touches the database, the model, the send guard and storage.
//
// WHO FITS IS THE SCORER'S CALL (lib/scoring/index.mjs, CANDIDATE_SCORER). This file finds the people who may be
// asked (Charlie's talent pool, consent to hear about roles given), hands each to the scorer with the role's own
// fields, and keeps each answer on the job (hire_jobs.last_search.qualify) so a person is scored once per role,
// scorer and brief. The role's brief is rebuilt from the role the source sent (lib/qualify/roles.mjs briefFromRole).
//
// REUSED, NOT REWRITTEN: the answer filer and its verbatim check (prompts/hire-mandate-answers.mjs,
// lib/qualify/answers.mjs verbatimOnly), the yes/no reader (lib/role-invite-reply.mjs), the one send door
// (lib/send-guard.mjs) behind the live-build check (lib/ask-preflight.mjs: a reply must land on a server that
// knows the thread), the grounding verifier, and the email kit.
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import { qualifyJobs } from "./jobs.mjs";
import { jsonOf, verbatimOnly } from "./answers.mjs";
import { newReplyKey, replyAddress } from "./reply-key.mjs";
import { ownWords } from "../own-words.mjs";
import { sendGuarded } from "../send-guard.mjs";
import { assertRunningBuild } from "../ask-preflight.mjs";
import { ResendSendPayload } from "../schemas/resend-send.mjs";
import { MandateAnswersOutput } from "../schemas/qualify-answers.mjs";
import { HIRE_MANDATE_ANSWERS_SYSTEM, buildMandateAnswersMessages } from "../../prompts/hire-mandate-answers.mjs";
import { verifyGrounding } from "../../grounding-verify.mjs";
import { renderQualifyVerify, renderQualifyReminder, renderQualifyPutForward, renderQualifyClosed, renderQualifyConfirm, renderQualifyHandoff, unsubUrlFor } from "../../email-kit.mjs";
import { connectionStore } from "./store.mjs";
import { syncRoles, briefFromRole } from "./roles.mjs";
import { ADAPTERS } from "./adapters.mjs";
import { writeJustification } from "./justification.mjs";
import { createScorer } from "../scoring/index.mjs";

const CV_BUCKET = "cvs";
/** At most this many new people scored for one role in one pass: bounds what a paid scorer can spend per run. */
export const EVALUATIONS_PER_PASS = 25;
/** The most recently updated pool rows read per role and pass; the scorer sees only those not scored before. */
export const POOL_READ_LIMIT = 500;
/** Scores kept per job (the newest win), so the job row stays small. */
export const SCORES_KEPT = 2000;

const POOL_COLS = "email,full_name,current_title,current_company,headline,total_years,city,country,linkedin_url,top_skills,consent_pool,seeking_status,updated_at";

/** A stable uuid for a pool person, from their address (threads key people by uuid). Pure. */
export function candidateIdFor(email) {
  const h = createHash("sha256").update(`talent_pool:${String(email || "").trim().toLowerCase()}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A pool row as the scorer sees it (lib/scoring/index.mjs ScoringCandidate). Pure. */
export function scoringCandidate(p, extra = {}) {
  const email = String(p?.email || "").trim().toLowerCase();
  return {
    candidate_id: candidateIdFor(email), email,
    full_name: p?.full_name ?? null, current_title: p?.current_title ?? null, current_company: p?.current_company ?? null,
    headline: p?.headline ?? null, total_years: Number.isFinite(Number(p?.total_years)) && p?.total_years !== null ? Number(p.total_years) : null,
    city: p?.city ?? null, country: p?.country ?? null, linkedin_url: p?.linkedin_url ?? null,
    top_skills: Array.isArray(p?.top_skills) ? p.top_skills : null,
    ...extra,
  };
}

/** The role as the scorer sees it (lib/scoring/index.mjs ScoringRole). Pure. */
export function scoringRole(job, spec) {
  return {
    id: job.id, external_id: spec?.external_id ?? null, source: spec?.source ?? null, title: job.title, client: job.client,
    location: spec?.location ?? null, must_haves: (spec?.criteria || []).filter((c) => c.kind === "must_have").map((c) => c.label),
    experience: spec?.experience ?? null, payload: spec?.payload ?? {},
  };
}

/** The experience check: the role's own years band against the years on record. Pure. */
export function experienceGate(band, years) {
  if (!band) return { eligibility_status: "NO_CONSTRAINTS" };
  const y = years === null || years === undefined || years === "" ? NaN : Number(years);
  if (!Number.isFinite(y)) return { eligibility_status: "NEEDS_VERIFICATION", reason: "no years of experience on record" };
  const ok = y >= band.min && (band.max == null || y <= band.max);
  return ok ? { eligibility_status: "ELIGIBLE" } : { eligibility_status: "INELIGIBLE", reason: `${y} years is outside ${band.min}${band.max == null ? "+" : ` to ${band.max}`}` };
}

/** Their own words as quotable evidence: each filed answer, then the CV's paragraphs. Pure. */
export function ownEvidence(thread) {
  const out = [];
  for (const [id, answer] of Object.entries(thread?.answers || {})) {
    if (id.startsWith("_") || typeof answer !== "string" || !answer.trim()) continue;
    out.push({ id: `answer:${id}`, quote: answer.replace(/\s+/g, " ").trim().slice(0, 700) });
  }
  const paras = String(thread?.cv_text || "").split(/\n\s*\n|\r\n\r\n/).map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length >= 40);
  paras.slice(0, 12).forEach((q, i) => out.push({ id: `cv:${i + 1}`, quote: q.slice(0, 700) }));
  return out;
}

/**
 * Every model call these deps make goes through one meter: calls, tokens in (with cache reads and writes) and out,
 * read from each response's own usage. The outreach workflow resets it before a run and stores it with the run, so
 * the workspace shows what a run really used, never an estimate. Pure apart from its counters.
 */
/**
 * The From line. With no display name it is CHARLIE_FROM unchanged; with one (the hand-off's "Charlie on behalf
 * of <org>") it is that name on CHARLIE_FROM's address, stripped to plain characters so a name can
 * never carry a second address or a header. An empty name after stripping refuses rather than sending nameless.
 */
export function senderFrom(base, fromName = null) {
  if (fromName == null) return base;
  const name = String(fromName).replace(/[\r\n]/g, " ").replace(/["<>\\]/g, "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("the sender's name is empty; nothing was sent");
  return `"${name}" <${String(/<([^>]+)>/.exec(base)?.[1] || base).trim()}>`;
}

export function usageMeter() {
  const zero = () => ({ ai_calls: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 });
  let n = zero();
  return {
    add(usage) {
      n.ai_calls += 1;
      n.tokens_in += Number(usage?.input_tokens) || 0;
      n.tokens_out += Number(usage?.output_tokens) || 0;
      n.tokens_cache_read += Number(usage?.cache_read_input_tokens) || 0;
      n.tokens_cache_write += Number(usage?.cache_creation_input_tokens) || 0;
    },
    snapshot: () => ({ ...n }),
    reset() { n = zero(); },
  };
}

export function qualifyDeps(db, { log = (m) => console.error(m), makeClient: makeRaw = () => new Anthropic() } = {}) {
  const meter = usageMeter();
  // the same client the code always used, with each response's usage counted on the way back
  // a transparent proxy: everything behaves exactly as the SDK client, only messages.create is counted
  const makeClient = () => {
    const c = makeRaw();
    const bind = (t, p) => { const v = t[p]; return typeof v === "function" ? v.bind(t) : v; };
    const messages = new Proxy(c.messages, { get: (t, p) => (p === "create" ? async (req, opts) => { const r = await t.create(req, opts); meter.add(r?.usage); return r; } : bind(t, p)) });
    return new Proxy(c, { get: (t, p) => (p === "messages" ? messages : bind(t, p)) });
  };
  const jobs = qualifyJobs(db);
  const cstore = connectionStore(db);
  const scorer = createScorer({ db });
  let resend = null;
  let buildChecked = false;

  /** The role's brief, rebuilt from the role the source sent (never stored, so it never drifts from the role). */
  async function currentSpec(jobId) {
    const { data, error } = await db.from("hire_connection_roles").select("external_id, payload, payload_hash, connection_id").eq("job_id", jobId).maybeSingle();
    if (error) throw new Error(`hire_connection_roles: ${error.message}`);
    if (!data?.payload) return null;
    const b = briefFromRole(data.payload);
    if (!b.ok) return null;
    const conn = (await cstore.connections()).find((c) => c.id === data.connection_id);
    return { ...b.spec, id: `role:${data.payload_hash || data.external_id}`, status: "approved", external_id: data.external_id, source: conn?.source?.type ?? null, payload: data.payload };
  }
  const hire = { ...jobs, currentSpec };

  async function gate({ spec, person }) {
    return experienceGate(spec?.experience ?? null, person?.total_years);
  }

  /** The people scored for this role under its current brief and scorer; scores up to EVALUATIONS_PER_PASS new ones.
   *  The list carries `checked`: the people this call scored, never the stored ones. */
  async function ensureEvaluated({ job, spec }) {
    const cur = (await jobs.getJob(job.id))?.job || job;
    const kept = cur.last_search?.qualify;
    const scored = kept && kept.scorer === scorer.name && kept.brief === spec.id ? { ...(kept.scored || {}) } : {};
    const { data, error } = await db.from("talent_pool").select(POOL_COLS).eq("consent_pool", true).order("updated_at", { ascending: false }).limit(POOL_READ_LIMIT);
    if (error) throw new Error(`talent_pool: ${error.message}`);
    const fresh = (data || []).filter((p) => p.email && p.seeking_status !== "not_looking" && !scored[candidateIdFor(p.email)]).slice(0, EVALUATIONS_PER_PASS);
    const role = scoringRole(job, spec);
    for (const p of fresh) {
      const c = scoringCandidate(p);
      try {
        const r = await scorer.score(c, role);
        scored[c.candidate_id] = { email: c.email, full_name: c.full_name, total_years: c.total_years, score: r.score, pass: r.pass, reasons: r.reasons, at: new Date().toISOString() };
      } catch (e) { log(`[qualify] score ${c.email} for ${job.id}: ${e?.message || e}`); }
    }
    if (fresh.length) {
      const keep = Object.entries(scored).sort((x, y) => String(y[1].at).localeCompare(String(x[1].at))).slice(0, SCORES_KEPT);
      const { error: w } = await db.from("hire_jobs").update({ last_search: { ...(cur.last_search || {}), qualify: { scorer: scorer.name, brief: spec.id, scored: Object.fromEntries(keep) } } }).eq("id", job.id);
      if (w) throw new Error(`hire_jobs scores: ${w.message}`);
    }
    const evals = Object.entries(scored).map(([candidate_id, x]) => ({
      candidate_id, fit: x.pass ? "strong" : "insufficient", score: x.score, reasons: x.reasons, scorer: scorer.name,
      retrieval: { distance: x.score == null ? 1 : 1 - x.score / 100 }, criteria: [],
      person: { email: x.email, full_name: x.full_name, total_years: x.total_years },
    }));
    return Object.assign(evals, { checked: fresh.length });
  }

  /** The person scored again with their answers and CV text; their own words kept as the evidence a note may cite. */
  async function evaluate({ job, spec, thread }) {
    const { data, error } = await db.from("talent_pool").select(POOL_COLS).eq("email", String(thread.email || "").toLowerCase()).maybeSingle();
    if (error) throw new Error(`talent_pool: ${error.message}`);
    const answers = Object.entries(thread.answers || {}).filter(([id, a]) => !id.startsWith("_") && typeof a === "string" && a.trim()).map(([id, answer]) => ({ question: (thread.questions || []).find((q) => q.id === id)?.text || id, answer }));
    const r = await scorer.score(scoringCandidate(data || { email: thread.email, full_name: thread.name }, { answers, cv_text: thread.cv_text || null }), scoringRole(job, spec));
    return { fit: r.pass ? "strong" : "insufficient", score: r.score, pass: r.pass, reasons: r.reasons, scorer: scorer.name, criteria: [], evidence: ownEvidence(thread) };
  }

  async function personFacts(emails) {
    const list = [...new Set(emails)];
    if (!list.length) return { pool: new Map(), suppressed: new Set(), status: new Map() };
    const read = async (t, cols, col) => { const r = await db.from(t).select(cols).in(col, list); if (r.error) throw new Error(`${t}: ${r.error.message}`); return r.data || []; };
    const pool = new Map();
    for (const p of await read("talent_pool", "email,full_name,consent_pool,seeking_status,total_years,linkedin_url,current_company,city,phone,comp_expected,comp_currency,notice_days", "email")) {
      const k = String(p.email).toLowerCase(), cur = pool.get(k);
      const worse = (r) => r.consent_pool !== true || r.seeking_status === "not_looking";
      if (!cur || (worse(p) && !worse(cur))) pool.set(k, p);   // two rows for one address: the one that says no wins
    }
    const suppressed = new Set((await read("suppressions", "address", "address")).map((s) => String(s.address).toLowerCase()));
    const status = new Map();
    for (const c of await read("candidates", "email,status", "email")) { const k = String(c.email).toLowerCase(); if (!status.has(k) || (c.status !== "active" && c.status !== "screening")) status.set(k, c.status); }
    return { pool, suppressed, status };
  }

  async function send({ email, template, dedupeKey, replyKey, mail, fromName = null, attachments = null }) {
    const base = String(process.env.CHARLIE_FROM || "").trim();
    if (!base) throw new Error("CHARLIE_FROM is not set; nothing was sent");
    const replyTo = replyAddress(replyKey, base);
    if (!replyTo) throw new Error("no reply address could be made; nothing was sent");
    const from = senderFrom(base, fromName);
    if (!buildChecked) { await assertRunningBuild("qualify"); buildChecked = true; }
    const ok = ResendSendPayload.safeParse({ from, to: email, replyTo, subject: mail.subject, html: mail.html, text: mail.text, ...(attachments ? { attachments } : {}) });
    if (!ok.success) throw new Error(`the ${template} email did not match the send schema: ${ok.error.issues[0]?.path.join(".")}`);
    resend ||= new Resend(process.env.RESEND_API_KEY);
    return sendGuarded({ resend, email, template, dedupeKey, payload: ok.data, log });
  }

  const cv = {
    async put(threadId, file) {
      const safe = String(file.filename || "cv.pdf").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
      // every file its own path, never overwritten: what a person confirmed is the exact file sent
      const path = `${threadId}/${Date.now()}/${safe}`;
      const { error } = await db.storage.from(CV_BUCKET).upload(path, file.bytes, { contentType: "application/pdf", upsert: false });
      if (error) throw new Error(`cv upload: ${error.message}`);
      return path;
    },
    async get(path) {
      if (!path) throw new Error("no CV PDF on record");
      const { data, error } = await db.storage.from(CV_BUCKET).download(path);
      if (error || !data) throw new Error(`cv download: ${error?.message || "empty"}`);
      return { bytes: new Uint8Array(await data.arrayBuffer()), filename: path.split("/").pop() };
    },
  };

  async function fileAnswers(questions, reply) {
    const res = await makeClient().messages.create({ model: String(process.env.HIRE_MANDATE_ANSWERS_MODEL || "claude-haiku-4-5-20251001"), max_tokens: 3000, temperature: 0, system: HIRE_MANDATE_ANSWERS_SYSTEM, messages: buildMandateAnswersMessages({ questions, reply }) });
    const ok = MandateAnswersOutput.safeParse(jsonOf((res?.content || []).map((b) => b.text || "").join("")));
    if (!ok.success) throw new Error(`the answers did not match the schema: ${ok.error.issues[0]?.path.join(".")}`);
    return verbatimOnly(questions, ok.data, reply);
  }

  const withUnsub = (fn) => (a) => fn({ ...a, unsubUrl: unsubUrlFor(a.email) });

  return {
    db, cstore, hire, scorer, adapters: ADAPTERS, syncRoles, ensureEvaluated, personFacts, gate, evaluate,
    // the grounding check takes the same metered client, so its tokens count with the run's
    writeJustification: (a) => { const client = makeClient(); return writeJustification({ client, verify: (v) => verifyGrounding({ ...v, client }), ...a }); },
    meter,
    send,
    render: { verify: withUnsub(renderQualifyVerify), reminder: withUnsub(renderQualifyReminder), putForward: withUnsub(renderQualifyPutForward), closed: withUnsub(renderQualifyClosed), confirm: withUnsub(renderQualifyConfirm), handoff: withUnsub(renderQualifyHandoff) },
    cv, newReplyKey, fileAnswers, ownWords, log,
  };
}
