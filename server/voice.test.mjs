// server/voice.test.mjs — the dashboard API: dark when the flag is off, refused without the secret,
// and every route against the in-memory fake with the models stubbed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createHash } from "node:crypto";
import { voiceRouter } from "./voice.ts";
import { fakeDb } from "../voice/__tests__/fake-db.mjs";
import * as store from "../voice/store.mjs";
import { readEvent } from "../charlie-store.mjs";
import { MANDATE_PARSE_SYSTEM } from "../prompts/mandate-parse.mjs";
import { signEvent } from "../charlie-store.mjs";

const SECRET = "test-dashboard-secret-0123456789abcdef";
const JD = `Field Service Technician, Leeds. Must have 2+ years repairing commercial HVAC in your current role.
You will be diagnosing faults yourself on your own service route, not following a dispatched checklist.`;
const MATRIX = {
  role: "Field Service Technician", company: null, location: "Leeds",
  hard: [{ requirement: "2+ years HVAC repair", quote: "Must have 2+ years repairing commercial HVAC in your current role", evidence_needed: "dated account" }],
  preferred: [],
  capabilities: [{ requirement: "diagnoses own faults", quote: "diagnosing faults yourself on your own service route, not following a dispatched checklist", evidence_needed: "an account", observable: ["a fault they traced"] }],
  ambiguous: [], contradictions: [], unknowns: [],
};
const fb = { anchor: "Could you tell me about that in your own words?", probe: "What did that look like day to day?", move_on: "Okay, thank you. Next one.", clarify: "Let me put that another way." };
const GEN = {
  items: [
    { ref: "hard:0", kind: "hard_requirement", priority: 1, budget_seconds: 120, contract: { establishes: "Two or more years of HVAC repair in the current role", why_it_matters: "The mandate makes it a must-have.", elements: [{ name: "context", required: true, core: true }, { name: "dates", required: true }], anchor_question: "Tell me about the HVAC repair work you do in your current role.", depth_probes: [{ text: "When did you start doing that, and is it still part of your week?", targets: "dates" }], ownership_probe: null, scenario: null, contradiction_hooks: [], expected_evidence: "A named employer and a start date.", fallback_text: fb } },
    { ref: "capabilities:0", kind: "capability", priority: 2, budget_seconds: 200, contract: { establishes: "Diagnoses faults on their own route", why_it_matters: "The mandate says diagnosing faults yourself.", elements: [{ name: "instance", required: true, core: true }, { name: "mechanism", required: true }], anchor_question: "Tell me about the last fault you traced from scratch.", depth_probes: [{ text: "How did you decide where to start looking?", targets: "mechanism" }], ownership_probe: null, scenario: null, contradiction_hooks: [], expected_evidence: "A named tool and a decision.", fallback_text: fb } },
    { ref: "intent:0", kind: "intent", priority: 3, budget_seconds: 90, contract: { establishes: "Why this role, in their own words", why_it_matters: "The mandate is for repair work on commercial sites.", elements: [{ name: "motivation", required: true, core: true }], anchor_question: "What drew you to this particular role?", depth_probes: [{ text: "What do you understand the day to day to be?", targets: "motivation" }], ownership_probe: null, scenario: null, contradiction_hooks: [], expected_evidence: "A specific reason.", fallback_text: fb } },
  ],
  flagged: [],
};
const stubClient = {
  calls: 0,
  messages: {
    create: async ({ system }) => {
      stubClient.calls++;
      const out = system === MANDATE_PARSE_SYSTEM ? MATRIX
        : system === VV_WRITER_SYSTEM ? { text: "Thanks. Tell me about the HVAC repair work you do in your current role." }
        : system === VV_JUDGE_SYSTEM ? { present: [], relevant: true }
        : system === VV_ASK_SYSTEM ? (stubClient.ask ?? { filters: [], sort: null, columns: null, aggregate: null, explanation: "", refused: "nothing" })
        : GEN;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },
};
/** The provider stub: mints conv_<n>; `fail` makes it throw. */
const mint = { n: 0, fail: false, async mintToken() { if (mint.fail) throw new Error("provider down"); mint.n++; return { token: `tok_${mint.n}`, conversation_id: `conv_${mint.n}` }; } };

let server, base, db;
const H = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };
const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
const json = async (r) => ({ status: r.status, body: await r.json() });
const kicks = []; // the post-call pipeline kicks the webhook asked for; nothing runs in this test

beforeAll(async () => {
  const app = express();
  // No global parser here: the router parses /voice/api itself (a mandate file can exceed 1 MB).
  app.use(voiceRouter({ makeClient: () => stubClient, log: () => {}, mintToken: mint.mintToken, kickPipeline: (id) => kicks.push(id) }));
  await new Promise((res) => { server = app.listen(0, () => res()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());
beforeEach(() => {
  db = fakeDb();
  store._setClientForTests(db);
  mint.n = 0; mint.fail = false;
  process.env.VOICE_VERIFICATION = "on";
  process.env.VOICE_DASHBOARD_SECRET = SECRET;
  process.env.VOICE_PLANNER_MODEL = "stub";
  process.env.VOICE_APP_ORIGIN = "https://site.test";
});

describe("gates", () => {
  it("everything under /voice is 404 while the flag is off", async () => {
    process.env.VOICE_VERIFICATION = "off";
    expect((await api("/voice/api/jobs")).status).toBe(404);
  });
  it("no secret configured is 503; a wrong or missing bearer is 401", async () => {
    delete process.env.VOICE_DASHBOARD_SECRET;
    expect((await api("/voice/api/jobs")).status).toBe(503);
    process.env.VOICE_DASHBOARD_SECRET = SECRET;
    expect((await fetch(`${base}/voice/api/jobs`)).status).toBe(401);
    expect((await api("/voice/api/jobs", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});

async function createJob() {
  const r = await json(await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "Field Service Technician", client: "Northwind", contact_email: "hr@northwind.test", jd_text: JD, questions: [], session_budget_seconds: 600 }) }));
  expect(r.status).toBe(201);
  return r.body;
}
async function approve(job) {
  const r = await json(await api(`/voice/api/jobs/${job.mandate.id}/plans/${job.plan.id}/approve`, { method: "POST", body: JSON.stringify({ by: "reviewer@example.com" }) }));
  expect(r.status).toBe(200);
  return r.body.plan;
}

describe("ask", () => {
  it("turns a question into a validated rule through the stub, and refuses a bad body and a bad bearer", async () => {
    process.env.VOICE_ASK_MODEL = "stub";
    stubClient.ask = { filters: [{ field: "city", op: "eq", value: "Bengaluru" }], sort: null, columns: ["name", "phone"], aggregate: "count", explanation: "People in Bengaluru, showing name and phone, counted.", refused: null };
    const r = await json(await api("/voice/api/ask", { method: "POST", body: JSON.stringify({ question: "how many in Bengaluru, show phone" }) }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.query).toMatchObject({ filters: [{ field: "city", op: "eq", value: "Bengaluru" }], columns: ["name", "phone"], aggregate: "count" });
    expect((await api("/voice/api/ask", { method: "POST", body: JSON.stringify({ question: "x" }) })).status).toBe(400);
    stubClient.ask = { filters: [], sort: null, columns: null, aggregate: null, explanation: "", refused: "The table holds no interview scores." };
    const refused = await json(await api("/voice/api/ask", { method: "POST", body: JSON.stringify({ question: "who interviewed best" }) }));
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ ok: false, refused: "The table holds no interview scores." });
    expect((await api("/voice/api/ask", { method: "POST", headers: { authorization: "Bearer nope" }, body: JSON.stringify({ question: "anyone" }) })).status).toBe(401);
  });
});

describe("pool", () => {
  it("returns the talent pool as the board's rows, newest first, and skips a row that does not fit rather than failing", async () => {
    db = fakeDb({ talent_pool: [
      { id: 7, email: "A@x.test", full_name: "Owen Pryce", phone: "+44 7700 900000", current_title: "HVAC Technician", current_company: "Acme", total_years: "4.5", comp_current: 1200000, comp_currency: "INR", top_skills: ["refrigerant recovery"], consent_pool: true, consent_share: false, source_form: "tally:abc", applied_at: "2026-09-01T00:00:00Z" },
      { id: 8, email: "not-an-email", full_name: "Broken Row", applied_at: "2026-09-02T00:00:00Z" },
    ] });
    store._setClientForTests(db);
    const r = await json(await api("/voice/api/pool"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, skipped: 1 });
    expect(r.body.people).toHaveLength(1);
    expect(r.body.people[0]).toMatchObject({ id: "tp:7", email: "a@x.test", name: "Owen Pryce", total_years: 4.5, comp_current: 1200000, top_skills: ["refrigerant recovery"], domains: [], consent_pool: true, consent_share: false, consent_process: false, previous_company: null });
    expect((await api("/voice/api/pool", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});

describe("jobs", () => {
  it("creates a job: parses the mandate, generates and saves a draft plan with its chain", async () => {
    const j = await createJob();
    expect(j.plan.status).toBe("draft");
    expect(j.plan.items).toHaveLength(3);
    expect(j.chain.ok).toBe(true);
    expect(db._rows("vv_mandates")).toHaveLength(1);
    expect(db._rows("vv_plan_items")).toHaveLength(3);
    const list = await json(await api("/voice/api/jobs"));
    expect(list.body.jobs[0]).toMatchObject({ role: "Field Service Technician", calls: 0 });
    expect(list.body.jobs[0].latest_plan.status).toBe("draft");
  });

  it("rejects malformed input by schema, and approves a plan whose chain holds", async () => {
    expect((await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "x" }) })).status).toBe(400);
    const j = await createJob();
    const p = await approve(j);
    expect(p.status).toBe("approved");
    const detail = await json(await api(`/voice/api/jobs/${j.mandate.id}`));
    expect(detail.body.plans[0].status).toBe("approved");
    expect(detail.body.chain.ok).toBe(true);
  });
});

describe("candidates and test sessions", () => {
  it("refuses to invite on a job with no approved plan", async () => {
    const j = await createJob();
    const r = await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "hr@northwind.test" }) });
    expect(r.status).toBe(409);
  });

  // A real candidate's session needs their CV (CandidateInput requires cv_text for kind "candidate"),
  // so contradictions can be checked against it; a test session may carry a persona CV instead.
  it("mints a signed link for a test session, and for a candidate only with a CV", async () => {
    const j = await createJob(); await approve(j);
    const t = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "HR@northwind.test" }) }));
    expect(t.status).toBe(201);
    expect(t.body.session).toMatchObject({ kind: "test", state: "invited", tester_email: "hr@northwind.test", candidate_id: null });
    const labelled = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "hr@northwind.test", label: "refuses everything", cv_text: "Persona: HVAC Service Technician at Acme since March 2023, rooftop units on commercial sites, twelve call-outs a week." }) }));
    expect(labelled.body.session.conditions).toEqual({ label: "refuses everything", cv_ref: `cv/session-${labelled.body.session.id}.txt` });
    const withCv = await json(await api(`/voice/api/calls/${labelled.body.session.id}`));
    expect(withCv.body.cv_text).toMatch(/^Persona: HVAC Service Technician/);
    expect(t.body.link).toMatch(/^https:\/\/site\.test\/v\//);
    const token = t.body.link.split("/v/")[1];
    expect(readEvent(token)).toEqual({ vv: t.body.session.id, k: "test" });
    expect(db._rows("vv_invitations")[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(db._rows("vv_invitations")[0].token_hash).not.toContain(token);

    const noCv = await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "candidate", email: "p@x.test", name: "Priya" }) });
    expect(noCv.status).toBe(400);
    const c = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "candidate", email: "p@x.test", name: "Priya", cv_text: "Priya, HVAC Service Technician at Acme since March 2023. Rooftop units on commercial sites, twelve call-outs a week." }) }));
    expect(c.status).toBe(201);
    expect(c.body.candidate.email).toBe("p@x.test");
    const cd = await json(await api(`/voice/api/calls/${c.body.session.id}`));
    expect(cd.body.cv_text).toMatch(/^Priya, HVAC Service Technician/);
    expect(c.body.session.kind).toBe("candidate");
    expect(db._uploaded.some((u) => u.path === `cv/${c.body.candidate.id}.txt`)).toBe(true);
    expect(db._buckets.has("voice-verification")).toBe(true);
  });
});

describe("calls and eval", () => {
  it("lists calls with who and job, shows a call with an empty package before evaluation, and deletes a session", async () => {
    const j = await createJob(); await approve(j);
    const t = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "hr@northwind.test" }) }));
    const list = await json(await api("/voice/api/calls"));
    expect(list.body.calls[0]).toMatchObject({ kind: "test", who: "hr@northwind.test", job: { role: "Field Service Technician", plan_version: 1 } });
    const one = await json(await api(`/voice/api/calls/${t.body.session.id}`));
    expect(one.body.package).toBeNull();
    expect(one.body.plan.items).toHaveLength(3);
    expect(one.body.events.map((e) => e.type)).toEqual(["session.invited"]);
    const del = await json(await api(`/voice/api/calls/${t.body.session.id}`, { method: "DELETE" }));
    expect(del.body.deleted).toBe(true);
    expect(db._rows("vv_sessions")).toHaveLength(0);
  });

  it("records a review as ground truth: agreement computed, a reason required on disagreement, and the session moves on; a test session has no review", async () => {
    const j = await createJob(); await approve(j);
    const c = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "candidate", email: "p@x.test", name: "Priya", cv_text: "Priya, HVAC Service Technician at Acme since March 2023, rooftop units on commercial sites twelve call-outs a week." }) }));
    const sid = c.body.session.id;
    // pretend the pipeline ran: two signals and the state awaiting_review
    db._rows("vv_signals").push(
      { id: "10000000-0000-4000-8000-000000000001", session_id: sid, plan_item_id: j.plan.items[0].id, category: "hard_requirement", status: "supported", evaluator_version: "e.1", evidence_ids: ["x"], reason: null },
      { id: "10000000-0000-4000-8000-000000000002", session_id: sid, plan_item_id: j.plan.items[1].id, category: "capability", status: "stated_only", evaluator_version: "e.1", evidence_ids: [], reason: null },
    );
    Object.assign(db._rows("vv_sessions")[0], { state: "awaiting_review" });

    const missingReason = await api(`/voice/api/calls/${sid}/review`, { method: "POST", body: JSON.stringify({ reviewer: "sme@x.test", per_signal: [{ signal_id: "10000000-0000-4000-8000-000000000002", human_status: "supported" }] }) });
    expect(missingReason.status).toBe(400);
    const unknownSignal = await api(`/voice/api/calls/${sid}/review`, { method: "POST", body: JSON.stringify({ reviewer: "sme@x.test", per_signal: [{ signal_id: "10000000-0000-4000-8000-000000000009", human_status: "supported" }] }) });
    expect(unknownSignal.status).toBe(400);

    const r = await json(await api(`/voice/api/calls/${sid}/review`, { method: "POST", body: JSON.stringify({
      reviewer: "sme@x.test",
      per_signal: [
        { signal_id: "10000000-0000-4000-8000-000000000001", human_status: "supported" },
        { signal_id: "10000000-0000-4000-8000-000000000002", human_status: "supported", disagreement_reason: "evidence_missed", note: "the leak detector quote at 1:10 was not extracted" },
      ],
      evidence_lift: { evidence_ids_new_beyond_cv: [], note: "the ownership answer was not on the CV" },
    }) }));
    expect(r.status).toBe(201);
    expect(r.body.review.per_signal[0]).toMatchObject({ agrees: true, disagreement_reason: null });
    expect(r.body.review.per_signal[1]).toMatchObject({ agrees: false, disagreement_reason: "evidence_missed", charlie_status: "stated_only", human_status: "supported" });
    expect(r.body.transition).toEqual({ ok: true, state: "reviewed" });

    const learn = await json(await api("/voice/api/learning"));
    expect(learn.body.totals).toEqual({ reviewed: 2, agreed: 1, disagreed: 1 });
    expect(learn.body.by_reason.evidence_missed).toMatchObject({ count: 1, jobs: { "Field Service Technician": 1 }, versions: { "e.1": 1 } });
    expect(learn.body.open[0]).toMatchObject({ role: "Field Service Technician", reason: "evidence_missed", human_status: "supported" });

    const t = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "hr@northwind.test" }) }));
    const tr = await api(`/voice/api/calls/${t.body.session.id}/review`, { method: "POST", body: JSON.stringify({ reviewer: "sme@x.test", per_signal: [{ signal_id: "10000000-0000-4000-8000-000000000001", human_status: "supported" }] }) });
    expect(tr.status).toBe(409);
  });
});

describe("meta, mandate file, summaries", () => {
  it("meta exposes the six statuses, the bands, the reasons and the versions, so no client keeps a copy", async () => {
    const m = await json(await api("/voice/api/meta"));
    expect(m.status).toBe(200);
    expect(m.body.statuses).toEqual(["strongly_supported", "supported", "stated_only", "contradicted", "insufficient", "not_assessed"]);
    expect(m.body.coverage_bands).toHaveLength(4);
    expect(m.body.disagreement_reasons).toHaveLength(5);
    expect(Object.keys(m.body.status_language)).toHaveLength(6);
    expect(m.body.versions.evaluator).toMatch(/^\d{4}/);
    expect(m.body.mandate_file_types).toContain("pdf");
  });

  it("a job can arrive as a text file, read verbatim; a wrong type or an unreadable file is refused", async () => {
    const b64 = Buffer.from(JD, "utf8").toString("base64");
    const r = await json(await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "Field Service Technician", contact_email: "hr@northwind.test", jd_file: { name: "mandate.txt", base64: b64 }, questions: [], session_budget_seconds: 600 }) }));
    expect(r.status).toBe(201);
    expect(r.body.mandate.jd_text).toContain("Must have 2+ years");
    const bad = await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "x y", contact_email: "hr@northwind.test", jd_file: { name: "mandate.exe", base64: b64 }, questions: [], session_budget_seconds: 600 }) });
    expect(bad.status).toBe(400);
    const empty = await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "x y", contact_email: "hr@northwind.test", jd_file: { name: "blank.txt", base64: Buffer.from(" ".repeat(60) + "\n" + " ".repeat(60)).toString("base64") }, questions: [], session_budget_seconds: 600 }) });
    expect(empty.status).toBe(422);
    const neither = await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "x y", contact_email: "hr@northwind.test", questions: [], session_budget_seconds: 600 }) });
    expect(neither.status).toBe(400);
  });

  it("every call carries a summary: one status per plan item in plan order, must-haves answered, evaluated, reviewed", async () => {
    const j = await createJob(); await approve(j);
    const c = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "candidate", email: "p@x.test", name: "Priya", cv_text: "Priya, HVAC Service Technician at Acme since March 2023, rooftop units on commercial sites twelve call-outs a week." }) }));
    let list = await json(await api("/voice/api/calls"));
    expect(list.body.calls[0].summary).toEqual({ items: [
      { ref: "hard:0", kind: "hard_requirement", establishes: "Two or more years of HVAC repair in the current role", status: null, coverage_band: null },
      { ref: "capabilities:0", kind: "capability", establishes: "Diagnoses faults on their own route", status: null, coverage_band: null },
      { ref: "intent:0", kind: "intent", establishes: "Why this role, in their own words", status: null, coverage_band: null },
    ], must_haves: { answered: 0, total: 1 }, evaluated: false, reviewed: false });
    db._rows("vv_signals").push(
      { id: "10000000-0000-4000-8000-000000000011", session_id: c.body.session.id, plan_item_id: j.plan.items[0].id, category: "hard_requirement", status: "supported", coverage_band: "partial_coverage", evaluator_version: "e.1", evidence_ids: ["x"], reason: null },
      { id: "10000000-0000-4000-8000-000000000012", session_id: c.body.session.id, plan_item_id: j.plan.items[2].id, category: "intent", status: "not_assessed", coverage_band: "no_usable_evidence", evaluator_version: "e.1", evidence_ids: [], reason: "not_reached" },
    );
    list = await json(await api("/voice/api/calls"));
    expect(list.body.calls[0].summary.items.map((i) => i.status)).toEqual(["supported", null, "not_assessed"]);
    expect(list.body.calls[0].summary).toMatchObject({ must_haves: { answered: 1, total: 1 }, evaluated: true, reviewed: false });
    const detail = await json(await api(`/voice/api/jobs/${j.mandate.id}`));
    expect(detail.body.sessions[0].summary.must_haves).toEqual({ answered: 1, total: 1 });
    expect(detail.body.sessions[0].name).toBe("Priya");
  });
});

describe("body size", () => {
  it("a mandate file over 1 MB is accepted by the router's own parser (the global 1 MB cap does not apply)", async () => {
    const big = JD + "\n" + "x".repeat(1_400_000);
    const r = await api("/voice/api/jobs", { method: "POST", body: JSON.stringify({ role: "Field Service Technician", contact_email: "hr@northwind.test", jd_file: { name: "mandate.txt", base64: Buffer.from(big).toString("base64") }, questions: [], session_budget_seconds: 600 }) });
    expect(r.status).toBe(201);
  });

  it("without the bearer, a large body is refused by the auth check before anything is parsed", async () => {
    const big = "x".repeat(1_400_000);
    const r = await fetch(`${base}/voice/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jd_text: big }) });
    expect(r.status).toBe(401);
  });
});

// ── the live path ─────────────────────────────────────────────────────────────
import { createHmac } from "node:crypto";
import { VV_WRITER_SYSTEM } from "../prompts/vv-writer.mjs";
import { VV_JUDGE_SYSTEM } from "../prompts/vv-judge.mjs";
import { VV_ASK_SYSTEM } from "../prompts/vv-ask.mjs";
import { TROUBLE_LINE, AGENT_SYSTEM_PROMPT } from "../voice/live.mjs";

const LLM_BEARER = "llm-bearer-0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "wsec_0123456789abcdef";
const sysMsg = (id) => ({ role: "system", content: AGENT_SYSTEM_PROMPT.replace("{{system__conversation_id}}", id) });
const sign = (body, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const sseText = (s) => s.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content || "").join("");

describe("live path: gates", () => {
  beforeEach(() => {
    process.env.VOICE_LLM_BEARER = LLM_BEARER;
    process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.ELEVENLABS_API_KEY = "k";
    process.env.ELEVENLABS_AGENT_ID = "agent_1";
    process.env.VOICE_WRITER_MODEL = "stub";
    process.env.VOICE_JUDGE_MODEL = "stub";
  });
  it("every live route is 404 while the flag is off", async () => {
    process.env.VOICE_VERIFICATION = "off";
    expect((await fetch(`${base}/voice/session/x`)).status).toBe(404);
    expect((await fetch(`${base}/voice/llm`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/webhooks/elevenlabs`, { method: "POST" })).status).toBe(404);
  });
  it("/voice/llm: no bearer configured is 503, a bad bearer is 401, and neither calls a model", async () => {
    stubClient.calls = 0;
    delete process.env.VOICE_LLM_BEARER;
    expect((await fetch(`${base}/voice/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    process.env.VOICE_LLM_BEARER = LLM_BEARER;
    expect((await fetch(`${base}/voice/llm`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
    expect(stubClient.calls).toBe(0);
  });
  it("/voice/llm: an unknown conversation id gets the trouble line, streamed, with no model call", async () => {
    stubClient.calls = 0;
    const r = await fetch(`${base}/voice/llm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LLM_BEARER}` }, body: JSON.stringify({ messages: [sysMsg("conv_unknown"), { role: "user", content: "hello" }], stream: true }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(sseText(await r.text())).toBe(TROUBLE_LINE);
    expect(stubClient.calls).toBe(0);
    const noId = await fetch(`${base}/voice/llm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LLM_BEARER}` }, body: JSON.stringify({ messages: [{ role: "user", content: "conversation_id=conv_x" }] }) });
    expect(sseText(await noId.text())).toBe(TROUBLE_LINE);
    expect(stubClient.calls).toBe(0);
  });
  it("/voice/session: a forged or unknown token is refused", async () => {
    expect((await fetch(`${base}/voice/session/not-a-token`)).status).toBe(401);
    const forged = signEvent({ vv: "00000000-0000-4000-8000-000000000000", k: "test" });
    expect((await fetch(`${base}/voice/session/${forged}`)).status).toBe(404);
  });
  it("/webhooks/elevenlabs: a bad or stale signature is 401 and writes nothing", async () => {
    const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_1", transcript: [] } });
    const post = (sig) => fetch(`${base}/webhooks/elevenlabs`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": sig }, body });
    expect((await post("t=1,v0=abc")).status).toBe(401);
    expect((await post(sign(body, "wrong"))).status).toBe(401);
    expect((await post(sign(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    expect(db._rows("vv_turns")).toHaveLength(0);
  });
});

describe("live path: start, turns, webhook, replay", () => {
  beforeEach(() => {
    process.env.VOICE_LLM_BEARER = LLM_BEARER;
    process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.ELEVENLABS_API_KEY = "k";
    process.env.ELEVENLABS_AGENT_ID = "agent_1";
    process.env.VOICE_WRITER_MODEL = "stub";
    process.env.VOICE_JUDGE_MODEL = "stub";
    stubClient.calls = 0;
  });
  const llm = (messages, tools) => fetch(`${base}/voice/llm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LLM_BEARER}` }, body: JSON.stringify({ messages, stream: true, tools }) });

  it("walks a test session from the link to the canonical transcript, and a replayed webhook changes nothing", async () => {
    const j = await createJob(); await approve(j);
    const inv = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "hr@northwind.test" }) }));
    const token = inv.body.link.split("/v/")[1];

    const page = await json(await fetch(`${base}/voice/session/${token}`));
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ kind: "test", state: "invited", role: "Field Service Technician", minutes: 10, consented: false, live: false, done: false });
    expect(page.body.consents.map((c) => c.scope)).toEqual(["recording", "retention"]);
    expect(page.body.progress).toEqual({ opened: 0, total: 3, now: null, done: false });
    expect(db._rows("vv_invitations")[0].opened_at).toBeTruthy();

    const start0 = await json(await fetch(`${base}/voice/session/${token}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consents: [{ scope: "recording", text_version: page.body.consents[0].text_version, granted: true }] }) }));
    expect(start0.status).toBe(403);
    expect(start0.body.missing).toEqual(["retention"]);

    const consents = page.body.consents.map((c) => ({ scope: c.scope, text_version: c.text_version, granted: true }));
    const start = await json(await fetch(`${base}/voice/session/${token}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consents, user_agent: "vitest" }) }));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ token: "tok_1", conversation_id: "conv_1", agent_id: "agent_1", first_message_var: "charlie_first_message", resuming: false });
    expect(start.body.first_message).toMatch(/^Hi, I'm Charlie/);
    const sid = inv.body.session.id;
    expect((await store.getSession(sid)).state).toBe("in_progress");
    // consent rows are append-only: the refused attempt's "recording" row stays, the full answer adds both
    expect(db._rows("vv_consents").map((c) => c.scope)).toEqual(["recording", "recording", "retention"]);
    expect(db._rows("vv_conversations")[0]).toMatchObject({ session_id: sid, provider_conversation_id: "conv_1" });

    const again = await json(await fetch(`${base}/voice/session/${token}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(again.status).toBe(409);

    // turn 1: ready → the first question (the stub writer returns a linted line)
    const t1 = await llm([sysMsg("conv_1"), { role: "assistant", content: start.body.first_message }, { role: "user", content: "yes, ready" }]);
    expect(t1.status).toBe(200);
    const q1 = sseText(await t1.text());
    expect(q1).toBe("Thanks. Tell me about the HVAC repair work you do in your current role.");
    const during = await json(await fetch(`${base}/voice/session/${token}`));
    expect(during.body.progress).toEqual({ opened: 1, total: 3, now: "Two or more years of HVAC repair in the current role", done: false });
    const live = db._rows("vv_events").filter((e) => e.type === "turn.recorded");
    expect(live).toHaveLength(1);
    expect(live[0].payload).toMatchObject({ move: "ask_anchor", candidate_text: "yes, ready", fallback_used: false });

    // turn 2: a refusal of everything from here on is one way to reach the end quickly
    const t2 = await llm([sysMsg("conv_1"), { role: "assistant", content: q1 }, { role: "user", content: "I'd rather not answer that" }], [{ type: "function", function: { name: "end_call" } }]);
    const a2 = await t2.text();
    expect(sseText(a2)).toMatch(/leave that one/);
    const t3 = await llm([sysMsg("conv_1"), { role: "user", content: "skip" }], [{ type: "function", function: { name: "end_call" } }]);
    const t4 = await llm([sysMsg("conv_1"), { role: "user", content: "skip" }], [{ type: "function", function: { name: "end_call" } }]);
    void t3;
    const a4 = await t4.text();
    expect(sseText(a4)).toMatch(/that's everything/);
    expect(a4).toContain('"name":"end_call"');
    expect((await store.getSession(sid)).state).toBe("completed");

    // the webhook: raw payload stored first, canonical turns written, session → transcript_ready
    const body = JSON.stringify({ type: "post_call_transcription", event_timestamp: 1, data: { agent_id: "agent_1", conversation_id: "conv_1", status: "done", transcript: [
      { role: "agent", message: start.body.first_message, time_in_call_secs: 0 },
      { role: "user", message: "yes, ready", time_in_call_secs: 12 },
      { role: "agent", message: q1, time_in_call_secs: 14 },
      { role: "user", message: "I'd rather not answer that", time_in_call_secs: 20 },
    ], metadata: { start_time_unix_secs: 1_700_000_000, call_duration_secs: 40 } } });
    const w = await json(await fetch(`${base}/webhooks/elevenlabs`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": sign(body) }, body }));
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ ok: true, turns: 4, transition: { ok: true, state: "transcript_ready" } });
    expect(db._uploaded.some((u) => u.path === "conversations/conv_1/post_call_transcription.json")).toBe(true);
    const turns = db._rows("vv_turns");
    expect(turns).toHaveLength(4);
    expect(turns[2]).toMatchObject({ speaker: "agent", move: "ask_anchor", plan_item_id: j.plan.items[0].id });
    expect(turns[3]).toMatchObject({ speaker: "candidate", plan_item_id: j.plan.items[0].id, usable: true });
    const conv = db._rows("vv_conversations")[0];
    expect(conv.transcript_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(conv.ended_at).toBe(new Date((1_700_000_000 + 40) * 1000).toISOString());

    const replay = await json(await fetch(`${base}/webhooks/elevenlabs`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": sign(body) }, body }));
    expect(replay.body).toEqual({ ok: true, duplicate: true });
    expect(db._rows("vv_turns")).toHaveLength(4);
    expect((await store.getSession(sid)).state).toBe("transcript_ready");
    // the pipeline was kicked once, by the transcript that moved the session, and not by the replay
    await new Promise((r) => setImmediate(r));
    expect(kicks).toEqual([sid]);

    // the page after the call, and a start after the call
    const after = await json(await fetch(`${base}/voice/session/${token}`));
    expect(after.body).toMatchObject({ state: "transcript_ready", done: true, live: false });
    expect((await fetch(`${base}/voice/session/${token}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    // the dashboard sees the same call
    const detail = await json(await api(`/voice/api/calls/${sid}`));
    expect(detail.body.turns).toHaveLength(4);
    expect(detail.body.conversations).toHaveLength(1);
  });

  it("a webhook for a conversation nobody started is acknowledged and stored nowhere; a non-transcript event is stored and acknowledged", async () => {
    const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_nobody", transcript: [] } });
    const r = await json(await fetch(`${base}/webhooks/elevenlabs`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": sign(body) }, body }));
    expect(r.body).toEqual({ ok: true, skipped: "unknown conversation" });
    expect(db._rows("vv_turns")).toHaveLength(0);
  });

  it("the provider failing to mint a token is a 502 with a plain message and no conversation row", async () => {
    const j = await createJob(); await approve(j);
    const inv = await json(await api(`/voice/api/jobs/${j.mandate.id}/candidates`, { method: "POST", body: JSON.stringify({ kind: "test", tester_email: "hr@northwind.test" }) }));
    const token = inv.body.link.split("/v/")[1];
    const page = await json(await fetch(`${base}/voice/session/${token}`));
    const consents = page.body.consents.map((c) => ({ scope: c.scope, text_version: c.text_version, granted: true }));
    mint.fail = true;
    const r = await json(await fetch(`${base}/voice/session/${token}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consents }) }));
    mint.fail = false;
    expect(r.status).toBe(502);
    expect(db._rows("vv_conversations")).toHaveLength(0);
    expect((await store.getSession(inv.body.session.id)).state).toBe("consented");
  });
});
