// resume-verdict-cache.test.mjs — a resumed batch's verdicts were paid for. Keep them.
//
// A batch that outlives its run is parked and collected by the next run (match-batch.mjs's resume
// path). Its verdicts were paid for, so they must be cached exactly like the normal path's
// (writeFreshVerdicts), or every pair is re-scored at full price the following run.
//
// The cache key cannot be recomputed on the resume side: writeFreshVerdicts derives matchCacheKey
// from the blinded dossier text, and the resume path rebuilds its users from the parked map
// (`{ email, jobId }`, no dossier), so a recomputed key would come from an EMPTY dossier and be
// permanently unreadable. The key therefore travels with the request, parked at submit time, which is
// also the only key that describes what the model actually scored.

import { describe, it, expect, vi, beforeEach } from "vitest";

const BATCH_ID = "msgbatch_parked_test";
const KEY_A = "cachekey_aaa";
const KEY_B = "cachekey_bbb";

const verdict = (score) => ({ score, verdict: "strong", why_you: "grounded", flag: null, dealbreaker_hit: false });

async function* results() {
  yield { custom_id: "u0_j0", result: { type: "succeeded", message: { content: [{ type: "text", text: JSON.stringify(verdict(88)) }], usage: { input_tokens: 20, output_tokens: 8 } } } };
  yield { custom_id: "u0_j1", result: { type: "succeeded", message: { content: [{ type: "text", text: JSON.stringify(verdict(64)) }], usage: { input_tokens: 20, output_tokens: 8 } } } };
}

const retrieveMock = vi.fn(async () => ({ id: BATCH_ID, processing_status: "ended", request_counts: { succeeded: 2, errored: 0 } }));
const createMock = vi.fn(async () => { throw new Error("the resume path must not submit a new batch"); });

vi.mock("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { batches: { create: createMock, retrieve: retrieveMock, results: vi.fn(() => results()) } }; } },
}));

const putVerdictsMock = vi.fn(async (rows) => rows.length);
const parked = {
  batchId: BATCH_ID,
  createdAt: new Date().toISOString(),
  map: [
    { custom_id: "u0_j0", email: "a@example.com", jobId: "gh:acme:1", cache_key: KEY_A },
    { custom_id: "u0_j1", email: "a@example.com", jobId: "gh:acme:2", cache_key: KEY_B },
  ],
};
let pendingPayload = parked;

vi.mock("./charlie-store.mjs", () => ({
  loadPendingBatch: vi.fn(async () => pendingPayload),
  savePendingBatch: vi.fn(async () => {}),
  clearPendingBatch: vi.fn(async () => {}),
  getVerdicts: vi.fn(async () => new Map()),
  putVerdicts: putVerdictsMock,
  pruneVerdicts: vi.fn(async () => {}),
}));

vi.mock("./select-jobs.mjs", () => ({
  tagCompanyReach: () => 0,
  personBlob: () => "person",
  selectForUser: (_d, jobs) => ({ jobs, stats: { in: jobs.length, kept: jobs.length, taken: jobs.length, region: "india", unreachable: 0, ineligible: 0, families: ["eng"] } }),
}));

const { runMatchBatch } = await import("./match-batch.mjs");

const USERS = [{ email: "a@example.com", dossier: { headline: "Engineer", strengths: ["Go"], proof_points: ["shipped x"] }, dossierText: "{}" }];
const JOBS = [
  { id: "gh:acme:1", company: "Acme", title: "Backend Engineer", description: "Go", location: "Remote", apply_url: "https://x/1" },
  { id: "gh:acme:2", company: "Acme", title: "Platform Engineer", description: "Go", location: "Remote", apply_url: "https://x/2" },
];

beforeEach(() => { putVerdictsMock.mockClear(); pendingPayload = parked; });

describe("a collected parked batch writes its verdicts back to the cache", () => {
  it("stores one row per cacheable verdict — this is what failed before the fix", async () => {
    const out = await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(out.resumed).toBe(true);
    expect(putVerdictsMock).toHaveBeenCalledTimes(1);
    expect(putVerdictsMock.mock.calls[0][0]).toHaveLength(2);
  });

  it("files each verdict under the key PARKED with its request, not a recomputed one", async () => {
    // The correctness point. The parked key describes the inputs the model actually scored; a key
    // recomputed on this side would describe today's dossier, which may have changed since.
    await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    const rows = putVerdictsMock.mock.calls[0][0];
    expect(rows.map((r) => r.cache_key).sort()).toEqual([KEY_A, KEY_B]);
    expect(rows.every((r) => r.email === "a@example.com")).toBe(true);
    expect(rows.find((r) => r.cache_key === KEY_A).output.score).toBe(88);
    expect(rows.find((r) => r.cache_key === KEY_B).output.score).toBe(64);
  });

  it("does not submit a second batch while collecting", async () => {
    await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("it fails soft in every direction — the worst case is the old behaviour", () => {
  it("a payload parked without a cache_key writes nothing", async () => {
    pendingPayload = { ...parked, map: parked.map.map(({ cache_key: _k, ...rest }) => rest) };
    const out = await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(out.resumed).toBe(true);            // still collects the results
    expect(putVerdictsMock).not.toHaveBeenCalled(); // just does not cache them
  });

  it("a null cache_key (MATCH_CACHE was off at submit time) writes nothing", async () => {
    pendingPayload = { ...parked, map: parked.map.map((e) => ({ ...e, cache_key: null })) };
    await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(putVerdictsMock).not.toHaveBeenCalled();
  });

  it("a cache write failure never breaks the collection", async () => {
    putVerdictsMock.mockRejectedValueOnce(new Error("supabase down"));
    const out = await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(out.resumed).toBe(true);
    expect(out.byEmail.get("a@example.com")).toHaveLength(2);
  });
});

describe("the submit path parks the key so the resume path can use it", () => {
  it("every parked request carries a cache_key field", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./match-batch.mjs", import.meta.url), "utf8");
    // The park payload must carry the key; without it the resume path is blind again.
    expect(src).toMatch(/cache_key: keyGrid\?\.\[ui\]\?\.\[ji\] \?\? null/);
  });
});
