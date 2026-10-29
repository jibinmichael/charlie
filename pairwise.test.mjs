// pairwise.test.mjs — ordering the shortlist by comparison instead of by a score that cannot rank.
//
// Match scores are coarse: most roles above the bar share the same few values. The scheduler walks
// candidates in score order and sends the first that clears the gate, so without pairwise ranking the
// pick is drawn from a near-total tie.
//
// The weight of these tests is on FAILING OPEN. A ranking that cannot run must never stop a send: the
// person gets today's role in score order. That is the one behaviour that cannot
// regress, because the send is the product.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pairwiseReorder, pairwiseMode } from "./lib/pairwise.mjs";
import { readFileSync } from "node:fs";
import { personBlock, buildPairwiseUser, PAIRWISE_SYSTEM } from "./prompts/pairwise-rank.mjs";

const job = (id, over = {}) => ({ id, company: id, title: `Role ${id}`, description: "x".repeat(300), ...over });

let savedMode, savedKey;
beforeEach(() => { savedMode = process.env.PAIRWISE_RANK; savedKey = process.env.ANTHROPIC_API_KEY; });
afterEach(() => {
  if (savedMode === undefined) delete process.env.PAIRWISE_RANK; else process.env.PAIRWISE_RANK = savedMode;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("the flag", () => {
  it("defaults to off and rejects an unknown value", () => {
    delete process.env.PAIRWISE_RANK;
    expect(pairwiseMode()).toBe("off");
    process.env.PAIRWISE_RANK = "yes";
    expect(pairwiseMode()).toBe("off");
  });

  it("shadow and on are readable after import", () => {
    process.env.PAIRWISE_RANK = "shadow";
    expect(pairwiseMode()).toBe("shadow");
    process.env.PAIRWISE_RANK = "on";
    expect(pairwiseMode()).toBe("on");
  });
});

describe("it fails OPEN — a send is never blocked by ranking", () => {
  it("returns the original order when there is no API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const list = [job("a"), job("b"), job("c")];
    const r = await pairwiseReorder(list, {}, { log: () => {} });
    expect(r.order.map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(r.comparisons).toBe(0);
    expect(r.changed).toBe(false);
  });

  it("returns the original order for a single candidate, spending nothing", async () => {
    const r = await pairwiseReorder([job("only")], {}, { log: () => {} });
    expect(r.order.map((j) => j.id)).toEqual(["only"]);
    expect(r.comparisons).toBe(0);
  });

  it("survives an empty or junk shortlist", async () => {
    for (const bad of [[], null, undefined]) {
      const r = await pairwiseReorder(bad, {}, { log: () => {} });
      expect(Array.isArray(r.order)).toBe(true);
      expect(r.changed).toBe(false);
    }
  });

  it("only ranks the head — the tail keeps its score order behind it", async () => {
    delete process.env.ANTHROPIC_API_KEY; // forces the no-op path, which must still respect `limit`
    const list = ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => job(x));
    const r = await pairwiseReorder(list, {}, { limit: 6, log: () => {} });
    expect(r.order).toHaveLength(8);
    expect(r.order.slice(6).map((j) => j.id)).toEqual(["g", "h"]);
  });
});

describe("the prompt", () => {
  it("asks for one letter and forbids explanation", () => {
    expect(PAIRWISE_SYSTEM).toMatch(/"A" or "B"/);
    expect(PAIRWISE_SYSTEM).toMatch(/Never explain/i);
  });

  it("bans the tie-breakers that are not in the evidence", () => {
    // A long rubric invites invented grounds ("more prestigious", "better culture") that are in
    // neither posting nor the person's record. Nothing invented, in ranking too.
    expect(PAIRWISE_SYSTEM).toMatch(/Ignore company fame, funding, perceived prestige/i);
  });

  it("puts the person BEFORE the roles, so the prefix is stable and cacheable", () => {
    // Same discipline as fit-coverage.mjs: the block that repeats across every comparison for one
    // person must come first, or the cache never engages and every comparison pays full price.
    const u = buildPairwiseUser({ person: "PERSONBLOCK", a: job("a"), b: job("b") });
    expect(u.indexOf("PERSONBLOCK")).toBeLessThan(u.indexOf("### ROLE A"));
    expect(u.indexOf("### ROLE A")).toBeLessThan(u.indexOf("### ROLE B"));
  });
});

describe("personBlock is grounded and bounded", () => {
  it("carries what the person has actually done", () => {
    const b = personBlock({
      headline: "React developer",
      professional_years: 4.4,
      strengths: ["React", "cross-platform"],
      proof_points: [{ claim: "shipped payments at a bank" }],
    });
    expect(b).toContain("React developer");
    expect(b).toContain("shipped payments at a bank");
    expect(b).toContain("Has actually done");
  });

  it("survives a missing or junk dossier", () => {
    for (const bad of [null, undefined, {}, { strengths: "not an array" }]) {
      expect(typeof personBlock(bad)).toBe("string");
    }
  });

  it("is length-capped, because it is re-sent on every comparison", () => {
    const huge = { headline: "x".repeat(5000), proof_points: Array(200).fill({ claim: "y".repeat(200) }) };
    expect(personBlock(huge).length).toBeLessThanOrEqual(2000);
  });
});

// ── The two re-rankers must COMPOSE, not overwrite each other ────────────────────────────────────
//
// If scheduler.mjs re-sorted the ORIGINAL array after pairwise (`walk = freshnessReorder(candidates)`),
// the paid-for pairwise ordering would be computed and discarded, silently.
//
// A source-order assertion, deliberately. Both functions are correct and unit-tested on their own; the
// risk is in the few lines that call them, and only their ORDER and their ARGUMENT can express it.
describe("scheduler: freshness and pairwise compose", () => {
  const src = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it("never re-sorts the ORIGINAL candidate array after ranking it", () => {
    // The shape that would discard the pairwise ordering.
    expect(code).not.toMatch(/walk\s*=\s*freshnessReorder\(candidates\)/);
    expect(code).not.toMatch(/freshnessReorder\(candidates\)/);
  });

  it("both re-rankers read and write the SAME accumulator", () => {
    expect(code).toMatch(/walk\s*=\s*freshnessReorder\(walk\)/);
    expect(code).toMatch(/pairwiseReorder\(walk,/);
  });

  it("freshness runs first, so pairwise reorders the freshness-ordered head", () => {
    // pairwiseReorder returns [...reordered head, ...untouched tail], so whichever runs LAST owns the
    // head. Pairwise is the expensive, role-specific judgment; it must not be the one overwritten.
    expect(code.indexOf("freshnessReorder(walk)")).toBeLessThan(code.indexOf("pairwiseReorder(walk,"));
  });

  it("the pairwise shadow log compares against what pairwise actually received", () => {
    // Printing `candidates[0]` would be wrong: after a freshness reorder it is not the role pairwise
    // was asked about, so the shadow line would report a comparison that never happened.
    expect(code).not.toMatch(/instead of \$\{candidates\[0\]/);
  });
});
