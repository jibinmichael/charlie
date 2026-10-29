// lib/env-parity.mjs — which config MUST be identical on both Railway services, DERIVED not declared.
//
// THE BUG CLASS. A flag such as `EDGE_ENGINE` set `on` for one service and `off` for the other, or a
// secret such as `CHARLIE_TOKEN_SECRET` present on `charlie` and missing on `charlie-engine` (which
// stops the daily send outright). A flag that means one thing in the cron and another in the server is
// not a config nit — it decides which people get role email and what those emails say.
//
// WHY DERIVED. A hand-written list of "flags that must match" is prose, and prose goes stale the first
// time somebody adds a flag. So the list is computed from the code: walk the import graph from each
// service's real entrypoints, collect every `process.env.X` read inside that graph, and intersect. A
// var read by code BOTH services execute must have the same value on both. Add a flag to a shared
// module and it joins the contract automatically; a var only the cron reads never enters it at all.
//
// The engine's entrypoints are parsed out of package.json's `engine:run`, so the chain cannot drift
// from the contract either.
//
// LIMITS, stated rather than papered over:
//   - Static analysis of literal `import ... from "./x.mjs"` only. A dynamic import() or a computed
//     key (`process.env[`HEARTBEAT_URL_${job}`]`) is invisible here, so the derived set is a FLOOR:
//     everything in it really is shared, but something shared could be missed.
//   - It says nothing about whether a value is CORRECT — only whether the two services agree.
// Both limits are why this reports, and does not gate a send.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A var that is a SECRET or a per-service address is out of scope for value comparison: we compare
// presence, never the value, and never print it. (Both services legitimately hold the same secret; the
// point is that one of them is not silently missing it.)
export const SECRET_PATTERN = /KEY|SECRET|TOKEN|DSN|PASSWORD/i;

// Vars Railway itself injects per service: they are SUPPOSED to differ, and comparing them would be
// pure noise that teaches an operator to ignore the report.
export const PLATFORM_PREFIX = /^(RAILWAY_|PORT$|NIXPACKS_)/;

/** The entrypoint files of each service, read from the code rather than remembered. */
export function serviceEntrypoints() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const chain = String(pkg.scripts?.["engine:run"] || "");
  // Every `node x.mjs` / `tsx x.mjs` in the cron chain (flags such as --max-old-space-size allowed
  // between the runtime and the file), in order, deduped.
  const engine = [...new Set([...chain.matchAll(/(?:^|&&|;|\s)(?:node|tsx)(?:\s+--[\w=.-]+)*\s+([\w./-]+\.(?:mjs|ts))/g)].map((m) => m[1]))];
  return { charlie: ["server/charlie-remote.ts"], "charlie-engine": engine };
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const ENV_RE = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // a package, not our code
  const p = resolve(dirname(fromFile), spec);
  for (const cand of [p, `${p}.mjs`, `${p}.ts`, join(p, "index.mjs")]) if (existsSync(cand)) return cand;
  return null;
}

/** Every repo file reachable by static import from `entry`, plus `entry` itself. */
export function importClosure(entries) {
  const seen = new Set();
  const stack = entries.map((e) => join(ROOT, e)).filter((f) => existsSync(f));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of src.matchAll(IMPORT_RE)) {
      const next = resolveLocal(f, m[1]);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return [...seen].map((f) => relative(ROOT, f).split(sep).join("/")).sort();
}

/** Every literal `process.env.X` name read anywhere in a set of repo-relative files. */
export function envReads(files) {
  const out = new Map(); // VAR -> [files]
  for (const rel of files) {
    let src;
    try { src = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
    for (const m of src.matchAll(ENV_RE)) {
      const name = m[1] || m[2];
      if (!name) continue;
      if (!out.has(name)) out.set(name, []);
      if (!out.get(name).includes(rel)) out.get(name).push(rel);
    }
  }
  return out;
}

// Vars whose NAME is built at runtime, so no literal-scanning regex can ever see them. Reporting one
// of these as "nothing reads it" would be a false alarm, and a report that cries wolf once gets ignored
// forever — `HEARTBEAT_URL_MATCH_SEND` is read as process.env[`HEARTBEAT_URL_${job.toUpperCase()}`],
// and calling it dead config would be exactly the wrong answer.
//
// Kept as an explicit prefix list rather than inferred, so adding a new dynamic family is a visible
// decision. A test asserts every `process.env[`...${` site in the repo has its prefix listed here.
export const DYNAMIC_PREFIXES = ["HEARTBEAT_URL_"];
export const isDynamicVar = (v) => DYNAMIC_PREFIXES.some((p) => String(v).startsWith(p));

// Every literal env name read ANYWHERE in the repo, including files no entrypoint statically imports
// (the `scripts/` tools, and anything reached only by a dynamic import). This is the honest test for
// "nothing reads this var at all" — a var set on Railway with no reader is stale config that makes the
// next person believe a flag is live when it does nothing.
const CODE_DIRS = ["lib", "prompts", "server", "emails", "scripts", "voice"];
export function repoEnvReads() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.|__)/.test(e.name)) walk(full); continue; }
      if (/\.(mjs|ts|tsx)$/.test(e.name)) files.push(relative(ROOT, full).split(sep).join("/"));
    }
  };
  try { for (const e of readdirSync(ROOT, { withFileTypes: true })) if (e.isFile() && /\.(mjs|ts)$/.test(e.name)) files.push(e.name); } catch { /* empty */ }
  for (const d of CODE_DIRS) walk(join(ROOT, d));
  return envReads(files);
}

/**
 * The derived contract: vars read by code BOTH services run, so they must hold the same value.
 * @returns {{shared: string[], charlieOnly: string[], engineOnly: string[], readers: Map<string,string[]>}}
 */
export function mustMatchVars() {
  const eps = serviceEntrypoints();
  const cFiles = importClosure(eps.charlie);
  const eFiles = importClosure(eps["charlie-engine"]);
  const cEnv = envReads(cFiles);
  const eEnv = envReads(eFiles);
  const keep = (v) => !PLATFORM_PREFIX.test(v);
  const shared = [...cEnv.keys()].filter((v) => eEnv.has(v) && keep(v)).sort();
  const readers = new Map(shared.map((v) => [v, [...new Set([...(cEnv.get(v) || []), ...(eEnv.get(v) || [])])].sort()]));
  return {
    shared,
    charlieOnly: [...cEnv.keys()].filter((v) => !eEnv.has(v) && keep(v)).sort(),
    engineOnly: [...eEnv.keys()].filter((v) => !cEnv.has(v) && keep(v)).sort(),
    readers,
  };
}

/**
 * Compare two services' actual config against the derived contract.
 *
 * Values of secret-shaped vars are compared but NEVER returned, so a report can be pasted anywhere.
 *
 * @param {Record<string,string>} charlie  var -> value, as Railway holds it
 * @param {Record<string,string>} engine
 * @param {string[]} [shared]  override the derived list (tests)
 * @returns {{diverged: object[], missing: object[], ok: boolean}}
 */
export function parityReport(charlie, engine, shared = mustMatchVars().shared) {
  const diverged = [], missing = [];
  const has = (o, v) => Object.prototype.hasOwnProperty.call(o || {}, v) && String(o[v] ?? "").trim() !== "";
  for (const v of shared) {
    const inC = has(charlie, v), inE = has(engine, v);
    if (!inC && !inE) continue; // set on neither: both fall back identically, so they still agree
    if (inC !== inE) {
      // A var present on one service only. Code usually falls back to a default when a var is
      // missing, which masks the gap — exactly why absence has to be reported.
      missing.push({ var: v, presentOn: inC ? "charlie" : "charlie-engine", absentOn: inC ? "charlie-engine" : "charlie" });
      continue;
    }
    if (String(charlie[v]).trim() !== String(engine[v]).trim()) {
      const secret = SECRET_PATTERN.test(v);
      diverged.push({ var: v, charlie: secret ? "<differs, value withheld>" : String(charlie[v]).trim(), engine: secret ? "<differs, value withheld>" : String(engine[v]).trim() });
    }
  }
  return { diverged, missing, ok: diverged.length === 0 && missing.length === 0 };
}

/** The shared vars a fingerprint may cover: non-secret, non-platform. */
export function fingerprintVars(shared = mustMatchVars().shared) {
  return shared.filter((v) => !SECRET_PATTERN.test(v) && !PLATFORM_PREFIX.test(v));
}

/**
 * A short digest of the shared FLAG values, so the two services can be compared unattended without
 * either one seeing the other's variables. `/healthz` publishes it; watchdog.mjs computes its own and
 * compares. A hash, so the endpoint stays as public as it already is.
 *
 * SECRETS ARE EXCLUDED. Not because the digest is reversible in practice, but because publishing a
 * function of a secret buys nothing here: key presence is already covered by preflight's required-env
 * check, and by scripts/env-parity.mjs, which can see both services' variables directly.
 *
 * A mismatch says "these two disagree", never which var — that is what scripts/env-parity.mjs is for,
 * and the watchdog detail says so instead of leaving the operator to guess.
 */
export function flagFingerprint(env = process.env, shared = mustMatchVars().shared) {
  const vars = fingerprintVars(shared);
  const h = createHash("sha256");
  for (const v of vars) h.update(v).update("\0").update(String(env[v] ?? "")).update("\0");
  return { hash: h.digest("hex").slice(0, 12), vars: vars.length };
}
