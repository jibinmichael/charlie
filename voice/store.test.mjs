// voice/store.test.mjs — the store against an in-memory fake: session creation and the kind rule,
// transitions with events, the optimistic cursor, and the deletion cascade leaving zero rows.
// No live database, no keys.
import { describe, it, expect, beforeEach } from "vitest";
import { fakeDb } from "./__tests__/fake-db.mjs";
import * as store from "./store.mjs";
import { recordConsent, withdrawConsent, consentStatus, CONSENT_TEXT_VERSION } from "./consent.mjs";
import { emit } from "./events.mjs";

const PLAN = "0f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
let db;

beforeEach(() => {
  db = fakeDb({ vv_plans: [{ id: PLAN, status: "approved" }] });
  store._setClientForTests(db);
});

async function candidateSession(email = "person@example.com") {
  const c = await store.upsertVvCandidate({ email, name_as_given: "A Person", cv_ref: "cv/person.pdf" });
  const s = await store.createSession({ kind: "candidate", candidate_id: c.id, plan_id: PLAN });
  return { c, s };
}

describe("createSession and the kind rule", () => {
  it("a candidate session needs a candidate and no tester; a test session the reverse", async () => {
    const { s } = await candidateSession();
    expect(s.state).toBe("invited");
    expect(s.kind).toBe("candidate");
    await expect(store.createSession({ kind: "candidate", plan_id: PLAN })).rejects.toThrow(/candidate_id/);
    await expect(store.createSession({ kind: "candidate", candidate_id: "x", tester_email: "hr@x.com", plan_id: PLAN })).rejects.toThrow(/no tester_email/);
    const t = await store.createSession({ kind: "test", tester_email: "HR@Client.com", plan_id: PLAN });
    expect(t.candidate_id).toBeNull();
    expect(t.tester_email).toBe("hr@client.com");
    await expect(store.createSession({ kind: "test", candidate_id: "x", tester_email: "hr@x.com", plan_id: PLAN })).rejects.toThrow(/no candidate_id/);
    await expect(store.createSession({ kind: "demo", tester_email: "hr@x.com", plan_id: PLAN })).rejects.toThrow(/unknown kind/);
  });

  it("refuses a plan that is not approved", async () => {
    db._rows("vv_plans").push({ id: "draft-plan", status: "draft" });
    await expect(store.createSession({ kind: "test", tester_email: "hr@x.com", plan_id: "draft-plan" })).rejects.toThrow(/not approved/);
  });
});

describe("transitionSession", () => {
  it("applies the pure machine, persists the state, and logs the event with kind", async () => {
    const { s } = await candidateSession();
    expect(await store.transitionSession(s.id, "consent.recorded")).toEqual({ ok: true, state: "consented" });
    expect(await store.transitionSession(s.id, "conversation.started")).toEqual({ ok: true, state: "in_progress" });
    const after = await store.getSession(s.id);
    expect(after.state).toBe("in_progress");
    expect(after.started_at).toBeTruthy();
    const events = await store.listEvents(s.id);
    expect(events.map((e) => e.type)).toEqual(["consent.recorded", "conversation.started"]);
    expect(events.every((e) => e.kind === "candidate" && e.payload.kind === "candidate")).toBe(true);
  });

  it("refuses an illegal event and writes nothing", async () => {
    const { s } = await candidateSession();
    const r = await store.transitionSession(s.id, "report.released");
    expect(r.ok).toBe(false);
    expect((await store.getSession(s.id)).state).toBe("invited");
    expect(await store.listEvents(s.id)).toEqual([]);
  });
});

describe("writeCursor (optimistic)", () => {
  it("accepts the expected version and bumps it; refuses a stale write and does not retry", async () => {
    const { s } = await candidateSession();
    expect(await store.writeCursor(s.id, { itemIndex: 0 }, 1)).toEqual({ ok: true, version: 2 });
    const stale = await store.writeCursor(s.id, { itemIndex: 99 }, 1);
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/stale/);
    expect((await store.getSession(s.id)).cursor).toEqual({ itemIndex: 0 });
  });
});

describe("consent", () => {
  it("records per scope with the text version; a later refusal wins; test sessions have no pool scope", async () => {
    const { s } = await candidateSession();
    await recordConsent(store, { session: s, scope: "recording", text_version: CONSENT_TEXT_VERSION, granted: true });
    await recordConsent(store, { session: s, scope: "retention", text_version: CONSENT_TEXT_VERSION, granted: true });
    await recordConsent(store, { session: s, scope: "pool", text_version: CONSENT_TEXT_VERSION, granted: true });
    let st = consentStatus(await store.listConsents(s.id), "candidate");
    expect(st.ok).toBe(true);
    expect(st.pool).toBe(true);
    await withdrawConsent(store, { session: s, scope: "pool" });
    st = consentStatus(await store.listConsents(s.id), "candidate");
    expect(st.ok).toBe(true);
    expect(st.pool).toBe(false);
    await expect(recordConsent(store, { session: s, scope: "pool", text_version: "1999.old", granted: true })).rejects.toThrow(/unknown text version/);
    const t = await store.createSession({ kind: "test", tester_email: "hr@x.com", plan_id: PLAN });
    await expect(recordConsent(store, { session: t, scope: "pool", text_version: CONSENT_TEXT_VERSION, granted: true })).rejects.toThrow(/no pool scope/);
  });

  it("withdrawing recording deletes the session", async () => {
    const { s } = await candidateSession();
    await recordConsent(store, { session: s, scope: "recording", text_version: CONSENT_TEXT_VERSION, granted: true });
    const r = await withdrawConsent(store, { session: s, scope: "recording" });
    expect(r.deleted).toBe(true);
    expect(db._rows("vv_sessions")).toHaveLength(0);
    expect(db._rows("vv_consents")).toHaveLength(0);
  });
});

describe("emit", () => {
  it("logs with kind and refuses a type outside the prefixes", async () => {
    const { s } = await candidateSession();
    await emit(store, s, "turn.recorded", { seq: 1, move: "ask_anchor" });
    const ev = await store.listEvents(s.id);
    expect(ev[0].type).toBe("turn.recorded");
    expect(ev[0].payload).toMatchObject({ seq: 1, kind: "candidate" });
    await expect(emit(store, s, "llm.decided")).rejects.toThrow(/not a valid event type/);
  });
});

describe("deletion cascade", () => {
  it("deleteVvCandidate leaves zero rows in every vv_ table for that person, and removes their objects", async () => {
    const { c, s } = await candidateSession("gone@example.com");
    await store.insertInvitation({ session_id: s.id, token_hash: "h1", expires_at: "2026-10-01T00:00:00Z" });
    await store.insertConsent({ session_id: s.id, scope: "recording", text_version: CONSENT_TEXT_VERSION, granted: true });
    const [conv] = await store.upsertConversation({ session_id: s.id, provider_conversation_id: "conv_1" });
    await store.updateConversation(conv.id, { raw_payload_ref: "raw/conv_1.json", audio_ref: "audio/conv_1.mp3" });
    await store.writeTurns(conv.id, [{ seq: 0, speaker: "agent", text: "Hello" }, { seq: 1, speaker: "candidate", text: "Hi" }]);
    await store.insertEvent({ session_id: s.id, kind: "candidate", type: "conversation.started" });
    // a second, unrelated person must survive the cascade
    await candidateSession("stays@example.com");

    const r = await store.deleteVvCandidate("gone@example.com");
    expect(r).toEqual({ found: true, sessions: 1 });
    for (const t of store.VV_SESSION_TABLES) {
      const rows = db._rows(t).filter((row) => row.session_id === s.id || row.id === s.id || row.conversation_id === conv.id);
      expect({ table: t, rows: rows.length }).toEqual({ table: t, rows: 0 });
    }
    expect(db._rows("vv_candidates").map((x) => x.email)).toEqual(["stays@example.com"]);
    expect(db._removed.sort()).toEqual(["audio/conv_1.mp3", "cv/person.pdf", "raw/conv_1.json"]);
    expect(db._rows("vv_sessions")).toHaveLength(1);
    void c;
  });

  it("deleting an unknown person is a no-op that says so", async () => {
    expect(await store.deleteVvCandidate("nobody@example.com")).toEqual({ found: false, sessions: 0 });
  });

  it("a storage failure aborts the cascade loudly", async () => {
    const { s } = await candidateSession("keep@example.com");
    const [conv] = await store.upsertConversation({ session_id: s.id, provider_conversation_id: "conv_2" });
    await store.updateConversation(conv.id, { audio_ref: "audio/conv_2.mp3" });
    db.storage.from = () => ({ remove: async () => ({ error: { message: "bucket offline" } }) });
    await expect(store.deleteSession(s.id)).rejects.toThrow(/storage removal failed/);
    expect(db._rows("vv_sessions")).toHaveLength(1);
  });
});

describe("upsertConversation idempotency", () => {
  it("a replayed provider conversation id does not create a second row", async () => {
    const { s } = await candidateSession();
    const a = await store.upsertConversation({ session_id: s.id, provider_conversation_id: "conv_x" });
    const b = await store.upsertConversation({ session_id: s.id, provider_conversation_id: "conv_x" });
    expect(a[0].id).toBe(b[0].id);
    expect(db._rows("vv_conversations")).toHaveLength(1);
  });
});

