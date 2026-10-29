// server/agents.test.mjs — the agents API: dark with the workspace flag, one secret, strict settings,
// "Run now" through the runner, drafts approved or rejected; and mounted on the live server.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { readFileSync } from "node:fs";
import { agentsRouter, agentDeps, qualifyInboundReply } from "./agents.ts";
import { configOf } from "../lib/agents/registry.mjs";

const SECRET = "test-dashboard-secret-0123456789abcdef";
let server, base, store;
const api = (path, init = {}, auth = `Bearer ${SECRET}`) => fetch(`${base}${path}`, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init.headers || {}) } });

beforeAll(async () => {
  const rows = {};
  store = {
    saved: [],
    async configs() { return ["outreach"].map((id) => configOf(id, rows[id] ?? null)); },
    async config(id) { return configOf(id, rows[id] ?? null); },
    async saveConfig(id, p) { rows[id] = { id, enabled: p.enabled ?? true, mode: p.mode ?? configOf(id, null).mode, settings: p.settings ?? {} }; this.saved.push([id, p]); return configOf(id, rows[id]); },
    async drafts() { return []; },
    async runs() { return []; },
    async aiUse() { return { runs: 2, since: "2026-10-06T04:00:00.000Z", ai_calls: 9, tokens: 50000, submitted: 1 }; },
    async skippedRun() { return "run-1"; },
  };
  const app = express();
  app.use(express.json());
  app.use(agentsRouter({ deps: { store }, log: () => {} }));
  await new Promise((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());
beforeEach(() => { process.env.HIRING_WORKSPACE = "on"; process.env.VOICE_DASHBOARD_SECRET = SECRET; });

describe("a draft from a removed agent is never sent", () => {
  it("the re-check refuses a Follow-up, Screening or Rediscovery draft and still refuses an old Sourcing & Outreach one", () => {
    process.env.RESEND_API_KEY ||= "re_test_key";
    const { recheck } = agentDeps({});
    expect(recheck({ agent: "followup" })).toMatchObject({ ok: false, reason: expect.stringMatching(/removed/) });
    expect(recheck({ agent: "outreach" })).toMatchObject({ ok: false });
    expect(recheck({ agent: "qualifier" })).toMatchObject({ ok: false, reason: expect.stringMatching(/removed/) });
    expect(recheck({ agent: "rediscovery" })).toMatchObject({ ok: false, reason: expect.stringMatching(/removed/) });
  });
});

describe("the agents API", () => {
  it("404 while the workspace is off, 401 with the wrong secret", async () => {
    process.env.HIRING_WORKSPACE = "off";
    expect((await api("/agents/api/agents")).status).toBe(404);
    process.env.HIRING_WORKSPACE = "on";
    expect((await api("/agents/api/agents", {}, "Bearer nope")).status).toBe(401);
  });

  it("a failure answers 500 with an id only; the detail stays in the log", async () => {
    const configs = store.configs;
    store.configs = async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 relation hire_agents"); };
    try {
      const r = await api("/agents/api/agents");
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body).toEqual({ error: "Something went wrong", id: expect.stringMatching(/^[0-9a-f]{8}$/) });
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hire_agents/);
    } finally {
      store.configs = configs;
    }
  });

  it("lists the one agent with its out-of-the-box mode", async () => {
    const d = await (await api("/agents/api/agents")).json();
    expect(d.agents.map((a) => [a.id, a.name, a.label, a.mode, a.built])).toEqual([["outreach", "Qualify & Submit", "White-label", "auto", true]]);
  });

  it("settings are strict and bounded; an unknown or removed agent is refused", async () => {
    expect((await api("/agents/api/agents/outreach", { method: "PUT", body: JSON.stringify({ settings: { daily_cap: 500 } }) })).status).toBe(400);
    expect((await api("/agents/api/agents/outreach", { method: "PUT", body: JSON.stringify({ settings: { send_to_everyone: true } }) })).status).toBe(400);
    // the Screening agent's editable lines went with it
    expect((await api("/agents/api/agents/outreach", { method: "PUT", body: JSON.stringify({ settings: { intro: "Thanks for applying." } }) })).status).toBe(400);
    for (const gone of ["nope", "followup", "qualifier", "rediscovery"]) expect((await api(`/agents/api/agents/${gone}`, { method: "PUT", body: JSON.stringify({ mode: "off" }) })).status).toBe(404);
    expect((await api("/agents/api/agents/qualifier/setup")).status).toBe(404);
    const ok = await api("/agents/api/agents/outreach", { method: "PUT", body: JSON.stringify({ mode: "auto", settings: { daily_cap: 10 } }) });
    expect((await ok.json()).agent).toMatchObject({ mode: "auto", settings: { daily_cap: 10 } });
  });

  it("Qualify & Submit has no Draft mode: it is automatic, controlled by each connection's mode", async () => {
    const r = await api("/agents/api/agents/outreach", { method: "PUT", body: JSON.stringify({ mode: "draft" }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/cannot run in draft mode/);
    expect((await api("/agents/api/agents/outreach", { method: "PUT", body: JSON.stringify({ mode: "off" }) })).status).toBe(200);
  });

  it("Run now on an agent that does not exist is refused", async () => {
    expect((await api("/agents/api/agents/qualifier/run", { method: "POST" })).status).toBe(404);
  });
});

describe("a connection's settings are its limits only: who fits is the scorer's call", () => {
  it("accepts the per-role cap and the batch size; refuses audience and min_fit", async () => {
    const { ConnectionInput } = await import("./agents.ts");
    expect(ConnectionInput.safeParse({ settings: { per_role_cap: 10, batch_size: 2 } }).success).toBe(true);
    expect(ConnectionInput.safeParse({ settings: { audience: "approved" } }).success).toBe(false);
    expect(ConnectionInput.safeParse({ settings: { min_fit: "strong" } }).success).toBe(false);
  });
});

describe("a person's decision on an agent's question", () => {
  it("needs the secret, a strict body, and a real question id", async () => {
    const id = "6f1c3c2e-8a8b-4b7e-9a3f-2b1d4c5e6f70";
    expect((await api(`/agents/api/proposals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve" }) }, "Bearer nope")).status).toBe(401);
    expect((await api(`/agents/api/proposals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision: "close" }) })).status).toBe(400);
    expect((await api(`/agents/api/proposals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision: "keep", extra: 1 }) })).status).toBe(400);
    expect((await api(`/agents/api/proposals/not-a-uuid/decide`, { method: "POST", body: JSON.stringify({ decision: "keep" }) })).status).toBe(404);
  });
});

describe("the Inbox view of Qualify & Submit conversations", () => {
  // a tiny in-memory stand-in for the Supabase client: from(table).select().eq()/.in() resolves rows; maybeSingle one row.
  // A table not given does not exist, as in a database before the candidacy migration (the store tells a missing
  // table from any other error, so the fake must answer the way Postgres does)
  const fakeDb = (tables) => ({
    from: (t) => {
      let rows = [...(tables[t] || [])];
      const missing = !(t in tables) && t.startsWith("hire_") && ["hire_orgs", "hire_candidacy_events", "hire_candidacy_proposals"].includes(t);
      const res = () => (missing ? { data: null, error: { code: "42P01", message: `relation "${t}" does not exist` } } : { data: rows, error: null });
      const q = {
        select: () => q, order: () => q, limit: () => q,
        eq: (k, v) => { rows = rows.filter((r) => r[k] === v); return q; },
        in: (k, vs) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
        maybeSingle: async () => (missing ? res() : { data: rows[0] ?? null, error: null }),
        then: (ok, bad) => Promise.resolve(res()).then(ok, bad),
      };
      return q;
    },
  });
  it("returns each conversation with its stage, never the reply key or CV text; 404 for an unknown connection; 401 without the secret", async () => {
    const db = fakeDb({
      hire_connections: [{ id: "c1", key: "pieworks", name: "Pieworks", mode: "shadow" }],
      hire_connection_roles: [{ connection_id: "c1", external_id: "100001", payload: { role: "Support Engineer", clientName: "Acme Robotics", location: "Jaipur" } }],
      hire_qualify_threads: [{ id: "t1", connection_id: "c1", name: "Asha Rao", email: "a@x.com", reply_key: "secretkey", cv_text: "private", stage: "verify_sent", verify_sent_at: "2026-10-06T04:00:00.000Z", external_role_id: "100001", consent: { state: "ASKED" } }],
      // one row for this thread, one for another connection: only this thread's shows (pins connection_id + thread_id)
      hire_submissions: [{ connection_id: "c1", thread_id: "t1", job_id: "j1", status: "duplicate", attempt: 1, response: { message: "already discovered" } }, { connection_id: "c9", thread_id: "t1", job_id: "j1", status: "sent", attempt: 2, response: { message: "Saved" } }],
    });
    const app = express(); app.use(express.json()); app.use(agentsRouter({ deps: { store, db }, log: () => {} }));
    const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    try {
      const ok = await fetch(`${b}/agents/api/connections/pieworks/threads`, { headers: { authorization: `Bearer ${SECRET}` } });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.threads).toEqual([expect.objectContaining({ name: "Asha Rao", label: "Asked", waitingFor: "them", nextAt: "2026-10-08T04:00:00.000Z", company: "Acme Robotics" })]);
      expect(JSON.stringify(body)).not.toMatch(/secretkey|private/);
      expect(body.threads[0].submission).toMatchObject({ status: "duplicate", attempt: 1 });
      expect((await fetch(`${b}/agents/api/connections/nope/threads`, { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(404);
      expect((await fetch(`${b}/agents/api/connections/pieworks/threads`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    } finally { srv.close(); }
  });

  it("the connection check reads one page through the adapter and says why when it cannot; the list carries the default wording", async () => {
    const db = fakeDb({ hire_connections: [{ id: "c1", key: "pieworks", name: "Pieworks", mode: "shadow", source: { type: "pieworks" } }, { id: "c2", key: "globex", name: "Globex", mode: "off", source: { type: "darwinbox" } }], hire_connection_roles: [], hire_qualify_threads: [], hire_submissions: [] });
    let calls = 0;
    const adapters = { pieworks: { check: async () => { calls++; if (calls > 1) throw new Error("Pieworks activeRoles page 1: HTTP 401"); return { ok: true, total: 31, sample: { id: 1, role: "QA", client: "Acme Robotics" } }; } } };
    const app = express(); app.use(express.json()); app.use(agentsRouter({ deps: { store, db, adapters }, log: () => {} }));
    const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    const get = (p) => fetch(`${b}${p}`, { headers: { authorization: `Bearer ${SECRET}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
      expect((await get("/agents/api/connections/pieworks/check")).body).toMatchObject({ ok: true, total: 31 });
      expect((await get("/agents/api/connections/pieworks/check")).body).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 401/) });
      expect((await get("/agents/api/connections/globex/check")).body).toMatchObject({ ok: false, error: "no check for darwinbox" });
      expect((await get("/agents/api/connections/nope/check")).status).toBe(404);
      // a connection no agent can run stays off: switching it on is refused before anything is saved
      const put = await fetch(`${b}/agents/api/connections/globex`, { method: "PUT", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "live" }) });
      expect(put.status).toBe(400);
      expect((await put.json()).error).toMatch(/cannot be switched on/);
      expect((await get("/agents/api/connections")).body.defaults.verify.intro).toMatch(/^\{company\} is hiring for the \{role\} role/);
    } finally { srv.close(); }
  });
});

describe("the Setup card's details", () => {
  it("gives the destination's needs, the timings and the real emails for a connection; 404 for an unknown one", async () => {
    // hire_orgs does not exist here, as before the candidacy migration
    const fake = (tables) => ({ from: (t) => { let rows = [...(tables[t] || [])]; const gone = t === "hire_orgs" ? { data: null, error: { code: "42P01", message: 'relation "hire_orgs" does not exist' } } : null; const q = { select: () => q, order: () => q, limit: () => q, eq: (k, v) => { rows = rows.filter((r) => r[k] === v); return q; }, maybeSingle: async () => gone ?? ({ data: rows[0] ?? null, error: null }), then: (ok, bad) => Promise.resolve(gone ?? { data: rows, error: null }).then(ok, bad) }; return q; } });
    const db = fake({ hire_connections: [{ id: "c1", key: "pieworks", name: "Pieworks", mode: "live", source: { type: "pieworks" }, destination: { via: "Pieworks" }, sequence: {} }], hire_connection_roles: [{ connection_id: "c1", job_id: "j1", payload: { role: "Support Engineer", clientName: "Acme Robotics", location: "Ajmer" } }] });
    const app = express(); app.use(express.json()); app.use(agentsRouter({ deps: { store, db }, log: () => {} }));
    const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await fetch(`${b}/agents/api/connections/pieworks/setup`, { headers: { authorization: `Bearer ${SECRET}` } });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.needs).toContain("CV as a PDF");
      expect(body.emails.map((e) => e.id)).toEqual(["verify", "reminder", "followup", "confirm", "putforward", "closed"]);
      expect(body.emails[0].subject).toBe("{role} at {company}: may I put you forward?");
      expect(body.timings.remind_after_hours).toBe(48);
      expect((await fetch(`${b}/agents/api/connections/nope/setup`, { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(404);
      expect((await fetch(`${b}/agents/api/connections/pieworks/setup`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    } finally { srv.close(); }
  });
});

describe("mounted on the live server", () => {
  it("charlie-remote.ts mounts the agents API and runs the agents every 15 minutes", () => {
    const src = readFileSync(new URL("./charlie-remote.ts", import.meta.url), "utf8");
    expect(src).toMatch(/app\.use\(agentsRouter\(\)\);/);
    expect(src).toMatch(/setInterval\(\(\) => \{ runAgentsSweep\(\)[^\n]*15 \* 60 \* 1000\)/);
  });
});

describe("a person's decision on putting someone forward (the Inbox's Approve / Pass)", () => {
  const T1 = "6f1c3c2e-8a8b-4b7e-9a3f-2b1d4c5e6f70";
  // a stand-in for the Supabase client over hire_qualify_threads; hire_orgs is missing, as before the candidacy migration
  const fakeDb = (threads) => ({
    from: (t) => {
      let rows = t === "hire_qualify_threads" ? threads : [];
      let patch = null;
      const res = () => {
        if (t === "hire_orgs") return { data: null, error: { code: "42P01", message: 'relation "hire_orgs" does not exist' } };
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        return { data: rows.map((r) => ({ ...r })), error: null };
      };
      const q = { select: () => q, order: () => q, limit: () => q, update: (p) => ((patch = p), q), eq: (k, v) => { rows = rows.filter((r) => r[k] === v); return q; }, maybeSingle: async () => { const r = res(); return { data: r.data?.[0] ?? null, error: r.error }; }, single: async () => { const r = res(); return { data: r.data?.[0] ?? null, error: r.error }; }, then: (ok, bad) => Promise.resolve(res()).then(ok, bad) };
      return q;
    },
  });
  it("records approve or pass on the thread; strict body; 404 unknown; 409 once it is over; 401 without the secret", async () => {
    const threads = [{ id: T1, job_id: "j1", candidate_id: "c1", stage: "ready", overrides: { keep: { fit: true } } }, { id: "7f1c3c2e-8a8b-4b7e-9a3f-2b1d4c5e6f70", stage: "submitted", overrides: {} }];
    const app = express(); app.use(express.json()); app.use(agentsRouter({ deps: { store, db: fakeDb(threads) }, log: () => {} }));
    const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    const post = (id, body, auth = `Bearer ${SECRET}`) => fetch(`${b}/agents/api/threads/${id}/approval`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post(T1, { decision: "approve" }, "Bearer nope")).status).toBe(401);
      expect((await post(T1, { decision: "maybe" })).status).toBe(400);
      expect((await post(T1, { decision: "approve", extra: 1 })).status).toBe(400);
      expect((await post("not-a-uuid", { decision: "approve" })).status).toBe(404);
      expect((await post("8f1c3c2e-8a8b-4b7e-9a3f-2b1d4c5e6f70", { decision: "approve" })).status).toBe(404);
      expect((await post("7f1c3c2e-8a8b-4b7e-9a3f-2b1d4c5e6f70", { decision: "approve" })).status).toBe(409);
      const ok = await post(T1, { decision: "approve", by: "asha" });
      expect(ok.status).toBe(200);
      expect((await ok.json()).approval).toMatchObject({ decision: "saved", by: "asha" });
      expect(threads[0].overrides).toMatchObject({ keep: { fit: true }, approval: { decision: "saved", by: "asha" } });
      await post(T1, { decision: "pass" });
      expect(threads[0].overrides.approval.decision).toBe("passed");
    } finally { srv.close(); }
  });
});

describe("a reply to apply+<key>@ (the /inbound hook)", () => {
  it("is not ours without an apply+ key; is held unread while the workspace is off; an unknown key is ours and not read", async () => {
    const logs = [];
    const log = (m) => logs.push(m);
    const db = { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; return q; } };
    expect(await qualifyInboundReply({ localParts: ["charlie"], from: "a@x.com", body: "hi", db, log })).toBe(false);
    process.env.HIRING_WORKSPACE = "off";
    expect(await qualifyInboundReply({ localParts: ["apply+abcdefghij1234"], from: "a@x.com", body: "yes", db, log })).toBe(true);
    expect(logs.pop()).toMatch(/HIRING_WORKSPACE is off/);
    process.env.HIRING_WORKSPACE = "on";
    expect(await qualifyInboundReply({ localParts: ["apply+abcdefghij1234"], from: "a@x.com", body: "yes", db, log })).toBe(true);
    expect(logs.pop()).toMatch(/no such conversation/);
  });

  it("charlie-remote.ts hands apply+ replies to it before onboarding", () => {
    const src = readFileSync(new URL("./charlie-remote.ts", import.meta.url), "utf8");
    expect(src).toMatch(/await qualifyInboundReply\(/);
    expect(src).not.toMatch(/hireInboundReply|hireRouter|ciRouter/);
  });
});
