// lib/hire-pursuit-sync.test.mjs — the saved lifecycle kept in step with the outreach emails.
// First run imports, a second run with no new mail changes nothing, a reply reconciles with from and to
// recorded, a mandate with no job is never saved, and one broken mandate never stops the others.
import { describe, it, expect, vi, beforeEach } from "vitest";

const JOB = "11111111-1111-1111-1111-111111111111";
const T = (iso) => new Date(iso).toISOString();
let threads = {};
vi.mock("./hire-outreach.mjs", () => ({
  OUTREACH_MANDATES: {},
  loadOutreach: async (_db, key) => structuredClone(threads[key] ?? []),
}));
vi.mock("./hire-outreach-lifecycle.mjs", () => ({ yesLists: () => ({}) }));
const { syncOutreachPursuits } = await import("./hire-pursuit-sync.mjs");
const { stateDiffers } = await import("./hire-pursuit-store.mjs");

/** A Supabase-shaped fake: eq/in/is/limit/maybeSingle/single, insert/update, and the two pursuit RPCs. */
function fakeDb(tables) {
  const t = { hire_people: [], hire_pursuits: [], hire_pursuit_events: [], hire_pursuit_keys: [], suppressions: [], ...tables };
  let n = 0;
  const from = (table) => {
    const f = [];
    let op = "select", payload = null, one = false, ret = false;
    const run = () => {
      if (op === "insert") { const row = { id: `${table}-${++n}`, ...payload }; t[table].push(row); return { data: ret ? (one ? row : [row]) : null, error: null }; }
      const rows = t[table].filter((r) => f.every((p) => p(r)));
      if (op === "update") { rows.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      return one ? { data: structuredClone(rows[0] ?? null), error: null } : { data: structuredClone(rows), error: null };
    };
    const q = {
      select: () => { if (op === "insert") ret = true; return q; },
      eq: (k, v) => { f.push((r) => r[k] === v); return q; },
      in: (k, vs) => { f.push((r) => vs.includes(r[k])); return q; },
      is: (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; },
      order: () => q, limit: () => q,
      insert: (p) => { op = "insert"; payload = p; return q; },
      update: (p) => { op = "update"; payload = p; return q; },
      maybeSingle: () => { one = true; return q; }, single: () => { one = true; return q; },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  const rpc = async (name, a) => {
    if (name === "hire_pursuit_create") {
      t.hire_pursuits.push({ ...structuredClone(a.p_row), seq: 0 });
      t.hire_pursuit_events.push({ pursuit_id: a.p_row.id, seq: 0, ...a.p_event, from_state: null, to_state: null, effects: [] });
      return { data: a.p_row.id, error: null };
    }
    if (name === "hire_pursuit_apply") {
      const row = t.hire_pursuits.find((r) => r.id === a.p_id && r.seq === a.p_expected_seq);
      if (!row) return { data: null, error: { message: "moved since it was read" } };
      const keep = { id: row.id, job_id: row.job_id, person_id: row.person_id, employer: row.employer, source: row.source };
      Object.assign(row, structuredClone(a.p_row), keep, { seq: a.p_expected_seq + 1 });
      const { from, to, ...ev } = a.p_event;
      t.hire_pursuit_events.push({ pursuit_id: a.p_id, seq: a.p_expected_seq + 1, ...ev, from_state: from, to_state: to });
      return { data: a.p_expected_seq + 1, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  };
  return { from, rpc, t };
}

const msg = (from, at, label = null, emailId = null) => ({ from, at: T(at), label, subject: "s", body: "b", emailId });
const thread = (email, poolId, messages) => ({ id: `ae-blr:${email}`, mandate: "ae-blr", person: { email, poolId, name: "Asha Rao", linkedin: null }, messages, lastAt: messages.at(-1).at });
const MANDATES = { "ae-blr": { job_id: JOB }, spd: {} };
const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("syncOutreachPursuits", () => {
  let db;
  beforeEach(() => {
    db = fakeDb({ hire_jobs: [{ id: JOB, client: "Acme", lifecycle: "active" }] });
    threads = { "ae-blr": [thread("asha@example.com", 803, [msg("charlie", "2026-10-05T10:00:00Z", "Role outreach")])] };
  });

  it("first run imports, a second run changes nothing, a mandate with no job is skipped", async () => {
    const r1 = await syncOutreachPursuits(db, { now: NOW, mandates: MANDATES, log: () => {} });
    expect(r1.mandates["ae-blr"]).toMatchObject({ imported: 1, failed: 0 });
    expect(r1.skipped).toEqual(["spd"]);
    expect(db.t.hire_pursuits[0]).toMatchObject({ job_id: JOB, employer: "Acme", engagement: "AWAITING_REPLY", waiting_for: "INTEREST" });
    expect(db.t.hire_people[0]).toMatchObject({ email: "asha@example.com" });
    expect(db.t.hire_pursuit_events.map((e) => e.type)).toEqual(["pursuit.imported"]);
    const r2 = await syncOutreachPursuits(db, { now: NOW + 60_000, mandates: MANDATES, log: () => {} });
    expect(r2.mandates["ae-blr"]).toMatchObject({ imported: 0, unchanged: 1 });
    expect(db.t.hire_pursuit_events).toHaveLength(1);
  });

  it("a reply reconciles the saved pursuit, recording what moved", async () => {
    await syncOutreachPursuits(db, { now: NOW, mandates: MANDATES, log: () => {} });
    threads["ae-blr"][0].messages.push(msg("candidate", "2026-10-05T11:00:00Z", null, "em-1"));
    const r = await syncOutreachPursuits(db, { now: NOW + 60_000, mandates: MANDATES, log: () => {} });
    expect(r.mandates["ae-blr"]).toMatchObject({ reconciled: 1 });
    const last = db.t.hire_pursuit_events.at(-1);
    expect(last).toMatchObject({ type: "pursuit.reconciled", actor: "system", seq: 1 });
    expect(last.from_state.to_read).toBeNull();
    expect(last.to_state.to_read).toMatchObject({ ref: "em-1" });
    expect(db.t.hire_pursuits[0]).toMatchObject({ seq: 1 });
  });

  // once an agent writes a pursuit through the one engine, the email record never overwrites it
  it("a pursuit an agent wrote through the engine is never overwritten; the difference is reported", async () => {
    await syncOutreachPursuits(db, { now: NOW, mandates: MANDATES, log: () => {} });
    db.t.hire_pursuit_events.push({ id: "ev-agent", pursuit_id: db.t.hire_pursuits[0].id, seq: 1, type: "time.tick", actor: "agent", at: T("2026-10-05T12:00:00Z"), version: "x" });
    db.t.hire_pursuits[0].seq = 1;
    threads["ae-blr"][0].messages.push(msg("candidate", "2026-10-05T13:00:00Z", null, "em-2"));
    const logs = [];
    const r = await syncOutreachPursuits(db, { now: NOW + 120_000, mandates: MANDATES, log: (m) => logs.push(m) });
    expect(r.mandates["ae-blr"]).toMatchObject({ differs: 1, reconciled: 0 });
    expect(db.t.hire_pursuit_events.map((e) => e.type)).toEqual(["pursuit.imported", "time.tick"]);
    expect(db.t.hire_pursuits[0].to_read ?? null).toBeNull();
    expect(logs.join(" ")).toMatch(/not overwritten/);
  });

  it("one mandate that cannot be read never stops the others", async () => {
    db.t.hire_jobs.push({ id: "22222222-2222-2222-2222-222222222222", client: null, lifecycle: "active" });
    const r = await syncOutreachPursuits(db, { now: NOW, mandates: { broken: { job_id: "22222222-2222-2222-2222-222222222222" }, "ae-blr": { job_id: JOB } }, log: () => {} });
    expect(r.mandates.broken).toMatchObject({ failed: 1, error: expect.stringMatching(/has no client/) });
    expect(r.mandates["ae-blr"]).toMatchObject({ imported: 1 });
  });

  it("stateDiffers ignores key order and sees a real change", () => {
    const a = { engagement: "AWAITING_REPLY", ask: { id: "k", kind: "INTEREST" }, contact: { state: "PERMITTED", basis: "pool_consent" } };
    expect(stateDiffers(a, { ...a, ask: { kind: "INTEREST", id: "k" } })).toBe(false);
    expect(stateDiffers(a, { ...a, engagement: "NO_RESPONSE" })).toBe(true);
  });
});
