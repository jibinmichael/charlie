// lib/agents/store.mjs — the ONLY reader and writer of hire_agents, hire_agent_runs and
// hire_agent_drafts (migration 20261005150000). FAIL LOUD: an agent that cannot record what it did must
// not do it, so every read and write here throws on error and the runner (lib/agents/engine.mjs) stops.
import { AGENT_IDS, configOf, istDayStart } from "./registry.mjs";

function must({ data, error }, what) {
  if (error) throw new Error(`agents-store ${what}: ${error.message}`);
  return data;
}

/** Sum the AI use of runs that measured it; older runs without ai_calls are left out, never counted as 0. Pure. */
export function sumAiUse(rows) {
  const metered = (rows || []).filter((r) => typeof r?.counts?.ai_calls === "number");
  const n = (r, k) => Number(r.counts[k]) || 0;
  return {
    runs: metered.length,
    since: metered.reduce((m, r) => (!m || r.started_at < m ? r.started_at : m), null),
    ai_calls: metered.reduce((t, r) => t + n(r, "ai_calls"), 0),
    tokens: metered.reduce((t, r) => t + n(r, "tokens_in") + n(r, "tokens_out") + n(r, "tokens_cache_read") + n(r, "tokens_cache_write"), 0),
    submitted: metered.reduce((t, r) => t + n(r, "submitted"), 0),
  };
}

export function agentStore(db) {
  if (!db) throw new Error("agentStore needs a database client");
  return {
    /** Every agent's live configuration (stored row over defaults). */
    async configs() {
      const rows = must(await db.from("hire_agents").select("*"), "configs") || [];
      return AGENT_IDS.map((id) => configOf(id, rows.find((r) => r.id === id) ?? null));
    },

    async config(id) {
      const rows = must(await db.from("hire_agents").select("*").eq("id", id), "config") || [];
      return configOf(id, rows[0] ?? null);
    },

    /** Store a change; whatever is not given keeps its current value. */
    async saveConfig(id, { enabled, mode, settings }, by) {
      const cur = await this.config(id);
      const row = {
        id,
        enabled: enabled ?? cur.enabled,
        mode: mode ?? cur.mode,
        settings: { ...cur.settings, ...(settings ?? {}) },
        updated_at: new Date().toISOString(),
        updated_by: by ?? null,
      };
      must(await db.from("hire_agents").upsert(row), "saveConfig");
      return this.config(id);
    },

    async startRun({ agent, trigger, mode }) {
      const r = must(await db.from("hire_agent_runs").insert({ agent, trigger, mode, status: "running" }).select("id").single(), "startRun");
      return r.id;
    },

    async finishRun(id, { status, counts = {}, items = [], note = null, error = null }) {
      must(await db.from("hire_agent_runs").update({ status, counts, items, note, error, finished_at: new Date().toISOString() }).eq("id", id), "finishRun");
    },

    /** A run that never started work (off, quiet hours, daily limit), recorded so the screen can say why. */
    async skippedRun({ agent, trigger, mode, note }) {
      const r = must(await db.from("hire_agent_runs").insert({ agent, trigger, mode, status: "skipped", note, finished_at: new Date().toISOString() }).select("id").single(), "skippedRun");
      return r.id;
    },

    async runs(agent, limit = 20) {
      return must(await db.from("hire_agent_runs").select("*").eq("agent", agent).order("started_at", { ascending: false }).limit(limit), "runs") || [];
    },

    async run(id) {
      return must(await db.from("hire_agent_runs").select("*").eq("id", id).maybeSingle(), "run");
    },

    /** AI tokens against people put forward, over every run that measured its AI use. Paged, so
     *  a long history is never cut at the API's row limit and silently undercounted. */
    async aiUse(agent) {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await db.from("hire_agent_runs").select("counts, started_at").eq("agent", agent).not("counts->ai_calls", "is", null).order("started_at", { ascending: true }).range(from, from + 999), "aiUse") || [];
        rows.push(...page);
        if (page.length < 1000) break;
      }
      return sumAiUse(rows);
    },

    /** Emails this agent sent or drafted today (India day): what the daily limit counts. */
    async usedToday(agent, now) {
      const rows = must(await db.from("hire_agent_runs").select("counts").eq("agent", agent).gte("started_at", istDayStart(now)), "usedToday") || [];
      return rows.reduce((n, r) => n + (Number(r.counts?.sent) || 0) + (Number(r.counts?.drafted) || 0), 0);
    },

    /** Propose an email. One per agent, person, role and kind: a second proposal is a no-op (false). */
    async addDraft(d) {
      const existing = must(await db.from("hire_agent_drafts").select("id,status").eq("agent", d.agent).eq("email", d.email).eq("mandate", d.mandate).eq("kind", d.kind), "addDraft:find") || [];
      if (existing.length) return false;
      must(await db.from("hire_agent_drafts").insert(d), "addDraft");
      return true;
    },

    async drafts({ status = "pending", agent = null, limit = 100 } = {}) {
      let q = db.from("hire_agent_drafts").select("*").eq("status", status);
      if (agent) q = q.eq("agent", agent);
      return must(await q.order("created_at", { ascending: false }).limit(limit), "drafts") || [];
    },

    async draft(id) {
      return must(await db.from("hire_agent_drafts").select("*").eq("id", id).maybeSingle(), "draft");
    },

    /** After an approved draft's send: sent, or failed with why (never left looking sent when it was not). */
    async finishDraft(id, result) {
      must(await db.from("hire_agent_drafts").update({ status: result === "sent" ? "sent" : "failed", result }).eq("id", id), "finishDraft");
    },

    /** Move a draft out of pending exactly once (the pending filter is the lock). */
    async decideDraft(id, { status, result = null, by = null }) {
      const rows = must(await db.from("hire_agent_drafts").update({ status, result, decided_by: by, decided_at: new Date().toISOString() }).eq("id", id).eq("status", "pending").select("id"), "decideDraft") || [];
      return rows.length === 1;
    },
  };
}
