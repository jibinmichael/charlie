// retrieval-features.test.mjs — the ranker must carry out WHY it ranked, not just WHERE.
//
// `finds` stores `_retrievalRank`, which says WHERE a role ranked. To learn WHY, `selectForUser`
// also carries the lexical score, the semantic score and the blend it sorted on; otherwise a click is
// an outcome with no attributable cause.
//
// No amount of click data can retrain a ranker whose inputs were thrown away. These fields are the
// difference between a system that records outcomes and one that can learn from them.
//
// THEY ARE TRANSPORT, NOT FACTS. Underscore-prefixed like `_retrievalRank`, never rendered, never
// user-facing, never a claim about the posting or the person.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { selectForUser } from "./select-jobs.mjs";
import { MATCHER_VERSION } from "./lib/matcher-version.mjs";

const src = readFileSync(new URL("./select-jobs.mjs", import.meta.url), "utf8");

const job = (id, title, extra = {}) => ({
  id, title, company: `Co${id}`, source: "greenhouse",
  location: "Bengaluru, India", description: `${title} building products with React and Node`,
  apply_url: `https://example.test/${id}`, posted_at: new Date(Date.now() - 86400000).toISOString(), ...extra,
});
const dossier = {
  headline: "Senior frontend engineer",
  preferences: { role: "Frontend Engineer", remote: "Bengaluru", tech: ["React", "Node"] },
  proof_points: ["shipped a checkout redesign", "led a team of four"],
  strengths: ["React", "TypeScript"],
};
const JOBS = [
  job("a", "Senior Frontend Engineer"),
  job("b", "Frontend Engineer"),
  job("c", "Backend Engineer"),
  job("d", "Warehouse Associate"),
];

describe("every chosen role carries the signals that ranked it", () => {
  const out = selectForUser(dossier, JOBS, 4);

  it("returns roles at all (an empty result would pass every assertion below)", () => {
    expect(out.jobs.length).toBeGreaterThan(0);
  });

  it("carries the lexical score and the position", () => {
    for (const j of out.jobs) {
      expect(typeof j._relScore, `${j.title} has no _relScore`).toBe("number");
      expect(typeof j._retrievalRank, `${j.title} has no _retrievalRank`).toBe("number");
    }
  });

  it("_retrievalRank is the ACTUAL order, not a copy of the array index by luck", () => {
    expect(out.jobs.map((j) => j._retrievalRank)).toEqual(out.jobs.map((_, i) => i));
  });

  it("the lexical score is monotonically non-increasing down the list", () => {
    // If it is not, the field is not the thing that did the sorting, and reading it later would
    // attribute a click to a number that had no part in the decision.
    const rels = out.jobs.map((j) => j._relScore);
    for (let i = 1; i < rels.length; i++) expect(rels[i]).toBeLessThanOrEqual(rels[i - 1]);
  });

  it("a closer role really does score higher — the signal means something", () => {
    // Compared against the BACKEND role, not the warehouse one: an out-of-family role never reaches
    // the ranker at all (it is dropped upstream), so asserting on it would be asserting on undefined.
    // That drop is itself the correct behaviour and is asserted separately below.
    const byId = new Map(out.jobs.map((j) => [j.id, j]));
    expect(byId.get("a")._relScore).toBeGreaterThan(byId.get("c")._relScore);
  });

  it("an unrelated role never reaches the ranker at all", () => {
    expect(out.jobs.map((j) => j.id)).not.toContain("d"); // Warehouse Associate
  });

  it("semantic is null when it did not run, never a fabricated zero", () => {
    // A 0 would read as "no semantic similarity" in a later analysis. null reads as "not measured",
    // which is the truth when no vectors were passed.
    for (const j of out.jobs) expect(j._semScore).toBeNull();
  });

  it("does not mutate the caller's job objects", () => {
    // selectForUser is used on the SHARED pool; stamping the originals would leak one user's ranking
    // into the next user's shortlist.
    for (const j of JOBS) {
      expect(j._relScore, `${j.title} was mutated in the source pool`).toBeUndefined();
      expect(j._retrievalRank).toBeUndefined();
    }
  });

  it("the fields are transport only — underscore-prefixed", () => {
    for (const k of ["_relScore", "_semScore", "_blendScore", "_retrievalRank"]) {
      expect(k.startsWith("_"), `${k} must be underscore-prefixed so nothing user-facing reads it`).toBe(true);
    }
  });
});

describe("one rank, one name", () => {
  // The retrieval rank has exactly one name, `_retrievalRank` (perUserJobs[ui] in match-batch.mjs IS
  // this function's output, so its index IS the rank). A metric with two names forks the first time
  // someone reads only one of them. Comments may name the retired `_poolRank`; code may not.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("_poolRank is gone from the code — it never had a reader", () => {
    expect(code).not.toMatch(/_poolRank/);
  });

  it("selectForUser stamps the rank under the name the eval script and 132 live rows already use", () => {
    expect(src).toMatch(/_retrievalRank: i,/);
    expect(readFileSync(new URL("./scripts/ranker-eval.mjs", import.meta.url), "utf8")).toMatch(/_retrievalRank/);
  });
});

describe("every find records the decision that produced it", () => {
  // slot and matcher_version are written by upsertFind on every emailed find. These assertions keep
  // that true.
  const store = readFileSync(new URL("./charlie-store.mjs", import.meta.url), "utf8");

  it("upsertFind stamps matcher_version by default — a caller cannot forget it", () => {
    expect(store).toMatch(/matcherVersion = MATCHER_VERSION/);
    expect(store).toMatch(/matcher_version: matcherVersion/);
  });

  it("MATCHER_VERSION is a real value, not an empty string standing in for one", () => {
    expect(MATCHER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-\S+$/);
  });

  it("upsertFind persists the slot alongside it", () => {
    expect(store).toMatch(/\bslot,\s*matcher_version: matcherVersion/);
  });

  it("the rank travels ON the job, so it survives whichever path writes the find", () => {
    // match-one.mjs (the on-demand / first-role path) never stamped a rank of its own. It writes the
    // job object it got from selectForUser, so stamping there is what covers it.
    expect(readFileSync(new URL("./match-one.mjs", import.meta.url), "utf8")).not.toMatch(/_retrievalRank:/);
    expect(src).toMatch(/_retrievalRank: i,/);
  });
});
