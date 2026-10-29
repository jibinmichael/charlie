// voice/isolation.test.mjs — a test session cannot reference a candidate, and every candidate-level
// read excludes test sessions. The migration's own constraint, read from the SQL, says the same
// thing, so the rule in code and the rule in the database cannot drift apart unnoticed.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fakeDb } from "./__tests__/fake-db.mjs";
import * as store from "./store.mjs";

const PLAN = "0f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
let db;
beforeEach(() => { db = fakeDb({ vv_plans: [{ id: PLAN, status: "approved" }] }); store._setClientForTests(db); });

describe("test sessions are isolated from candidate data", () => {
  it("a test session cannot carry a candidate_id, and a candidate session cannot lack one", async () => {
    await expect(store.createSession({ kind: "test", candidate_id: "some-person", tester_email: "hr@x.com", plan_id: PLAN })).rejects.toThrow();
    await expect(store.createSession({ kind: "candidate", tester_email: "hr@x.com", plan_id: PLAN })).rejects.toThrow();
  });

  it("listCandidateSessions never returns a test session; listTestSessions never returns a candidate one", async () => {
    const c = await store.upsertVvCandidate({ email: "p@example.com" });
    await store.createSession({ kind: "candidate", candidate_id: c.id, plan_id: PLAN });
    await store.createSession({ kind: "test", tester_email: "hr@x.com", plan_id: PLAN });
    await store.createSession({ kind: "test", tester_email: "hr2@x.com", plan_id: PLAN });
    const cand = await store.listCandidateSessions();
    const test = await store.listTestSessions();
    expect(cand).toHaveLength(1);
    expect(cand.every((s) => s.kind === "candidate")).toBe(true);
    expect(test).toHaveLength(2);
    expect(test.every((s) => s.kind === "test" && s.candidate_id === null)).toBe(true);
  });

  it("events from a test session carry kind=test so no metric can mistake them", async () => {
    const t = await store.createSession({ kind: "test", tester_email: "hr@x.com", plan_id: PLAN });
    await store.transitionSession(t.id, "consent.recorded");
    const ev = await store.listEvents(t.id);
    expect(ev[0].kind).toBe("test");
    expect(ev[0].payload.kind).toBe("test");
  });

  it("the migration enforces the same kind rule as a check constraint", () => {
    const sql = readFileSync("supabase/migrations/20260922130000_vv_session.sql", "utf8");
    expect(sql).toMatch(/constraint vv_sessions_kind_shape check/);
    expect(sql).toMatch(/kind = 'test'\s+and candidate_id is null\s+and tester_email is not null/);
    expect(sql).toMatch(/kind = 'candidate' and candidate_id is not null and tester_email is null/);
    expect(sql).toMatch(/kind\s+text not null check \(kind in \('candidate', 'test'\)\)/);
  });

  it("nothing in voice/ touches the email product's tables", () => {
    const src = ["voice/store.mjs", "voice/plan.mjs", "voice/session.mjs", "voice/consent.mjs", "voice/events.mjs"]
      .map((f) => readFileSync(f, "utf8")).join("\n");
    for (const table of ['"candidates"', '"finds"', '"talent_pool"', '"suppressions"', '"sent_emails"']) {
      expect(src.includes(`from(${table})`)).toBe(false);
    }
    expect(src).not.toMatch(/scoped\(/);
  });
});
