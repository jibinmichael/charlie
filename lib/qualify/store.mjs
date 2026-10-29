// lib/qualify/store.mjs — the ONLY reader and writer of hire_connections, hire_connection_roles,
// hire_qualify_threads and hire_submissions (migration 20261005170000), and of the candidacy tables
// hire_candidacy_events and hire_candidacy_proposals (migration 20261006062852). FAIL LOUD: every read and write of a
// thread throws on error, so the agent stops instead of acting on a state it could not read or record.
//
// The candidacy lifecycle:
//   - every row belongs to one organisation (org_id); this store reads and writes only its own organisation's
//     connections and threads. Two reads are deliberately global: openEmails (one conversation per person at a time,
//     across organisations, for the person's sake) and threadByKey (a reply finds its thread by its own key).
//   - every stage change is recorded as an event naming who caused it: `as({actor_type, actor_id, ref})` gives a
//     view of this store acting for that actor. Recording an event never blocks the change itself; a failure is
//     counted (eventFailures) so the run can say it, never silent.
//   - until the candidacy migration is applied (hire_orgs missing), none of this happens and the store behaves
//     without it (code reading a table that is not there yet fails open).
import { createHash } from "node:crypto";
import { qualifyMove } from "../hire-lifecycle.mjs";

function must({ data, error }, what) {
  if (error) throw new Error(`connections-store ${what}: ${error.message}`);
  return data;
}

/** A stable hash of a JSON value (key order does not matter). Pure. */
export function hashOf(value) {
  const norm = (v) => (Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
  return createHash("sha256").update(JSON.stringify(norm(value))).digest("hex").slice(0, 32);
}

export const ACTOR_TYPES = ["agent", "person", "candidate", "employer", "system"];

/** A table that does not exist yet: Postgres 42P01, or PostgREST's PGRST205 / "Could not find the table". Pure. */
export function isMissingTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");
  return code === "42P01" || code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(msg);
}
export const DEFAULT_ORG = "charlie";

/**
 * The one lifecycle engine decides Qualify & Submit's moves: "shadow" (the default) checks every stage
 * change against lib/hire-lifecycle.mjs qualifyMove after it is written and records any disagreement; "enforce"
 * checks before, and a move the engine refuses is not written (the agent also asks before it sends). Only the exact
 * word "enforce" enforces; anything else is shadow, and every run says which it ran in.
 */
export const engineMode = (v = process.env.LIFECYCLE_ENGINE) => (String(v ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow");

export function connectionStore(db, { org = DEFAULT_ORG, log = (m) => console.error(m), engine = engineMode() } = {}) {
  if (!db) throw new Error("connectionStore needs a database client");
  const now = () => new Date().toISOString();
  // whether the candidacy migration is applied, read once per store. ONLY a missing table means "not yet": any other
  // error (a network blip, a timeout) throws and is not remembered, so one failed read can never put a store that
  // should be enforcing the lifecycle back on the old rules for a whole sweep
  let ready = null;
  const candidacy = async () => {
    if (ready === null) {
      const { error } = await db.from("hire_orgs").select("id").limit(1);
      if (!error) ready = true;
      else if (isMissingTable(error)) ready = false;
      else throw new Error(`connections-store candidacy: ${error.message}`);
    }
    return ready;
  };
  // this organisation's rows only, once the column exists. Sync on purpose: a query builder is thenable, so awaiting
  // it here would run the query (the caller reads `scoped` from candidacy() first)
  const own = (q, scoped) => (scoped ? q.eq("org_id", org) : q);
  const shared = { eventFailures: 0, refusals: 0, refused: [], moves: 0 };

  async function record(ev, cause) {
    // the change already happened; a failure to read readiness here is a failure to record it, counted, never thrown
    let on;
    try { on = await candidacy(); } catch (e) { shared.eventFailures++; log(`[candidacy] ${ev.type} for ${ev.thread_id}: ${e?.message || e}`); return false; }
    if (!on) return false;
    if (!cause || !ACTOR_TYPES.includes(cause.actor_type)) { shared.eventFailures++; log(`[candidacy] ${ev.type} for ${ev.thread_id}: no actor, not recorded`); return false; }
    try {
      const { error } = await db.from("hire_candidacy_events").insert({ org_id: org, actor_type: cause.actor_type, actor_id: cause.actor_id ?? null, ref: ev.ref ?? cause.ref ?? null, ...ev });
      if (error) throw new Error(error.message);
      return true;
    } catch (e) {
      shared.eventFailures++;
      log(`[candidacy] ${ev.type} for ${ev.thread_id}: ${e?.message || e}`);
      return false;
    }
  }
  /** The engine's verdict on a move by this store's actor. */
  const verdict = (from, to, thread, cause) =>
    qualifyMove({ from: from ?? null, to, actor: cause?.actor_type ?? "unknown", agent: cause?.actor_type === "agent" ? cause.actor_id : null, thread });
  /** In enforce mode, a move the engine refuses is never written (throws, so the run counts it and stops that one). */
  const enforce = async (id, from, patch, cause) => {
    if (engine !== "enforce" || !patch.stage || patch.stage === from) return;
    const cur = id ? must(await db.from("hire_qualify_threads").select("*").eq("id", id).maybeSingle(), "engine") : null;
    const v = verdict(from, patch.stage, { ...(cur || {}), ...patch }, cause);
    if (!v.ok) { shared.refusals++; shared.refused.push(v.reason); throw new Error(`the lifecycle engine refused ${from ?? "new"} to ${patch.stage}: ${v.reason}`); }
  };
  const stageEvent = async (row, from, patch, cause) => {
    if (!row || !patch.stage || patch.stage === from) return null;
    shared.moves++;
    await record({ type: "stage.changed", job_id: row.job_id, thread_id: row.id, candidate_id: row.candidate_id, from_stage: from ?? null, to_stage: patch.stage, reason: patch.close_reason || patch.last_error || cause?.reason || null }, cause);
    // shadow: the engine's verdict on the move that was just made; a disagreement is recorded and counted, never silent
    if (engine === "shadow") {
      const v = verdict(from, patch.stage, row, cause);
      if (!v.ok) {
        shared.refusals++; shared.refused.push(v.reason);
        log(`[lifecycle-engine] would refuse ${row.id} ${from ?? "new"} to ${patch.stage}: ${v.reason}`);
        await record({ type: "engine.refused", job_id: row.job_id, thread_id: row.id, candidate_id: row.candidate_id, from_stage: from ?? null, to_stage: patch.stage, reason: v.reason }, cause);
      }
    }
    return null;
  };

  const make = (cause) => ({
    /** This store, acting for one actor: every stage change it writes is recorded with that actor. */
    as(next) { return make({ ...next }); },
    get eventFailures() { return shared.eventFailures; },
    /** Moves the engine refused (shadow: recorded after the fact; enforce: not made), and their reasons. */
    get engineRefusals() { return shared.refusals; },
    get engineMoves() { return shared.moves; },
    get engineReasons() { return [...shared.refused]; },
    engineMode: engine,
    /** May this store's actor make this move now? The engine's verdict, for a caller that is about to send. */
    mayMove(t, to, patch = {}) { return verdict(t?.stage ?? null, to, { ...(t || {}), ...patch }, cause); },
    candidacyReady: candidacy,

    async connections() {
      return must(await own(db.from("hire_connections").select("*"), await candidacy()).order("created_at"), "connections") || [];
    },
    async connection(key) {
      return must(await own(db.from("hire_connections").select("*").eq("key", key), await candidacy()).maybeSingle(), "connection");
    },
    async saveConnection(key, patch, by) {
      const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => ["name", "source", "destination", "sequence", "settings", "mode"].includes(k)));
      return must(await own(db.from("hire_connections").update({ ...allowed, updated_at: now(), updated_by: by ?? null }).eq("key", key), await candidacy()).select("*").single(), "saveConnection");
    },

    async roles(connectionId) {
      return must(await db.from("hire_connection_roles").select("*").eq("connection_id", connectionId), "roles") || [];
    },
    async upsertRole(row) {
      return must(await db.from("hire_connection_roles").upsert({ ...row, last_seen_at: now() }, { onConflict: "connection_id,external_id" }).select("*").single(), "upsertRole");
    },
    async threads(connectionId, stages = null) {
      let q = own(db.from("hire_qualify_threads").select("*").eq("connection_id", connectionId), await candidacy());
      if (stages) q = q.in("stage", stages);
      return must(await q, "threads") || [];
    },
    /** Every address with an open thread, across every connection AND every organisation: one conversation per
     *  person at a time, for the person's sake (deliberately not scoped). */
    async openEmails() {
      const rows = must(await db.from("hire_qualify_threads").select("email").in("stage", ["verify_sent", "reminded", "answered", "held", "confirming", "ready", "submitting"]), "openEmails") || [];
      return new Set(rows.map((r) => r.email));
    },
    async thread(id) {
      return must(await own(db.from("hire_qualify_threads").select("*").eq("id", id), await candidacy()).maybeSingle(), "thread");
    },
    async threadsForJob(jobId) {
      return must(await own(db.from("hire_qualify_threads").select("*").eq("job_id", jobId), await candidacy()), "threadsForJob") || [];
    },
    /** A reply finds its thread by its own unique key, whichever organisation it belongs to (deliberately not scoped). */
    async threadByKey(replyKey) {
      return must(await db.from("hire_qualify_threads").select("*").eq("reply_key", replyKey).maybeSingle(), "threadByKey");
    },
    async openThread(row) {
      await enforce(null, null, { stage: row.stage, ...row }, cause);
      const t = must(await db.from("hire_qualify_threads").insert((await candidacy()) ? { ...row, org_id: org } : row).select("*").single(), "openThread");
      await stageEvent(t, null, { stage: t?.stage }, cause);
      return t;
    },
    async updateThread(id, patch) {
      // the stage it moved from, for the history: read only once the history exists, and never in the way of the
      // change itself (before the migration this path is exactly the old single update)
      // enforce only: the stage it would move from, read first (shadow and before-migration stay the single update)
      if (engine === "enforce" && patch.stage) await enforce(id, must(await db.from("hire_qualify_threads").select("stage").eq("id", id).maybeSingle(), "engine")?.stage ?? null, patch, cause);
      let before = null;
      if (patch.stage && (await candidacy())) {
        try { before = (await db.from("hire_qualify_threads").select("stage").eq("id", id).maybeSingle()).data; } catch { before = null; }
      }
      const t = must(await own(db.from("hire_qualify_threads").update({ ...patch, updated_at: now() }).eq("id", id), await candidacy()).select("*").single(), "updateThread");
      await stageEvent(t, before?.stage, patch, cause);
      return t;
    },
    /**
     * Update only while the thread is still at `stage` and, for each key in `match` (replied_at, updated_at), still
     * holds that value (null = still empty); null when it has moved on, so no update is lost.
     */
    async updateThreadIf(id, stage, patch, match = {}) {
      await enforce(id, stage, patch, cause);
      let q = own(db.from("hire_qualify_threads").update({ ...patch, updated_at: now() }).eq("id", id).eq("stage", stage), await candidacy());
      for (const [k, v] of Object.entries(match)) q = v == null ? q.is(k, null) : q.eq(k, v);
      const t = must(await q.select("*").maybeSingle(), "updateThreadIf");
      await stageEvent(t, stage, patch, cause);
      return t;
    },

    /**
     * A person's decision on putting this person forward ("saved" | "passed"), kept on the thread as
     * overrides.approval = { decision, by, at }. The agent submits a ready thread only once it reads "saved".
     * Written whatever the stage; the agent re-reads it at every step that would write to the person.
     */
    async setApproval(id, decision, by) {
      if (!["saved", "passed"].includes(decision)) throw new Error(`connections-store setApproval: unknown decision ${decision}`);
      const cur = must(await own(db.from("hire_qualify_threads").select("*").eq("id", id), await candidacy()).maybeSingle(), "setApproval");
      if (!cur) return null;
      const approval = { decision, by: by ?? null, at: now() };
      const t = must(await own(db.from("hire_qualify_threads").update({ overrides: { ...(cur.overrides || {}), approval }, updated_at: now() }).eq("id", id), await candidacy()).select("*").single(), "setApproval");
      await record({ type: "approval.decided", job_id: cur.job_id, thread_id: cur.id, candidate_id: cur.candidate_id, reason: decision === "saved" ? "approved to be put forward" : "passed: not to be put forward" }, { actor_type: "person", actor_id: by ?? "workspace" });
      return t;
    },

    // ── the candidacy: what an agent asks a person for, and the record of what happened ─────────────────────────
    /** Ask a person to decide (today: close as not a fit). Any earlier open question on the thread is voided first.
     *  null until the candidacy migration is applied: the caller then keeps today's behaviour. */
    async propose({ thread, kind, check_id, reason, evidence = {} }) {
      if (!(await candidacy())) return null;
      must(await db.from("hire_candidacy_proposals").update({ status: "void", decided_at: now(), decided_by: "superseded" }).eq("thread_id", thread.id).eq("status", "pending"), "propose");
      // the caller records "proposal.made" once the thread is really held behind it (never for a withdrawn question)
      return must(await db.from("hire_candidacy_proposals").insert({ org_id: org, job_id: thread.job_id, thread_id: thread.id, kind, check_id, proposed_by: cause?.actor_id ?? "agent", reason, evidence }).select("*").single(), "propose");
    },
    /** A reply arrived: the person's question is no longer the right one. */
    async voidProposals(thread) {
      if (!(await candidacy())) return 0;
      const rows = must(await db.from("hire_candidacy_proposals").update({ status: "void", decided_at: now(), decided_by: "superseded" }).eq("thread_id", thread.id).eq("status", "pending").select("id"), "voidProposals") || [];
      return rows.length;
    },
    async pendingProposals() {
      if (!(await candidacy())) return [];
      return must(await db.from("hire_candidacy_proposals").select("*").eq("org_id", org).eq("status", "pending").order("created_at"), "pendingProposals") || [];
    },
    /** An organisation's name (the connection's own, else this store's), for "Charlie on behalf of <it>" on a
     *  hand-off; null before the migration. */
    async orgName(id = org) {
      if (!(await candidacy())) return null;
      return must(await db.from("hire_orgs").select("name").eq("id", id || org).maybeSingle(), "orgName")?.name ?? null;
    },
    async proposal(id) {
      if (!(await candidacy())) return null;
      return must(await db.from("hire_candidacy_proposals").select("*").eq("org_id", org).eq("id", id).maybeSingle(), "proposal");
    },
    /** A person's decision: approved (close them) or kept (carry on past that check). Only a pending one moves. */
    async decideProposal(id, status, by) {
      if (!(await candidacy())) return null;
      return must(await db.from("hire_candidacy_proposals").update({ status, decided_by: by, decided_at: now() }).eq("org_id", org).eq("id", id).eq("status", "pending").select("*").maybeSingle(), "decideProposal");
    },
    async recordEvent(ev) { return record(ev, cause); },
    async eventsForThreads(ids) {
      if (!ids.length || !(await candidacy())) return [];
      return must(await db.from("hire_candidacy_events").select("*").eq("org_id", org).in("thread_id", ids).order("at"), "eventsForThreads") || [];
    },

    async submissions(connectionId) {
      return must(await db.from("hire_submissions").select("*").eq("connection_id", connectionId), "submissions") || [];
    },
    async submissionsForJob(jobId) {
      return must(await db.from("hire_submissions").select("*").eq("job_id", jobId), "submissionsForJob") || [];
    },
    async recordSubmission(row) {
      return must(await db.from("hire_submissions").insert(row).select("*").single(), "recordSubmission");
    },
  });
  return make(null);
}
