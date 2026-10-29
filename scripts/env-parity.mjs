// scripts/env-parity.mjs — check that the two Railway services agree on the config they share.
//
//   node scripts/env-parity.mjs              # report; exit 1 if anything diverges
//   node scripts/env-parity.mjs --contract    # also print the derived contract and who reads what
//
// Read-only. Sends nothing, writes nothing, costs $0. Needs the Railway CLI logged in and the project
// linked, since it reads both services' variables.
//
// The contract is DERIVED, not declared (lib/env-parity.mjs): it walks the import graph from each
// service's real entrypoints (the engine's read from package.json's `engine:run`), collects every
// literal `process.env.X` read, and intersects. A var both services' code reads must hold the same
// value on both; a var missing on one side silently falls back to a default, so it is reported too.
//
// SECRETS ARE NEVER PRINTED. A secret-shaped var is compared and reported as "differs, value
// withheld", so the output can be pasted into a PR.

import { execFileSync } from "node:child_process";
import { mustMatchVars, parityReport, repoEnvReads, isDynamicVar, SECRET_PATTERN, PLATFORM_PREFIX } from "../lib/env-parity.mjs";

const SERVICES = ["charlie", "charlie-engine"];

function railwayVars(service) {
  let raw;
  try {
    raw = execFileSync("railway", ["variables", "-s", service, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`could not read ${service} variables (${e.stderr?.toString().trim() || e.message}). Is the Railway CLI logged in and the project linked? Node 22 is required for it.`);
  }
  const j = JSON.parse(raw);
  // Tolerate either {KEY: value} or [{name, value}] shapes across CLI versions rather than assuming one.
  if (Array.isArray(j)) return Object.fromEntries(j.map((r) => [r.name ?? r.key, r.value]));
  return j;
}

function main() {
  const { shared, charlieOnly, engineOnly, readers } = mustMatchVars();
  const envs = {};
  for (const s of SERVICES) envs[s] = railwayVars(s);

  const r = parityReport(envs.charlie, envs["charlie-engine"], shared);

  console.log(`contract: ${shared.length} var(s) read by BOTH services (derived from the import graph)`);
  console.log(`charlie holds ${Object.keys(envs.charlie).length} var(s) · charlie-engine holds ${Object.keys(envs["charlie-engine"]).length}\n`);

  if (r.diverged.length) {
    console.log(`DIVERGED — ${r.diverged.length} shared var(s) hold DIFFERENT values:`);
    for (const d of r.diverged) console.log(`  ${d.var.padEnd(28)} charlie=${d.charlie}   charlie-engine=${d.engine}`);
    console.log("");
  }
  if (r.missing.length) {
    console.log(`ABSENT ON ONE SIDE — ${r.missing.length} shared var(s) set on one service only:`);
    for (const m of r.missing) console.log(`  ${m.var.padEnd(28)} set on ${m.presentOn}, MISSING on ${m.absentOn}`);
    console.log("  (a missing var does not error — the code falls back to a default, which is exactly why");
    console.log("   the absence has to be reported rather than discovered later.)\n");
  }
  if (r.ok) console.log("OK — every shared var either matches or is unset on both.\n");

  // Not a divergence, but worth seeing: config set on a service that will never read it. Harmless to
  // the run, but it misleads a reader into believing a feature is configured.
  const everywhere = repoEnvReads();
  const dead = [];
  for (const svc of SERVICES) {
    for (const v of Object.keys(envs[svc])) {
      if (PLATFORM_PREFIX.test(v) || isDynamicVar(v)) continue; // a runtime-built name is invisible to a literal scan, not dead
      if (!everywhere.has(v)) { dead.push({ svc, var: v, why: "no code anywhere reads it" }); continue; }
      const otherOnly = svc === "charlie" ? engineOnly : charlieOnly;
      if (otherOnly.includes(v)) dead.push({ svc, var: v, why: "only the OTHER service's code reads it" });
    }
  }
  if (dead.length) {
    console.log(`DEAD CONFIG — set where it cannot do anything (harmless to the run, misleading to a human):`);
    for (const d of dead) console.log(`  ${d.var.padEnd(28)} on ${d.svc.padEnd(15)} ${d.why}`);
    console.log("");
  }

  if (process.argv.includes("--contract")) {
    console.log("the derived contract (var -> the shared files that read it):");
    for (const v of shared) {
      const set = SERVICES.filter((s) => Object.prototype.hasOwnProperty.call(envs[s], v));
      const val = set.length && !SECRET_PATTERN.test(v) ? ` = ${String(envs[set[0]][v]).slice(0, 40)}` : set.length ? " = <secret>" : " (unset on both)";
      console.log(`  ${v}${val}\n      ${(readers.get(v) || []).slice(0, 4).join(", ")}`);
    }
    console.log(`\ncharlie-only reads (${charlieOnly.length}): ${charlieOnly.join(", ")}`);
    console.log(`\nengine-only reads (${engineOnly.length}): ${engineOnly.join(", ")}`);
  }

  // Non-zero so this is usable as a pre-deploy gate, not just a thing to read.
  process.exit(r.ok ? 0 : 1);
}

try { main(); } catch (e) { console.error(`env-parity fatal: ${e.message}`); process.exit(2); }
