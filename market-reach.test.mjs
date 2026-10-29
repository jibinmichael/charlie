// market-reach.test.mjs — the filter that decides what the scan may delete.
//
// A large share of scanned roles are reachable by neither India nor the US. That dead weight inflates
// jobs.json toward V8's single-string ceiling, so the scan can drop it.
//
// THE RISK THIS FILE GUARDS. Every other gate in Charlie skips ONE role for ONE person. This one
// deletes a role for EVERYONE, at scan time, before any person is considered. A reachability rule that
// reads the wrong field silences many users while every check stays green. So the tests below are
// weighted toward "it must not delete", not "it deletes correctly".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reachableByAnyMarket, safeToDelete, shadowReport, reachMode, MARKETS } from "./lib/market-reach.mjs";

const job = (over = {}) => ({ id: "greenhouse:acme:1", company: "Acme", title: "Engineer", location: "Berlin, Germany", description: "x".repeat(200), ...over });

let saved;
beforeEach(() => { saved = process.env.MARKET_REACH_FILTER; });
afterEach(() => { if (saved === undefined) delete process.env.MARKET_REACH_FILTER; else process.env.MARKET_REACH_FILTER = saved; });

describe("mode is read at call time, never frozen at import", () => {
  it("defaults to off, so the filter is inert until someone turns it on", () => {
    delete process.env.MARKET_REACH_FILTER;
    expect(reachMode()).toBe("off");
  });

  it("an unknown value falls back to off rather than guessing", () => {
    process.env.MARKET_REACH_FILTER = "yes-please";
    expect(reachMode()).toBe("off");
  });

  it("shadow is readable after import, not frozen at load", () => {
    // A module-level const would freeze this at import and silently ignore the env var.
    process.env.MARKET_REACH_FILTER = "shadow";
    expect(reachMode()).toBe("shadow");
  });

  it("ENFORCE IS REFUSED and downgraded to shadow", () => {
    // The basis this would delete on fires for most plainly-US "City, ST" roles and for strings like
    // "Office based" that name no place at all. Deleting on it would remove thousands of real,
    // reachable roles from every user at once, so the code refuses until the geo rule is fixed.
    process.env.MARKET_REACH_FILTER = "enforce";
    expect(reachMode()).toBe("shadow");
  });
});

describe("reachability: keep when in doubt", () => {
  it("an India role is reachable", () => {
    expect(reachableByAnyMarket(job({ location: "Bengaluru, India" }))).toBe(true);
  });

  it("a US role is reachable", () => {
    expect(reachableByAnyMarket(job({ location: "Austin, TX, United States" }))).toBe(true);
  });

  it("a role in a market we do not serve is not reachable", () => {
    expect(reachableByAnyMarket(job({ location: "Berlin, Germany" }))).toBe(false);
  });

  it("FAILS OPEN on a malformed role — an error must never delete", () => {
    // A kept-but-unreachable role costs a few kilobytes and the send gate drops it later anyway.
    // A wrongly-deleted role is gone for every user with no trace. Keep, always.
    const exploding = { get location() { throw new Error("corrupt row"); } };
    expect(reachableByAnyMarket(exploding)).toBe(true);
  });

  it("keeps a role with no location rather than deleting what it cannot read", () => {
    // The SEND gate correctly refuses a role it cannot place. The DELETE filter must not: an
    // unlocatable role could be in Bengaluru, and deleting it removes it from everyone forever.
    const placeless = job({ location: null, description: "Great role, apply now" });
    expect(reachableByAnyMarket(placeless)).toBe(false); // send gate says no, as designed
    expect(safeToDelete(placeless)).toBe(false);         // and we still refuse to delete it
  });

  it("both served markets are consulted, not just the first", () => {
    expect(MARKETS).toContain("india");
    expect(MARKETS).toContain("us");
  });
});

describe("shadowReport measures without touching anything", () => {
  it("counts the unreachable and leaves the array untouched", () => {
    const jobs = [
      job({ id: "greenhouse:a:1", location: "Bengaluru, India" }),
      job({ id: "greenhouse:b:2", location: "Berlin, Germany" }),
      job({ id: "ashby:c:3", location: "Paris, France" }),
    ];
    const before = JSON.stringify(jobs);
    const rep = shadowReport(jobs);

    expect(rep.total).toBe(3);
    expect(rep.unreachable).toBe(2);
    expect(rep.pct).toBe("66.7");
    // NO byte figure: these in-memory objects carry uncapped descriptions (scan-jobs caps only when
    // writing jobs.json), so a size measured here would badly overstate the on-disk saving.
    expect(rep.mb).toBeUndefined();
    expect(rep.bytes).toBeUndefined();
    // THE ASSERTION THAT MATTERS: shadow mode is a measurement, so the input must be byte-identical
    // afterwards. If this ever fails, "shadow" has started deleting.
    expect(JSON.stringify(jobs)).toBe(before);
    expect(jobs).toHaveLength(3);
  });

  it("attributes the waste to a source, so a human can act on it", () => {
    const rep = shadowReport([
      job({ id: "workday:x:1", location: "Berlin, Germany" }),
      job({ id: "workday:x:2", location: "Munich, Germany" }),
      job({ id: "ashby:y:3", location: "Paris, France" }),
    ]);
    expect(rep.bySource.workday).toBe(2);
    expect(rep.bySource.ashby).toBe(1);
  });

  it("carries real sample rows, because a percentage alone cannot be reviewed", () => {
    const rep = shadowReport([job({ company: "Zalando", title: "Backend Engineer", location: "Berlin, Germany" })]);
    expect(rep.samples[0]).toContain("Zalando");
    expect(rep.samples[0]).toContain("Berlin");
  });

  it("caps samples so a 30,000-role report stays readable", () => {
    const many = Array.from({ length: 500 }, (_, i) => job({ id: `greenhouse:c:${i}`, location: "Berlin, Germany" }));
    const rep = shadowReport(many);
    expect(rep.unreachable).toBe(500);
    expect(rep.samples.length).toBeLessThanOrEqual(15);
  });

  it("survives an empty or junk input without throwing into the scan", () => {
    expect(shadowReport([]).total).toBe(0);
    expect(shadowReport(null).total).toBe(0);
    expect(shadowReport([null, undefined]).total).toBe(2);
  });
});

describe("safeToDelete: positive evidence only", () => {
  it("deletes a role that NAMES a place outside every market we serve", () => {
    expect(safeToDelete(job({ location: "Berlin, Germany" }))).toBe(true);
    expect(safeToDelete(job({ location: "Singapore" }))).toBe(true);
  });

  it("never deletes a role either market can take", () => {
    expect(safeToDelete(job({ location: "Bengaluru, India" }))).toBe(false);
    expect(safeToDelete(job({ location: "Austin, TX, United States" }))).toBe(false);
  });

  it("never deletes on uncertainty — the difference between foreign and unknown", () => {
    // Each of these is REJECTED by the send gate for a reason that is not "it is somewhere else".
    // Deleting on any of them would remove roles from everyone on the basis of a missing field, which
    // would silently empty the pool.
    for (const j of [
      job({ location: null, description: "no place stated" }),
      job({ location: "", description: "no place stated" }),
    ]) {
      expect(safeToDelete(j), `refused to keep: ${JSON.stringify(j.location)}`).toBe(false);
    }
  });

  it("an exception can never cause a deletion", () => {
    expect(safeToDelete({ get location() { throw new Error("corrupt"); } })).toBe(false);
  });
});
