// lib/hire-outreach-lifecycle.mjs — where each outreach thread stands in the candidate lifecycle, for the
// inbox. READ ONLY: the saved pursuit where one exists (savedLifecycles), else computed on every read from the
// backfill mapping (lib/hire-pursuit-backfill.mjs) and lib/hire-lifecycle.mjs stageOf. Nothing is written.
//
// FAILS TOWARD "a person reads it": if the human yes lists cannot be read, nobody is shown as
// interested, their replies show as a reply to read. One thread that cannot be mapped carries its own
// error and never takes the others down.
import { readFileSync } from "node:fs";
import { mapOutreachThread, yesListsFromSource } from "./hire-pursuit-backfill.mjs";
import { stageOf, systemStageOf } from "./hire-lifecycle.mjs";
import { OUTREACH_MANDATES } from "./hire-outreach.mjs";

/**
 * The human yes lists, read as text from the operator file named by HIRE_YES_LISTS_FILE (a module with a
 * `const MANDATES = { <key>: { yes: [poolId, ...] } }` block; it is never imported or run).
 * {} when the variable is unset or the file is unreadable.
 */
export function yesLists() {
  const file = process.env.HIRE_YES_LISTS_FILE;
  if (!file) return {};
  try {
    const y = yesListsFromSource(readFileSync(file, "utf8"));
    return y.error ? {} : y;
  } catch {
    return {};
  }
}

/** One thread's lifecycle, as the inbox shows it. Pure. */
export function threadLifecycle(thread, { yes, suppression, now }) {
  const r = mapOutreachThread(thread, { person_id: thread.person.email, yes, suppression, now });
  if (r.unmapped) return { unmapped: true, why: r.why, flags: r.flags };
  const p = r.pursuit;
  const ctx = { job: { id: p.job_id, employer_id: p.employer_id, company: null, lifecycle: "active" }, assessment: null, person: {} };
  const s = stageOf(p, ctx);
  const sys = systemStageOf(p, ctx);
  return {
    stage: s.stage,
    system_stage: sys.stage,
    close_group: sys.group,
    nextAction: s.next_action,
    owner: s.owner,
    waitingFor: s.waiting_for,
    dueAt: Number.isFinite(s.due_at) ? new Date(s.due_at).toISOString() : null,
    engagement: p.engagement,
    screening: p.screening.state,
    consentToScreen: p.screening_consent.state,
    consentToIntroduce: p.disclosure.state,
    flags: r.flags,
    shadow: true,
  };
}

/** A saved hire_pursuits row as stageOf reads it (history and keys are not needed to say where someone stands). Pure. */
export function savedView(row) {
  return { id: row.id, job_id: row.job_id, employer_id: row.employer, person_id: row.person_id, source: row.source, outreach_type: row.outreach_type, contact: row.contact, engagement: row.engagement, screening_consent: row.screening_consent, disclosure: row.disclosure, screening: row.screening, handoff: row.handoff, ask: row.ask ?? null, to_read: row.to_read ?? null, closed_out: row.closed_out, sent_to: row.sent_to ?? null, keys: [], history: [] };
}

function shape(p, s, extra, sys = null) {
  return {
    stage: s.stage,
    system_stage: sys?.stage ?? null,
    close_group: sys?.group ?? null,
    nextAction: s.next_action,
    owner: s.owner,
    waitingFor: s.waiting_for,
    dueAt: Number.isFinite(s.due_at) ? new Date(s.due_at).toISOString() : null,
    engagement: p.engagement,
    screening: p.screening.state,
    consentToScreen: p.screening_consent.state,
    consentToIntroduce: p.disclosure.state,
    ...extra,
  };
}

/**
 * The SAVED lifecycle for one mandate's threads (lib/hire-pursuit-sync.mjs keeps it in step). Map of email -> lifecycle; an email with no
 * saved pursuit is absent (the caller falls back to the derived stage and says so). Reads only.
 */
export async function savedLifecycles(db, jobId, emails) {
  const out = new Map();
  if (!jobId || !emails.length) return out;
  const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data || []; };
  const job = must(await db.from("hire_jobs").select("id,client,lifecycle").eq("id", jobId).limit(1), "hire_jobs")[0];
  if (!job?.client) return out;
  const people = must(await db.from("hire_people").select("id,email").in("email", emails), "hire_people");
  if (!people.length) return out;
  const rows = must(await db.from("hire_pursuits").select("*").eq("job_id", jobId).in("person_id", people.map((p) => p.id)), "hire_pursuits");
  const byId = new Map(people.map((p) => [p.id, p]));
  const lj = { id: job.id, employer_id: job.client, company: job.client, lifecycle: job.lifecycle ?? "active" };
  for (const row of rows) {
    const person = byId.get(row.person_id);
    const p = savedView(row);
    const ctx = { job: lj, assessment: null, person: { email: person.email } };
    out.set(String(person.email).toLowerCase(), shape(p, stageOf(p, ctx), { saved: true, assessed: false, seq: row.seq }, systemStageOf(p, ctx)));
  }
  return out;
}

/** Every thread of one mandate with its lifecycle: the saved one where it exists, else derived. Writes nothing. */
export async function withLifecycle(db, threads, mandate, now) {
  const emails = threads.map((t) => t.person.email);
  let supp = new Map();
  if (emails.length) {
    const r = await db.from("suppressions").select("address,reason").in("address", emails);
    if (r.error) throw new Error(`suppressions: ${r.error.message}`);
    supp = new Map((r.data || []).map((s) => [String(s.address).toLowerCase(), s.reason]));
  }
  const yes = yesLists()[mandate] ?? new Set();
  // the saved stage wins; a failed read of it falls back to the derived stage rather than blanking the inbox
  let saved = new Map();
  try {
    saved = await savedLifecycles(db, OUTREACH_MANDATES[mandate]?.job_id, emails);
  } catch (e) {
    console.error(`[outreach-lifecycle] ${mandate}: saved stage unreadable, showing derived: ${e?.message || e}`);
  }
  return threads.map((t) => {
    try {
      const kept = saved.get(String(t.person.email).toLowerCase());
      if (kept) return { ...t, lifecycle: kept };
      return { ...t, lifecycle: { ...threadLifecycle(t, { yes: yes.has(t.person.poolId), suppression: supp.get(t.person.email), now }), saved: false } };
    } catch (e) {
      return { ...t, lifecycle: { error: String(e?.message || e) } };
    }
  });
}
