// lib/qualify/decide.test.mjs — a person's decision on an agent's question is recorded with who made it, moves the
// question first (the lock), and leaves the acting to the agent; a stale or repeated decision changes nothing.
import { describe, it, expect } from "vitest";
import { decideProposal } from "./decide.mjs";

function fake({ proposal = { id: "p1", thread_id: "t1", check_id: "fit", reason: "fit is potential after their answers", status: "pending" }, thread = { id: "t1", job_id: "j1", candidate_id: "c1", stage: "held", updated_at: "v1", overrides: {} } } = {}) {
  const events = [], writes = [];
  let cause = null;
  const s = {
    as: (c) => ({ ...s, _cause: c, updateThreadIf: async (id, stage, patch, match) => { writes.push({ id, stage, patch, match, cause: c }); if (thread.stage !== stage || thread.updated_at !== match.updated_at) return null; Object.assign(thread, patch); return thread; }, recordEvent: async (e) => events.push({ ...e, cause: c }) }),
    proposal: async (id) => (proposal && proposal.id === id ? { ...proposal } : null),
    thread: async () => thread,
    decideProposal: async (id, status, by) => (proposal.status === "pending" ? Object.assign(proposal, { status, decided_by: by }) : null),
  };
  return { s, proposal, thread, events, writes, get cause() { return cause; } };
}

describe("a person's decision on 'close as not a fit?'", () => {
  it("approve: recorded with who decided; the thread goes back to the agent, told to close for that check", async () => {
    const f = fake();
    const out = await decideProposal({ id: "p1", decision: "approve", by: "workspace" }, { cstore: f.s });
    expect(out.ok).toBe(true);
    expect(f.proposal).toMatchObject({ status: "approved", decided_by: "workspace" });
    expect(f.thread).toMatchObject({ stage: "answered", overrides: { close: { fit: true } } });
    expect(f.writes[0].cause).toMatchObject({ actor_type: "person", actor_id: "workspace" });
    expect(f.events).toEqual([expect.objectContaining({ type: "proposal.decided", approval_id: "p1", cause: expect.objectContaining({ actor_type: "person" }) })]);
  });

  it("keep: the agent carries on past that check", async () => {
    const f = fake();
    await decideProposal({ id: "p1", decision: "keep" }, { cstore: f.s });
    expect(f.thread.overrides).toEqual({ keep: { fit: true } });
  });

  it("a second click, an unknown question, a moved thread or a bad decision change nothing", async () => {
    const f = fake();
    await decideProposal({ id: "p1", decision: "keep" }, { cstore: f.s });
    expect((await decideProposal({ id: "p1", decision: "approve" }, { cstore: f.s })).status).toBe(409);
    expect(f.thread.overrides).toEqual({ keep: { fit: true } });
    expect((await decideProposal({ id: "nope", decision: "approve" }, { cstore: fake().s })).status).toBe(404);
    expect((await decideProposal({ id: "p1", decision: "close" }, { cstore: fake().s })).status).toBe(400);
    const moved = fake({ thread: { id: "t1", stage: "answered", updated_at: "v2" } });
    expect((await decideProposal({ id: "p1", decision: "approve" }, { cstore: moved.s })).status).toBe(409);
    expect(moved.proposal.status).toBe("pending");
    expect(moved.events).toEqual([]);
    // a reply lands between the read and the write: refused, and the history never says it was acted on
    const race = fake();
    race.s.thread = async () => ({ ...race.thread, updated_at: "v0" });
    const out = await decideProposal({ id: "p1", decision: "approve" }, { cstore: race.s });
    expect(out.status).toBe(409);
    expect(race.events).toEqual([]);
  });
});
