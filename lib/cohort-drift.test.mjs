// cohort-drift.test.mjs — the allowlist and the candidate table must not disagree in silence.
//
// A watchdog warning never triggers the alert email on its own, so the grading is what makes drift
// actionable: "a brand-new signup legitimately sits here for a day" is the reason this is not a hard
// failure, so the AGE is the entire signal. A list of names with no ages makes a day-old signup and a
// five-day-old hole look identical.

import { describe, it, expect } from "vitest";
import { cohortDrift, GRACE_DAYS } from "./cohort-drift.mjs";

const NOW = Date.parse("2026-08-07T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();
const inCohort = (set) => (email) => set.has(String(email || "").toLowerCase());

describe("cohortDrift — active users outside the allowlist", () => {
  const candidates = [
    { email: "served@x.com", created_at: daysAgo(30) },
    { email: "new@x.com", created_at: daysAgo(0) },
    { email: "yesterday@x.com", created_at: daysAgo(1) },
    { email: "twodays@x.com", created_at: daysAgo(2) },
    { email: "olddrift@x.com", created_at: daysAgo(9) },
  ];
  const out = cohortDrift({ candidates, cohortRaw: "served@x.com", inCohort: inCohort(new Set(["served@x.com"])), now: NOW });

  it("counts everyone off the allowlist, not a sample of them", () => {
    expect(out.orphans).toHaveLength(4);
    expect(out.orphans.map((o) => o.email)).not.toContain("served@x.com");
  });

  it("reports how long each has been waiting", () => {
    const byEmail = Object.fromEntries(out.orphans.map((o) => [o.email, o.days]));
    expect(byEmail["new@x.com"]).toBe(0);
    expect(byEmail["yesterday@x.com"]).toBe(1);
    expect(byEmail["olddrift@x.com"]).toBe(9);
  });

  it("puts the worst case first", () => {
    expect(out.orphans[0].email).toBe("olddrift@x.com");
  });

  it("only the ones past the grace window escalate — a day-2 first role is the design", () => {
    expect(GRACE_DAYS).toBe(2);
    expect(out.overdue.map((o) => o.email).sort()).toEqual(["olddrift@x.com", "twodays@x.com"]);
  });

  it("an unknown age is OVERDUE, never quietly inside the grace window", () => {
    // The fail-closed case. A missing created_at must not let somebody hide forever.
    const o = cohortDrift({ candidates: [{ email: "ghost@x.com", created_at: null }], cohortRaw: "", inCohort: () => false, now: NOW });
    expect(o.orphans[0].days).toBeNull();
    expect(o.overdue).toHaveLength(1);
    expect(o.orphans[0].email).toBe("ghost@x.com"); // and it sorts to the top
  });

  it("says nothing when the two agree", () => {
    const o = cohortDrift({ candidates: [{ email: "a@x.com", created_at: daysAgo(5) }], cohortRaw: "a@x.com", inCohort: inCohort(new Set(["a@x.com"])), now: NOW });
    expect(o.orphans).toEqual([]);
    expect(o.overdue).toEqual([]);
    expect(o.stale).toEqual([]);
  });
});

describe("cohortDrift — allowlisted addresses that are no longer active", () => {
  // The same drift the other way: addresses still allowlisted with no active candidate behind them.
  const candidates = [{ email: "live@x.com", created_at: daysAgo(10) }];

  it("names every address in the allowlist with no active candidate behind it", () => {
    const out = cohortDrift({
      candidates,
      cohortRaw: "live@x.com, former.one@example.com, former.two@example.com, former.three@example.org",
      inCohort: inCohort(new Set(["live@x.com"])),
      now: NOW,
    });
    expect(out.stale).toEqual(["former.one@example.com", "former.two@example.com", "former.three@example.org"]);
  });

  it("is case- and whitespace-insensitive, like the allowlist itself", () => {
    const out = cohortDrift({ candidates, cohortRaw: "  LIVE@x.com  ", inCohort: inCohort(new Set(["live@x.com"])), now: NOW });
    expect(out.stale).toEqual([]);
  });

  it("an empty or unset allowlist reports no stale addresses (that is the other check's job)", () => {
    expect(cohortDrift({ candidates, cohortRaw: "", inCohort: () => false, now: NOW }).stale).toEqual([]);
    expect(cohortDrift({ candidates, inCohort: () => false, now: NOW }).stale).toEqual([]);
  });
});

describe("cohortDrift — never throws on junk", () => {
  it("survives no arguments at all", () => {
    expect(cohortDrift()).toEqual({ orphans: [], overdue: [], stale: [] });
  });

  it("treats a missing predicate as 'nobody is allowlisted' (fail closed, loud)", () => {
    const out = cohortDrift({ candidates: [{ email: "a@x.com", created_at: daysAgo(5) }], now: NOW });
    expect(out.orphans).toHaveLength(1);
  });
});
