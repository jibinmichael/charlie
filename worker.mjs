// worker.mjs — the work queue's worker.
// Its own Railway service (railway.worker.json, `npm run worker:run`), so heavy work never slows the email server's
// inbound door. Any number can run side by side: each row is claimed by one worker under a lease (lib/work-store.mjs).
//
//   node --env-file=.env.local worker.mjs           loop until stopped
//   node --env-file=.env.local worker.mjs --once    one pass, then exit (a smoke check)
//
// Each pass: lib/work-runner.mjs runOnce over the registered kinds, then a heartbeat (HEARTBEAT_URL_WORKER) when the
// pass ran clean, and /fail when a kind could not be claimed or a row failed for good. Errors go to Sentry. SIGTERM
// lets the pass in progress finish, then exits.

import "./lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs";
import { pingHeartbeat } from "./lib/heartbeat.mjs";
import { workStore } from "./lib/work-store.mjs";
import { runOnce, nextPauseMs } from "./lib/work-runner.mjs";

/** "work.ping" proves the loop end to end. */
export const PING = {
  "work.ping": { concurrency: 4, leaseSeconds: 30, handle: async (payload) => ({ pong: true, said: typeof payload?.say === "string" ? payload.say.slice(0, 80) : null }) },
};

const PAUSE_MS = 5000;

export async function main({ once = false, log = console.error } = {}) {
  initSentry({ name: "worker" });
  const worker = `${hostname()}:${process.pid}`;
  const store = workStore();
  // the kinds this worker runs: the ping. A new kind of queued work registers its handler here
  // ({ concurrency, leaseSeconds, handle(payload) }) and is enqueued with lib/work-store.mjs.
  const HANDLERS = { ...PING };
  let stopping = false, lastPing = 0;
  process.on("SIGTERM", () => { stopping = true; log("[worker] SIGTERM: finishing this pass, then stopping"); });
  process.on("SIGINT", () => { stopping = true; });
  log(`[worker] ${worker} running ${Object.keys(HANDLERS).join(", ")}`);
  do {
    let pass;
    try {
      pass = await runOnce({ store, handlers: HANDLERS, worker, log, capture: captureError });
    } catch (e) {
      captureError(e, { kind: "worker-pass" });
      log(`[worker] pass: ${e?.message || e}`);
      pass = null;
    }
    const clean = pass && !pass.skipped.length && !pass.failed;
    // the heartbeat once a minute at most when busy, every idle pass otherwise, so a busy worker is not a stream of pings
    if (!pass?.claimed || Date.now() - lastPing > 60_000) { await pingHeartbeat("worker", { fail: !clean, log }); lastPing = Date.now(); }
    if (pass && (pass.claimed || pass.reaped || pass.skipped.length)) log(`[worker] pass: ${JSON.stringify(pass)}`);
    if (once || stopping) break;
    // straight on while there is work; the idle wait only after an empty or failed pass
    const pause = nextPauseMs(pass, PAUSE_MS);
    if (pause) await new Promise((r) => setTimeout(r, pause));
  } while (!stopping);
  await flushSentry();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main({ once: process.argv.includes("--once") }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
