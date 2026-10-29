// lib/heartbeat.mjs — best-effort cron heartbeat pings (for Healthchecks.io or similar).
//
// pingHeartbeat(job) hits the URL held in the env var HEARTBEAT_URL_<JOB>, so an external monitor
// alerts you when a scheduled job STOPS running (silence = something's wrong). It is ALWAYS
// best-effort by design:
//   - a missing/empty env var is a no-op (heartbeats are opt-in per job) but WARNS once per process,
//     because an unconfigured heartbeat is otherwise indistinguishable from a healthy one,
//   - every failure is caught + logged, never thrown,
// so a heartbeat can NEVER fail or abort the job it monitors. Call it at the SUCCESSFUL end of a job.
// Node 22+ global fetch; short timeout so a hung endpoint can't stall the run.

const TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 5000);
// Which HEARTBEAT_URL_* keys we've already warned about, so an unconfigured job logs once per
// process instead of once per call.
const warnedMissing = new Set();

/**
 * The env var that holds a job's heartbeat URL: `HEARTBEAT_URL_` + the job name uppercased, with every
 * character outside [A-Z0-9_] replaced by `_`, so the name is always settable in a shell or a host's
 * env UI ("voice-pipeline" → HEARTBEAT_URL_VOICE_PIPELINE).
 * @param {string} job
 * @returns {string}
 */
export function heartbeatEnvKey(job) {
  return `HEARTBEAT_URL_${String(job).toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
}

/**
 * Ping the heartbeat URL for a named job. Always resolves (never rejects).
 * @param {string} job  logical job name; the env var read is heartbeatEnvKey(job).
 * @param {{ fail?: boolean, log?: (m: string) => void }} [opts]  fail=true pings the "/fail" endpoint
 *   (Healthchecks.io convention) to actively signal a failed run.
 * @returns {Promise<void>}
 */
export async function pingHeartbeat(job, { fail = false, log = console.error } = {}) {
  const key = heartbeatEnvKey(job);
  const base = process.env[key];
  if (!base) {
    // Still a no-op — monitoring must never break the job it watches — but not SILENT. An
    // unconfigured heartbeat is otherwise indistinguishable from a healthy one, so a job could run
    // unmonitored forever with nothing to notice. Warned once per process, not per call.
    if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      log(`[heartbeat] ${key} is not set — "${job}" is running UNMONITORED (no external alert if it stops).`);
    }
    return;
  }
  const url = fail ? base.replace(/\/+$/, "") + "/fail" : base;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(url, { method: "POST", signal: ctrl.signal });
  } catch (e) {
    log(`[heartbeat] ${key} ping failed (non-fatal): ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}
