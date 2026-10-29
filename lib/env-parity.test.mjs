// env-parity.test.mjs — the config both services must agree on (lib/env-parity.mjs).
//
// THE BUG CLASS: a flag such as `EDGE_ENGINE` `on` for `charlie` and `off` for `charlie-engine`, or a
// secret such as `CHARLIE_TOKEN_SECRET` set on the server and missing on the cron. Neither is
// detectable unless something says which config the two services share.
//
// The contract is DERIVED from the import graph rather than declared, because a hand-written list of
// "flags that must match" is prose and goes stale the first time somebody adds a flag. These tests are
// therefore about the derivation itself: that it finds the vars we know are shared, excludes the ones we
// know are not, and cannot quietly report an all-clear.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  serviceEntrypoints, importClosure, envReads, repoEnvReads, mustMatchVars,
  parityReport, flagFingerprint, fingerprintVars, isDynamicVar, DYNAMIC_PREFIXES, SECRET_PATTERN,
} from "./env-parity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("the contract is derived from the code, not remembered", () => {
  it("reads the engine's entrypoints out of package.json's engine:run", () => {
    // If the cron chain changes, the contract changes with it. A list typed here would not.
    const eps = serviceEntrypoints();
    expect(eps.charlie).toEqual(["server/charlie-remote.ts"]);
    expect(eps["charlie-engine"]).toContain("scheduler.mjs");
    expect(eps["charlie-engine"]).toContain("preflight.mjs");
    expect(eps["charlie-engine"]).toContain("watchdog.mjs");
    // and it really is parsed, not hardcoded: every entry appears in the script string
    const chain = JSON.parse(read("package.json")).scripts["engine:run"];
    for (const f of eps["charlie-engine"]) expect(chain).toContain(f);
  });

  it("walks real imports, so a shared module lands in both closures", () => {
    const c = importClosure(["server/charlie-remote.ts"]);
    const e = importClosure(["scheduler.mjs"]);
    for (const f of ["charlie-store.mjs", "lib/send-guard.mjs"]) {
      expect(c, `charlie must reach ${f}`).toContain(f);
      expect(e, `engine must reach ${f}`).toContain(f);
    }
  });

  it("puts the flags that decide a role email in the MUST-MATCH set", () => {
    // Each of these is read by a module both services execute, so a mismatch changes who gets mail or
    // what it says.
    const { shared } = mustMatchVars();
    // ROLE_COHORT is not here: it gates no send path, so a disagreement cannot change who receives a
    // role. VOYAGE_SEMANTIC and GROUNDING_MODE are cron-only, because only the cron composes and sends
    // role email (asserted below). VERIFY_MODE is shared: the server's Sourcing & Outreach agent checks
    // every "why you" line with the same grounding verifier.
    for (const v of ["EDGE_ENGINE", "GIFT_A_ROLE", "MATCH_BAR", "FIT_FLOOR", "KNOCKOUT_MODE", "RETRIEVAL_MODE", "CHARLIE_FROM", "CHARLIE_TOKEN_SECRET", "VERIFY_MODE"]) {
      expect(shared, `${v} must be in the must-match contract`).toContain(v);
    }
  });

  it("keeps single-service config OUT, so the report does not cry wolf", () => {
    // A var only one service reads cannot diverge in any way that matters. FRESHNESS_MODE/MATCH_CACHE
    // are cron-only; COMPANY_CONTEXT and the drips are server-only.
    const { shared, charlieOnly, engineOnly } = mustMatchVars();
    for (const v of ["FRESHNESS_MODE", "MATCH_CACHE", "MAX_RUN_COST_USD", "VOYAGE_SEMANTIC", "GROUNDING_MODE"]) {
      expect(shared).not.toContain(v);
      expect(engineOnly).toContain(v);
    }
    for (const v of ["COMPANY_CONTEXT", "WEDGE_DRIP", "GAME_PLAN"]) {
      expect(shared).not.toContain(v);
      expect(charlieOnly).toContain(v);
    }
    // MARKETGAP_DROP is read by neither service: market-gap.mjs is in no deployed import graph and runs
    // only as a hand-run command, `node market-gap.mjs <email>`. If it is ever wired into a scheduled
    // run, this assertion fails and reminds whoever moves it to re-home the flag with it.
    for (const v of ["MARKETGAP_DROP"]) {
      expect(shared, `${v} is shared again`).not.toContain(v);
      expect(charlieOnly, `${v} is back on the server — re-home the flag deliberately`).not.toContain(v);
      expect(engineOnly, `${v} joined the cron — say so here`).not.toContain(v);
    }
  });

  it("ignores the vars Railway injects per service", () => {
    const { shared } = mustMatchVars();
    expect(shared.some((v) => v.startsWith("RAILWAY_"))).toBe(false);
    expect(shared).not.toContain("PORT");
  });

  it("finds env reads in files no entrypoint imports (the scripts)", () => {
    const all = repoEnvReads();
    expect(all.has("SEED_ONLY")).toBe(true); // read only by scripts/seed-us-testers.mjs
    expect(all.size).toBeGreaterThan(100);
  });

  it("every runtime-built env name has its prefix declared", () => {
    // The one way the dead-config report can produce a FALSE alarm: a var whose name is assembled at
    // runtime is invisible to a literal scan (HEARTBEAT_URL_MATCH_SEND, for one). A single false alarm
    // is enough to make an operator ignore the report.
    const files = [];
    const walk = (d, base) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (e.isDirectory()) { if (!/^(node_modules|\.)/.test(e.name)) walk(join(d, e.name), base); continue; }
        // Test files are not deployed, and this file itself contains the pattern in a comment.
        if (!/\.(mjs|ts)$/.test(e.name) || /\.test\.[cm]?[jt]s$/.test(e.name)) continue;
        // `.tmp.` files are scratch probes another test file creates and deletes INSIDE a scanned
        // directory (lib/build-id.test.mjs writes lib/__buildid-probe.tmp.mjs to prove the fingerprint
        // tracks content). Vitest runs files in parallel, so this walk can see one that is already gone.
        if (/\.tmp\.[cm]?[jt]s$/.test(e.name)) continue;
        files.push(join(d, e.name));
      }
    };
    for (const d of [".", "lib", "server", "scripts", "voice"]) walk(d);
    const found = new Set();
    for (const f of files) {
      // And tolerate a file that vanished between readdir and read anyway. This assertion exists to
      // catch an undeclared dynamic env prefix; failing it because a sibling test cleaned up mid-walk
      // reports a problem that is not there, and an intermittently-red suite teaches you to re-run CI
      // instead of reading it.
      let src;
      try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      // process.env[`PREFIX${...   — capture the literal prefix
      for (const m of src.matchAll(/process\.env\[\s*`([A-Z0-9_]+)\$\{/g)) found.add(m[1]);
    }
    for (const p of found) expect(DYNAMIC_PREFIXES, `process.env[\`${p}\${...}\`] is read somewhere; add "${p}" to DYNAMIC_PREFIXES or the dead-config report will call it dead`).toContain(p);
    expect(isDynamicVar("HEARTBEAT_URL_MATCH_SEND")).toBe(true);
    expect(isDynamicVar("EDGE_ENGINE")).toBe(false);
  });
});

describe("the comparison catches both shapes of drift", () => {
  const SHARED = ["EDGE_ENGINE", "CHARLIE_TOKEN_SECRET"];

  it("catches a flag with DIFFERENT values — the EDGE_ENGINE case", () => {
    const r = parityReport({ EDGE_ENGINE: "on" }, { EDGE_ENGINE: "off" }, SHARED);
    expect(r.ok).toBe(false);
    expect(r.diverged).toEqual([{ var: "EDGE_ENGINE", charlie: "on", engine: "off" }]);
  });

  it("catches a var set on ONE service — the CHARLIE_TOKEN_SECRET case", () => {
    // A missing secret stops the daily send. A missing var does not error: the code falls back to a
    // default, which is why absence has to be REPORTED rather than discovered later.
    const r = parityReport({ CHARLIE_TOKEN_SECRET: "abc" }, {}, SHARED);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([{ var: "CHARLIE_TOKEN_SECRET", presentOn: "charlie", absentOn: "charlie-engine" }]);
  });

  it("treats blank as absent — an empty var is not a value", () => {
    const r = parityReport({ EDGE_ENGINE: "on" }, { EDGE_ENGINE: "   " }, SHARED);
    expect(r.missing.map((m) => m.var)).toEqual(["EDGE_ENGINE"]);
  });

  it("never prints a secret's value, even when it diverges", () => {
    const r = parityReport({ CHARLIE_TOKEN_SECRET: "aaa" }, { CHARLIE_TOKEN_SECRET: "bbb" }, SHARED);
    expect(r.diverged[0]).toEqual({ var: "CHARLIE_TOKEN_SECRET", charlie: "<differs, value withheld>", engine: "<differs, value withheld>" });
    expect(JSON.stringify(r)).not.toContain("aaa");
    expect(JSON.stringify(r)).not.toContain("bbb");
  });

  it("is quiet when a shared var is unset on BOTH (they still agree)", () => {
    expect(parityReport({}, {}, SHARED).ok).toBe(true);
  });

  it("is quiet when everything matches", () => {
    const both = { EDGE_ENGINE: "on", CHARLIE_TOKEN_SECRET: "x" };
    expect(parityReport(both, { ...both }, SHARED)).toEqual({ diverged: [], missing: [], ok: true });
  });
});

describe("the published fingerprint is comparable and safe", () => {
  it("differs when a shared flag differs, and matches when it does not", () => {
    const shared = ["EDGE_ENGINE", "MATCH_BAR"];
    const a = flagFingerprint({ EDGE_ENGINE: "on", MATCH_BAR: "70" }, shared);
    const b = flagFingerprint({ EDGE_ENGINE: "off", MATCH_BAR: "70" }, shared);
    const c = flagFingerprint({ EDGE_ENGINE: "on", MATCH_BAR: "70" }, shared);
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toBe(c.hash);
    expect(a.vars).toBe(2);
  });

  it("does not cover secrets, so /healthz publishes no function of a key", () => {
    const vars = fingerprintVars(mustMatchVars().shared);
    expect(vars.some((v) => SECRET_PATTERN.test(v))).toBe(false);
    // and changing a secret must not move the hash
    const shared = ["EDGE_ENGINE", "CHARLIE_TOKEN_SECRET"];
    expect(flagFingerprint({ EDGE_ENGINE: "on", CHARLIE_TOKEN_SECRET: "a" }, shared).hash)
      .toBe(flagFingerprint({ EDGE_ENGINE: "on", CHARLIE_TOKEN_SECRET: "b" }, shared).hash);
  });

  it("treats an unset var the same on both sides", () => {
    const shared = ["EDGE_ENGINE", "NEVER_SET_ANYWHERE"];
    expect(flagFingerprint({ EDGE_ENGINE: "on" }, shared).hash).toBe(flagFingerprint({ EDGE_ENGINE: "on", NEVER_SET_ANYWHERE: "" }, shared).hash);
  });
});

describe("the check is wired where it runs unattended", () => {
  it("/healthz publishes the hash and the var count", () => {
    const server = read("server/charlie-remote.ts");
    expect(server).toMatch(/const FLAGS = flagFingerprint\(\);/);
    expect(server).toMatch(/app\.get\("\/healthz",[^\n]*flags: FLAGS\.hash/);
  });

  it("the watchdog compares hashes and says how to find the offending var", () => {
    const watchdog = read("watchdog.mjs");
    const fn = watchdog.match(/function checkFlagParity\(healthz\)[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/mine\.hash === healthz\.flags/);
    expect(fn).toMatch(/scripts\/env-parity\.mjs/); // actionable, not just "something is wrong"
    expect(fn).not.toMatch(/\badd\(/); // warn only: config drift must not make a good send look CRASHED
    // A server that does not publish a hash must read as "cannot compare", never as agreement.
    expect(fn).toMatch(/cannot compare/);
    expect(watchdog).toMatch(/checkFlagParity\(j\)/);
  });

  it("the operator script exits non-zero on drift, so it can gate a deploy", () => {
    const script = read("scripts/env-parity.mjs");
    expect(script).toMatch(/process\.exit\(r\.ok \? 0 : 1\)/);
    expect(script).toMatch(/--json/); // parsed, not scraped off the CLI's table output
  });
});
