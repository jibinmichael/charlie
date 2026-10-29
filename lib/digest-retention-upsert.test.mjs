// digest-retention-upsert.test.mjs — the BEHAVIOURAL half of the fit-only decision.
//
// digest-retention.test.mjs proves the classifier and reads the enforcement out of the source. That
// is not enough on its own: a source scan cannot tell you whether a row reached Supabase. This file
// drives the real `upsertFind` against a fake postgrest client and watches the wire.
//
// The one thing it must show: for a constraint-shaped digest row, `finds.upsert` is NEVER called.

import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertSpy = vi.fn(async () => ({ error: null }));
const deleteSpy = vi.fn(() => ({ eq: () => ({ error: null }) }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table) => ({
      upsert: (row, opts) => upsertSpy(table, row, opts),
      delete: deleteSpy,
    }),
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake-service-role-key";

const { upsertFind } = await import("../charlie-store.mjs");

const EMAIL = "person@example.com";
const JOB = { id: "gh:acme:1", company: "Acme", title: "Backend Engineer" };
const MATCH = { score: 64, verdict: "maybe" };

const write = (status, digest_rule, extra = {}) =>
  upsertFind({ email: EMAIL, jobId: JOB.id, job: JOB, match: MATCH, status, composed: { digest_rule, ...extra } });

beforeEach(() => { upsertSpy.mockClear(); });

describe("constraint-shaped digest rows never reach the database", () => {
  // The constraint-shaped majority, including the single biggest category.
  for (const rule of [
    "constraint:location:remote-mismatch",
    "constraint:arrangement:onsite-vs-remote-only",
    "constraint:dealbreaker:hit",
    "city-corridor:outside",
    "language:required",
    "pay-floor:below",
    "region:unreachable",
    "knockout:structural",
  ]) {
    it(`writes nothing for ${rule}`, async () => {
      await write("digest", rule);
      expect(upsertSpy).not.toHaveBeenCalled();
    });
  }

  it("still returns the id, so no caller changes shape or throws", async () => {
    await expect(write("digest", "constraint:location:remote-mismatch"))
      .resolves.toBe(`${EMAIL}:${JOB.id}`);
  });
});

describe("fit-shaped digest rows are written exactly as before", () => {
  for (const rule of ["fit-floor:below", "match-bar:below"]) {
    it(`writes ${rule} to finds`, async () => {
      await write("digest", rule);
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const [table, row] = upsertSpy.mock.calls[0];
      expect(table).toBe("finds");
      expect(row.status).toBe("digest");
      expect(row.composed.digest_rule).toBe(rule);
    });
  }

  it("carries stored coverage through untouched — this is what depth-question reads", async () => {
    const cov = { composite: 61, mustHave: 0.5, missing: ["Kubernetes"] };
    await write("digest", "fit-floor:below", { _cov: cov });
    expect(upsertSpy.mock.calls[0][1].composed._cov).toEqual(cov);
  });
});

describe("an unclassifiable rule is written, not guessed away", () => {
  // Older rows carry no digest_rule. A writer that omits it must keep persisting: the filter may
  // narrow the data, never lose an unknown.
  it("writes when digest_rule is absent, empty, or the `unrecorded` sentinel", async () => {
    for (const rule of [undefined, "", "unrecorded"]) {
      upsertSpy.mockClear();
      await write("digest", rule);
      expect(upsertSpy, `rule ${JSON.stringify(rule)} must still be written`).toHaveBeenCalledTimes(1);
    }
  });
});

describe("no other status is affected", () => {
  // The send path writes `new`/`sent`/`dry_run` and must be untouched; `digest_sent` transitions a
  // row that already exists, and filtering it would strand the row as permanently unsent.
  for (const status of ["new", "sent", "dry_run", "digest_sent", "closest"]) {
    it(`${status} is written even with a constraint-shaped rule attached`, async () => {
      await write(status, "constraint:location:remote-mismatch");
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy.mock.calls[0][1].status).toBe(status);
    });
  }
});

describe("nothing is deleted", () => {
  it("no delete is issued on any path — historical rows are untouched", async () => {
    await write("digest", "constraint:location:remote-mismatch");
    await write("digest", "fit-floor:below");
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
