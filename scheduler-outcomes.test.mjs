// scheduler-outcomes.test.mjs — mechanical guards over scheduler.mjs's per-user loop.
//
// WHY THIS FILE IS A SOURCE PARSER AND NOT A UNIT TEST. Both bugs it guards are invisible to an
// ordinary test:
//
//   1. THE TDZ CRASH. If `askFor(match)` sits ABOVE `const { match, ... } = job`, it throws
//      `ReferenceError: Cannot access 'match' before initialization` for every user on every send —
//      but only once ROLE_ASK is anything other than `off`, because the ternary short-circuits.
//      No unit test of `askFor` can see it: the bug is in the CALLER's statement order.
//
//   2. THE UNLABELLED EXIT. The outcome census is only true if EVERY path out of the loop body sets
//      `outcome`. A future edit that adds a `continue` and forgets produces a count that looks
//      complete and silently is not. The `finally` catches it at runtime
//      (it lands in `unrecorded`); this catches it at review time.
//
// Prose is not enforcement. A comment saying "keep the destructure above the
// call" cannot make it so. A test that parses the real file can.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");
const LINES = SRC.split("\n");
const lineOf = (pred) => LINES.findIndex(pred) + 1; // 1-indexed, 0 when absent

describe("scheduler.mjs — `match` is unpacked before anything reads it", () => {
  it("the destructure precedes the askFor call", () => {
    const destructure = lineOf((l) => /const\s*\{\s*match\s*,\s*passed_bar\s*,\s*\.\.\.rawJob\s*\}\s*=\s*job/.test(l));
    const askCall = lineOf((l) => /askFor\(match\)/.test(l));
    expect(destructure).toBeGreaterThan(0);
    expect(askCall).toBeGreaterThan(0);
    // Strictly less: same line would mean someone folded them together, which is also fine to reject
    // here rather than reason about.
    expect(destructure).toBeLessThan(askCall);
  });

  it("nothing else in the loop reads `match` before that line", () => {
    const destructure = lineOf((l) => /const\s*\{\s*match\s*,\s*passed_bar\s*,\s*\.\.\.rawJob\s*\}\s*=\s*job/.test(l));
    const loopStart = lineOf((l) => /for \(const u of users\)/.test(l));
    const between = LINES.slice(loopStart, destructure - 1);
    // `cand.match` / `d.cand.match` / `j.match` are different bindings and are allowed; a BARE `match`
    // identifier before the destructure is the bug.
    const offenders = between
      .map((l, i) => [loopStart + i + 1, l])
      .filter(([, l]) => !/^\s*(\/\/|\*)/.test(l))
      .filter(([, l]) => /(^|[^.\w"'`])match(?![\w:])/.test(l.replace(/\/\/.*$/, "")));
    expect(offenders.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });
});

describe("scheduler.mjs — every exit from the per-user loop is labelled", () => {
  const loopStart = lineOf((l) => /for \(const u of users\)/.test(l));
  const finallyLine = lineOf((l) => /^\s*\} finally \{/.test(l));

  it("the loop declares a per-iteration outcome and tallies it in a finally", () => {
    expect(loopStart).toBeGreaterThan(0);
    expect(finallyLine).toBeGreaterThan(loopStart);
    const decl = lineOf((l) => /let outcome = "unrecorded";/.test(l));
    expect(decl).toBeGreaterThan(loopStart);
    expect(decl).toBeLessThan(finallyLine);
    expect(SRC).toMatch(/\} finally \{[\s\S]{0,600}?tally\(outcome\);/);
  });

  it("no `continue` in the loop leaves the outcome unset", () => {
    // Every `continue;` between the loop head and the finally must carry a BARE `outcome = "..."`
    // assignment on itself or within the preceding 3 lines.
    //
    // The lookbehind matters: `considered[considered.length - 1].outcome = "drop"` sits three lines
    // above the fit-veto `continue` and would otherwise satisfy a naive match — a false pass on the
    // one line this test most needs to reason about correctly.
    // `outcome =` and not `outcome ==`. Deliberately NOT `outcome = "` — one exit assigns a ternary
    // (`outcome = digestPicks.length > 0 ? ... : ...`), and a regex that only recognises a string
    // literal reports a labelled exit as unlabelled.
    const LABEL = /(?<![.\w])outcome\s*=(?!=)/;
    // The window is the `continue` line itself plus the ONE preceding meaningful line (blank lines and
    // comments skipped). It is deliberately not a 3-line lookback: with a wider window, a NEW
    // unlabelled `continue` placed just after an existing labelled one inherits its neighbour's label
    // and passes.
    const meaningful = (i) => {
      for (let k = i - 1; k > loopStart; k--) {
        const t = LINES[k].trim();
        if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        return LINES[k];
      }
      return "";
    };
    const unlabelled = [];
    for (let i = loopStart; i < finallyLine - 1; i++) {
      const line = LINES[i];
      if (!/\bcontinue;/.test(line)) continue;
      const window = `${meaningful(i)}\n${line}`;
      if (!LABEL.test(window)) unlabelled.push({ line: i + 1, text: line.trim(), window });
    }
    // ONE permitted exception: the fit-engine veto's `continue` belongs to the INNER walk over
    // candidates, not to the user loop. It moves to the next candidate and the same user still
    // reaches an outcome further down. It is matched on its own log text so that a NEW unlabelled
    // `continue` can never hide behind the exemption.
    const INNER_WALK = /FIT VETO/;
    const offenders = unlabelled.filter((u) => !INNER_WALK.test(u.window));
    expect(offenders.map((u) => `${u.line}: ${u.text}`)).toEqual([]);
    // and the exemption itself must still be there — if the veto block is deleted, this test should
    // be revisited rather than silently keeping a dead allowance.
    expect(unlabelled.length).toBe(1);
  });

  it("the catch labels the failure", () => {
    expect(SRC).toMatch(/\} catch \(e\) \{\s*\n\s*failed\+\+;\s*\n\s*outcome = "error";/);
  });

  it("the census is printed on every run, dry or not, and compared to the user count", () => {
    expect(SRC).toMatch(/log\(`outcomes: /);
    expect(SRC).toMatch(/TALLY DOES NOT MATCH THE USER COUNT/);
    // and it reaches the persisted KPI snapshot, so it survives log retention
    expect(SRC).toMatch(/outcome_census: outcomes,/);
  });
});
