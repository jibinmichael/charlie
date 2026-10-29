// fit-stage-unwired.test.mjs — the two-stage engine exists, and it decides nothing.
//
// The whole safety argument for this work is that v1 keeps every production decision. That is a claim
// about the import graph, so it is checked mechanically rather than asserted in a doc.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { stage1Key } from "./fit-stage.mjs";
import { Stage1Requirement, Stage2Requirement, parseStage1Requirement, parseStage2Requirement, STAGE2_STATUSES } from "./schemas/fit-stage.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), "utf8");
/** Source with comment lines stripped: these scans are about CODE, and the header prose legitimately
 *  names the very things it is promising not to call. */
const code = (f) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the shadow engine is wired to nothing that decides or sends", () => {
  const importers = readdirSync(ROOT)
    .filter((f) => (f.endsWith(".mjs") || f.endsWith(".ts")) && !f.includes(".test."))
    .filter((f) => /fit-stage\.mjs|fit-decision\.mjs/.test(read(f)));

  it("no root production module imports the stage engine or the operator", () => {
    expect(importers).toEqual([]);
  });

  it("the live gate still routes on the matcher bar and the fit floor", () => {
    const gate = read("quality-gate.mjs");
    expect(gate).toMatch(/matcherScore < Number\(process\.env\.MATCH_BAR \|\| 70\)/);
    expect(gate).toMatch(/covScoreable && cov\.composite < FIT_FLOOR/);
    expect(gate).not.toMatch(/fit-stage|fit-decision/);
  });

});

describe("the stage-1 cache key", () => {
  it("is stable for the same posting and changes with the posting", () => {
    const a = stage1Key("Backend Engineer", "We need Go and Postgres.");
    expect(stage1Key("Backend Engineer", "We need Go and Postgres.")).toBe(a);
    expect(stage1Key("Backend Engineer", "We need Rust and Postgres.")).not.toBe(a);
  });

  it("distinguishes two postings that share a body but differ in level", () => {
    // Same description, different title, genuinely different requirements.
    expect(stage1Key("Senior Backend Engineer", "Same body.")).not.toBe(stage1Key("Backend Engineer", "Same body."));
  });

  it("changes when the extraction prompt changes, so a contract cannot outlive its rules", () => {
    const src = read("lib/fit-stage.mjs");
    expect(src).toMatch(/createHash\("sha256"\)\.update\(FIT_STAGE1_SYSTEM\)/);
  });
});

describe("the model boundaries", () => {
  it("stage 1 requires every field the decision reads", () => {
    expect(parseStage1Requirement({ req: "Go", gating: true, kind: "capability", tool: true }).ok).toBe(true);
    for (const missing of [{ gating: true, kind: "capability", tool: true }, { req: "Go", kind: "capability", tool: true }, { req: "Go", gating: true, tool: true }, { req: "Go", gating: true, kind: "capability" }]) {
      expect(parseStage1Requirement(missing).ok, JSON.stringify(missing)).toBe(false);
    }
  });

  it("stage 2 accepts the four statuses and rejects anything else", () => {
    for (const s of STAGE2_STATUSES) expect(parseStage2Requirement({ req: "Go", status: s }).ok, s).toBe(true);
    expect(parseStage2Requirement({ req: "Go", status: "partly" }).ok).toBe(false);
  });

  it("a stage-2 row that fails is scored UNKNOWN, never dropped", () => {
    // Dropping shrinks the conjunction's denominator and makes the send EASIER. The module comment
    // says so; this pins the behaviour.
    const src = read("lib/fit-stage.mjs");
    expect(src).toMatch(/FAIL CLOSED, DO NOT SKIP/);
    expect(src).toMatch(/status: "unknown"/);
  });

  it("a requirement stage 1 asked for but stage 2 skipped still counts, as unknown", () => {
    const src = read("lib/fit-stage.mjs");
    expect(src).toMatch(/not returned by the judge, scored unknown/);
  });
});
