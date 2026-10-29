// lib/qualify/jobs.mjs — the jobs Qualify & Submit works on (hire_jobs, one per employer-system role; migration
// 20261004120000 and 20261004160000) and a person's decision on putting someone forward (kept on the thread, see
// lib/qualify/store.mjs setApproval). FAIL LOUD: every call throws on a database error.
import { store } from "../../charlie-store.mjs";

function must({ data, error }, what) {
  if (error) throw new Error(`qualify-jobs ${what}: ${error.message}`);
  return data;
}

export function qualifyJobs(db = null) {
  const c = () => db || store();
  /** The approval kept on the one thread for this job and person, as { decision, decided_by } or null. */
  async function decisionFor(jobId, candidateId) {
    const t = must(await c().from("hire_qualify_threads").select("overrides").eq("job_id", jobId).eq("candidate_id", candidateId).maybeSingle(), "decisionFor");
    const a = t?.overrides?.approval;
    return a?.decision ? { decision: a.decision, decided_by: a.by ?? null, at: a.at ?? null } : null;
  }
  return {
    client: c,
    async createJob({ title, client, jd_text, jd_source }) {
      return must(await c().from("hire_jobs").insert({ title, client, jd_text, jd_source, status: "approved" }).select("*").single(), "createJob");
    },
    async updateJob(id, { title, client, jd_text }) {
      return must(await c().from("hire_jobs").update({ title, client, jd_text }).eq("id", id).select("*").single(), "updateJob");
    },
    async getJob(id) {
      const job = must(await c().from("hire_jobs").select("*").eq("id", id).maybeSingle(), "getJob");
      return job ? { job } : null;
    },
    /** Active, paused or closed. Fails with a plain message while migration 20261004160000 is not applied. */
    async setLifecycle(id, lifecycle) {
      const r = await c().from("hire_jobs").update({ lifecycle }).eq("id", id).select("*").single();
      if (r.error && /lifecycle/i.test(String(r.error.message || ""))) throw new Error("the role state is not stored yet: apply migration 20261004160000_hire_job_lifecycle.sql");
      return must(r, "setLifecycle");
    },
    decisionFor,
  };
}
