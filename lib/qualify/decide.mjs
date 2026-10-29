// lib/qualify/decide.mjs — a person's decision on what an agent asked them (the "Needs you" queue of the candidacy
// lifecycle). The only question today is "close as not a fit?". The decision is recorded and kept on
// the thread for the agent to act on at its next run: approve (overrides.close[check]) closes them with the honest
// closing email; keep (overrides.keep[check]) carries on past that check. The agent sends; this never emails.
//
// The proposal moves first (pending → approved | kept) and is the lock: a second click, or a reply that voided the
// question meanwhile, finds nothing pending and changes nothing.

export const DECISIONS = { approve: "approved", keep: "kept" };

/** @returns {Promise<{ok: true, proposal: any} | {ok: false, status: number, reason: string, proposal?: any}>} */
export async function decideProposal({ id, decision, by = "workspace" }, { cstore }) {
  const status = DECISIONS[decision];
  if (!status) return { ok: false, status: 400, reason: "decision must be approve or keep" };
  const p = await cstore.proposal(id);
  if (!p) return { ok: false, status: 404, reason: "no such question" };
  if (p.status !== "pending") return { ok: false, status: 409, reason: `already ${p.status}` };
  const thread = await cstore.thread(p.thread_id);
  if (!thread || thread.stage !== "held") return { ok: false, status: 409, reason: "the conversation has moved on; read it again" };
  const decided = await cstore.decideProposal(id, status, by);
  if (!decided) return { ok: false, status: 409, reason: "already decided" };
  const person = cstore.as({ actor_type: "person", actor_id: by, reason: status === "approved" ? `approved: ${p.reason}` : `kept them: ${p.reason}` });
  const side = status === "approved" ? "close" : "keep";
  const overrides = { ...(thread.overrides || {}), [side]: { ...(thread.overrides?.[side] || {}), [p.check_id]: true } };
  const moved = await person.updateThreadIf(thread.id, "held", { stage: "answered", overrides }, { updated_at: thread.updated_at ?? null });
  // the history says a decision was acted on only when it was: a reply that won the race means it was not
  if (!moved) return { ok: false, status: 409, reason: "a reply arrived at the same moment; the agent reads it first and asks again if it still has to", proposal: decided };
  await person.recordEvent({ type: "proposal.decided", job_id: thread.job_id, thread_id: thread.id, candidate_id: thread.candidate_id, reason: status === "approved" ? `approved: ${p.reason}` : `kept them: ${p.reason}`, approval_id: p.id });
  return { ok: true, proposal: decided };
}
