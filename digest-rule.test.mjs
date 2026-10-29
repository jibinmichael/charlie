// digest-rule.test.mjs — every row that exists because a gate fired must say WHICH gate, by name.
//
// A digest row's `digest_reason` is prose ("strong profile fit, but location (Copenhagen) isn't
// reachable for you"). Prose explains ONE role; it cannot be grouped or counted. So every gated row
// also carries the machine name of the exit that fired, and these tests pin that:
//   - gateRole returns a `rule` on every exit
//   - preSendGuard keeps that rule instead of flattening it to `gate:${outcome}`
//   - upsertFind refuses to write a gated row without one

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { recordedRule } from "./charlie-store.mjs";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

// TWO OR MORE segments, not exactly two. presend-guard wraps its own findings as
// `constraint:${miss.rule}` and miss.rule is itself `area:detail`, so those arrive three deep:
// `constraint:location:remote-mismatch`, and they are the majority of real digest rows. A
// two-segment-only pattern would read them as NOT machine-readable.
const MACHINE_READABLE = /^[a-z0-9-]+(?::[a-zA-Z0-9-]+)+$/;   // roleKey is camelCase

describe("gateRole — every exit carries a machine-readable rule", () => {
  // A source parse, not a behaviour test, ON PURPOSE. gateRole's fourteen exits are guarded by
  // liveness fetches, model calls and env modes; reaching each one through the front door needs more
  // scaffolding than the invariant is worth. What must never happen is a FIFTEENTH exit added without
  // a rule, and that is a property of the text.
  const gate = src("./quality-gate.mjs");
  const exits = gate.split("\n").map((line, i) => ({ line, n: i + 1 })).filter((x) => /return \{ outcome:/.test(x.line));

  it("finds every exit (guards against the regex silently matching nothing)", () => {
    expect(exits.length).toBeGreaterThanOrEqual(14);
  });

  it("no exit returns an outcome without a rule", () => {
    const missing = exits.filter((x) => !/rule:\s*"/.test(x.line)).map((x) => `quality-gate.mjs:${x.n}`);
    expect(missing).toEqual([]);
  });

  it("every rule is machine-readable: lowercase colon-separated segments, no prose, no spaces", () => {
    const rules = [...gate.matchAll(/rule:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThanOrEqual(14);
    for (const r of rules) expect(r).toMatch(MACHINE_READABLE);
  });
});

describe("the rules presend-guard adds on top of gateRole's", () => {
  // These never appear in quality-gate.mjs, so the source scan above cannot see them. They are the
  // three-segment ones, and they are the majority of what actually gets written.
  const guard = src("./presend-guard.mjs");

  it("wraps its findings under a constraint: prefix", () => {
    expect(guard).toMatch(/rule: `constraint:\$\{miss\.rule\}`/);
  });

  it("every literal rule it emits is machine-readable too", () => {
    const rules = [...guard.matchAll(/rule: "([^"]+)"/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThanOrEqual(4);   // repeat:identity/roleKey/core/company-cooloff
    for (const r of rules) expect(r).toMatch(MACHINE_READABLE);
  });

  it("the composed constraint form is machine-readable as well", () => {
    // What send-audit.mjs actually produces, wrapped the way presend-guard wraps it.
    for (const miss of ["location:remote-mismatch", "dealbreaker:hit", "arrangement:unknown", "arrangement:onsite-vs-remote-only"]) {
      expect(`constraint:${miss}`).toMatch(MACHINE_READABLE);
    }
  });
});

describe("preSendGuard — passes the gate's own rule through", () => {
  it("does not flatten fourteen causes back into three", () => {
    const guard = src("./presend-guard.mjs");
    // A guard that rewrites the rule as `gate:${outcome}` would discard the gate's machine-readable rule.
    expect(guard).not.toMatch(/rule:\s*`gate:\$\{g\.outcome\}`\s*,/);
    expect(guard).toMatch(/rule:\s*g\.rule\s*\|\|/);
  });
});

describe("recordedRule — a gated write with no rule is impossible, not merely discouraged", () => {
  it("passes a gated row through untouched when it names its rule", () => {
    const composed = { digest_rule: "region:unreachable", digest_reason: "prose for the human" };
    expect(recordedRule(composed, "digest", "a@b.com:x")).toBe(composed);
  });

  it("substitutes the explicit sentinel when a gated row forgets", () => {
    expect(recordedRule({ digest_reason: "prose only" }, "digest", "a@b.com:x"))
      .toEqual({ digest_reason: "prose only", digest_rule: "unrecorded" });
  });

  it("treats null composed on a gated row as unrecorded, never as an empty write", () => {
    expect(recordedRule(null, "digest", "a@b.com:x")).toEqual({ digest_rule: "unrecorded" });
    expect(recordedRule(undefined, "digest_sent", "a@b.com:x")).toEqual({ digest_rule: "unrecorded" });
  });

  it("treats a blank or whitespace rule as absent (the Number(null)===0 trap, for strings)", () => {
    expect(recordedRule({ digest_rule: "" }, "digest", "a@b.com:x").digest_rule).toBe("unrecorded");
    expect(recordedRule({ digest_rule: "   " }, "digest", "a@b.com:x").digest_rule).toBe("unrecorded");
    expect(recordedRule({ digest_rule: 42 }, "closest", "a@b.com:x").digest_rule).toBe("unrecorded");
  });

  it("covers every status that exists BECAUSE a gate fired", () => {
    for (const s of ["digest", "digest_sent", "closest"]) {
      expect(recordedRule(null, s, "a@b.com:x")).toEqual({ digest_rule: "unrecorded" });
    }
  });

  it("leaves ungated statuses alone — a sent role is not a gate outcome", () => {
    for (const s of ["new", "emailed", "unsent", "send_failed", "dry_run"]) {
      expect(recordedRule(null, s, "a@b.com:x")).toBeNull();
      expect(recordedRule({ anything: 1 }, s, "a@b.com:x")).toEqual({ anything: 1 });
    }
  });
});

describe("the write sites all record the rule", () => {
  // Every caller that writes a gated row. A new one added without digest_rule still cannot write a
  // null (recordedRule catches it), but it WILL fire a Sentry alert — this keeps that from being the
  // way we find out.
  const sites = [
    ["scheduler.mjs", /composed: \{ digest_rule: d\.rule,/],
    ["first-role.mjs", /composed: \{ digest_rule: gate\.rule,/],
    ["match-one.mjs", /composed: \{ digest_rule: d\.rule,/],
  ];
  for (const [file, pattern] of sites) {
    it(`${file} passes digest_rule to upsertFind`, () => {
      expect(src(`./${file}`)).toMatch(pattern);
    });
  }

  it("match-one routes 'closest' on the rule, not on the prose it used to string-match", () => {
    const mo = src("./match-one.mjs");
    expect(mo).not.toMatch(/below the match bar\/i\.test\(g\.reason/);
    expect(mo).toMatch(/g\.rule === "match-bar:below"/);
  });
});
