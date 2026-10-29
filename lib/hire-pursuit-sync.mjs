// lib/hire-pursuit-sync.mjs — keep the saved candidate lifecycle in step with the outreach email record.
// For every outreach mandate that belongs to a hire_jobs row
// (lib/hire-outreach.mjs OUTREACH_MANDATES job_id), each thread is mapped to a pursuit exactly as the
// backfill maps it (lib/hire-pursuit-backfill.mjs mapOutreachThread) and then:
//   no saved pursuit for that job and person -> IMPORTED  (one `pursuit.imported` event)
//   saved, and the email record says the same  -> unchanged (nothing written)
//   saved, and the email record says otherwise -> RECONCILED (one `pursuit.reconciled` event, from and to)
// Runs every 15 minutes on the server, so a send or a reply moves the saved stage without the send path or
// /inbound changing.
//
// THE EMAIL RECORD IS THE SOURCE while every state is email-derived. A pursuit an agent has written through the one
// lifecycle engine (an event whose actor is "agent") is never overwritten: the difference is counted as
// `differs` and logged for a person, and the engine's record stands.
//
// FAIL CLOSED, PER PERSON: an identity conflict, an unmapped thread or a failed write is counted and
// logged, never guessed and never allowed to stop the rest.
import { randomUUID } from "node:crypto";
import { loadOutreach, OUTREACH_MANDATES } from "./hire-outreach.mjs";
import { mapOutreachThread } from "./hire-pursuit-backfill.mjs";
import { yesLists } from "./hire-outreach-lifecycle.mjs";
import { pursuitStore, lifecycleJob, stateDiffers } from "./hire-pursuit-store.mjs";

function must({ data, error }, what) {
  if (error) throw new Error(`hire-pursuit-sync ${what}: ${error.message}`);
  return data;
}

/**
 * @param {any} db a Supabase client
 * @returns {Promise<{mandates: Record<string, {imported:number, reconciled:number, unchanged:number, conflicts:number, unmapped:number, failed:number}>, skipped: string[]}>}
 */
export async function syncOutreachPursuits(db, { now = Date.now(), log = (m) => console.error(m), mandates = OUTREACH_MANDATES } = {}) {
  const store = pursuitStore(db);
  const yes = yesLists();
  const out = { mandates: {}, skipped: [] };
  for (const [key, M] of Object.entries(mandates)) {
    if (!M.job_id) { out.skipped.push(key); continue; }
    const n = { imported: 0, reconciled: 0, unchanged: 0, differs: 0, conflicts: 0, unmapped: 0, failed: 0 };
    out.mandates[key] = n;
    try {
    const jobRow = must(await db.from("hire_jobs").select("id,client,lifecycle").eq("id", M.job_id).maybeSingle(), `job ${key}`);
    if (!jobRow) { log(`[pursuit-sync] ${key}: job ${M.job_id} not found; nothing saved`); continue; }
    const job = lifecycleJob(jobRow); // throws without a client: no employer, no pursuit
    const threads = await loadOutreach(db, key, now);
    const emails = threads.map((t) => t.person.email);
    const supp = new Map(emails.length ? must(await db.from("suppressions").select("address,reason").in("address", emails), "suppressions").map((s) => [String(s.address).toLowerCase(), s.reason]) : []);
    for (const t of threads) {
      try {
        const who = await store.person({ email: t.person.email, linkedin_url: t.person.linkedin, full_name: t.person.name });
        if (who.action === "conflict") { n.conflicts++; log(`[pursuit-sync] ${key} ${t.id}: identity conflict, not saved (${who.reason})`); continue; }
        const mapped = mapOutreachThread(t, { person_id: who.id, yes: yes[key]?.has(t.person.poolId) ?? false, suppression: supp.get(t.person.email), now, job });
        if (mapped.unmapped) { n.unmapped++; log(`[pursuit-sync] ${key} ${t.id}: unmapped (${mapped.why.join("; ")})`); continue; }
        const saved = must(await db.from("hire_pursuits").select("id").eq("job_id", job.id).eq("person_id", who.id).maybeSingle(), "find");
        if (!saved) {
          await store.importPursuit({ ...mapped.pursuit, id: randomUUID() }, { at: now, ref: `outreach:${key}` });
          n.imported++;
        } else {
          const cur = await store.load(saved.id);
          if (cur.history.some((e) => e.actor === "agent")) {
            // the engine's record stands; the email record's different reading is reported, never written over it
            if (stateDiffers(cur, mapped.pursuit)) { n.differs++; log(`[pursuit-sync] ${key} ${t.id}: an agent wrote this pursuit through the engine; the email record differs, not overwritten`); }
            else n.unchanged++;
            continue;
          }
          const r = await store.reconcile(cur, mapped.pursuit, { at: now, ref: `outreach:${key}` });
          n[r]++;
        }
      } catch (e) {
        n.failed++;
        log(`[pursuit-sync] ${key} ${t.id}: ${e?.message || e}`);
      }
    }
    } catch (e) {
      // one mandate that cannot be read (no job, no client, a failed read) never stops the others
      n.failed++;
      n.error = String(e?.message || e);
      log(`[pursuit-sync] ${key}: ${n.error}`);
    }
  }
  return out;
}
