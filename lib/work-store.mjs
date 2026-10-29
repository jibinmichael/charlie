// lib/work-store.mjs — THE work queue's one door to the database (hire_work, migration 20261009100000). Every step of
// hiring at volume is a row here: enqueued once by its key, claimed by one worker under a lease, then done, retried
// after a backoff, or failed after its attempts.
//
// RULES IT KEEPS
// - Idempotent by key: enqueueing the same step twice is one row (on conflict do nothing).
// - A row is worked by the worker that holds its lease: complete and fail only land on a row still leased to that
//   worker, so a worker that outlived its lease cannot overwrite the worker that took over.
// - A row that used every attempt is failed, never retried forever, and keeps its last error for a person to read.
// - Fail open when the table is not there yet: the worker idles and says so, nothing crashes.

import { store as defaultStore } from "../charlie-store.mjs";

const MISSING = /hire_work|PGRST205|42P01|42883|does not exist|Could not find/i;

/** The wait before a failed row is tried again: 30 seconds, doubling, at most an hour. Pure. */
export function backoffSeconds(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(30 * 2 ** (n - 1), 3600);
}

/** A row to enqueue, checked: a kind, a key, and only known fields. Pure; throws on a row that would be wrong. */
export function workRow({ kind, key, payload = {}, company = null, max_attempts = 5, run_after = null }) {
  if (typeof kind !== "string" || kind.length < 3 || kind.length > 80) throw new Error(`work row: bad kind ${JSON.stringify(kind)}`);
  if (typeof key !== "string" || key.length < 3 || key.length > 300) throw new Error(`work row: bad key for ${kind}`);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`work row: payload must be an object (${key})`);
  const attempts = Math.min(20, Math.max(1, Number(max_attempts) || 5));
  return { kind, key, payload, company: company ?? null, max_attempts: attempts, ...(run_after ? { run_after } : {}) };
}

/**
 * The queue over a Supabase client.
 * @param {any} [db] a Supabase client (a fake under test); the service-role client by default
 */
export function workStore(db = null) {
  const c = () => db || defaultStore();
  const now = () => new Date().toISOString();

  return {
    /** True when the error says the table or function is not there yet (an unapplied migration). */
    isMissing(err) {
      return MISSING.test(String(err?.message || err?.code || err || ""));
    },

    /** Add steps; a key already queued is left as it is. @returns {Promise<number>} rows newly added */
    async enqueue(rows) {
      const list = (Array.isArray(rows) ? rows : [rows]).map(workRow);
      if (!list.length) return 0;
      const { data, error } = await c().from("hire_work").upsert(list, { onConflict: "key", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`enqueue: ${error.message}`);
      return (data || []).length;
    },

    /** Take up to `limit` rows of one kind under a lease. @returns {Promise<object[]>} */
    async claim({ kind, limit, worker, leaseSeconds }) {
      const { data, error } = await c().rpc("hire_work_claim", { p_kind: kind, p_limit: limit, p_worker: worker, p_lease_seconds: leaseSeconds });
      if (error) throw new Error(`claim ${kind}: ${error.message}`);
      return Array.isArray(data) ? data : [];
    },

    /** Mark a row done, only if this worker still holds it. @returns {Promise<boolean>} whether it landed */
    async complete({ id, worker, result = null }) {
      const { data, error } = await c().from("hire_work")
        .update({ status: "done", result, lease_until: null, last_error: null, updated_at: now() })
        .eq("id", id).eq("leased_by", worker).eq("status", "running").select("id");
      if (error) throw new Error(`complete ${id}: ${error.message}`);
      return (data || []).length === 1;
    },

    /** A failed attempt: retried after a backoff, or failed for good on its last attempt. Only by the lease holder. */
    async fail({ id, worker, error: message, attempts, maxAttempts, at = Date.now() }) {
      const last = Number(attempts) >= Number(maxAttempts);
      const patch = last
        ? { status: "failed", lease_until: null, last_error: String(message).slice(0, 1000), updated_at: now() }
        : { status: "pending", lease_until: null, leased_by: null, last_error: String(message).slice(0, 1000), run_after: new Date(at + backoffSeconds(attempts) * 1000).toISOString(), updated_at: now() };
      const { data, error } = await c().from("hire_work").update(patch).eq("id", id).eq("leased_by", worker).eq("status", "running").select("id");
      if (error) throw new Error(`fail ${id}: ${error.message}`);
      return { landed: (data || []).length === 1, final: last };
    },

    /** The rows with these keys: their status and result (a finishing step reads its parts this way). */
    async byKeys(keys) {
      if (!keys?.length) return [];
      const { data, error } = await c().from("hire_work").select("key, status, result, last_error").in("key", keys);
      if (error) throw new Error(`byKeys: ${error.message}`);
      return data || [];
    },

    /** Rows whose worker died on their last attempt: failed, so they are seen and never claimed again. */
    async reap({ at = Date.now(), limit = 100 } = {}) {
      const { data, error } = await c().from("hire_work").select("id, attempts, max_attempts")
        .eq("status", "running").lt("lease_until", new Date(at).toISOString()).limit(limit);
      if (error) throw new Error(`reap: ${error.message}`);
      const ids = (data || []).filter((r) => r.attempts >= r.max_attempts).map((r) => r.id);
      if (!ids.length) return 0;
      const { error: e2 } = await c().from("hire_work")
        .update({ status: "failed", lease_until: null, last_error: "its worker stopped during the last attempt", updated_at: now() })
        .in("id", ids).eq("status", "running");
      if (e2) throw new Error(`reap: ${e2.message}`);
      return ids.length;
    },
  };
}
