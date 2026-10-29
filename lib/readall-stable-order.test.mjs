// readall-stable-order.test.mjs — paging without an ORDER BY is not paging.
//
// Supabase caps a read at 1000 rows, so readAll pages with `.range()`. Postgres guarantees no row
// order between two queries, so `.range(0,999)` followed by `.range(1000,1999)` can return
// overlapping windows of a shifting order: some rows come back twice and others never come back at
// all, while the total count still matches the table exactly.
//
// The guard is mechanical because the symptom is invisible: nothing errors, nothing is short, and the
// total matches the table exactly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../charlie-store.mjs", import.meta.url), "utf8");
const BODY = SRC.slice(SRC.indexOf("export async function readAll"), SRC.indexOf("export async function listActiveCandidates"));

describe("why this matters, demonstrated", () => {
  // Not a test of our code: a demonstration that the failure is real and silent, so the assertions
  // below are not cargo-culted. Two pages taken from a source whose order drifts between calls.
  it("unordered paging returns the right count and the wrong rows", () => {
    const table = Array.from({ length: 2000 }, (_, i) => i);
    let call = 0;
    const unorderedPage = (from, to) => {
      // The order changes between the two requests, exactly as Postgres is free to do.
      const view = call++ === 0 ? table : [...table.slice(500), ...table.slice(0, 500)];
      return view.slice(from, to + 1);
    };
    const got = [...unorderedPage(0, 999), ...unorderedPage(1000, 1999)];
    expect(got.length).toBe(2000);                 // the count is right
    expect(new Set(got).size).toBeLessThan(2000);  // the rows are not
  });

  it("ordered paging returns both", () => {
    const table = Array.from({ length: 2000 }, (_, i) => i);
    const orderedPage = (from, to) => [...table].sort((a, b) => a - b).slice(from, to + 1);
    const got = [...orderedPage(0, 999), ...orderedPage(1000, 1999)];
    expect(got.length).toBe(2000);
    expect(new Set(got).size).toBe(2000);
  });
});

describe("readAll pages in a stable order", () => {
  it("orders every page by a unique key", () => {
    expect(BODY, "readAll ranges without ordering; its pages can overlap").toMatch(/\.order\(orderKey/);
    expect(BODY).toMatch(/orderKey = orderKey \|\| PAGE_KEY\[table\] \|\| "id"/);
  });

  // NOT EVERY TABLE HAS AN `id`, and the ones that do not are among the largest: `candidates` is
  // keyed by email and `match_verdicts` by cache_key. Defaulting to id for those throws rather than
  // paging wrongly, but a send script stopping dead is not a fix either. Note database.types.ts lists
  // an id on candidates that the live schema does not have.
  it("knows the paging key for every table that has no id", () => {
    const map = SRC.slice(SRC.indexOf("const PAGE_KEY = {"), SRC.indexOf("};", SRC.indexOf("const PAGE_KEY = {")));
    for (const [table, key] of [["candidates", "email"], ["suppressions", "address"], ["match_verdicts", "cache_key"], ["join_applicants", "email"]]) {
      expect(map, `${table} has no id column; PAGE_KEY must name its key`).toMatch(new RegExp(`${table}:\\s*"${key}"`));
    }
  });

  it("range comes after order, or the ordering does not apply to the window", () => {
    expect(BODY).toMatch(/\.order\(orderKey[^;]*\)\s*\.range\(/);
  });

  it("the caller's own narrow is applied first, so their sort survives as the primary", () => {
    // Passing q => q.order("screen_score") must still sort by score; id is only the tiebreak that
    // stops the page boundary moving underneath it.
    expect(BODY).toMatch(/if \(narrow\) q = narrow\(q\);[\s\S]{0,240}\.order\(orderKey/);
  });

  it("a read error throws rather than returning a short answer", () => {
    expect(BODY).toMatch(/if \(error\) throw new Error/);
  });
});

describe("nothing hand-rolls its own pager any more", () => {
  it("the scripts that had one now use readAll", async () => {
    const { readdirSync } = await import("node:fs");
    const offenders = [];
    for (const f of readdirSync(new URL("../scripts", import.meta.url))) {
      if (!f.endsWith(".mjs")) continue;
      const s = readFileSync(new URL(`../scripts/${f}`, import.meta.url), "utf8");
      // A local pager that ranges without ordering is the same bug one directory over.
      if (/\.range\(\s*from\s*,/.test(s) && !/\.order\(/.test(s)) offenders.push(f);
    }
    expect(offenders, `hand-rolled unordered pager(s):\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
