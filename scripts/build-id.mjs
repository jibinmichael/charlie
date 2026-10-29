// scripts/build-id.mjs — compare this tree's build fingerprint with what the two services are running.
//
//   node --env-file=.env.local scripts/build-id.mjs           # this tree vs both live services
//   node --env-file=.env.local scripts/build-id.mjs --files    # also list what the fingerprint covers
//
// Read-only. Sends nothing, writes nothing, costs $0.
//
// The fingerprint is a content hash of the running source (lib/build-id.mjs), so it cannot drift from
// the code the way a hand-bumped VERSION can. The server reports its build on /healthz; the engine is a
// cron job with no HTTP surface, so it stamps its build at the START of each run (preflight.mjs). Right
// after an engine deploy the stamp still describes the previous code until the next run, and the
// output says so.

import { loadEnv, loadEngineBuild } from "../charlie-store.mjs";
import { buildId, buildFiles } from "../lib/build-id.mjs";

const HEALTHZ = process.env.HEALTHZ_URL || "https://api.example.com/healthz";

async function main() {
  loadEnv();
  const local = buildId();
  const files = buildFiles();

  let server = null, version = null, healthzErr = null;
  try {
    const r = await fetch(HEALTHZ, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    server = j.build ?? null;
    version = j.version ?? null;
  } catch (e) { healthzErr = e.message; }

  const stamp = await loadEngineBuild();
  const ageH = stamp?.at ? (Date.now() - Date.parse(stamp.at)) / 3600e3 : NaN;

  console.log(`this tree        build ${local || "UNKNOWN"}  (${files.length} source file(s))`);
  console.log(`charlie (server) build ${server || (healthzErr ? `UNREACHABLE — ${healthzErr}` : "not reported — pre-fingerprint deploy")}${version ? `  VERSION ${version}` : ""}`);
  console.log(`charlie-engine   build ${stamp?.build || "NEVER STAMPED"}${stamp?.at ? `  last run ${stamp.at} (${ageH.toFixed(1)}h ago)` : ""}${stamp?.files ? `  ${stamp.files} file(s)` : ""}`);

  console.log("");
  if (!stamp?.build) {
    console.log("The engine has never stamped a build. Either preflight.mjs has not run since the stamp shipped");
    console.log("(the cron runs once a day) or the stamp write is failing — check the preflight log for");
    console.log("'build stamp not recorded'.");
  } else if (server && server === stamp.build && local === server) {
    console.log("ALL THREE AGREE. This tree is what both services are running.");
  } else {
    if (server && stamp.build && server !== stamp.build) console.log(`DIVERGED: the two services are on different code (server ${server}, engine ${stamp.build}).`);
    if (local !== stamp.build) console.log(`This tree is NOT what the engine last ran. If you just deployed the engine, that is expected: the stamp updates at the next cron run (${ageH >= 0 ? `${ageH.toFixed(1)}h since the last one` : "unknown"}).`);
    if (server && local !== server) console.log(`This tree is NOT what the server is running. The server restarts on deploy, so this one should match immediately — if it does not, the deploy did not land.`);
  }

  if (process.argv.includes("--files")) {
    console.log(`\nfingerprint covers ${files.length} file(s):`);
    for (const f of files) console.log(`  ${f}`);
  }
}

main().catch((e) => { console.error("build-id fatal:", e.message); process.exit(1); });
