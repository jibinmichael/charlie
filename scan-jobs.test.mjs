// scan-jobs.test.mjs — tests for the board scanner: Workable multi-location ids, 429 retry, and
// Retry-After compliance.
//
// A Workable multi-location role ships as SEPARATE feed rows that share ONE shortcode. The scan's
// normalize() builds the id as `workable:<slug>:<jobId>` and byId.set() dedupes within a run, so a
// bare shortcode id would collapse every city to ONE role (the last seen). extractWorkable suffixes
// the id with a stable per-city key so each city survives.

import { describe, it, expect, afterEach } from "vitest";
import { extractWorkable, fetchBoard } from "./scan-jobs.mjs";

const mk = (shortcode, city, extra = {}) => ({
  shortcode,
  title: "Business Development Executive",
  city,
  country: "India",
  published_on: "2026-07-01",
  description: "<p>Sell things.</p>",
  application_url: `https://apply.workable.com/apna/j/${shortcode}/`,
  ...extra,
});

describe("extractWorkable — id-collision fix", () => {
  it("gives four cities sharing one shortcode four distinct ids", () => {
    const cities = ["Chandigarh", "Kolkata", "Bhubaneswar", "Lucknow"];
    const ids = cities.map((c) => extractWorkable(mk("E0A805A13F", c)).jobId);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain("E0A805A13F-chandigarh");
    expect(ids).toContain("E0A805A13F-kolkata");
  });

  it("is stable across runs for the same shortcode + city", () => {
    expect(extractWorkable(mk("ABC123", "Bengaluru")).jobId)
      .toBe(extractWorkable(mk("ABC123", "Bengaluru")).jobId);
  });

  it("normalizes messy city strings to a clean, stable suffix", () => {
    expect(extractWorkable(mk("Z9", "New Delhi")).jobId).toBe("Z9-new-delhi");
  });

  it("falls back to the bare shortcode when the role names no city (e.g. remote)", () => {
    const job = { shortcode: "REMOTE1", title: "Staff Engineer", published_on: "2026-07-01", telecommuting: true };
    expect(extractWorkable(job).jobId).toBe("REMOTE1");
  });

  it("reads the city from the locations[] array when top-level city is absent", () => {
    const job = mk("LOC1", undefined, { city: undefined, locations: [{ city: "Pune", region: "Maharashtra", country: "India" }] });
    expect(extractWorkable(job).jobId).toBe("LOC1-pune");
  });

  it("still returns the real posted date and apply url (no regression to other fields)", () => {
    const ex = extractWorkable(mk("K1", "Kolkata"));
    expect(ex.posted_at).toBe("2026-07-01");
    expect(ex.apply_url).toContain("/K1/");
    expect(ex.location).toBe("Kolkata, India");
  });
});

// ── 429 retry + the notfound/rateLimited split ─────────────────────────────────────────────────
// A 429 must be retried, and a 429 that never clears must be booked as rateLimited, not notfound:
// "the host throttled us" and "no such board" are different health signals.
describe("fetchBoard — rate-limit handling", () => {
  const entry = { company: "Apna", slug: "apna", source: "workable" };
  const okBody = { jobs: [{ shortcode: "A1", title: "BDE", city: "Pune", country: "India" }] };
  const res = (status, body = {}, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  const stub = (queue) => {
    let i = 0;
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(url); return queue[Math.min(i++, queue.length - 1)]; };
    return calls;
  };
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("retries a 429 and succeeds when the host relents", async () => {
    const calls = stub([res(429), res(429), res(200, okBody)]);
    const r = await fetchBoard(entry, { baseMs: 1 });
    expect(r.ok).toBe(true);
    expect(r.jobs).toHaveLength(1);
    expect(calls).toHaveLength(3); // proves it actually retried
  });

  it("gives up after the retry budget and reports rateLimited, NOT a bare not-found", async () => {
    const calls = stub([res(429)]);
    const r = await fetchBoard(entry, { retries: 2, baseMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);              // the flag main() counts separately
    expect(r.reason).toMatch(/rate limited/i);      // and it says so in the health record
    expect(calls).toHaveLength(3);                  // 1 initial + 2 retries
  });

  it("does NOT retry a genuine 404 — one request, and never flagged rateLimited", async () => {
    const calls = stub([res(404)]);
    const r = await fetchBoard(entry, { baseMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("HTTP 404");
    expect(r.rateLimited).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("retries a 503 the same way", async () => {
    const calls = stub([res(503), res(200, okBody)]);
    const r = await fetchBoard(entry, { baseMs: 1 });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("abandons a hostile Retry-After immediately, so one board cannot stall the scan", async () => {
    // An unaffordable ask (99999s) returns in ONE request having waited nothing: a host demanding
    // that does not relent 50ms later, so clamping and retrying only wastes requests. One board
    // still cannot stall the scan.
    stub([res(429, {}, { "retry-after": "99999" }), res(200, okBody)]);
    const t0 = Date.now();
    const r = await fetchBoard(entry, { baseMs: 1, maxWaitMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500); // still the point: no stalling, ever
  });
});

// ── Retry-After compliance ─────────────────────────────────────────────────────────────────────
// An explicit Retry-After ask is honoured at face value up to a total per-board budget. Clamping it
// (e.g. to 8s) guarantees failure: the host is knocked on again before it asked, answers 429 every
// time, and the board is written off having never waited. maxWaitMs governs only our own invented
// backoff.
describe("fetchBoard — Retry-After compliance", () => {
  const entry = { company: "Apna", slug: "apna", source: "workable" };
  const okBody = { jobs: [{ shortcode: "A1", title: "BDE", city: "Pune", country: "India" }] };
  const res = (status, body = {}, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  const stub = (queue) => {
    let i = 0;
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(url); return queue[Math.min(i++, queue.length - 1)]; };
    return calls;
  };
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("stops immediately when the host asks for longer than the budget, instead of burning retries", async () => {
    // A 60s ask is read at face value, seen to exceed the budget, and the board is given up on in ONE
    // request: no waiting, no wasted attempts, and the reason says what was actually asked for.
    const calls = stub([res(429, {}, { "retry-after": "60" })]);
    const r = await fetchBoard(entry, { baseMs: 1, budgetMs: 30000 });
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(calls).toHaveLength(1);                     // one request, no retries
    expect(r.reason).toMatch(/host asked 60s/);        // the reason carries the asked-for wait
    expect(r.reason).toMatch(/over 30s budget/);
  });

  it("honours an explicit Retry-After that fits the budget, and recovers", async () => {
    // 1s is inside the budget, so it waits the full ask and the board comes back.
    const calls = stub([res(429, {}, { "retry-after": "1" }), res(200, okBody)]);
    const r = await fetchBoard(entry, { baseMs: 1, budgetMs: 30000 });
    expect(r.ok).toBe(true);
    expect(r.jobs).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("still caps OUR OWN backoff when the host names no Retry-After", async () => {
    // maxWaitMs keeps its original job. Without a stated ask there is nothing to honour, so the
    // invented wait must stay bounded — otherwise exponential backoff runs away on a silent 429.
    const calls = stub([res(429), res(429), res(200, okBody)]);
    const r = await fetchBoard(entry, { baseMs: 1, maxWaitMs: 5, budgetMs: 30000 });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("keeps the budget as a real ceiling across repeated asks", async () => {
    // Three 1s asks against a 2s budget: two are affordable, the third is not. Proves the budget is
    // cumulative, not per-attempt — otherwise a host could hold one board forever in 1s increments.
    // (Real waits, so the numbers are kept small enough to stay inside the default test timeout.)
    const calls = stub([res(429, {}, { "retry-after": "1" })]);
    const r = await fetchBoard(entry, { baseMs: 1, retries: 9, budgetMs: 2000 });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(3); // waited 1s + 1s = 2s, a third ask would breach the 2s budget
    expect(r.reason).toMatch(/over 2s budget/);
  });
});
