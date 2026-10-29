// match-resume-sparse.test.mjs — resuming a parked batch must survive a user who was fully cached.
//
// The resume path rebuilds this run's user array from the PARKED
// custom_ids (`u{i}_j{j}`). A user whose every (person x job) pair came back from the verdict cache
// contributes NO request to the batch, so their index is a HOLE in that rebuilt array. `.map()`
// preserves holes and `new Map()` rejects an undefined entry:
//
//     fatal: Iterator value undefined is not an entry object
//
// which would abort the entire daily send. The byEmail constructor must skip holes, as the collect
// loop underneath does (`if (!u || !job) continue`). This only fires once the verdict cache returns
// hits (see verdict-cache-chunk.test.mjs).

import { describe, it, expect, vi } from "vitest";

const PARKED = {
  batchId: "batch_parked",
  createdAt: new Date().toISOString(),
  // ONLY u1 is present. u0 was served entirely from the verdict cache -> index 0 is a hole.
  map: [{ custom_id: "u1_j0", email: "cached-neighbour@example.com", jobId: "gh-acme-42" }],
};

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      this.messages = {
        batches: {
          create: vi.fn(),
          retrieve: vi.fn(async () => ({ id: "batch_parked", processing_status: "ended", request_counts: {} })),
          results: vi.fn(async function* () {
            yield {
              custom_id: "u1_j0",
              result: {
                type: "succeeded",
                message: {
                  content: [{ type: "text", text: JSON.stringify({ score: 81, verdict: "strong", why_you: "grounded", flag: null, dealbreaker_hit: false }) }],
                  usage: { input_tokens: 10, output_tokens: 4 },
                },
              },
            };
          }),
        },
      };
    }
  },
}));

vi.mock("./select-jobs.mjs", () => ({
  tagCompanyReach: () => 0,
  personBlob: () => "blob",
  selectForUser: (_d, jobs) => ({ jobs, stats: { in: jobs.length, kept: jobs.length, taken: jobs.length, region: "us", unreachable: 0, ineligible: 0, families: ["eng"] } }),
}));

vi.mock("./charlie-store.mjs", () => ({
  loadPendingBatch: vi.fn(async () => PARKED),
  savePendingBatch: vi.fn(async () => {}),
  clearPendingBatch: vi.fn(async () => {}),
  getVerdicts: vi.fn(async () => new Map()),
  putVerdicts: vi.fn(async () => 0),
  pruneVerdicts: vi.fn(async () => {}),
}));

const { runMatchBatch } = await import("./match-batch.mjs");

const dossier = (name) => ({
  name, headline: "Software Engineer", narrative: "Builds backend services.",
  proof_points: [], case_studies: [], strengths: [], gaps: [], preferences: {},
});
const job = {
  id: "gh-acme-42", title: "Senior Software Engineer", company: "Acme", location: "Remote (US)",
  description: "Build and scale backend systems in Node.", url: "https://boards.greenhouse.io/acme/jobs/42",
  source: "greenhouse", posted_at: "2026-07-10",
};

describe("resuming a parked batch with a fully-cached user", () => {
  it("does not throw when an index is a hole (a hole must not abort the send)", async () => {
    const users = [
      { email: "fully-cached@example.com", dossier: dossier("A"), dossierText: "A" }, // contributed no request
      { email: "cached-neighbour@example.com", dossier: dossier("B"), dossierText: "B" },
    ];
    // Must not reject with "Iterator value undefined is not an entry object".
    const out = await runMatchBatch({ matcherPrompt: "rubric", users, jobs: [job], log: () => {} });
    expect(out).toBeTruthy();
    expect(out.resumed).toBe(true);
  });

  it("still scores the user who WAS in the batch", async () => {
    const users = [
      { email: "fully-cached@example.com", dossier: dossier("A"), dossierText: "A" },
      { email: "cached-neighbour@example.com", dossier: dossier("B"), dossierText: "B" },
    ];
    const out = await runMatchBatch({ matcherPrompt: "rubric", users, jobs: [job], log: () => {} });
    const scored = out.byEmail.get("cached-neighbour@example.com");
    expect(Array.isArray(scored)).toBe(true);
    expect(scored.length).toBeGreaterThan(0);
  });
});
