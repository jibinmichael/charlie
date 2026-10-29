// one-path.test.mjs — there is ONE serving track, and nothing between runs may score the job pool.
//
// Every cohort, new signup or existing, is served by the same weekly run. A second way to serve a
// person — a task queued after signup, a fallback that sends immediately, a sweep that scores on a
// timer — runs a full parallel copy of the send pipeline (dozens of model calls) triggered by an
// inbound email from a stranger, and none of it shows in a run's cost line because none of it happens
// during a run.
//
// WHY THIS IS A REACHABILITY TEST AND NOT A GREP. A test that asserts a source file contains some
// characters proves an author's intent, not behaviour. So this file walks the real import graph: from every setInterval callback registered by the
// server, follow relative imports transitively, and fail if any of them can reach a module that
// scores a job against a person. Re-introducing the behaviour three modules deep still fails.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// The four functions that turn a person and a posting into a score, each one a model call that costs
// money. Reaching any of them between runs is the thing this file forbids.
//
// FUNCTIONS, NOT FILES. Module reachability alone gives false positives: render-email.mjs imports
// `fitLane` from fit-coverage.mjs, a pure classifier that calls nothing, and that alone would make the
// whole server "reach the scorer". Importing a
// module for a helper is not spending money; calling computeCoverage is. So an import edge only
// counts when it actually carries one of these names.
const MONEY = ["matchBestRole", "runMatchBatch", "sendFirstRole"];

// `computeCoverage` is deliberately NOT in that list, and the reason is worth stating because it is
// the one hole here. It scores a single role rather than the pool, and one caller reachable from a
// timer still holds it: market-briefing.mjs, whose fit-ranked spotlight runs at dossier completion.
// A static import graph cannot see that it is switched off — so that half is pinned behaviourally
// instead, by spotlight-seniority.test.mjs ("STANDOUT_FIT is opt-in"), which proves the ranker
// returns null and spends nothing unless the flag is deliberately set. Two different tools, because
// no single one covers both halves.

/**
 * Relative imports of a file, as { path, names } — `names` being the named bindings taken from it.
 * A default or namespace import yields no names, which is correct here: none of MONEY is exported
 * that way, so it cannot arrive through one.
 */
function importsOf(absPath) {
  if (!existsSync(absPath)) return [];
  const src = readFileSync(absPath, "utf8");
  const out = [];
  for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}\s*from\s*)?["'](\.[^"']+)["']/g)) {
    const target = resolve(dirname(absPath), m[2]);
    if (!existsSync(target)) continue;
    const names = (m[1] || "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ path: target, names });
  }
  return out;
}

/**
 * Walk the import graph from `entry` and return every place a MONEY function is pulled in, as
 * "importer -> name". Empty means nothing downstream of this entry point can score anything.
 */
function moneyReachedFrom(entry) {
  const seen = new Set();
  const found = [];
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const cur = stack.pop();
    const rel = relative(ROOT, cur);
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const { path, names } of importsOf(cur)) {
      for (const n of names) if (MONEY.includes(n)) found.push(`${rel} -> ${n}`);
      stack.push(path);
    }
  }
  return found;
}

// ── the timers ───────────────────────────────────────────────────────────────────────────────────

const SERVER = "server/charlie-remote.ts";
const serverSrc = read(SERVER);

/** Sweep function names the server registers on a setInterval, mapped to the module they come from. */
function timerModules() {
  const called = [...serverSrc.matchAll(/setInterval\(\s*\(\)\s*=>\s*\{?\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const out = new Map();
  for (const name of new Set(called)) {
    const imp = serverSrc.match(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'](\\.[^"']+)["']`));
    out.set(name, imp ? imp[1] : null); // null = defined locally in the server file
  }
  return out;
}

describe("no timer can score a job against a person", () => {
  const timers = timerModules();

  it("found the timers (an empty map would pass every case below)", () => {
    expect(timers.size).toBeGreaterThanOrEqual(5);
    expect([...timers.keys()]).toContain("runTaskSweep");
  });

  for (const [name, mod] of timerModules()) {
    it(`${name} cannot reach a job scorer`, () => {
      // A locally-defined sweep (runTaskSweep) is covered by the server file's own import graph.
      const entry = mod ? join("server", mod) : SERVER;
      const hits = moneyReachedFrom(entry);
      expect(
        hits,
        `${name} reaches ${hits.join(", ")}. Scoring belongs in the weekly run, where its cost lands in the run's cost line.`,
      ).toEqual([]);
    });
  }

  it("the server itself never imports the first-role pipeline", () => {
    expect(serverSrc).not.toMatch(/from\s+["']\.\.\/first-role\.mjs["']/);
  });

  it("the two sweeps that scored the pool are not registered", () => {
    for (const gone of ["runMarketGapSweep", "runMarketBriefingSweep"]) {
      expect(serverSrc, `${gone} is back on a timer`).not.toMatch(new RegExp(`setInterval[^;]*${gone}`));
    }
  });

  // The run itself DOES score, and must. Without this, every assertion above could pass because a
  // function was renamed and MONEY no longer matches anything anywhere.
  it("the weekly run still reaches the scorer (proves MONEY is not a dead list)", () => {
    const hits = moneyReachedFrom("scheduler.mjs");
    expect(hits.length, "scheduler.mjs scores nothing — MONEY is stale, and every check above is vacuous").toBeGreaterThan(0);
  });
});

// ── one cohort ───────────────────────────────────────────────────────────────────────────────────

describe("the run serves everybody, with no age cohort", () => {
  const sched = read("scheduler.mjs");

  it("scheduler.mjs no longer reads ONBOARDING_GRACE_HOURS", () => {
    const code = sched.replace(/^\s*\/\/.*$/gm, ""); // comments explain the removal; they are not the behaviour
    expect(code, "the onboarding grace is back, and new users are held out of the only run there is")
      .not.toMatch(/ONBOARDING_GRACE_HOURS/);
  });

  it("scheduler.mjs does not filter candidates by how old they are", () => {
    const code = sched.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/graceHours/);
    expect(code, "an age-based filter on created_at is a cohort by another name")
      .not.toMatch(/candidates\s*=\s*candidates\.filter\([^)]*created_at/);
  });

  it("confirm-sweep no longer sends a role on dossier completion", () => {
    const code = read("confirm-sweep.mjs").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/sendFirstRole/);
  });

  it("nothing queues a first_role task any more", () => {
    const code = serverSrc.replace(/^\s*\/\/.*$/gm, "");
    expect(code, "the day-2 second track is back").not.toMatch(/kind:\s*["']first_role["']/);
  });
});
