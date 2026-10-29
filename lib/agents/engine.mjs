// lib/agents/engine.mjs — the runner every agent goes through, so the rules are in one place:
//   - one run per agent at a time (a slow run is never overlapped)
//   - off is off; an agent whose workflow is not built never runs
//   - quiet hours (India time) and a daily limit on emails sent or drafted
//   - every run is recorded (hire_agent_runs) with what it did per person, INCLUDING the runs it skipped
//     and why, so "it did nothing" is always visible and never silent
//   - an agent that cannot record a run does not run (FAIL CLOSED)
// Approving a draft goes through here too: the exact stored email, through the same send guard.
import { AGENTS, inQuietHours } from "./registry.mjs";

const running = new Set();

/**
 * @param {{ id: string, trigger: "schedule"|"manual", now?: number, store: any, workflows: Record<string, Function>, deps: any, log?: Function }} a
 * @returns {Promise<{ status: string, run_id?: string, note?: string, counts?: any }>}
 */
export async function runAgent({ id, trigger, now = Date.now(), store, workflows, deps, log = (m) => console.error(m) }) {
  const def = AGENTS[id];
  if (!def) throw new Error(`unknown agent ${id}`);
  if (running.has(id)) return { status: "skipped", note: "the previous run is still going" };
  running.add(id);
  try {
    const cfg = await store.config(id);
    const skip = async (note) => {
      // a scheduled tick that does nothing is not worth a row every 15 minutes; a person pressing Run now is
      if (trigger === "manual") return { status: "skipped", note, run_id: await store.skippedRun({ agent: id, trigger, mode: cfg.mode, note }) };
      return { status: "skipped", note };
    };
    if (!def.built || !workflows[id]) return skip("this agent is not built yet");
    if (!cfg.enabled || cfg.mode === "off") return skip("this agent is off");
    if (inQuietHours(now, cfg.settings.quiet_from, cfg.settings.quiet_to)) return skip(`quiet hours (${cfg.settings.quiet_from}:00 to ${cfg.settings.quiet_to}:00, India time)`);
    // an agent that runs less often than the 15-minute sweep (Sourcing & Outreach: once a day) waits its turn
    if (trigger === "schedule" && Number(def.every_minutes) > 15) {
      const [last] = await store.runs(id, 1);
      if (last && now - Date.parse(last.started_at) < def.every_minutes * 60_000) return { status: "skipped", note: "not due yet" };
    }
    const used = await store.usedToday(id, now);
    const remaining = Math.max(0, Number(cfg.settings.daily_cap) - used);
    if (remaining <= 0) return skip(`today's limit of ${cfg.settings.daily_cap} is reached`);
    const runId = await store.startRun({ agent: id, trigger, mode: cfg.mode });
    try {
      const r = await workflows[id]({ cfg, now, remaining, runId, deps });
      const status = r.counts.failed > 0 ? "needs_review" : r.needsReview ? "needs_review" : "ok";
      await store.finishRun(runId, { status, counts: r.counts, items: r.items });
      return { status, run_id: runId, counts: r.counts };
    } catch (e) {
      log(`[agent:${id}] run failed: ${e?.message || e}`);
      await store.finishRun(runId, { status: "failed", error: String(e?.message || e).slice(0, 500), ...(e?.counts ? { counts: e.counts } : {}) }).catch(() => {});
      return { status: "failed", run_id: runId, note: String(e?.message || e) };
    }
  } finally {
    running.delete(id);
  }
}

/**
 * Send a draft exactly as it was proposed, or refuse. The draft moves out of pending first (the lock),
 * so two clicks can never send twice; then the same guard every send goes through. An agent may add a
 * re-check (deps.recheck) of what made the draft allowed, read again now; it failing or throwing is a no.
 * deps: { store, sendGuarded, resend, from, replyTo, preflight, validate, recheck? }
 */
export async function approveDraft({ id, by, deps }) {
  const { store, sendGuarded, resend, from, replyTo, preflight, validate, recheck } = deps;
  const d = await store.draft(id);
  if (!d) return { ok: false, reason: "no such draft" };
  if (d.status !== "pending") return { ok: false, reason: `this draft is already ${d.status}` };
  if (typeof recheck === "function") {
    let r;
    try { r = await recheck(d); } catch (e) { return { ok: false, reason: `could not re-check before sending, so nothing is sent: ${String(e?.message || e).slice(0, 160)}` }; }
    if (!r?.ok) return { ok: false, reason: r?.reason || "the re-check refused it; nothing is sent" };
  }
  if (!from) return { ok: false, reason: "CHARLIE_FROM is not set; nothing is sent" };
  await preflight(d.send.template);
  const payload = { from, to: d.email, replyTo, subject: d.subject, html: d.send.html, text: d.body_text };
  if (!validate(payload)) return { ok: false, reason: "the email is malformed; nothing is sent" };
  if (!(await store.decideDraft(id, { status: "sent", result: "sending", by }))) return { ok: false, reason: "someone else decided this draft first" };
  try {
    const res = await sendGuarded({ resend, email: d.email, template: d.send.template, dedupeKey: d.send.dedupeKey, payload });
    const sent = res?.status === "sent";
    await store.finishDraft(id, sent ? "sent" : `not sent: ${res?.status ?? "no status"}`);
    return { ok: sent, reason: sent ? "sent" : `not sent: ${res?.status ?? "no status"}` };
  } catch (e) {
    await store.finishDraft(id, `failed: ${String(e?.message || e).slice(0, 200)}`);
    return { ok: false, reason: String(e?.message || e) };
  }
}

export async function rejectDraft({ id, by, store }) {
  return (await store.decideDraft(id, { status: "rejected", result: "rejected", by })) ? { ok: true } : { ok: false, reason: "this draft is no longer pending" };
}
