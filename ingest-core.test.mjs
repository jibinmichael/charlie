// ingest-core.test.mjs — Vitest for the shared ingestion helpers.
// isIndiaRegion is the region-partition logic that keeps a company out of both the "yc" and
// "india" segments; runPool is the concurrency primitive both ingesters rely on.
import { describe, it, expect } from "vitest";
import { isIndiaRegion, runPool } from "./ingest-core.mjs";

describe("isIndiaRegion", () => {
  it("matches India and South Asia (case/space tolerant)", () => {
    expect(isIndiaRegion(["India"])).toBe(true);
    expect(isIndiaRegion(["South Asia"])).toBe(true);
    expect(isIndiaRegion(["America / Canada", " india "])).toBe(true);
  });
  it("is false for non-India regions, empty, or missing", () => {
    expect(isIndiaRegion(["America / Canada", "Europe"])).toBe(false);
    expect(isIndiaRegion([])).toBe(false);
    expect(isIndiaRegion(undefined)).toBe(false);
    expect(isIndiaRegion(null)).toBe(false);
  });
  it("does not match substrings like 'Indiana' or 'Indianapolis'", () => {
    expect(isIndiaRegion(["Indiana"])).toBe(false);
  });
});

describe("runPool", () => {
  it("runs every item, respecting the concurrency cap", async () => {
    const seen = [];
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      seen.push(n);
      active--;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it("handles an empty list without spawning workers", async () => {
    await expect(runPool([], 4, async () => { throw new Error("should not run"); })).resolves.toBeUndefined();
  });
});
