// lib/work-runner.mjs — one pass of the worker over the work queue. For each registered
// kind it claims up to that kind's concurrency, runs them side by side, and marks each done or failed. The worker loop
// (worker.mjs) calls this again and again; tests call it once with a fake store.
//
// RULES IT KEEPS
// - Every row is isolated: one failing step is retried or failed on its own, and the pass goes on.
// - A step that runs past most of its lease is stopped as a failure, so a slow step never ends up worked twice.
// - A kind whose claim fails (the table not there yet, the database down) is skipped this pass and reported.

/** The step, or a failure once it runs past `ms`; the timer is cleared either way. */
async function withinTime(promise, ms, label) {
  let t;
  const late = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label}: ran past its time (${Math.round(ms / 1000)}s)`)), ms); t.unref?.(); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * One pass.
 * @param {{ store: ReturnType<import("./work-store.mjs").workStore>, handlers: Record<string, { handle: (payload: object, ctx: { row: object }) => Promise<any>, concurrency?: number, leaseSeconds?: number }>,
 *   worker: string, log?: (m: string) => void, capture?: (e: unknown, ctx: object) => void, at?: () => number }} input
 * @returns {Promise<{ claimed: number, done: number, retried: number, failed: number, lost: number, skipped: string[], reaped: number }>}
 */
export async function runOnce({ store, handlers, worker, log = () => {}, capture = () => {}, at = Date.now }) {
  const out = { claimed: 0, done: 0, retried: 0, failed: 0, lost: 0, skipped: [], reaped: 0 };
  try {
    out.reaped = await store.reap({ at: at() });
  } catch (e) {
    log(`[worker] reap: ${e?.message || e}`);
  }
  for (const [kind, h] of Object.entries(handlers || {})) {
    if (typeof h?.handle !== "function") { out.skipped.push(kind); continue; }
    const leaseSeconds = Math.max(10, Number(h.leaseSeconds) || 300);
    const limit = Math.min(100, Math.max(1, Number(h.concurrency) || 4));
    let rows;
    try {
      rows = await store.claim({ kind, limit, worker, leaseSeconds });
    } catch (e) {
      out.skipped.push(kind);
      log(`[worker] ${kind}: ${store.isMissing?.(e) ? "the work queue is not there yet (migration 20261009100000)" : e?.message || e}`);
      continue;
    }
    out.claimed += rows.length;
    await Promise.all(rows.map(async (row) => {
      try {
        const result = await withinTime(Promise.resolve().then(() => h.handle(row.payload || {}, { row })), leaseSeconds * 800, `${kind} ${row.key}`);
        const landed = await store.complete({ id: row.id, worker, result: result ?? null });
        landed ? (out.done += 1) : (out.lost += 1);
        if (!landed) log(`[worker] ${kind} ${row.key}: finished after its lease passed to another worker; its result was not written`);
      } catch (e) {
        // "not yet" (e.later): a step waiting on other steps is retried after its backoff, never reported as an error
        if (!e?.later) capture(e, { kind: "work", work_kind: kind, key: row.key });
        try {
          const f = await store.fail({ id: row.id, worker, error: e?.message || String(e), attempts: row.attempts, maxAttempts: row.max_attempts, at: at() });
          if (!f.landed) out.lost += 1;
          else f.final ? (out.failed += 1) : (out.retried += 1);
          log(`[worker] ${kind} ${row.key}: ${f.final ? "failed for good" : "will retry"}: ${e?.message || e}`);
        } catch (e2) {
          out.lost += 1;
          log(`[worker] ${kind} ${row.key}: could not record the failure: ${e2?.message || e2}`);
        }
      }
    }));
  }
  return out;
}

/** How long the worker waits before its next pass: not at all while there is work, the idle wait when a pass found
 *  none or failed (a fixed rest after every pass would cap the worker's throughput). Pure. */
export function nextPauseMs(pass, idleMs) {
  return pass && Number(pass.claimed) > 0 ? 0 : idleMs;
}
