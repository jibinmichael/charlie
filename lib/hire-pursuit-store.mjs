// lib/hire-pursuit-store.mjs — the ONLY reader and writer of hire_people, hire_pursuits,
// hire_pursuit_keys and hire_pursuit_events (migration 20261005130000, NOT applied). The state machine
// is lib/hire-lifecycle.mjs; this file only loads a pursuit, asks transition() what happens, and
// stores the answer through hire_pursuit_apply (row + event + reply keys in one transaction, refused
// if the row moved since it was read). A refused transition writes nothing.
//
// FAIL LOUD: a pursuit that cannot be read or written throws, and a history
// that disagrees with its row throws, rather than acting on a state nobody can explain.
import { createPursuit, transition } from "./hire-lifecycle.mjs";
import { identityKeys, resolvePerson, IDENTITY_KEYS } from "./hire-people.mjs";

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msOf = (s) => (s == null ? null : Date.parse(s));
function must({ data, error }, what) {
  if (error) throw new Error(`hire-pursuit-store ${what}: ${error.message}`);
  return data;
}

/** A hire_jobs row as the lifecycle sees it. The employer is the client the job names; no client, no pursuit. */
export function lifecycleJob(job) {
  const client = typeof job?.client === "string" ? job.client.trim() : "";
  if (!job?.id || !client) throw new Error(`hire job ${job?.id ?? "?"} has no client: name the employer before anyone is pursued`);
  return { id: job.id, employer_id: client, company: client, lifecycle: job.lifecycle ?? "active", cold_outreach: job.cold_outreach === true };
}

/** pursuit → hire_pursuits columns (history and keys live in their own tables). Pure. */
export function rowOf(p) {
  return {
    id: p.id, job_id: p.job_id, person_id: p.person_id, employer: p.employer_id, source: p.source, source_at: iso(p.source_at),
    discovery_run: p.discovery_run, outreach_type: p.outreach_type, contact: p.contact, engagement: p.engagement,
    screening_consent: p.screening_consent, disclosure: p.disclosure, screening: p.screening, handoff: p.handoff,
    ask: p.ask, waiting_for: p.ask?.waiting_for ?? null, due_at: iso(p.ask?.due_at), sent_to: p.sent_to,
    to_read: p.to_read, closed_out: p.closed_out, version: p.version,
  };
}

/** hire_pursuits row + its events + its keys → pursuit. Throws if the history does not account for the row. */
export function pursuitOf(row, events, keys) {
  const history = [...events].sort((a, b) => a.seq - b.seq);
  if (history.length !== row.seq + 1 || history.some((e, i) => e.seq !== i)) throw new Error(`hire_pursuits ${row.id}: ${history.length} events for seq ${row.seq}; the history does not explain the row`);
  return {
    id: row.id, job_id: row.job_id, employer_id: row.employer, person_id: row.person_id, source: row.source,
    source_at: msOf(row.source_at), discovery_run: row.discovery_run, outreach_type: row.outreach_type, contact: row.contact,
    engagement: row.engagement, screening_consent: row.screening_consent, disclosure: row.disclosure, screening: row.screening,
    handoff: row.handoff, ask: row.ask ?? null, keys: keys.map((k) => k.key), sent_to: row.sent_to ?? null, to_read: row.to_read ?? null,
    closed_out: row.closed_out, version: row.version, seq: row.seq,
    history: history.map((e) => ({ type: e.type, actor: e.actor, at: msOf(e.at), pursuit_id: row.id, job_id: row.job_id, employer_id: row.employer, ref: e.ref ?? null, from: e.from_state ?? null, to: e.to_state ?? null, effects: e.effects ?? [], version: e.version })),
  };
}

const STATE = ["contact", "engagement", "screening_consent", "disclosure", "screening", "handoff", "ask", "sent_to", "to_read", "closed_out"];
/** The state a reconcile compares and records (never identity, never history). Pure. */
export function stateOf(p) {
  return Object.fromEntries(STATE.map((k) => [k, p[k] ?? null]));
}
/** Does the email record say something different from what is saved? Key order never counts. Pure. */
export function stateDiffers(a, b) {
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
  return canon(stateOf(a)) !== canon(stateOf(b));
}

export function pursuitStore(db) {
  if (!db) throw new Error("pursuitStore needs a database client");
  const load = async (id) => {
    const row = must(await db.from("hire_pursuits").select("*").eq("id", id).maybeSingle(), "load");
    if (!row) throw new Error(`hire_pursuits ${id} not found`);
    const events = must(await db.from("hire_pursuit_events").select("*").eq("pursuit_id", id).order("seq", { ascending: true }), "load:events") || [];
    const keys = must(await db.from("hire_pursuit_keys").select("key, created_at").eq("pursuit_id", id).order("created_at", { ascending: true }), "load:keys") || [];
    return pursuitOf(row, events, keys);
  };

  return {
    load,

    /** Who is this? An existing person, a new one, or a conflict for a person to settle (never merged). */
    async person(record) {
      const keys = identityKeys(record);
      const present = IDENTITY_KEYS.filter((k) => keys[k]);
      const found = [];
      for (const k of present) found.push(...(must(await db.from("hire_people").select("*").eq(k, keys[k]), `person:${k}`) || []));
      const verdict = resolvePerson(keys, found);
      if (verdict.action === "conflict") return verdict;
      if (verdict.action === "existing") {
        if (Object.keys(verdict.fill).length) must(await db.from("hire_people").update(verdict.fill).eq("id", verdict.id), "person:fill");
        return { action: "existing", id: verdict.id };
      }
      const row = must(await db.from("hire_people").insert({ ...keys, full_name: record.full_name ?? null }).select("id").single(), "person:insert");
      return { action: "new", id: row.id };
    },

    async create({ id, job, person_id, person, source, source_at = null, discovery_run = null, open_gaps, at }) {
      const p = createPursuit({ id, job: lifecycleJob(job), person: { ...person, id: person_id }, source, source_at, discovery_run, open_gaps, at });
      const [created] = p.history;
      must(await db.rpc("hire_pursuit_create", { p_row: rowOf(p), p_event: { type: created.type, actor: created.actor, at: iso(created.at), ref: created.ref, version: created.version } }), "create");
      return load(p.id);
    },

    /** Run one event. Refused → nothing written, the reason returned. Accepted → stored atomically. */
    async apply(id, event, ctx) {
      const p = await load(id);
      const r = transition(p, event, ctx);
      if (!r.ok) return r;
      const fresh = r.pursuit.keys.filter((k) => !p.keys.includes(k));
      const rec = r.record;
      must(await db.rpc("hire_pursuit_apply", { p_id: id, p_expected_seq: p.seq, p_row: rowOf(r.pursuit), p_event: { type: rec.type, actor: rec.actor, at: iso(rec.at), ref: rec.ref, from: rec.from, to: rec.to, effects: rec.effects, version: rec.version }, p_new_keys: fresh }), "apply");
      return { ok: true, pursuit: await load(id), record: rec };
    },

    /**
     * IMPORT: a pursuit whose state comes from the email record, not from a transition (the legacy
     * outreach scripts send outside the lifecycle's guards, so replaying their sends would be refused or
     * would need invented facts). One `pursuit.imported` event names the source. The pursuit must
     * already pass invariants() (lib/hire-pursuit-backfill.mjs finish()); it has no reply keys.
     */
    async importPursuit(p, { at, ref }) {
      if (p.keys?.length) throw new Error(`import ${p.id}: an imported pursuit carries no reply keys`);
      must(await db.rpc("hire_pursuit_create", { p_row: rowOf(p), p_event: { type: "pursuit.imported", actor: "system", at: iso(at), ref, version: p.version } }), "import");
      return load(p.id);
    },

    /**
     * RECONCILE: bring a saved pursuit back in step with the email record. Only the state columns move
     * (who, which job, which employer and which source never change); the change is one
     * `pursuit.reconciled` event carrying from and to, so the history says what moved and when.
     * Returns "unchanged" when nothing differs.
     */
    async reconcile(stored, mapped, { at, ref }) {
      const next = { ...mapped, id: stored.id, job_id: stored.job_id, employer_id: stored.employer_id, person_id: stored.person_id, source: stored.source, source_at: stored.source_at, discovery_run: stored.discovery_run, keys: stored.keys };
      if (!stateDiffers(stored, next)) return "unchanged";
      must(await db.rpc("hire_pursuit_apply", { p_id: stored.id, p_expected_seq: stored.seq, p_row: rowOf(next), p_event: { type: "pursuit.reconciled", actor: "system", at: iso(at), ref, from: stateOf(stored), to: stateOf(next), effects: [], version: next.version }, p_new_keys: [] }), "reconcile");
      return "reconciled";
    },

    /** Every pursuit for one person, for reply routing and opt-out (lib/hire-lifecycle.mjs routeReply, optOutEverywhere). */
    async forPerson(person_id) {
      const rows = must(await db.from("hire_pursuits").select("id").eq("person_id", person_id), "forPerson") || [];
      return Promise.all(rows.map((r) => load(r.id)));
    },
  };
}
