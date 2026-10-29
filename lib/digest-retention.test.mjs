// digest-retention.test.mjs — only fit-shaped digest rows are retained (lib/digest-retention.mjs).
//
// A constraint-shaped row never carries stored coverage, because the constraint gates return
// `cov: null` before gateRole reaches its getCov() call. depth-question cannot read such rows and
// they displace the rows it can; market-gap would spend model calls on roles the person cannot take.
//
// The two properties these tests exist to hold:
//   1. constraint-shaped roles are no longer persisted
//   2. anything we cannot classify is RETAINED, never guessed away

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { retainDecision, isFitShaped } from "./digest-retention.mjs";

describe("fit-shaped rules are retained", () => {
  it("keeps the two rules that mean 'close on fit'", () => {
    for (const rule of ["fit-floor:below", "match-bar:below"]) {
      expect(retainDecision(rule).retain, `${rule} must be retained`).toBe(true);
      expect(isFitShaped(rule)).toBe(true);
    }
  });

  it("keeps a future fit-floor variant without needing a code change", () => {
    expect(retainDecision("fit-floor:v2-below").retain).toBe(true);
  });
});

describe("constraint-shaped rules are NOT persisted", () => {
  // Every rule string observed in the live data or emitted by the live gates.
  const constraintRules = [
    "constraint:location:remote-mismatch",
    "constraint:arrangement:onsite-vs-remote-only",
    "constraint:arrangement:unknown",
    "constraint:dealbreaker:hit",
    "constraint:level-below-target",
    "constraint:evergreen",
    "city-corridor:outside",
    "language:required",
    "pay-floor:below",
    "region:unreachable",
    "eligibility:work-auth",
    "knockout:structural",
    "remote-access:region-barred",
    "seniority:chasm",
    "liveness:unconfirmed",
    "data-sufficiency:profile-thin",
  ];

  for (const rule of constraintRules) {
    it(`drops ${rule}`, () => {
      const d = retainDecision(rule);
      expect(d.retain).toBe(false);
      expect(d.why).toContain("constraint-shaped");
    });
  }

  it("the biggest single category by far is covered", () => {
    // The largest constraint category. If this one ever started being retained the filter would be
    // pointless, so it gets its own assertion.
    expect(retainDecision("constraint:location:remote-mismatch").retain).toBe(false);
  });
});

describe("it never silently misclassifies", () => {
  // Older rows carry no digest_rule. A missing rule means "cannot classify", NOT "constraint-shaped".
  // Retaining costs a row; dropping destroys data we cannot recover.
  it("RETAINS a missing, empty or whitespace rule", () => {
    for (const rule of [undefined, null, "", "   "]) {
      const d = retainDecision(rule);
      expect(d.retain, `${JSON.stringify(rule)} must be retained`).toBe(true);
      expect(d.why).toContain("unclassified");
    }
  });

  it("RETAINS the 'unrecorded' sentinel rather than treating it as a constraint", () => {
    // recordedRule writes this when a caller forgets. It means "we do not know".
    expect(retainDecision("unrecorded").retain).toBe(true);
  });

  it("treats an unknown NAMED rule as constraint-shaped, not as unclassified", () => {
    // A rule string that exists but is not fit-shaped is a constraint: every named rule emitted by
    // the gates today that is not fit-floor/match-bar is one. The fail-open case is the ABSENCE of
    // a rule, tested above — not the presence of an unfamiliar one.
    const d = retainDecision("some-future-gate:reason");
    expect(d.retain).toBe(false);
    expect(d.why).toContain("constraint-shaped");
  });
});

describe("enforced at the one door, and scoped to digest only", () => {
  const src = readFileSync(new URL("../charlie-store.mjs", import.meta.url), "utf8");

  it("upsertFind applies it — the single point all three writers funnel through", () => {
    expect(src).toMatch(/retainDecision\(composedOut\?\.digest_rule\)/);
  });

  it("applies to `digest` ONLY", () => {
    // digest_sent transitions an existing row; closest is a different concept; dry_run is used by the
    // SEND path too, so filtering it would silently drop send previews.
    expect(src).toMatch(/if \(status === "digest"\) \{/);
    expect(src).not.toMatch(/if \(status === "digest" \|\| status === "dry_run"\)/);
  });

  it("skips the write without throwing, and still returns the id", () => {
    const at = src.indexOf("retainDecision(composedOut?.digest_rule)");
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/return id;/);
    expect(block).not.toMatch(/throw/);
  });

  it("DELETES NOTHING — no destructive call was introduced", () => {
    // Scoped to the inserted block, comments stripped: the claim is about destructive CODE, and
    // scanning prose only re-finds the word "drop" in the note explaining what is NOT dropped.
    const at = src.indexOf("RETAIN FIT-SHAPED DIGEST ROWS ONLY");
    const end = src.indexOf("const base = { id, job, match", at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const block = src.slice(at, end).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(block).not.toMatch(/\.delete\(|\.remove\(|DROP |TRUNCATE/i);
  });

  it("`fit:clears` is a SEND, never a digest row — so excluding it from FIT_SHAPED is safe", () => {
    // The one fit-named rule the regex deliberately does not match. It is only ever emitted beside
    // outcome:"send", so it can never arrive here as a digest write. If a future edit ever emits it
    // without that outcome, this fails and the regex must be revisited.
    const gate = readFileSync(new URL("../quality-gate.mjs", import.meta.url), "utf8");
    const lines = gate.split("\n").filter((l) => l.includes('rule: "fit:clears"'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l, l.trim()).toMatch(/outcome: "send"/);
    expect(isFitShaped("fit:clears")).toBe(false);
  });

  it("reuses digest_rule — there is no second classification system", () => {
    const lib = readFileSync(new URL("./digest-retention.mjs", import.meta.url), "utf8");
    // it must classify from the rule alone, never re-derive from prose or re-run a gate
    expect(lib).not.toMatch(/digest_reason/);
    expect(lib).not.toMatch(/auditRole|languageBlocker|computeCoverage|belowStatedFloor/);
  });
});
