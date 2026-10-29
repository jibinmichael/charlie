// voice/pipeline.test.mjs — the post-call pipeline: a session with a transcript becomes
// a report; one failed extraction leaves one item insufficient (extraction) and the rest proceed;
// the cap leaves the unreached items insufficient (cap); a second run is a no-op; a test session
// goes to reported and never to awaiting_review; a candidate session waits for review; the sweep
// isolates a failing session and reports the heartbeat honestly.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import { fakeDb } from "./__tests__/fake-db.mjs";
import * as store from "./store.mjs";
import { runPipelineForSession, runPipelineSweep, usageCostUsd } from "./pipeline.mjs";
import { VV_EXTRACT_PROMPT_VERSION } from "./extract.mjs";
import { EVALUATOR_VERSION } from "./evaluate.mjs";
import { STATUSES } from "./statuses.mjs";

const raw = JSON.parse(fs.readFileSync("evals/vv/test-plan.json", "utf8"));
const plan = raw.plan || raw;
const fx = JSON.parse(fs.readFileSync("evals/vv/evidence/strong_specific.json", "utf8"));
const MANDATE = { id: "m1", role: "Field Service Technician", client: "Northwind", contact_email: "hr@northwind.test", jd_text: "jd", hr_questions: [], next_step_text: null };

let db, session, conversation;

/** The extractor as a stub: the fixture's output for the item named in the TOPIC line, or a throw. */
function clientWith({ throwFor = [], usage = { input_tokens: 1000, output_tokens: 200 } } = {}) {
  const c = { calls: [], messages: { create: async ({ messages }) => {
    const text = String(messages?.[0]?.content || "");
    const item = plan.items.find((i) => text.includes(`TOPIC: ${i.evidence_contract.establishes}`));
    c.calls.push(item?.ref ?? "?");
    if (item && throwFor.includes(item.ref)) throw new Error(`boom ${item.ref}`);
    const out = (item && fx.extractor_output[item.id]) || { items: [] };
    return { content: [{ type: "text", text: JSON.stringify(out) }], usage };
  } } };
  return c;
}

async function seed(kind = "test") {
  db = fakeDb({
    vv_mandates: [MANDATE],
    vv_plans: [{ id: plan.id, mandate_id: "m1", version: 1, status: "approved", session_budget_seconds: plan.session_budget_seconds, consent_text_version: plan.consent_text_version ?? "v1", flagged: [] }],
    vv_plan_items: plan.items.map((i) => ({ ...i, plan_id: plan.id })),
  });
  store._setClientForTests(db);
  process.env.VOICE_EXTRACTOR_MODEL = "stub";
  let candidate_id = null;
  if (kind === "candidate") candidate_id = (await store.upsertVvCandidate({ email: "c@x.test", name_as_given: "Asha" })).id;
  session = await store.createSession({ kind, candidate_id, tester_email: kind === "test" ? "t@x.test" : null, plan_id: plan.id });
  await store.transitionSession(session.id, "consent.recorded");
  await store.upsertConversation({ session_id: session.id, provider_conversation_id: "conv_1" });
  conversation = await store.getConversationByProviderId("conv_1");
  await store.transitionSession(session.id, "conversation.started");
  const s = await store.getSession(session.id);
  // The controller reached the first two items; the intent item was never opened.
  const cursor = { phase: "ready", items: Object.fromEntries(plan.items.slice(0, 2).map((i) => [i.id, { status: "sufficient", probesAsked: 1, scenarioAsked: false }])) };
  await store.writeCursor(session.id, cursor, s.version);
  await store.writeTurns(conversation.id, fx.turns.map(({ id, ...t }) => ({ ...t, conversation_id: conversation.id })));
  await store.transitionSession(session.id, "session.completed");
  await store.transitionSession(session.id, "transcript.received", { conversation_id: conversation.id });
  session = await store.getSession(session.id);
  expect(session.state).toBe("transcript_ready");
}

beforeEach(() => seed("test"));

// Signals live in the capability grid plus the one intent signal; the must-have gate summarises the hard ones.
const allSignals = (pkg) => [...(pkg.capability_grid || []), ...(pkg.intent ? [pkg.intent] : [])];
const signalOf = (pkg, ref) => allSignals(pkg).find((s) => s.ref === ref);

describe("runPipelineForSession", () => {
  it("turns a transcript into a report: evidence written, statuses from the six words, a test session reported", async () => {
    const client = clientWith();
    const r = await runPipelineForSession({ store, client, sessionId: session.id, log: () => {} });
    expect(r).toMatchObject({ ok: true, state: "reported", version: 1, failures: [], cap_hit: [] });
    // The intent item was never opened, so it has no turns and the extractor is not called for it.
    expect(client.calls).toEqual(["hard:0", "capabilities:0"]);
    expect(db._rows("vv_evidence").length).toBeGreaterThan(0);
    const reports = db._rows("vv_reports");
    expect(reports).toHaveLength(1);
    const pkg = reports[0].package;
    expect(pkg.versions).toMatchObject({ extractor: VV_EXTRACT_PROMPT_VERSION, evaluator: EVALUATOR_VERSION });
    for (const s of allSignals(pkg)) expect(STATUSES).toContain(s.status);
    expect(signalOf(pkg, "hard:0").status).toBe(fx.expect["hard:0"]);
    expect(signalOf(pkg, "capabilities:0").status).toBe(fx.expect["capabilities:0"]);
    expect(signalOf(pkg, "hard:0").evidence.length).toBeGreaterThan(0);
    const types = db._rows("vv_events").map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["evidence.extracted", "signals.computed", "report.rendered"]));
    expect(types).not.toContain("review.recorded");
    expect(db._rows("vv_sessions")[0].state).toBe("reported");
  });

  it("one item's extraction throwing leaves that item insufficient (extraction) and the rest of the session proceeds", async () => {
    const client = clientWith({ throwFor: ["capabilities:0"] });
    const r = await runPipelineForSession({ store, client, sessionId: session.id, log: () => {} });
    expect(r).toMatchObject({ ok: true, state: "reported", failures: [plan.items[1].id] });
    const pkg = db._rows("vv_reports")[0].package;
    expect(signalOf(pkg, "capabilities:0")).toMatchObject({ status: "insufficient", reason: "extraction" });
    expect(signalOf(pkg, "hard:0").status).toBe(fx.expect["hard:0"]);
  });

  it("the cost cap stops extraction: items not reached read insufficient (cap), and the cap is on the event", async () => {
    const client = clientWith();
    const r = await runPipelineForSession({ store, client, sessionId: session.id, maxCostUsd: 0.001, log: () => {} });
    expect(r.ok).toBe(true);
    expect(client.calls).toEqual(["hard:0"]);
    expect(r.cap_hit).toEqual([plan.items[1].id, plan.items[2].id]);
    const pkg = db._rows("vv_reports")[0].package;
    expect(signalOf(pkg, "capabilities:0")).toMatchObject({ status: "insufficient", reason: "cap" });
    const ev = db._rows("vv_events").find((e) => e.type === "evidence.extracted");
    expect(ev.payload.cap_hit).toHaveLength(2);
    expect(ev.payload.cost_usd).toBeCloseTo(usageCostUsd({ input_tokens: 1000, output_tokens: 200 }), 4);
  });

  it("a second run on the same session and versions is a no-op: no model call, one report", async () => {
    const client = clientWith();
    await runPipelineForSession({ store, client, sessionId: session.id, log: () => {} });
    const calls = client.calls.length;
    const again = await runPipelineForSession({ store, client, sessionId: session.id, log: () => {} });
    expect(again).toMatchObject({ ok: true, skipped: "already_reported", version: 1 });
    expect(client.calls).toHaveLength(calls);
    expect(db._rows("vv_reports")).toHaveLength(1);
  });

  it("resumes at the stage it reached: a session left at evidence_ready is evaluated and rendered without re-extracting", async () => {
    const client = clientWith();
    // Simulate a run that died after extraction.
    await store.transitionSession(session.id, "evidence.extracted", { items: 0, failures: [], cap_hit: [], cost_usd: 0 });
    const r = await runPipelineForSession({ store, client, sessionId: session.id, log: () => {} });
    expect(r).toMatchObject({ ok: true, state: "reported" });
    expect(client.calls).toEqual([]);
  });

  it("a candidate session waits for review and is never reported by the pipeline", async () => {
    await seed("candidate");
    const r = await runPipelineForSession({ store, client: clientWith(), sessionId: session.id, log: () => {} });
    expect(r).toMatchObject({ ok: true, state: "awaiting_review" });
    expect(db._rows("vv_sessions")[0].state).toBe("awaiting_review");
  });
});

describe("runPipelineSweep", () => {
  it("processes every session that owes a report, isolates one that throws, and pings the heartbeat honestly", async () => {
    const pings = [];
    const heartbeat = async (job, opts) => pings.push([job, opts?.fail ?? false]);
    const client = clientWith();
    const clean = await runPipelineSweep({ store, client, log: () => {}, heartbeat });
    expect(clean).toMatchObject({ seen: 1, done: 1, failed: 0 });
    expect(pings).toEqual([["voice-pipeline", false]]);

    // A second session whose plan cannot load: it fails alone, the sweep finishes, the heartbeat says
    // so. The reported session is no longer owed anything and is not seen.
    const broken = await store.createSession({ kind: "test", tester_email: "u@x.test", plan_id: plan.id });
    const row = db._rows("vv_sessions").find((s) => s.id === broken.id);
    row.state = "transcript_ready";
    row.plan_id = "00000000-0000-4000-8000-00000000dead";
    const mixed = await runPipelineSweep({ store, client, log: () => {}, heartbeat });
    expect(mixed).toMatchObject({ seen: 1, done: 0, failed: 1 });
    expect(mixed.results[0]).toMatchObject({ ok: false, sessionId: broken.id });
    expect(pings.at(-1)).toEqual(["voice-pipeline", true]);
  });
});
