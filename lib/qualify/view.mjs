// lib/qualify/view.mjs — one Qualify & Submit conversation as the Inbox shows it. PURE.
//
// The status map: every stage, who it is waiting for, and what happens next with its date,
// read straight from the agent's own thread row (lib/qualify/agent.mjs). Nothing here is set by hand and nothing is
// guessed: a date the row does not hold is not shown. The reply address key and the CV text never leave the server.
import { confirmFacts } from "./agent.mjs";
import { SYSTEM_STAGES, CLOSE_GROUPS, qualifyStageOf } from "../hire-lifecycle.mjs";


/** Stage, waiting for, and next step: the engine's (lib/hire-lifecycle.mjs qualifyStageOf), one place for it. */
export const stageOf = qualifyStageOf;

/**
 * The candidacy lifecycle's system stages: the same few words for every organisation and every
 * agent, derived from the thread, never stored. Found, Contacted, Interested, Qualifying, Ready to introduce,
 * Introduced, With employer, Hired, or Closed with a reason group. Pure.
 */
export { SYSTEM_STAGES, CLOSE_GROUPS };
export function systemStageOf(t = {}) {
  switch (t.stage) {
    case "verify_sent": return (t.rounds ?? 1) >= 2 || t.consent?.recheck_asked ? "Qualifying" : "Contacted";
    case "reminded": return "Contacted";
    case "answered": case "held": case "confirming": case "failed": return "Qualifying";
    case "ready": case "submitting": return "Ready to introduce";
    case "submitted": return "Introduced";
    case "closed": return "Closed";
    default: return null;
  }
}

/** Why a closed conversation ended, in the four fixed groups; null when the reason says nothing we can group. Pure. */
export function closeGroupOf(t = {}) {
  if (t.stage !== "closed") return null;
  const r = String(t.close_reason || "").toLowerCase();
  // the employer system's own words come after its prefix and must never be matched as ours: checked first
  if (/^refused by the employer system/.test(r) || /no longer open/.test(r) || /^the employer passed/.test(r)) return "Employer chose";
  if (/said no|took back|will not work/.test(r)) return "They chose";
  if (/no reply|did not reply|still missing|cannot be emailed|yes was not confirmed/.test(r)) return "No answer";
  if (/fit is|experience check|expects .* lakh/.test(r)) return "Not a fit";
  return null;
}

/** Where their permission stands, with the email it came from. Pure. */
export function permissionOf(c = {}) {
  if (c.state === "WITHDRAWN") return { label: "Withdrawn", at: c.withdrawn_at || null, ref: c.evidence_withdrawn || null };
  if (c.state === "GRANTED" && c.confirmed_hash) return { label: "Confirmed YES", at: c.confirmed_at || null, ref: c.evidence_confirmed || null };
  if (["REPLIED", "GRANTED", "CONFIRM_ASKED", "CONFIRM_UNCLEAR", "RECHECK"].includes(c.state)) return { label: "Replied", at: c.replied_at || null, ref: c.evidence || null };
  return { label: "Asked", at: c.asked_at || null, ref: null };
}

/**
 * The Inbox's view of one thread. role: the hire_connection_roles row (payload = the employer's role); submissions:
 * this thread's hire_submissions rows. Pure.
 * @param {any} [t]
 * @param {{ role?: any, submissions?: any[], events?: any[], proposal?: any }} [opts]
 */
export function threadView(t = {}, { role = null, submissions = [], events = [], proposal = null } = {}) {
  const c = t.consent || {};
  const facts = c.confirm_hash ? confirmFacts(t.fields || {}, t.cv_path, c.justification || "") : null;
  const last = [...submissions].sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0)).pop() || null;
  const kept = [...(Array.isArray(t.answers?._after) ? t.answers._after : []), ...(Array.isArray(t.answers?._confirm) ? t.answers._confirm : [])]
    .map((x) => ({ at: x?.at || null, words: String(x?.words || ""), unread: Boolean(x?.unread) }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    id: t.id, name: t.name || null, email: t.email || null,
    role: role?.payload?.role || c.role_shown || null, company: role?.payload?.clientName || c.company_shown || null, city: role?.payload?.location || null,
    external_role_id: t.external_role_id || null, job_id: t.job_id || null, fit: t.fit || null, rounds: t.rounds ?? 1,
    stage: t.stage, ...stageOf(t),
    system_stage: systemStageOf(t), close_group: closeGroupOf(t),
    // which agent is handling it: Qualify & Submit, while the conversation is open
    handled_by: ["verify_sent", "reminded", "answered", "confirming", "ready", "submitting"].includes(t.stage) ? "Qualify & Submit" : null,
    needs_you: t.stage === "held" || t.stage === "failed" || (t.stage === "ready" && !t.overrides?.approval?.decision) || [...(t.answers?._after || [])].some((x) => x?.unread),
    // a person's decision on putting them forward (lib/qualify/store.mjs setApproval); a ready thread waits for "saved"
    approval: t.overrides?.approval?.decision ? { decision: t.overrides.approval.decision, by: t.overrides.approval.by ?? null, at: t.overrides.approval.at ?? null } : null,
    proposal: proposal ? { id: proposal.id, kind: proposal.kind, check: proposal.check_id, reason: proposal.reason, evidence: proposal.evidence || {}, proposed_by: proposal.proposed_by, at: proposal.created_at || null } : null,
    // what happened, in order, and who caused it (hire_candidacy_events)
    events: events.map((e) => ({ at: e.at, type: e.type, actor: e.actor_type, actor_id: e.actor_type === "candidate" ? null : e.actor_id || null, from: e.from_stage || null, to: e.to_stage || null, reason: e.reason || null })),
    permission: permissionOf(c),
    confirm: facts ? { lines: facts, asks: Number(c.confirm_asks || 0), sent_at: c.confirm_sent_at || null } : null,
    questions: (t.questions || []).map((q) => ({ id: q.id, text: q.text, round: q.round ?? 1, answer: typeof t.answers?.[q.id] === "string" ? t.answers[q.id] : null })),
    kept,
    submission: last ? { status: last.status, attempt: last.attempt ?? null, at: last.created_at || null, message: last.response?.message ?? last.response?.error ?? null } : null,
    verify_sent_at: t.verify_sent_at || null, replied_at: t.replied_at || null, updated_at: t.updated_at || null, created_at: t.created_at || null,
  };
}
