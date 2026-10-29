// unreachable-cohort.test.mjs — a person we serve who cannot receive mail must be reported by name.
//
// scheduler.mjs drops suppressed recipients BEFORE scoring, which also drops them from the coverage
// denominator, so `silent_no_send` can never fire for them. The fixture below has the shape that
// matters: the candidate's OWN address is fine and only the forwarding address (`email_config.notify`)
// has hard bounced, so any check keyed on `candidate.email` would pass while every send fails.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unreachableCohort, unreachableDetail, routingAddress } from "./unreachable-cohort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// A candidate whose forwarding address has hard bounced.
const FORWARDED = { email: "asha@example.com", status: "active", email_config: { notify: "asha.fwd@example.net" } };
const SUPPRESSED = new Map([["asha.fwd@example.net", "hard_bounce"]]);

describe("an active member we cannot reach is reported by name", () => {
  it("catches the bounced FORWARDING address even though the candidate's own address is clean", () => {
    // The assertion that fails against any check keyed on candidate.email.
    const bad = unreachableCohort({ candidates: [FORWARDED], suppressed: SUPPRESSED });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ email: "asha@example.com", routing: "asha.fwd@example.net", reason: "hard_bounce", viaNotify: true });
  });

  it("the detail line names the person, the failing address and the reason", () => {
    // What an operator reads at 2am: a name, not "dropped 1".
    expect(unreachableDetail(unreachableCohort({ candidates: [FORWARDED], suppressed: SUPPRESSED })))
      .toBe("asha@example.com (routed to asha.fwd@example.net) — hard_bounce");
  });

  it("catches a suppressed PRIMARY address too, and does not claim it was a forward", () => {
    const bad = unreachableCohort({ candidates: [{ email: "a@b.com", status: "active" }], suppressed: new Map([["a@b.com", "complaint"]]) });
    expect(bad).toHaveLength(1);
    expect(bad[0].viaNotify).toBe(false);
  });

  it("flags an ACTIVE member carrying an `unsubscribe` row (two tables disagreeing)", () => {
    // Not a resolved opt-out: this contradiction silently blocks role email while everything looks
    // green. Report it and let a human read the reason.
    const bad = unreachableCohort({ candidates: [{ email: "owner@x.com", status: "active" }], suppressed: { "owner@x.com": "unsubscribe" } });
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBe("unsubscribe");
  });

  it("says nothing about a reachable cohort — no crying wolf", () => {
    expect(unreachableCohort({ candidates: [{ email: "fine@x.com", status: "active" }], suppressed: new Map() })).toEqual([]);
  });

  it("ignores paused and unsubscribed people (their silence is the intended outcome)", () => {
    const rows = [
      { email: "paused@x.com", status: "paused" },
      { email: "gone@x.com", status: "unsubscribed" },
    ];
    expect(unreachableCohort({ candidates: rows, suppressed: new Map([["paused@x.com", "hard_bounce"], ["gone@x.com", "unsubscribe"]]) })).toEqual([]);
  });

  it("ignores anyone outside the cohort when a cohort predicate is given", () => {
    const rows = [FORWARDED, { email: "other@x.com", status: "active" }];
    const sup = new Map([...SUPPRESSED, ["other@x.com", "hard_bounce"]]);
    const bad = unreachableCohort({ candidates: rows, suppressed: sup, inCohort: (e) => e === FORWARDED.email });
    expect(bad.map((u) => u.email)).toEqual([FORWARDED.email]);
  });

  it("matches case-insensitively, because suppressions.address is stored lower-case", () => {
    const bad = unreachableCohort({ candidates: [{ email: "Mixed@Case.com", status: "active" }], suppressed: new Map([["mixed@case.com", "hard_bounce"]]) });
    expect(bad).toHaveLength(1);
  });

  it("treats a missing status as active (a row we would still try to mail)", () => {
    expect(unreachableCohort({ candidates: [{ email: "a@b.com" }], suppressed: new Map([["a@b.com", "hard_bounce"]] ) })).toHaveLength(1);
  });

  it("routingAddress prefers notify, falls back to the candidate's own address", () => {
    expect(routingAddress(FORWARDED)).toBe("asha.fwd@example.net");
    expect(routingAddress({ email: "A@B.com", email_config: {} })).toBe("a@b.com");
    expect(routingAddress({})).toBe("");
  });
});

describe("both the run and the watchdog say it out loud", () => {
  const scheduler = read("scheduler.mjs");
  const watchdog = read("watchdog.mjs");

  it("the scheduler no longer drops suppressed candidates with only a count", () => {
    expect(scheduler).toMatch(/unreachableCohort\(\{ candidates, suppressed: reasons \}\)/);
    expect(scheduler).toMatch(/UNREACHABLE:/);
  });

  it("the scheduler reports the unreachable set to Sentry, not just the log", () => {
    // A log line vanishes when the host's log window rolls; the alarm has to reach a human.
    const cap = scheduler.match(/captureError\([^;]*kind: "unreachable_cohort"[^;]*\);/);
    expect(cap).not.toBeNull();
    expect(cap[0]).toMatch(/unreachableDetail\(unreachable\)/);
  });

  it("a failed suppression read is reported as UNKNOWN, never as all-clear", () => {
    // suppressionReasons returns null (not an empty Map) on error precisely so these cannot be
    // confused. If this ever silently becomes `|| new Map()`, the alarm reports everyone reachable.
    expect(scheduler).toMatch(/if \(reasons === null\)/);
    expect(scheduler).toMatch(/REACHABILITY UNKNOWN/);
    expect(scheduler).toMatch(/kind: "reachability_unknown"/);
  });

  it("the store distinguishes 'nobody blocked' from 'could not check'", () => {
    const store = read("charlie-store.mjs");
    const fn = store.match(/export async function suppressionReasons[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/return null;/); // the error path
    expect(fn[0]).toMatch(/return new Map\(/); // the success path
  });

  it("the watchdog runs the reachability check as a FAILURE, not a warning", () => {
    // warn() never triggers an owner alert on its own, so a warning here would be silent — the same
    // blind spot one level up. This must be add().
    const fn = watchdog.match(/async function checkCohortReachable\(\)[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/add\(\s*\n?\s*"every active user can actually receive mail"/);
    expect(watchdog).toMatch(/await checkCohortReachable\(\);/);
  });

  it("the watchdog check is scoped to the cohort actually being served", () => {
    const fn = watchdog.match(/async function checkCohortReachable\(\)[\s\S]*?\n\}/);
    // There is no allowlist on the send path, so the check is scoped to EVERY active user.
    expect(fn[0]).not.toMatch(/inCohort:/);
    expect(fn[0]).toMatch(/\.eq\("status", "active"\)/);
  });

  it("the watchdog reports the reachable count, so it cannot pass vacuously", () => {
    // "0 checked, 0 unreachable" must never read as a pass: the denominator is every active user, and
    // the count is printed.
    const fn = watchdog.match(/async function checkCohortReachable\(\)[\s\S]*?\n\}/);
    // The denominator is listActiveCandidates, and a run with zero active users fails elsewhere.
    expect(fn[0]).toMatch(/active user\(s\), all reachable/);
  });

  it("the check and the send resolve the recipient the same way", () => {
    // If these two ever diverge we check one address and mail another — the exact shape of the bug.
    expect(scheduler).toMatch(/const to = u\.email_config\?\.notify \|\| u\.email;/);
    const lib = read("lib/unreachable-cohort.mjs");
    expect(lib).toMatch(/candidate\?\.email_config\?\.notify \|\| candidate\?\.email/);
  });
});
