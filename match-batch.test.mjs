// match-batch.test.mjs — regression guard for runMatchBatch.
//
// scheduler.mjs awaits runMatchBatch with no try/catch, so anything that throws while building
// requests (before the batch is submitted) aborts the daily pipeline. This test drives the
// request-building loop + batch lifecycle end to end with the Anthropic SDK and the pre-filter
// mocked, so the "runMatchBatch throws before submit" class cannot regress silently.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the Anthropic Batches SDK: submit -> ended immediately -> one succeeded, scored result ---
const createMock = vi.fn(async ({ requests }) => ({
  id: "batch_test",
  processing_status: "ended",
  request_counts: { total: requests.length, succeeded: requests.length, errored: 0 },
}));
const retrieveMock = vi.fn(async () => ({ id: "batch_test", processing_status: "ended", request_counts: {} }));
async function* fakeResults() {
  yield {
    custom_id: "u0_j0",
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "text", text: JSON.stringify({ score: 88, verdict: "strong", why_you: "grounded reason", flag: null, dealbreaker_hit: false }) }],
        usage: { input_tokens: 20, output_tokens: 8 },
      },
    },
  };
}
const resultsMock = vi.fn(() => fakeResults());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      this.messages = { batches: { create: createMock, retrieve: retrieveMock, results: resultsMock } };
    }
  },
}));

// --- Mock the deterministic pre-filter so a job survives without coupling to family/region internals.
// The request builder is what is under test; all it needs is >=1 selected job per user.
vi.mock("./select-jobs.mjs", () => ({
  tagCompanyReach: () => 0,
  selectForUser: (_dossier, jobs) => ({
    jobs,
    stats: { in: jobs.length, kept: jobs.length, taken: jobs.length, region: "us", unreachable: 0, ineligible: 0, families: ["eng"] },
  }),
}));

const { runMatchBatch, pendingBatchAction, capacityWarnings } = await import("./match-batch.mjs");

const validDossier = {
  name: "Test User",
  headline: "Software Engineer",
  narrative: "Builds backend services.",
  proof_points: [],
  case_studies: [],
  strengths: [],
  gaps: [],
  preferences: {},
};
const job = {
  id: "gh-acme-42",
  title: "Senior Software Engineer",
  company: "Acme",
  location: "Remote (US)",
  description: "Build and scale backend systems in Node.",
  url: "https://boards.greenhouse.io/acme/jobs/42",
  source: "greenhouse",
  posted_at: "2026-07-10",
};

describe("runMatchBatch", () => {
  beforeEach(() => {
    createMock.mockClear();
    resultsMock.mockClear();
  });

  it("builds requests and completes without throwing", async () => {
    const result = await runMatchBatch({
      matcherPrompt: "You are the matcher rubric.",
      users: [{ email: "user@example.com", dossier: validDossier, dossierText: JSON.stringify(validDossier) }],
      jobs: [job],
      log: () => {},
    });

    // The loop ran to completion and a batch was submitted.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.requestCount).toBe(1);

    // Each built request carries the scoring messages (proving `...scoring` was spread, not `messages`).
    const submitted = createMock.mock.calls[0][0];
    expect(submitted.requests).toHaveLength(1);
    expect(submitted.requests[0].params.messages?.[0]?.content).toBeTruthy();

    // The result mapped back to the user and cleared the bar.
    const scored = result.byEmail.get("user@example.com");
    expect(scored).toHaveLength(1);
    expect(scored[0].match.score).toBe(88);
    expect(scored[0].passed_bar).toBe(true);
  });

  it("returns empty (no throw) when a user has no selected jobs", async () => {
    const result = await runMatchBatch({
      matcherPrompt: "rubric",
      users: [{ email: "empty@example.com", dossier: validDossier, dossierText: JSON.stringify(validDossier) }],
      jobs: [],
      log: () => {},
    });
    expect(result.requestCount).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ── Parked-batch policy ───────────────────────────────────────────────────────────────────────
// scheduler.mjs sits inside engine:run's `&&` chain, so a throw on a slow batch would abort digest
// + newsletter too — and Anthropic documents a slow batch as NORMAL ("most complete within 1 hour;
// maximum 24 hours"). A slow batch is therefore parked and collected on the next run: the send is
// DELAYED, not cancelled, and we never pay twice for scoring already bought.
describe("pendingBatchAction", () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse("2026-07-20T12:00:00Z");
  const parked = (hoursAgo) => ({ batchId: "msgbatch_x", createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(), map: [] });

  it("nothing parked → discard (the normal path: run a fresh batch)", () => {
    expect(pendingBatchAction(null, null, NOW)).toBe("discard");
    expect(pendingBatchAction({ createdAt: "x" }, null, NOW)).toBe("discard"); // no batchId
  });

  it("parked and ENDED → collect (reuse the scoring we already paid for)", () => {
    expect(pendingBatchAction(parked(6), { processing_status: "ended" }, NOW)).toBe("collect");
  });

  it("still in_progress and young → wait (leave parked; do NOT start a second batch)", () => {
    expect(pendingBatchAction(parked(6), { processing_status: "in_progress" }, NOW)).toBe("wait");
  });

  // Past Anthropic's documented 24h ceiling it will never produce results, and holding the slot would
  // starve every future run — the parked batch would block sends indefinitely.
  it("in_progress past the 24h ceiling → discard, so it can never starve later runs", () => {
    expect(pendingBatchAction(parked(27), { processing_status: "in_progress" }, NOW)).toBe("discard");
    expect(pendingBatchAction(parked(25), { processing_status: "in_progress" }, NOW)).toBe("wait"); // inside the 26h margin
  });

  it("unreadable status (deleted/expired/network) → discard, never block the day on it", () => {
    expect(pendingBatchAction(parked(2), null, NOW)).toBe("discard");
  });

  it("an unparseable or missing createdAt → discard (don't wait on a timestamp we can't trust)", () => {
    expect(pendingBatchAction({ batchId: "b", createdAt: "not-a-date", map: [] }, { processing_status: "in_progress" }, NOW)).toBe("discard");
    expect(pendingBatchAction({ batchId: "b", map: [] }, { processing_status: "in_progress" }, NOW)).toBe("discard");
  });

  // canceled/expired are terminal but NOT "ended" — never collectable, never worth waiting on.
  it("canceled or expired → discard", () => {
    expect(pendingBatchAction(parked(1), { processing_status: "canceled" }, NOW)).toBe("discard");
    expect(pendingBatchAction(parked(1), { processing_status: "expired" }, NOW)).toBe("discard");
  });

  // Every slow-batch case must resolve to a state that keeps the engine:run chain alive.
  it("a slow batch never throws and never cancels the day", () => {
    for (const h of [1, 5, 12, 23]) {
      expect(() => pendingBatchAction(parked(h), { processing_status: "in_progress" }, NOW)).not.toThrow();
      expect(["wait", "collect"]).toContain(pendingBatchAction(parked(h), { processing_status: "in_progress" }, NOW));
    }
  });
});

// A run that crosses the cost ceiling aborts and nobody gets a role email that day, so the operator
// needs a warning before the ceiling fires. These lock the warning in: it must fire BELOW the ceiling (that is the entire point), must stay quiet
// in normal operation, and must never be mistaken for the abort decision itself.
describe("capacityWarnings", () => {
  const caps = { maxBatchRequests: 5000, maxRunCostUsd: 25 };

  it("says nothing when there is real headroom", () => {
    expect(capacityWarnings({ requestCount: 1000, estCost: 5, caps })).toEqual([]);
  });

  // $22.69 of a $25 ceiling must warn. (The request count is held well clear of its own threshold so this asserts the cost path alone: the KPI history's
  // `scored` counter is not the batch request count, and this test must not quietly assume it is.)
  it("warns BEFORE the ceiling fires ($22.69 of $25)", () => {
    const w = capacityWarnings({ requestCount: 1000, estCost: 22.69, caps });
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/91% of MAX_RUN_COST_USD/);
  });

  it("warns on the request ceiling independently of cost", () => {
    const w = capacityWarnings({ requestCount: 4500, estCost: 1, caps });
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/90% of MAX_BATCH_REQUESTS/);
  });

  it("reports both when both are close", () => {
    expect(capacityWarnings({ requestCount: 4500, estCost: 24, caps }).length).toBe(2);
  });

  // It observes; it does not decide. Over the ceiling it still only returns strings — the hard caps in
  // runMatchBatch own the abort, and this must never become a second, softer gate.
  it("over the ceiling it still only reports — it never throws or signals abort", () => {
    const w = capacityWarnings({ requestCount: 8123, estCost: 26.12, caps });
    expect(() => capacityWarnings({ requestCount: 8123, estCost: 26.12, caps })).not.toThrow();
    expect(w.every((x) => typeof x === "string")).toBe(true);
  });

  // A bogus percentage from a missing cap would train the reader to ignore the real alarm.
  it("stays silent when a cap is missing or nonsensical", () => {
    expect(capacityWarnings({ requestCount: 9e9, estCost: 9e9, caps: {} })).toEqual([]);
    expect(capacityWarnings({ requestCount: 9e9, estCost: 9e9, caps: { maxBatchRequests: 0, maxRunCostUsd: -1 } })).toEqual([]);
  });
});

// ── the constrained-decode precondition, made readable ────────────────────────────────────────
// "A shadow batch shows syntax drops -> 0" is the precondition for flipping MATCH_CONSTRAINED_DECODE=on.
// A count that only exists in a log line ages out before anyone reads it, so runMatchBatch RETURNS
// the counts and scheduler.mjs persists them in the daily kpi.json snapshot.
describe("runMatchBatch reports the decode drop counts", () => {
  beforeEach(() => {
    createMock.mockClear();
    resultsMock.mockClear();
  });

  it("returns NUMERIC drop counts when a batch actually ran", async () => {
    const result = await runMatchBatch({
      matcherPrompt: "You are the matcher rubric.",
      users: [{ email: "user@example.com", dossier: validDossier, dossierText: JSON.stringify(validDossier) }],
      jobs: [job],
      log: () => {},
    });
    // The fixture reply is valid JSON and schema-valid, so a clean batch is 0 of each — and 0 here is
    // a MEASUREMENT, which is exactly the evidence the flip needs.
    expect(result.syntaxDrops).toBe(0);
    expect(result.semanticSkips).toBe(0);
    expect(typeof result.constrained).toBe("boolean");
  });

  // The load-bearing one. On a day where no batch is submitted (nothing to score, or a 100% verdict
  // cache hit) the counts must be NULL. Reporting 0 would manufacture "a clean batch ran" out of a
  // quiet day and hand a flip decision false evidence — the fail-closed-becomes-fail-to-zero shape,
  // in a metric rather than a gate.
  it("returns NULL, not 0, when no batch ran at all", async () => {
    const result = await runMatchBatch({
      matcherPrompt: "rubric",
      users: [{ email: "empty@example.com", dossier: validDossier, dossierText: JSON.stringify(validDossier) }],
      jobs: [],
      log: () => {},
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(result.syntaxDrops).toBeNull();
    expect(result.semanticSkips).toBeNull();
    expect(result.syntaxDrops).not.toBe(0); // states the distinction the whole test exists for
  });
});

// ── The pre-filter cap, and why it is 300 ────────────────────────────────────────────────────────
//
// K is the single number that decides how much of the market a person is ever compared against. The
// retrieval-rank instrument shows roles that CLEAR the bar being found right up to rank ~150, so a cap
// of 150 is binding: lowering K buys money with recall. A service-level override that silently
// disagrees with the code default is the failure to avoid.
describe("MAX_JOBS_PER_USER — the cap has a derivation, and it is 300", () => {
  it("defaults to 300, not 150", async () => {
    const { DEFAULT_CAPS } = await import("./match-batch.mjs");
    expect(DEFAULT_CAPS.maxJobsPerUser).toBe(300);
  });

  it("the constant carries its reasoning, not a bare number", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./match-batch.mjs", import.meta.url), "utf8");
    const decl = src.slice(src.indexOf("export const DEFAULT_CAPS"));
    const preamble = src.slice(Math.max(0, src.indexOf("export const DEFAULT_CAPS") - 1400), src.indexOf("maxJobsPerUser", src.indexOf("export const DEFAULT_CAPS")));
    expect(preamble + decl.slice(0, 400)).toMatch(/measured|safety margin|pre-rank/i);
  });

  it(".env.example tells the operator to leave it blank and says why", async () => {
    const { readFileSync } = await import("node:fs");
    const env = readFileSync(new URL("./.env.example", import.meta.url), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("MAX_JOBS_PER_USER="));
    expect(line).toMatch(/LEAVE BLANK/);
    // The ceiling interaction is the part that can abort a whole run — it must be stated where the
    // person about to change the value will read it.
    expect(line).toMatch(/MAX_RUN_COST_USD/);
  });
});

// ── The abort ceiling ────────────────────────────────────────────────────────────────────────────
//
// runMatchBatch THROWS above this, and scheduler.mjs sits inside engine:run's && chain, so a breach
// does not just skip matching — it kills role emails, digest and newsletter together. The number is
// derived from the real per-pair cost: estIn counts matcher + FULL dossier + job on EVERY pair.
describe("MAX_RUN_COST_USD — derived from measured tokens, not a carried figure", () => {
  it("defaults to 80, sized for 100 users at K=300", async () => {
    const { DEFAULT_CAPS } = await import("./match-batch.mjs");
    expect(DEFAULT_CAPS.maxRunCostUsd).toBe(80);
  });

  it("clears the cold-cache worst case with room for growth, not by 3%", async () => {
    // A ceiling one signup can breach is not a ceiling — it is a scheduled outage.
    const { DEFAULT_CAPS } = await import("./match-batch.mjs");
    const cold = (users) => {
      const pairs = users * DEFAULT_CAPS.maxJobsPerUser;
      return (pairs * 3253 / 1e6) * 0.5 + (pairs * 350 / 1e6) * 2.5;   // measured per-pair tokens
    };
    expect(cold(77)).toBeLessThan(DEFAULT_CAPS.maxRunCostUsd);
    expect(cold(100)).toBeLessThan(DEFAULT_CAPS.maxRunCostUsd);   // the actual sizing point
    // and not absurdly high — still trips well below a genuine runaway
    expect(DEFAULT_CAPS.maxRunCostUsd).toBeLessThan(cold(120));
  });

  it("a $30 ceiling would abort a 58-user run; the default does not", async () => {
    const { DEFAULT_CAPS } = await import("./match-batch.mjs");
    const pairs = 58 * DEFAULT_CAPS.maxJobsPerUser;
    const worst = (pairs * 3253 / 1e6) * 0.5 + (pairs * 350 / 1e6) * 2.5;
    expect(worst).toBeGreaterThan(30);  // a $30 ceiling would abort here
    expect(worst).toBeLessThan(DEFAULT_CAPS.maxRunCostUsd);
  });

  it("the derivation is written down where the constant is", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./match-batch.mjs", import.meta.url), "utf8");
    const at = src.lastIndexOf("maxRunCostUsd: Number");
    expect(src.slice(Math.max(0, at - 1600), at)).toMatch(/derived|per pair/i);
  });
});
