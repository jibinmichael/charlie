// lib/qualify/store.test.mjs — the candidacy lifecycle v1 at the store: every stage change is
// recorded with who caused it, every read and write of a thread or connection is this organisation's, and until the
// candidacy migration is applied nothing of this happens (the store behaves exactly as before).
import { describe, it, expect } from "vitest";
import { connectionStore } from "./store.mjs";

const DEFAULTS = { hire_candidacy_proposals: { status: "pending" } };

/** A recording stand-in for the Supabase client: rows per table, every query's filters kept for the assertions. */
function fakeDb(tables, { missing = [] } = {}) {
  const queries = [];
  const db = {
    queries,
    from(table) {
      const q = { table, op: "select", filters: [], patch: null, row: null };
      queries.push(q);
      const rows = () => (tables[table] || []).filter((r) => q.filters.every(([k, v, how]) => (how === "in" ? v.includes(r[k]) : how === "is" ? (r[k] ?? null) === v : r[k] === v)));
      const run = () => {
        if (missing.includes(table)) return { data: null, error: { message: `relation "${table}" does not exist` } };
        // copies out, as the real client returns (a returned row never changes under the caller); column defaults in
        const copy = (r) => structuredClone(r);
        if (q.op === "insert") { const r = { id: `${table}-${(tables[table] || []).length + 1}`, ...(DEFAULTS[table] || {}), ...q.row }; (tables[table] ||= []).push(r); return { data: [copy(r)], error: null }; }
        if (q.op === "update") { const hit = rows(); hit.forEach((r) => Object.assign(r, q.patch)); return { data: hit.map(copy), error: null }; }
        return { data: rows().map(copy), error: null };
      };
      const b = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k, v) => (q.filters.push([k, v, "eq"]), b),
        in: (k, v) => (q.filters.push([k, v, "in"]), b),
        is: (k, v) => (q.filters.push([k, v, "is"]), b),
        insert: (row) => ((q.op = "insert"), (q.row = row), b),
        update: (patch) => ((q.op = "update"), (q.patch = patch), b),
        single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
      };
      return b;
    },
  };
  return db;
}

const world = (over = {}) => ({
  hire_orgs: [{ id: "charlie" }],
  hire_connections: [{ id: "c1", key: "pieworks", org_id: "charlie" }, { id: "c2", key: "pieworks", org_id: "acme" }],
  hire_qualify_threads: [
    { id: "t1", connection_id: "c1", job_id: "j1", candidate_id: "p1", email: "a@x.com", stage: "answered", reply_key: "k1", org_id: "charlie" },
    { id: "t9", connection_id: "c1", job_id: "j1", candidate_id: "p9", email: "z@x.com", stage: "answered", reply_key: "k9", org_id: "acme" },
  ],
  hire_candidacy_events: [],
  hire_candidacy_proposals: [],
  ...over,
});
const scoped = (q) => q.filters.some(([k, v]) => k === "org_id" && v === "charlie");

describe("the store, once the candidacy migration is applied", () => {
  it("reads and writes only this organisation's connections and threads; a reply key and open addresses stay global", async () => {
    const db = fakeDb(world());
    const s = connectionStore(db, { org: "charlie", log: () => {} });
    expect((await s.connections()).map((c) => c.id)).toEqual(["c1"]);
    expect((await s.threads("c1")).map((t) => t.id)).toEqual(["t1"]);
    expect((await s.threadsForJob("j1")).map((t) => t.id)).toEqual(["t1"]);
    await s.connection("pieworks");
    await s.updateThread("t1", { fit: "strong" });
    await s.updateThreadIf("t1", "answered", { fit: "strong" });
    for (const q of db.queries.filter((q) => ["hire_connections", "hire_qualify_threads"].includes(q.table) && !(q.table === "hire_qualify_threads" && q.op === "select" && q.filters.length === 1 && q.filters[0][0] === "id"))) {
      expect(scoped(q), `${q.table} ${q.op} ${JSON.stringify(q.filters)}`).toBe(true);
    }
    // the two deliberate exceptions
    expect((await s.threadByKey("k9"))?.id).toBe("t9");
    expect([...(await s.openEmails())].sort()).toEqual(["a@x.com", "z@x.com"]);
  });

  it("a new thread is this organisation's", async () => {
    const db = fakeDb(world());
    const t = await connectionStore(db, { org: "charlie", log: () => {} }).as({ actor_type: "agent", actor_id: "outreach" }).openThread({ connection_id: "c1", job_id: "j1", candidate_id: "p2", email: "b@x.com", stage: "verify_sent", reply_key: "k2" });
    expect(t.org_id).toBe("charlie");
  });

  it("every stage change is an event naming who caused it; a change that is not a stage change is not", async () => {
    const tables = world();
    const s = connectionStore(fakeDb(tables), { org: "charlie", log: () => {} });
    await s.as({ actor_type: "agent", actor_id: "outreach", ref: "run-1" }).updateThreadIf("t1", "answered", { stage: "closed", close_reason: "said no" });
    await s.as({ actor_type: "candidate", actor_id: "a@x.com", ref: "msg-1" }).updateThread("t1", { stage: "answered" });
    await s.as({ actor_type: "agent", actor_id: "outreach" }).updateThread("t1", { fit: "strong" });
    // the engine also records a move it would refuse; this test is
    // about who caused each change, so it reads the stage changes, and pins the one refusal separately
    expect(tables.hire_candidacy_events.filter((e) => e.type === "engine.refused").map((e) => [e.from_stage, e.to_stage, e.actor_type])).toEqual([["closed", "answered", "candidate"]]);
    expect(tables.hire_candidacy_events.filter((e) => e.type === "stage.changed").map((e) => [e.actor_type, e.actor_id, e.from_stage, e.to_stage, e.reason, e.ref, e.org_id])).toEqual([
      ["agent", "outreach", "answered", "closed", "said no", "run-1", "charlie"],
      ["candidate", "a@x.com", "closed", "answered", null, "msg-1", "charlie"],
    ]);
  });

  it("a change with no actor, or an event that cannot be written, never blocks the change and is counted", async () => {
    const tables = world();
    const s = connectionStore(fakeDb(tables, { missing: ["hire_candidacy_events"] }), { org: "charlie", log: () => {} });
    const t = await s.as({ actor_type: "agent", actor_id: "outreach" }).updateThread("t1", { stage: "closed" });
    expect(t.stage).toBe("closed");
    await s.updateThread("t1", { stage: "answered" }); // no actor
    // the agent's change (table missing), the actorless change, and
    // the engine's refusal of the actorless change (no actor to record it under): three, each counted
    expect(s.eventFailures).toBe(3);
    expect(s.engineRefusals).toBe(1);
  });

  it("a proposal voids any earlier open one, is recorded, and only a pending one can be decided", async () => {
    const tables = world();
    const s = connectionStore(fakeDb(tables), { org: "charlie", log: () => {} }).as({ actor_type: "agent", actor_id: "outreach" });
    const t = tables.hire_qualify_threads[0];
    const a = await s.propose({ thread: t, kind: "close_not_fit", check_id: "fit", reason: "fit is potential", evidence: { fit: "potential" } });
    const b = await s.propose({ thread: t, kind: "close_not_fit", check_id: "pay", reason: "pay above band" });
    expect(tables.hire_candidacy_proposals.map((p) => p.status)).toEqual(["void", "pending"]);
    expect(a.proposed_by).toBe("outreach");
    expect((await s.pendingProposals()).map((p) => p.id)).toEqual([b.id]);
    expect((await s.decideProposal(b.id, "kept", "workspace"))?.status).toBe("kept");
    expect(await s.decideProposal(b.id, "approved", "workspace")).toBeNull();
    // the caller records "proposal.made" once the thread is held behind it (the history never shows a question
    // nobody saw); propose itself records nothing
    expect(tables.hire_candidacy_events.filter((e) => e.type === "proposal.made")).toHaveLength(0);
  });
});

describe("readiness is never guessed", () => {
  it("a passing error on the first read throws and is not remembered; only a missing table means not yet", async () => {
    const tables = world();
    let blip = true;
    const db = fakeDb(tables);
    const from = db.from.bind(db);
    db.from = (t) => {
      if (t === "hire_orgs" && blip) { blip = false; const b = from(t); return { ...b, select: () => ({ limit: async () => ({ data: null, error: { message: "fetch failed" } }) }) }; }
      return from(t);
    };
    const s = connectionStore(db, { org: "charlie", log: () => {} });
    await expect(s.connections()).rejects.toThrow(/fetch failed/);
    expect((await s.connections()).map((c) => c.id)).toEqual(["c1"]);
    expect(await s.candidacyReady()).toBe(true);
  });

  it("a missing table is told apart from every other error, in the shapes Postgres and PostgREST really return", async () => {
    const { isMissingTable } = await import("./store.mjs");
    expect(isMissingTable({ code: "PGRST205", message: "Could not find the table 'public.hire_orgs' in the schema cache" })).toBe(true);
    expect(isMissingTable({ code: "42P01", message: 'relation "hire_orgs" does not exist' })).toBe(true);
    expect(isMissingTable({ message: "Could not find the table 'public.hire_orgs' in the schema cache" })).toBe(true);
    // each code on its own counts, whatever the wording
    expect(isMissingTable({ code: "PGRST205", message: "" })).toBe(true);
    expect(isMissingTable({ code: "42P01", message: "" })).toBe(true);
    for (const e of [{ code: "42703", message: "column hire_orgs.id does not exist" }, { message: 'role "authenticator" does not exist' }, { message: "fetch failed" }, { code: "57014", message: "canceling statement due to statement timeout" }, { code: "PGRST002" }])
      expect(isMissingTable(e), JSON.stringify(e)).toBe(false);
  });

  it("an event whose readiness cannot be read is counted, never thrown at a change that already happened", async () => {
    const db = fakeDb(world());
    const from = db.from.bind(db);
    db.from = (t) => (t === "hire_orgs" ? { select: () => ({ limit: async () => ({ data: null, error: { message: "fetch failed" } }) }) } : from(t));
    const s = connectionStore(db, { log: () => {} }).as({ actor_type: "agent", actor_id: "outreach" });
    expect(await s.recordEvent({ type: "stage.changed", job_id: "j1", thread_id: "t1" })).toBe(false);
    expect(s.eventFailures).toBe(1);
  });

  it("a held conversation is an open one: it blocks a second conversation for the person", async () => {
    const s = connectionStore(fakeDb(world({ hire_qualify_threads: [{ id: "t1", connection_id: "c1", job_id: "j1", email: "h@x.com", stage: "held", org_id: "charlie" }] })), { log: () => {} });
    expect([...(await s.openEmails())]).toEqual(["h@x.com"]);
  });
});

describe("the store, before the candidacy migration is applied", () => {
  it("behaves exactly as before: no organisation filter, no events, no proposals", async () => {
    const tables = world({ hire_orgs: undefined });
    const db = fakeDb(tables, { missing: ["hire_orgs", "hire_candidacy_events", "hire_candidacy_proposals"] });
    const s = connectionStore(db, { log: () => {} }).as({ actor_type: "agent", actor_id: "outreach" });
    expect((await s.threads("c1")).map((t) => t.id)).toEqual(["t1", "t9"]);
    await s.updateThread("t1", { stage: "closed" });
    expect(db.queries.filter((q) => q.table !== "hire_orgs").some(scoped)).toBe(false);
    expect(await s.propose({ thread: tables.hire_qualify_threads[0], kind: "close_not_fit", check_id: "fit", reason: "x" })).toBeNull();
    expect(await s.candidacyReady()).toBe(false);
    expect(s.eventFailures).toBe(0);
  });

  it("a stage change is the old single update: no read before it", async () => {
    const db = fakeDb(world({ hire_orgs: undefined }), { missing: ["hire_orgs"] });
    await connectionStore(db, { log: () => {} }).as({ actor_type: "agent", actor_id: "outreach" }).updateThread("t1", { stage: "closed" });
    expect(db.queries.filter((q) => q.table === "hire_qualify_threads").map((q) => q.op)).toEqual(["update"]);
  });
});

describe("the store asks the one lifecycle engine", () => {
  it("shadow (the default): a move the engine would refuse is still written, and recorded as a refusal", async () => {
    const tables = world();
    const s = connectionStore(fakeDb(tables), { org: "charlie", log: () => {}, engine: "shadow" });
    const t = await s.as({ actor_type: "agent", actor_id: "outreach" }).updateThreadIf("t1", "answered", { stage: "closed", close_reason: "fit is potential after their answers" });
    expect(t.stage).toBe("closed");
    expect(s.engineRefusals).toBe(1);
    expect(tables.hire_candidacy_events.find((e) => e.type === "engine.refused")).toMatchObject({ from_stage: "answered", to_stage: "closed", actor_type: "agent", reason: expect.stringMatching(/approval/) });
  });

  it("enforce: a move the engine refuses is never written; a legal one is", async () => {
    const tables = world();
    const s = connectionStore(fakeDb(tables), { org: "charlie", log: () => {}, engine: "enforce" }).as({ actor_type: "agent", actor_id: "outreach" });
    await expect(s.updateThreadIf("t1", "answered", { stage: "closed", close_reason: "fit is potential after their answers" })).rejects.toThrow(/engine refused answered to closed/);
    expect(tables.hire_qualify_threads[0].stage).toBe("answered");
    await expect(s.updateThread("t1", { stage: "submitted" })).rejects.toThrow(/engine refused/);
    expect((await s.updateThreadIf("t1", "answered", { stage: "closed", close_reason: "said no" })).stage).toBe("closed");
    expect(s.mayMove({ stage: "ready", consent: {} }, "submitting").ok).toBe(false);
  });

  it("only the exact word enforce enforces", async () => {
    const { engineMode } = await import("./store.mjs");
    expect(engineMode("enforce")).toBe("enforce");
    expect(engineMode(" Enforce ")).toBe("enforce");
    for (const v of [undefined, "", "shadow", "on", "enforced", "true"]) expect(engineMode(v)).toBe("shadow");
  });
});

describe("enforce stops a new conversation the engine refuses", () => {
  it("a conversation opened by anyone but Qualify & Submit is never written", async () => {
    const tables = world();
    const s = connectionStore(fakeDb(tables), { org: "charlie", log: () => {}, engine: "enforce" });
    await expect(s.as({ actor_type: "agent", actor_id: "followup" }).openThread({ connection_id: "c1", job_id: "j1", candidate_id: "p3", email: "c@x.com", stage: "verify_sent", reply_key: "k3" })).rejects.toThrow(/engine refused/);
    expect(tables.hire_qualify_threads.some((t) => t.email === "c@x.com")).toBe(false);
    const ok = await s.as({ actor_type: "agent", actor_id: "outreach" }).openThread({ connection_id: "c1", job_id: "j1", candidate_id: "p3", email: "c@x.com", stage: "verify_sent", reply_key: "k3" });
    expect(ok.email).toBe("c@x.com");
  });
});

describe("a person's decision on putting someone forward (the Inbox's Approve / Pass)", () => {
  it("is kept on the thread's overrides, keeps every other override, and is recorded as the person's", async () => {
    const tables = world();
    tables.hire_qualify_threads[0].overrides = { keep: { fit: true } };
    const s = connectionStore(fakeDb(tables), { log: () => {} });
    const t = await s.setApproval("t1", "saved", "asha");
    expect(t.overrides).toEqual({ keep: { fit: true }, approval: { decision: "saved", by: "asha", at: expect.any(String) } });
    expect(tables.hire_candidacy_events).toEqual([expect.objectContaining({ type: "approval.decided", thread_id: "t1", actor_type: "person", actor_id: "asha" })]);
    expect((await s.setApproval("t1", "passed", "asha")).overrides.approval.decision).toBe("passed");
  });

  it("refuses an unknown decision, and finds nothing outside this organisation", async () => {
    const s = connectionStore(fakeDb(world()), { log: () => {} });
    await expect(s.setApproval("t1", "maybe", "asha")).rejects.toThrow(/unknown decision/);
    expect(await s.setApproval("t9", "saved", "asha")).toBeNull();
  });
});
