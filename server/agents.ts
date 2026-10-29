// server/agents.ts — the agents API and the agents' schedule (lib/agents/*).
// What the hiring workspace's Agents screen reads and changes: each agent's on/off, mode and settings, its runs,
// and the drafts waiting for a person. Plus runAgentsSweep, which charlie-remote.ts calls every 15
// minutes to run each built agent on its schedule.
//
// DARK BY DEFAULT: behind HIRING_WORKSPACE, read at call time. ONE SECRET: the VOICE_DASHBOARD_SECRET
// Bearer, as server/outreach.ts. Every email an agent sends, or a person approves, goes through
// sendGuarded after the live-server check (lib/ask-preflight.mjs).
// @ts-ignore — express ships no types here, same as charlie-remote.ts
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";
import { z } from "zod";
// @ts-ignore — plain ESM JS
import { store } from "../charlie-store.mjs";
// @ts-ignore — plain ESM JS
import { AGENTS, AGENT_IDS, MODES } from "../lib/agents/registry.mjs";
/** The registry looked up by an agent id read from a route or AGENT_IDS (both plain strings). */
const AGENT = AGENTS as Record<string, { name: string; built: boolean; modes?: string[] }>;
// @ts-ignore — plain ESM JS
import { agentStore } from "../lib/agents/store.mjs";
// @ts-ignore — plain ESM JS
import { runAgent, approveDraft, rejectDraft } from "../lib/agents/engine.mjs";
// @ts-ignore — plain ESM JS
import { runQualify } from "../lib/qualify/agent.mjs";
// @ts-ignore — plain ESM JS
import { qualifyDeps } from "../lib/qualify/wiring.mjs";
// @ts-ignore — plain ESM JS
import { connectionStore } from "../lib/qualify/store.mjs";
// @ts-ignore — plain ESM JS
import { onQualifyReply } from "../lib/qualify/agent.mjs";
// @ts-ignore — plain ESM JS
import { replyKeyFrom } from "../lib/qualify/reply-key.mjs";
import { decideProposal } from "../lib/qualify/decide.mjs";
// @ts-ignore — plain .mjs
import { threadView } from "../lib/qualify/view.mjs";
// @ts-ignore — plain .mjs
import { DEFAULT_VERIFY_COPY } from "../lib/qualify/copy.mjs";
// @ts-ignore — plain .mjs
import { ADAPTERS } from "../lib/qualify/adapters.mjs";
// @ts-ignore — plain .mjs
import { qualifySetup } from "../lib/agents/setup.mjs";
// @ts-ignore — plain ESM JS
import { sendGuarded } from "../lib/send-guard.mjs";
// @ts-ignore — plain ESM JS
import { ResendSendPayload } from "../lib/schemas/resend-send.mjs";
// @ts-ignore — plain ESM JS
import { assertAskDeployable } from "../lib/ask-preflight.mjs";
// @ts-ignore — plain ESM JS
import { pingHeartbeat } from "../lib/heartbeat.mjs";
// @ts-ignore — plain ESM JS
import { captureError } from "../lib/sentry-node.mjs";

type Request = any; type Response = any; type Router = any;

function hireEnabled(): boolean {
  return /^(on|1|true|yes)$/i.test(String(process.env.HIRING_WORKSPACE || "").trim());
}

function bearerOk(req: Request): "ok" | "unconfigured" | "bad" {
  const secret = String(process.env.VOICE_DASHBOARD_SECRET || "").trim();
  if (!secret) return "unconfigured";
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ""));
  if (!m) return "bad";
  const a = Buffer.from(m[1].trim()), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>, log: (m: string) => void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e: any) {
    // The detail stays in our log under an id; the browser gets the id only, never internal error text.
    const id = randomUUID().slice(0, 8);
    log(`[agents-api] ${id} ${req.method} ${req.path}: ${e?.message || e}`);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong", id });
  }
};

/** Every setting a person may change, with its bounds. Anything else is refused (strict). */
export const SettingsInput = z.object({
  daily_cap: z.number().int().min(0).max(200),
  quiet_from: z.number().int().min(0).max(23),
  quiet_to: z.number().int().min(0).max(23),
  min_confidence: z.number().min(0.5).max(1),
}).partial().strict();

export const ConfigInput = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(MODES as [string, ...string[]]).optional(),
  settings: SettingsInput.optional(),
  by: z.string().trim().min(1).max(120).optional(),
}).strict();

/** The real dependencies an agent acts through. Tests pass their own. */
export function agentDeps(db: any) {
  const from = process.env.CHARLIE_FROM || "";
  return {
    db,
    store: agentStore(db),
    sendGuarded,
    resend: new Resend(process.env.RESEND_API_KEY),
    from,
    replyTo: process.env.CHARLIE_START_ADDR || from,
    preflight: (template: string) => assertAskDeployable(template),
    validate: (payload: any) => ResendSendPayload.safeParse(payload).success,
    log: (m: string) => console.error(m),
    // Qualify & Submit (lib/qualify/agent.mjs): its own dependencies, built from Charlie's existing parts
    qualify: qualifyDeps(db),
    // a draft left by an agent or workflow that no longer exists is never sent (nothing can re-check it)
    recheck: (d: any) =>
      d.agent === "outreach" ? { ok: false, reason: "Sourcing & Outreach was replaced by Qualify & Submit; this draft can no longer be sent" }
      : !AGENT_IDS.includes(d.agent) ? { ok: false, reason: "the agent that wrote this draft was removed; it can no longer be sent" }
      : { ok: true },
  };
}

export const WORKFLOWS: Record<string, Function> = {
  // the run's AI use is measured, not estimated: the meter is reset before and stored in the run's counts after
  outreach: async ({ cfg, now, remaining, runId, deps }: any) => {
    const meter = deps.qualify?.meter;
    meter?.reset?.();
    let r;
    try {
      r = await runQualify({ cfg, now, remaining, runId, deps: deps.qualify });
    } catch (e: any) {
      // a run that fails still spent what it spent: the engine stores these counts on the failed run
      if (meter && e && typeof e === "object") e.counts = meter.snapshot();
      throw e;
    }
    if (meter) Object.assign(r.counts, meter.snapshot());
    return r;
  },
};

/** A person's decision on an agent's question. `by` is who decided; there are no named users yet, so "workspace". */
export const DecisionInput = z.object({
  decision: z.enum(["approve", "keep"]),
  by: z.string().trim().min(1).max(120).optional(),
}).strict();

/** What a person may change on a connection (hire_connections). Anything else is refused (strict). */
export const ConnectionInput = z.object({
  mode: z.enum(["off", "shadow", "live"]).optional(),
  statuses: z.array(z.string().trim().min(1).max(40)).min(1).max(12).optional(),
  settings: z.object({
    // who fits is the pluggable scorer's call (lib/scoring/index.mjs, CANDIDATE_SCORER), not a setting here
    per_role_cap: z.number().int().min(1).max(30),
    batch_size: z.number().int().min(1).max(16),
  }).partial().strict().optional(),
  sequence: z.object({ verify: z.object({ intro: z.string().trim().max(400), closing: z.string().trim().max(400) }).partial().strict() }).partial().strict().optional(),
  by: z.string().trim().min(1).max(120).optional(),
}).strict();

/** charlie-remote.ts, every 15 minutes: run each built agent. A no-op while HIRING_WORKSPACE is off. */
let sweeping = false;
export async function runAgentsSweep({ db = null as any, log = (m: string) => console.error(m) }: { db?: any; log?: (m: string) => void } = {}) {
  if (!hireEnabled() || sweeping) return null;
  sweeping = true;
  try {
    const deps = agentDeps(db || store());
    const out: Record<string, any> = {};
    for (const id of AGENT_IDS) {
      if (!AGENT[id].built) continue;
      out[id] = await runAgent({ id, trigger: "schedule", store: deps.store, workflows: WORKFLOWS, deps, log });
    }
    const failed = Object.values(out).some((r: any) => r?.status === "failed");
    await pingHeartbeat("agents", failed ? { fail: true } : {});
    return out;
  } catch (e: any) {
    log(`[agents] sweep failed: ${e?.message || e}`);
    captureError(e, { kind: "agents-sweep" });
    await pingHeartbeat("agents", { fail: true });
    return null;
  } finally {
    sweeping = false;
  }
}

/**
 * The /inbound hook: an email to apply+<key>@ is a reply to a Qualify & Submit email (lib/qualify/agent.mjs
 * onQualifyReply: answers filed verbatim, the CV PDF kept). Returns true when it was one (handled or refused), false
 * when /inbound should carry on as before. Never throws. Dark while HIRING_WORKSPACE is off.
 */
export async function qualifyInboundReply({ localParts, from, body, cvFile = null, qualifyCvText = null, ref = null, db = null as any, log = (m: string) => console.error(m) }: { localParts: string[]; from: string; body: string; cvFile?: { filename: string; bytes: Uint8Array } | null; qualifyCvText?: string | null; ref?: string | null; db?: any; log?: (m: string) => void }): Promise<boolean> {
  const key = replyKeyFrom(localParts);
  if (!key) return false;
  if (!hireEnabled()) { log(`[qualify-inbound] a reply to apply+${key} arrived while HIRING_WORKSPACE is off; not read`); return true; }
  try {
    const client = db || store();
    const thread = await connectionStore(client).threadByKey(key).catch((e: any) => { log(`[qualify-inbound] apply+${key}: lookup: ${e?.message || e}`); return null; });
    if (!thread) { log(`[qualify-inbound] apply+${key}: no such conversation`); return true; }
    // only the text of a file that reads like a CV is read as their CV (never a payslip that happened to be attached)
    const out = await onQualifyReply(thread, { body, from, cvText: qualifyCvText, cvFile, ref }, qualifyDeps(client, { log }));
    log(`[qualify-inbound] apply+${key}: ${out}`);
  } catch (e: any) {
    log(`[qualify-inbound] apply+${key}: ${e?.message || e}`); captureError(e, { kind: "qualify-inbound", key });
  }
  return true;
}

/** @param db the Supabase client (a fake under test) */
export function agentsRouter({ db = null as any, deps = null as any, log = (m: string) => console.error(m) }: { db?: any; deps?: any; log?: (m: string) => void } = {}): Router {
  const r = express.Router();
  const D = () => deps || agentDeps(db || store());

  r.use("/agents/api", (req: Request, res: Response, next: any) => {
    if (!hireEnabled()) return res.status(404).json({ error: "not found" });
    const v = bearerOk(req);
    if (v === "unconfigured") return res.status(503).json({ error: "no dashboard secret configured" });
    if (v === "bad") return res.status(401).json({ error: "unauthorized" });
    next();
  });

  r.get("/agents/api/agents", wrap(async (_req, res) => {
    const S = D().store;
    const configs = await S.configs();
    const pending = await S.drafts({ status: "pending" });
    const agents = [];
    for (const c of configs) {
      const [last] = await S.runs(c.id, 1);
      agents.push({ ...c, last_run: last ?? null, pending: pending.filter((d: any) => d.agent === c.id).length });
    }
    res.json({ agents });
  }, log));

  r.put("/agents/api/agents/:id", wrap(async (req, res) => {
    const id = String(req.params.id || "");
    if (!AGENT_IDS.includes(id)) return res.status(404).json({ error: "no such agent" });
    const ok = ConfigInput.safeParse(req.body || {});
    if (!ok.success) return res.status(400).json({ error: ok.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    // an agent refuses the modes it does not have
    const allowed: string[] = AGENT[id].modes ?? MODES;
    if (ok.data.mode && !allowed.includes(ok.data.mode)) return res.status(400).json({ error: `${AGENT[id].name} cannot run in ${ok.data.mode} mode` });
    res.json({ agent: await D().store.saveConfig(id, ok.data, ok.data.by ?? "workspace") });
  }, log));

  r.post("/agents/api/agents/:id/run", wrap(async (req, res) => {
    const id = String(req.params.id || "");
    if (!AGENT_IDS.includes(id)) return res.status(404).json({ error: "no such agent" });
    const d = D();
    res.json(await runAgent({ id, trigger: "manual", store: d.store, workflows: WORKFLOWS, deps: d, log }));
  }, log));

  r.get("/agents/api/agents/:id/runs", wrap(async (req, res) => {
    const id = String(req.params.id || "");
    if (!AGENT_IDS.includes(id)) return res.status(404).json({ error: "no such agent" });
    const d = D();
    // ai_use: AI tokens against people put forward over every run that measured it, not just the 30 listed (a
    // submission lands hours or days after the run that judged the person)
    const [runs, ai_use] = await Promise.all([d.store.runs(id, 30), d.store.aiUse(id)]);
    res.json({ runs, ai_use });
  }, log));

  r.get("/agents/api/drafts", wrap(async (req, res) => {
    const agent = req.query.agent ? String(req.query.agent) : null;
    res.json({ drafts: await D().store.drafts({ status: "pending", agent }) });
  }, log));

  r.post("/agents/api/drafts/:id/approve", wrap(async (req, res) => {
    const by = String(req.body?.by || "workspace").slice(0, 120);
    const out = await approveDraft({ id: String(req.params.id || ""), by, deps: D() });
    res.status(out.ok ? 200 : 409).json(out);
  }, log));

  // the employer connections the Qualify & Submit agent works with (hire_connections)
  r.get("/agents/api/connections", wrap(async (_req, res) => {
    const C = connectionStore(D().db);
    const out = [];
    for (const c of await C.connections()) {
      const roles = await C.roles(c.id);
      const threads = await C.threads(c.id);
      const by = threads.reduce((m: any, t: any) => ((m[t.stage] = (m[t.stage] || 0) + 1), m), {});
      out.push({ key: c.key, name: c.name, mode: c.mode, source: c.source, destination: c.destination, settings: c.settings, sequence: c.sequence, updated_at: c.updated_at, roles: { total: roles.length, briefed: roles.filter((x: any) => x.job_id).length }, threads: by });
    }
    // Charlie's own wording, so the settings boxes start with it (lib/qualify/copy.mjs)
    res.json({ connections: out, defaults: { verify: DEFAULT_VERIFY_COPY } });
  }, log));

  // is the connection working? A live read of one page of the employer system's roles; never a submit. Says the
  // reason when it is not (no key set, refused, unreachable), so a broken key is seen before a run fails on it.
  r.get("/agents/api/connections/:key/check", wrap(async (req, res) => {
    const C = connectionStore(D().db);
    const cur = await C.connection(String(req.params.key || ""));
    if (!cur) return res.status(404).json({ error: "no such connection" });
    const adapter = (D().adapters || ADAPTERS)[cur.source?.type];
    if (!adapter?.check) return res.json({ ok: false, at: new Date().toISOString(), error: `no check for ${cur.source?.type}` });
    try {
      res.json({ ...(await adapter.check(cur)), at: new Date().toISOString() });
    } catch (e: any) {
      res.json({ ok: false, at: new Date().toISOString(), error: String(e?.message || e).slice(0, 200) });
    }
  }, log));

  // what the Setup card shows beyond the saved settings: what the destination needs, the timings, the real emails,
  // the abilities with their models, the guardrails (lib/agents/setup.mjs). Read-only.
  r.get("/agents/api/connections/:key/setup", wrap(async (req, res) => {
    const C = connectionStore(D().db);
    const cur = await C.connection(String(req.params.key || ""));
    if (!cur) return res.status(404).json({ error: "no such connection" });
    // the templates show their variables as tokens, so no role is filled in
    res.json(qualifySetup({ connection: cur, env: process.env }));
  }, log));

  // each of the connection's conversations as the Inbox shows it (lib/qualify/view.mjs, the approved status map);
  // read-only, and never the reply key or the CV text
  r.get("/agents/api/connections/:key/threads", wrap(async (req, res) => {
    const C = connectionStore(D().db);
    const cur = await C.connection(String(req.params.key || ""));
    if (!cur) return res.status(404).json({ error: "no such connection" });
    const roles = new Map((await C.roles(cur.id)).map((x: any) => [String(x.external_id), x]));
    const subs = await C.submissions(cur.id);
    const rows = await C.threads(cur.id);
    // the candidacy record (empty until its migration is applied): what happened and who caused it, and any open
    // question an agent asked a person
    const events = await C.eventsForThreads(rows.map((t: any) => t.id));
    const open = new Map((await C.pendingProposals()).map((p: any) => [p.thread_id, p]));
    const threads = rows.map((t: any) => threadView(t, { role: roles.get(String(t.external_role_id)) || null, submissions: subs.filter((s: any) => s.thread_id === t.id), events: events.filter((e: any) => e.thread_id === t.id), proposal: open.get(t.id) || null }));
    threads.sort((a: any, b: any) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
    res.json({ connection: { key: cur.key, name: cur.name, mode: cur.mode }, threads });
  }, log));

  // a person's decision on what an agent asked them ("Needs you"): approve the close, or keep them
  // (lib/qualify/decide.mjs). The agent acts on it at its next run; nothing is emailed from here.
  r.post("/agents/api/proposals/:id/decide", wrap(async (req, res) => {
    const ok = DecisionInput.safeParse(req.body || {});
    if (!ok.success) return res.status(400).json({ error: ok.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(404).json({ error: "no such question" });
    const out = await decideProposal({ id, decision: ok.data.decision, by: ok.data.by ?? "workspace" }, { cstore: connectionStore(D().db) });
    if (!out.ok) return res.status(out.status || 409).json({ error: out.reason });
    res.json({ ok: true, proposal: { id: out.proposal.id, status: out.proposal.status, decided_by: out.proposal.decided_by, decided_at: out.proposal.decided_at } });
  }, log));

  // a person's decision on putting someone forward (the Inbox's Approve / Pass): kept on the thread
  // (lib/qualify/store.mjs setApproval). The agent submits a ready thread only once it reads "saved", at its next run;
  // nothing is emailed or submitted from here.
  r.post("/agents/api/threads/:id/approval", wrap(async (req, res) => {
    const ok = z.object({ decision: z.enum(["approve", "pass"]), by: z.string().trim().min(1).max(120).optional() }).strict().safeParse(req.body || {});
    if (!ok.success) return res.status(400).json({ error: "decision (approve or pass) is required, and by at most" });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(404).json({ error: "no such conversation" });
    const C = connectionStore(D().db);
    const cur = await C.thread(id);
    if (!cur) return res.status(404).json({ error: "no such conversation" });
    if (["submitted", "submitting", "closed"].includes(cur.stage)) return res.status(409).json({ error: `the conversation is ${cur.stage}; nothing to decide` });
    const t = await C.setApproval(id, ok.data.decision === "approve" ? "saved" : "passed", ok.data.by ?? "workspace");
    if (!t) return res.status(404).json({ error: "no such conversation" });
    res.json({ ok: true, approval: t.overrides?.approval ?? null });
  }, log));

  r.put("/agents/api/connections/:key", wrap(async (req, res) => {
    const ok = ConnectionInput.safeParse(req.body || {});
    if (!ok.success) return res.status(400).json({ error: ok.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const C = connectionStore(D().db);
    const cur = await C.connection(String(req.params.key || ""));
    if (!cur) return res.status(404).json({ error: "no such connection" });
    // a connection no agent can run (no adapter for its source) stays off
    if (ok.data.mode && ok.data.mode !== "off" && !(D().adapters || ADAPTERS)[cur.source?.type]) return res.status(400).json({ error: `${cur.name} cannot be switched on: no agent can run a ${cur.source?.type ?? "source"} connection yet` });
    const patch: any = {};
    if (ok.data.mode) patch.mode = ok.data.mode;
    if (ok.data.statuses) patch.source = { ...(cur.source || {}), statuses: ok.data.statuses };
    if (ok.data.settings) patch.settings = { ...(cur.settings || {}), ...ok.data.settings };
    if (ok.data.sequence) patch.sequence = { ...(cur.sequence || {}), verify: { ...(cur.sequence?.verify || {}), ...(ok.data.sequence.verify || {}) } };
    res.json({ connection: await C.saveConnection(cur.key, patch, ok.data.by ?? "workspace") });
  }, log));

  r.post("/agents/api/drafts/:id/reject", wrap(async (req, res) => {
    const by = String(req.body?.by || "workspace").slice(0, 120);
    const out = await rejectDraft({ id: String(req.params.id || ""), by, store: D().store });
    res.status(out.ok ? 200 : 409).json(out);
  }, log));

  return r;
}
