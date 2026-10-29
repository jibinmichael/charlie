// digest-coverage.test.mjs — the near-miss keeps the coverage we already paid for.
//
// WHY THIS EXISTS. To tell someone "two of your last six roles wanted Kubernetes", Charlie has to read
// those six job descriptions against their profile. That is a Sonnet call per role, and across the
// whole user base that adds up to a real cost on every pass.
//
// It is already paid for: scheduler.mjs computes coverage inside preSendGuard for EVERY gate decision
// and uses it to choose send/digest/drop. It keeps that coverage on the near-misses too (`composed._cov`),
// so the insight pass never re-scores the same roles on a second model call. That makes the
// depth-question email free.
//
// THIS TEST PARSES THE REAL SOURCE, on purpose. The guarded code is two words inside a long line in
// the send path; a comment asking the next person not to drop it is not enforcement. The same pattern
// guards the cron chain in cron-chain.test.mjs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "scheduler.mjs"), "utf8");

/** The one statement that writes a near-miss row. */
const digestUpsert = () => {
  const line = SRC.split("\n").find((l) => l.includes("upsertFind(") && l.includes('"digest"'));
  expect(line, "the digest upsertFind call has moved or changed shape").toBeTruthy();
  return line;
};

describe("a near-miss find carries its coverage", () => {
  it("the digest write persists _cov", () => {
    expect(digestUpsert()).toMatch(/_cov/);
  });

  it("the gate's coverage is carried onto the digest pick rather than dropped", () => {
    // preSendGuard returns { decision, rule, reason, cov } for every decision. The push that collects
    // digest candidates must keep `cov`; without it the write above has nothing to persist.
    const push = SRC.split("\n").find((l) => l.includes("digestPicks.push("));
    expect(push, "digestPicks.push has moved").toBeTruthy();
    expect(push, "g.cov is being discarded again — the insight pass would re-score and re-bill").toMatch(/cov/);
  });

  it("it is ADDITIVE: digest_reason and every other field survive", () => {
    // The failure this guards against is a well-meant tidy-up that replaces the object rather than
    // extending it. digest_reason is what the weekly digest email reads.
    const line = digestUpsert();
    expect(line).toMatch(/digest_reason/);
    expect(line).toMatch(/match: d\.cand\.match/);
    expect(line).toMatch(/slot: d\.slot/);
    expect(line).toMatch(/status: dryRun \? "dry_run" : "digest"/);
  });

  it("the SENT path still keeps its own coverage, unchanged", () => {
    const sent = SRC.split("\n").find((l) => l.includes("upsertFind(") && l.includes('"new"'));
    expect(sent, "the send-candidate write has moved").toBeTruthy();
    expect(sent).toMatch(/_cov/);
  });

  it("no coverage call was ADDED to the send path — this must stay free", () => {
    // The entire point is to stop paying twice. If a second computeCoverage appears in the digest
    // loop, the saving is gone and the cost this avoided has quietly come back.
    const calls = (SRC.match(/computeCoverage\(/g) || []).length;
    expect(calls, `expected the single getCov call in the gate walk, found ${calls}`).toBe(1);
  });
});
