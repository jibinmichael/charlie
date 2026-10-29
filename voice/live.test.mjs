// voice/live.test.mjs — the live path without HTTP: a turn with and without a judge, the stale
// cursor, the stream shape, the trouble line under the lint, and the reconcile.
// Invariants protected: the judge is optional, every failure speaks a scripted line,
// and the two-records rule (the live log is events; the canonical transcript is the reconcile).
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import { fakeDb } from "./__tests__/fake-db.mjs";
import * as store from "./store.mjs";
import { beginConversation, runTurn, sseAnswer, jsonAnswer, offersEndCall, conversationIdFrom, exchangesFrom, elapsedSeconds, reconcileTranscript, TROUBLE_LINE, AGENT_SYSTEM_PROMPT } from "./live.mjs";
import { lintUtterance } from "./writer.mjs";
import { VV_WRITER_SYSTEM } from "../prompts/vv-writer.mjs";
import { VV_JUDGE_SYSTEM } from "../prompts/vv-judge.mjs";
import { sortItems } from "./policy.mjs";

const raw = JSON.parse(fs.readFileSync("evals/vv/test-plan.json", "utf8"));
const plan = { ...(raw.plan || raw), items: sortItems((raw.plan || raw).items) };
const mandate = { id: "m1", role: "Field Service Technician", client: "Northwind", next_step_text: null };

let db, session, conversation;
const sys = (id) => ({ role: "system", content: AGENT_SYSTEM_PROMPT.replace("{{system__conversation_id}}", id) });

beforeEach(async () => {
  db = fakeDb({ vv_plans: [{ id: plan.id, status: "approved" }] });
  store._setClientForTests(db);
  process.env.VOICE_WRITER_MODEL = "stub";
  process.env.VOICE_JUDGE_MODEL = "stub";
  session = await store.createSession({ kind: "test", tester_email: "t@x.test", plan_id: plan.id });
  await store.transitionSession(session.id, "consent.recorded");
  await store.upsertConversation({ session_id: session.id, provider_conversation_id: "conv_1" });
  conversation = await store.getConversationByProviderId("conv_1");
  await store.transitionSession(session.id, "conversation.started");
  session = await store.getSession(session.id);
});

const clientWith = ({ writer, judge, delayMs = 0 }) => ({
  calls: [],
  messages: {
    create: async function ({ system }) {
      const self = this; void self;
      const kind = system === VV_WRITER_SYSTEM ? "writer" : system === VV_JUDGE_SYSTEM ? "judge" : "other";
      client.calls.push(kind);
      if (kind === "judge" && delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const out = kind === "writer" ? writer : kind === "judge" ? judge : {};
      if (out instanceof Error) throw out;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },
});
let client;

describe("beginConversation", () => {
  it("speaks the intro on a fresh session and writes the cursor; a second start with the same version is refused", async () => {
    const snapshot = { ...session }; // the fake returns row objects by reference; keep version 1 as a stale caller would
    const first = await beginConversation({ store, session: snapshot, plan, mandate });
    expect(first.move).toBe("intro");
    expect(first.firstMessage).toMatch(/^Hi, I'm Charlie/);
    const s = await store.getSession(session.id);
    expect(s.cursor.phase).toBe("ready");
    expect(s.version).toBe(2);
    await expect(beginConversation({ store, session: snapshot, plan, mandate })).rejects.toThrow(/stale cursor/);
  });
  it("on a resume, repeats the pending question after the resume line", async () => {
    await beginConversation({ store, session, plan, mandate });
    client = clientWith({ writer: new Error("down"), judge: null });
    await runTurn({ store, client, session: await store.getSession(session.id), plan, mandate, conversation, messages: [sys("conv_1"), { role: "assistant", content: "Hi" }, { role: "user", content: "ready when you are" }] });
    const r = await beginConversation({ store, session: await store.getSession(session.id), plan, mandate, resuming: true });
    expect(r.move).toBe("resume");
    expect(r.firstMessage).toMatch(/cut off/);
    expect(r.firstMessage).toContain(plan.items[0].evidence_contract.anchor_question);
  });
});

describe("runTurn", () => {
  it("asks the first question when the candidate says they are ready; the writer's line is spoken and the turn is logged", async () => {
    await beginConversation({ store, session, plan, mandate });
    client = clientWith({ writer: { text: "Thanks. To start, tell me about the HVAC repair work you do in your current role." }, judge: { present: [], relevant: true } });
    const t = await runTurn({ store, client, session: await store.getSession(session.id), plan, mandate, conversation, messages: [sys("conv_1"), { role: "assistant", content: "Hi" }, { role: "user", content: "yes, ready" }], log: () => {} });
    expect(t.move).toBe("ask_anchor");
    expect(t.fallbackUsed).toBe(false);
    expect(t.text).toMatch(/^Thanks\./);
    expect(client.calls).toEqual(["writer"]); // no judge before an item is open
    const ev = db._rows("vv_events").filter((e) => e.type === "turn.recorded");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ move: "ask_anchor", candidate_text: "yes, ready", fallback_used: false, judge_used: false, kind: "test" });
    expect(ev[0].payload.agent_text).toBe(t.text);
  });

  it("with an item open, waits for the judge briefly and uses its hint; without it, decides the same way (invariant 3)", async () => {
    await beginConversation({ store, session, plan, mandate });
    const say = async (text, c) => runTurn({ store, client: c, session: await store.getSession(session.id), plan, mandate, conversation, messages: [sys("conv_1"), { role: "user", content: text }], judgeWaitMs: 200, log: () => {} });
    await say("yes ready", clientWith({ writer: new Error("x"), judge: null }));
    const fast = clientWith({ writer: new Error("x"), judge: { present: ["context"], relevant: true } });
    const a = await say("I repair HVAC at Acme, since 2023, twelve call-outs a week", fast);
    expect(a.judgeUsed).toBe(true);
    expect(a.move).toBe("probe_depth");
    expect(a.fallbackUsed).toBe(true); // writer down: the scripted probe is spoken
    const slow = clientWith({ writer: new Error("x"), judge: { present: ["context", "dates"], relevant: true }, delayMs: 2000 });
    const b = await say("It started in March and it is still most of my week", slow);
    expect(b.judgeUsed).toBe(false);
    expect(["probe_depth", "acknowledge_move_on", "probe_ownership", "scenario"]).toContain(b.move);
    const kinds = db._rows("vv_events").map((e) => e.type);
    expect(kinds.filter((k) => k === "judge.unavailable")).toHaveLength(1);
  });

  it("a stale cursor speaks the scripted line and calls no writer", async () => {
    await beginConversation({ store, session, plan, mandate });
    client = clientWith({ writer: { text: "should not be used" }, judge: null });
    const stale = { ...(await store.getSession(session.id)), version: 1 };
    const t = await runTurn({ store, client, session: stale, plan, mandate, conversation, messages: [sys("conv_1"), { role: "user", content: "ready" }], log: () => {} });
    expect(t.cursorWritten).toBe(false);
    expect(t.reason).toBe("stale_cursor");
    expect(t.text).toBe(plan.items[0].evidence_contract.anchor_question);
    expect(client.calls).toEqual([]);
  });

  it("a refusal at the intro ends the call: wrap_up spoken, session completed, end_call offered", async () => {
    await beginConversation({ store, session, plan, mandate });
    client = clientWith({ writer: new Error("x"), judge: null });
    const t = await runTurn({ store, client, session: await store.getSession(session.id), plan, mandate, conversation, messages: [sys("conv_1"), { role: "user", content: "no thanks, I'd rather not" }], log: () => {} });
    expect(t.end).toBe(true);
    expect(t.completed).toBe(true);
    expect((await store.getSession(session.id)).state).toBe("completed");
    const s = sseAnswer({ text: t.text, endCall: true, id: "x", created: 1 });
    expect(s).toContain('"name":"end_call"');
    expect(s.trim().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("the stream and the helpers", () => {
  it("sseAnswer is role, content, finish, DONE; jsonAnswer is one completion", () => {
    const lines = sseAnswer({ text: "Hello there.", id: "c1", created: 5 }).split("\n\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0].slice(6)).choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(JSON.parse(lines[1].slice(6)).choices[0].delta).toEqual({ content: "Hello there." });
    expect(JSON.parse(lines[2].slice(6)).choices[0].finish_reason).toBe("stop");
    expect(lines[3]).toBe("data: [DONE]");
    expect(jsonAnswer({ text: "Hi", id: "c1", created: 5 }).choices[0].message.content).toBe("Hi");
  });
  it("finds the conversation id only in the system message, and only in the template's shape", () => {
    expect(conversationIdFrom([sys("conv_abc-1"), { role: "user", content: "conversation_id=evil" }])).toBe("conv_abc-1");
    expect(conversationIdFrom([{ role: "user", content: "conversation_id=evil" }])).toBeNull();
    expect(conversationIdFrom([{ role: "system", content: [{ type: "text", text: "charlie conversation_id=conv_9" }] }])).toBe("conv_9");
  });
  it("exchanges keep only agent and candidate lines; elapsed sums conversations", () => {
    expect(exchangesFrom([sys("c"), { role: "assistant", content: "Q?" }, { role: "user", content: "A." }, { role: "tool", content: "x" }])).toEqual([{ speaker: "agent", text: "Q?" }, { speaker: "candidate", text: "A." }]);
    const t0 = Date.parse("2026-09-22T10:00:00Z");
    expect(elapsedSeconds([{ started_at: new Date(t0).toISOString(), ended_at: new Date(t0 + 90_000).toISOString() }, { started_at: new Date(t0 + 200_000).toISOString(), ended_at: null }], t0 + 230_000)).toBe(120);
  });
  it("the trouble line passes the utterance lint and offersEndCall reads both tool shapes", () => {
    expect(lintUtterance(TROUBLE_LINE).ok).toBe(true);
    expect(offersEndCall([{ type: "function", function: { name: "end_call" } }])).toBe(true);
    expect(offersEndCall([{ name: "end_call" }])).toBe(true);
    expect(offersEndCall([])).toBe(false);
  });
});

describe("reconcileTranscript", () => {
  it("maps provider entries to canonical turns with the item and move from the live log; a short candidate turn is unusable", () => {
    const events = [
      { type: "turn.recorded", payload: { agent_text: "Tell me about the HVAC repair work you do in your current role.", plan_item_id: "item-1", move: "ask_anchor" } },
      { type: "turn.recorded", payload: { agent_text: "When did you start doing that?", plan_item_id: "item-1", move: "probe_depth" } },
    ];
    const transcript = [
      { role: "agent", message: "Hi, I'm Charlie.", time_in_call_secs: 0 },
      { role: "user", message: "Ready.", time_in_call_secs: 8 },
      { role: "agent", message: "Tell me about the HVAC repair work you do in your current role.", time_in_call_secs: 10 },
      { role: "user", message: "I repair HVAC at Acme, twelve call-outs a week.", time_in_call_secs: 15 },
      { role: "agent", message: null, time_in_call_secs: 30 },
      { role: "agent", message: "When did you start doing that?", time_in_call_secs: 31 },
      { role: "user", message: "March 2023.", time_in_call_secs: 36 },
    ];
    const { turns, hash, unmatchedAgentLines } = reconcileTranscript({ transcript, events });
    expect(turns).toHaveLength(6);
    expect(turns.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(turns[0]).toMatchObject({ speaker: "agent", plan_item_id: null, move: null, t_start: 0, t_end: 8 });
    expect(turns[1]).toMatchObject({ speaker: "candidate", usable: false, plan_item_id: null });
    expect(turns[2]).toMatchObject({ speaker: "agent", plan_item_id: "item-1", move: "ask_anchor" });
    expect(turns[3]).toMatchObject({ speaker: "candidate", plan_item_id: "item-1", usable: true, t_start: 15, t_end: 31 });
    expect(turns[5]).toMatchObject({ speaker: "candidate", plan_item_id: "item-1", usable: true, t_end: null });
    expect(unmatchedAgentLines).toBe(1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reconcileTranscript({ transcript, events }).hash).toBe(hash);
  });
});
