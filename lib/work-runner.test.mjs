// lib/work-runner.test.mjs — the work queue's pass and its store, against an in-memory queue that keeps the claim
// function's rules (lease, attempts, run_after, one worker per row). No database, no network.
import { describe, it, expect } from "vitest";
import { runOnce, nextPauseMs } from "./work-runner.mjs";
import { backoffSeconds, workRow, workStore } from "./work-store.mjs";

/** An in-memory queue with the same contract as lib/work-store.mjs over hire_work + hire_work_claim. */
function memQueue(rows = []) {
  let clock = Date.parse("2026-10-09T10:00:00Z");
  const q = rows.map((r, i) => ({ id: `w${i + 1}`, status: "pending", attempts: 0, max_attempts: 5, run_after: clock, leased_by: null, lease_until: null, payload: {}, ...r }));
  return {
    q, tick: (ms) => (clock += ms), now: () => clock,
    isMissing: () => false,
    async reap({ at }) { let n = 0; for (const r of q) if (r.status === "running" && r.lease_until < at && r.attempts >= r.max_attempts) { r.status = "failed"; n++; } return n; },
    async claim({ kind, limit, worker, leaseSeconds }) {
      const ok = q.filter((r) => r.kind === kind && r.attempts < r.max_attempts && ((r.status === "pending" && r.run_after <= clock) || (r.status === "running" && r.lease_until < clock))).slice(0, limit);
      for (const r of ok) Object.assign(r, { status: "running", leased_by: worker, lease_until: clock + leaseSeconds * 1000, attempts: r.attempts + 1 });
      return ok.map((r) => ({ ...r }));
    },
    async complete({ id, worker, result }) { const r = q.find((x) => x.id === id); if (!r || r.leased_by !== worker || r.status !== "running") return false; Object.assign(r, { status: "done", result }); return true; },
    async fail({ id, worker, error, attempts, maxAttempts, at }) {
      const r = q.find((x) => x.id === id); if (!r || r.leased_by !== worker || r.status !== "running") return { landed: false, final: false };
      const final = attempts >= maxAttempts;
      Object.assign(r, final ? { status: "failed", last_error: error } : { status: "pending", leased_by: null, last_error: error, run_after: at + backoffSeconds(attempts) * 1000 });
      return { landed: true, final };
    },
  };
}
const ok = (fn) => ({ concurrency: 2, leaseSeconds: 60, handle: fn });

describe("one pass", () => {
  it("runs each claimed row and marks it done with its result", async () => {
    const m = memQueue([{ kind: "a", key: "a:1", payload: { n: 1 } }, { kind: "a", key: "a:2", payload: { n: 2 } }]);
    const out = await runOnce({ store: m, handlers: { a: ok(async (p) => ({ twice: p.n * 2 })) }, worker: "w1", at: m.now });
    expect(out).toMatchObject({ claimed: 2, done: 2, failed: 0, retried: 0 });
    expect(m.q.map((r) => [r.status, r.result?.twice])).toEqual([["done", 2], ["done", 4]]);
  });

  it("isolates every row: one throws and is retried after its backoff; the other is done", async () => {
    const m = memQueue([{ kind: "a", key: "a:bad" }, { kind: "a", key: "a:good" }]);
    const out = await runOnce({ store: m, handlers: { a: ok(async (_p, { row }) => { if (row.key === "a:bad") throw new Error("boom"); return 1; }) }, worker: "w1", at: m.now });
    expect(out).toMatchObject({ done: 1, retried: 1, failed: 0 });
    const bad = m.q.find((r) => r.key === "a:bad");
    expect(bad).toMatchObject({ status: "pending", last_error: "boom", run_after: m.now() + 30_000 });
    // not claimable before its backoff, claimable after
    expect((await runOnce({ store: m, handlers: { a: ok(async () => 1) }, worker: "w1", at: m.now })).claimed).toBe(0);
    m.tick(30_000);
    expect((await runOnce({ store: m, handlers: { a: ok(async () => 1) }, worker: "w1", at: m.now })).done).toBe(1);
  });

  it("fails a row for good on its last attempt, and never claims it again", async () => {
    const m = memQueue([{ kind: "a", key: "a:x", max_attempts: 2 }]);
    const h = { a: ok(async () => { throw new Error("always"); }) };
    await runOnce({ store: m, handlers: h, worker: "w1", at: m.now });
    m.tick(3_600_000);
    const out = await runOnce({ store: m, handlers: h, worker: "w1", at: m.now });
    expect(out.failed).toBe(1);
    expect(m.q[0]).toMatchObject({ status: "failed", attempts: 2 });
    m.tick(3_600_000);
    expect((await runOnce({ store: m, handlers: h, worker: "w1", at: m.now })).claimed).toBe(0);
  });

  it("a row whose worker died is claimed again after its lease; on its last attempt it is reaped as failed", async () => {
    const m = memQueue([{ kind: "a", key: "a:1", max_attempts: 2 }]);
    await m.claim({ kind: "a", limit: 1, worker: "dead", leaseSeconds: 60 });   // a worker took it and vanished
    expect((await runOnce({ store: m, handlers: { a: ok(async () => 1) }, worker: "w2", at: m.now })).claimed).toBe(0);
    m.tick(61_000);
    await m.claim({ kind: "a", limit: 1, worker: "dead2", leaseSeconds: 60 });  // the second attempt also vanished
    m.tick(61_000);
    const out = await runOnce({ store: m, handlers: { a: ok(async () => 1) }, worker: "w3", at: m.now });
    expect(out.reaped).toBe(1);
    expect(m.q[0].status).toBe("failed");
  });

  it("a step that outlived its lease cannot write over the worker that took over", async () => {
    const m = memQueue([{ kind: "a", key: "a:1" }]);
    const [row] = await m.claim({ kind: "a", limit: 1, worker: "slow", leaseSeconds: 60 });
    m.tick(61_000);
    await m.claim({ kind: "a", limit: 1, worker: "fast", leaseSeconds: 60 });
    expect(await m.complete({ id: row.id, worker: "slow", result: "late" })).toBe(false);
    expect(m.q[0]).toMatchObject({ status: "running", leased_by: "fast" });
  });

  it("a step that runs past most of its lease is stopped as a failure, not left to be worked twice", async () => {
    const m = memQueue([{ kind: "a", key: "a:1" }]);
    const out = await runOnce({ store: m, handlers: { a: { concurrency: 1, leaseSeconds: 0.05, handle: () => new Promise(() => {}) } }, worker: "w1", at: m.now });
    expect(out.retried).toBe(1);
    expect(m.q[0].last_error).toMatch(/ran past its time/);
  }, 20_000);

  it("a kind whose claim fails is skipped and named; the other kinds still run", async () => {
    const m = memQueue([{ kind: "b", key: "b:1" }]);
    const broken = { ...m, claim: async ({ kind }) => { if (kind === "a") throw new Error("relation hire_work does not exist"); return m.claim({ kind, limit: 1, worker: "w1", leaseSeconds: 60 }); }, isMissing: () => true };
    const logs = [];
    const out = await runOnce({ store: broken, handlers: { a: ok(async () => 1), b: ok(async () => 1) }, worker: "w1", at: m.now, log: (s) => logs.push(s) });
    expect(out.skipped).toEqual(["a"]);
    expect(out.done).toBe(1);
    expect(logs.join("\n")).toMatch(/not there yet/);
  });
});

describe("the store", () => {
  it("backs off 30s, doubling, at most an hour", () => {
    expect([1, 2, 3, 8, 20].map(backoffSeconds)).toEqual([30, 60, 120, 3600, 3600]);
  });
  it("refuses a row without a kind or a key, or with a payload that is not an object", () => {
    expect(() => workRow({ kind: "", key: "k:1" })).toThrow(/kind/);
    expect(() => workRow({ kind: "a.b", key: "" })).toThrow(/key/);
    expect(() => workRow({ kind: "a.b", key: "k:1", payload: [1] })).toThrow(/payload/);
    expect(workRow({ kind: "a.b", key: "k:1", max_attempts: 99 })).toMatchObject({ max_attempts: 20, company: null, payload: {} });
  });
  it("enqueues idempotently by key, claims through the claim function, and completes only under its own lease", async () => {
    const calls = [];
    const chain = (table) => {
      const st = { table, ops: [] };
      const api = new Proxy({}, { get: (_t, op) => (op === "then" ? (res) => res({ data: op === "then" && st.ops.some((o) => o[0] === "select") ? [{ id: "x" }] : [], error: null }) : (...args) => { st.ops.push([op, ...args]); return api; }) });
      calls.push(st);
      return api;
    };
    const db = { from: chain, rpc: async (name, args) => { calls.push({ rpc: name, args }); return { data: [{ id: "r1" }], error: null }; } };
    const s = workStore(db);
    expect(await s.enqueue([{ kind: "a.b", key: "k:1" }])).toBe(1);
    expect(calls[0].ops[0]).toEqual(["upsert", [{ kind: "a.b", key: "k:1", payload: {}, company: null, max_attempts: 5 }], { onConflict: "key", ignoreDuplicates: true }]);
    expect(await s.claim({ kind: "a.b", limit: 3, worker: "w", leaseSeconds: 60 })).toEqual([{ id: "r1" }]);
    expect(calls[1]).toEqual({ rpc: "hire_work_claim", args: { p_kind: "a.b", p_limit: 3, p_worker: "w", p_lease_seconds: 60 } });
    await s.complete({ id: "r1", worker: "w", result: { ok: 1 } });
    const done = calls[2].ops;
    expect(done.find((o) => o[0] === "update")[1]).toMatchObject({ status: "done", result: { ok: 1 } });
    expect(done.filter((o) => o[0] === "eq").map((o) => o.slice(1))).toEqual([["id", "r1"], ["leased_by", "w"], ["status", "running"]]);
  });
  it("records a failure only under its own lease: a retry with its backoff, or failed for good on the last attempt", async () => {
    const ops = [];
    const chain = () => { const st = []; ops.push(st); const api = new Proxy({}, { get: (_t, op) => (op === "then" ? (res) => res({ data: [{ id: "r1" }], error: null }) : (...args) => { st.push([op, ...args]); return api; }) }); return api; };
    const s = workStore({ from: chain });
    const at = Date.parse("2026-10-09T10:00:00Z");
    expect(await s.fail({ id: "r1", worker: "w", error: "boom", attempts: 2, maxAttempts: 5, at })).toEqual({ landed: true, final: false });
    expect(ops[0].find((o) => o[0] === "update")[1]).toMatchObject({ status: "pending", leased_by: null, last_error: "boom", run_after: new Date(at + 60_000).toISOString() });
    expect(ops[0].filter((o) => o[0] === "eq").map((o) => o.slice(1))).toEqual([["id", "r1"], ["leased_by", "w"], ["status", "running"]]);
    expect(await s.fail({ id: "r1", worker: "w", error: "boom", attempts: 5, maxAttempts: 5, at })).toEqual({ landed: true, final: true });
    expect(ops[1].find((o) => o[0] === "update")[1]).toMatchObject({ status: "failed" });
  });
});

// at volume the worker cannot rest between passes while there is work: a pass that claimed rows is
// followed at once by the next; only an empty pass waits
describe("the pause between passes", () => {
  it("is none after a pass that claimed work, the idle wait after an empty or failed pass", () => {
    expect(nextPauseMs({ claimed: 4 }, 5000)).toBe(0);
    expect(nextPauseMs({ claimed: 0 }, 5000)).toBe(5000);
    expect(nextPauseMs(null, 5000)).toBe(5000);
  });
});
