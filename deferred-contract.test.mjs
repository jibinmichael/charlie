// deferred-contract.test.mjs — "not scored yet" must never be reported as "nothing cleared your bar".
//
// When a match batch is still `in_progress` at the API, runMatchBatch returns an EMPTY byEmail with
// `deferred: true`. scheduler.mjs must honour that flag: if it fell through the send loop instead, every
// user would be logged "nothing above the bar", KPIs would read 0%, and a silent-no-send alert would
// fire, all describing a matching collapse that did not happen. Nothing has been scored yet.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// --- a parked batch that has NOT finished -------------------------------------------------------
const retrieveMock = vi.fn(async () => ({ id: "msgbatch_parked", processing_status: "in_progress", request_counts: { processing: 300, succeeded: 0, errored: 0 } }));
const createMock = vi.fn(async () => { throw new Error("a second batch must never be submitted while one is parked"); });

vi.mock("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { batches: { create: createMock, retrieve: retrieveMock, results: vi.fn() } }; } },
}));

vi.mock("./charlie-store.mjs", () => ({
  loadPendingBatch: vi.fn(async () => ({ batchId: "msgbatch_parked", createdAt: new Date().toISOString(), map: [] })),
  savePendingBatch: vi.fn(async () => {}),
  clearPendingBatch: vi.fn(async () => {}),
  getVerdicts: vi.fn(async () => new Map()),
  putVerdicts: vi.fn(async () => {}),
  pruneVerdicts: vi.fn(async () => {}),
}));

vi.mock("./select-jobs.mjs", () => ({
  tagCompanyReach: () => 0,
  personBlob: () => "person",
  selectForUser: (_d, jobs) => ({ jobs, stats: { in: jobs.length, kept: jobs.length, taken: jobs.length, region: "india", unreachable: 0, ineligible: 0, families: ["eng"] } }),
}));

const { runMatchBatch } = await import("./match-batch.mjs");

const USERS = [{ email: "a@example.com", dossier: { headline: "Engineer", strengths: ["Go"], proof_points: ["shipped x"] }, dossierText: "{}" }];
const JOBS = [{ id: "gh:acme:1", company: "Acme", title: "Backend Engineer", description: "Go", location: "Remote", apply_url: "https://x/1" }];

describe("runMatchBatch — a parked, unfinished batch", () => {
  it("reports deferred, and an EMPTY result rather than a set of zero scores", async () => {
    const out = await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(out.deferred).toBe(true);
    expect(out.byEmail.size).toBe(0);
    expect(out.cost).toBe(0);
  });

  it("does not submit a second batch while one is parked", async () => {
    await runMatchBatch({ matcherPrompt: "rubric", users: USERS, jobs: JOBS, log: () => {} });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("scheduler — it must READ the flag it is handed", () => {
  // A source assertion, and here is why it has to be. scheduler.mjs is a top-level script whose main()
  // opens Resend, reads the live candidate table and walks the real send path; driving it in-process to
  // observe "no user was logged below the bar" would mean mocking a dozen modules and would assert on
  // the mocks rather than the behaviour. The guard is one destructure and one early return, both
  // properties of the text. The behaviour they produce is asserted above, on the function that hands
  // the flag over.
  const src = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it("destructures `deferred` off the match result", () => {
    expect(code).toMatch(/deferred:\s*matchDeferred/);
  });

  it("returns before the per-user loop when the batch has not finished", () => {
    const guard = code.indexOf("if (matchDeferred)");
    const loop = code.indexOf("for (const u of users)");
    expect(guard).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(loop);
    // and the guard body actually returns, rather than merely logging
    expect(code.slice(guard, loop)).toMatch(/\breturn;/);
  });

  it("reports a deferred run to Sentry — a run that scores nobody is a real event", () => {
    expect(code).toMatch(/kind: "match_deferred"/);
  });

  it("does not ping the match_send heartbeat on a deferred run", () => {
    // The heartbeat means "the match -> gate -> compose -> send batch completed cleanly". A deferred
    // run did not. Staying silent is what lets an external monitor notice a batch that never lands.
    const guard = code.indexOf("if (matchDeferred)");
    const beat = code.indexOf('pingHeartbeat("match_send")');
    expect(guard, "no deferred guard at all").toBeGreaterThan(-1);   // else the compare below is vacuous
    expect(beat, "no match_send heartbeat at all").toBeGreaterThan(-1);
    expect(beat).toBeGreaterThan(guard);
  });
});
