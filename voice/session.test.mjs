// voice/session.test.mjs — every legal transition, every illegal one, and the kind rule.
// Invariants: no LLM chooses workflow state (the machine takes only a state, a kind, an event), and a
// test session has no review and no release.
import { describe, it, expect } from "vitest";
import { transition, legalTransitions, STATES, EVENTS, isTerminal } from "./session.mjs";

describe("transition", () => {
  it("walks the candidate happy path end to end", () => {
    const path = [
      ["invited", "consent.recorded", "consented"],
      ["consented", "conversation.started", "in_progress"],
      ["in_progress", "conversation.dropped", "in_progress"],
      ["in_progress", "conversation.resumed", "in_progress"],
      ["in_progress", "session.completed", "completed"],
      ["completed", "transcript.received", "transcript_ready"],
      ["transcript_ready", "evidence.extracted", "evidence_ready"],
      ["evidence_ready", "signals.computed", "evaluated"],
      ["evaluated", "report.rendered", "awaiting_review"],
      ["awaiting_review", "review.recorded", "reviewed"],
      ["reviewed", "report.released", "reported"],
      ["reported", "dispute.opened", "reported"],
    ];
    for (const [from, ev, to] of path) expect(transition({ state: from, kind: "candidate" }, ev)).toEqual({ ok: true, state: to });
  });

  it("a test session goes from evaluated straight to reported, and has no review or release", () => {
    expect(transition({ state: "evaluated", kind: "test" }, "report.rendered")).toEqual({ ok: true, state: "reported" });
    expect(transition({ state: "awaiting_review", kind: "test" }, "review.recorded").ok).toBe(false);
    expect(transition({ state: "reviewed", kind: "test" }, "report.released").ok).toBe(false);
    expect(transition({ state: "reviewed", kind: "test" }, "report.released").reason).toMatch(/nothing is released about a person/);
  });

  it("evaluator failure blocks, and a later successful evaluation unblocks", () => {
    expect(transition({ state: "evidence_ready", kind: "candidate" }, "signals.blocked")).toEqual({ ok: true, state: "blocked" });
    expect(transition({ state: "blocked", kind: "candidate" }, "signals.computed")).toEqual({ ok: true, state: "evaluated" });
    expect(transition({ state: "blocked", kind: "candidate" }, "report.rendered").ok).toBe(false);
  });

  it("side exits: declined, unreachable, expired, abandoned; an abandoned session still gets its transcript", () => {
    expect(transition({ state: "invited", kind: "candidate" }, "session.declined").state).toBe("declined");
    expect(transition({ state: "consented", kind: "candidate" }, "session.declined").state).toBe("declined");
    expect(transition({ state: "invited", kind: "candidate" }, "session.unreachable").state).toBe("unreachable");
    expect(transition({ state: "invited", kind: "candidate" }, "session.expired").state).toBe("expired");
    expect(transition({ state: "in_progress", kind: "candidate" }, "session.expired").state).toBe("abandoned");
    expect(transition({ state: "abandoned", kind: "candidate" }, "transcript.received").state).toBe("transcript_ready");
  });

  it("refuses every event that is not allowed in a state, with the state named", () => {
    const r = transition({ state: "invited", kind: "candidate" }, "report.released");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed in state "invited"/);
    expect(transition({ state: "reported", kind: "candidate" }, "conversation.started").ok).toBe(false);
    expect(transition({ state: "declined", kind: "candidate" }, "consent.recorded").ok).toBe(false);
    expect(transition({ state: "completed", kind: "candidate" }, "evidence.extracted").ok).toBe(false);
  });

  it("refuses unknown states, kinds, and events rather than guessing", () => {
    expect(transition({ state: "live", kind: "candidate" }, "consent.recorded").ok).toBe(false);
    expect(transition({ state: "invited", kind: "demo" }, "consent.recorded").ok).toBe(false);
    expect(transition({ state: "invited", kind: "candidate" }, "llm.decided").ok).toBe(false);
  });

  it("every legal transition lands in a known state, and the candidate machine has more edges than the test machine", () => {
    for (const kind of ["candidate", "test"]) {
      for (const t of legalTransitions(kind)) expect(STATES).toContain(t.to);
    }
    expect(legalTransitions("candidate").length).toBe(legalTransitions("test").length + 2);
    expect(EVENTS.length).toBeGreaterThan(10);
  });

  it("terminal states", () => {
    expect(isTerminal("reported")).toBe(true);
    expect(isTerminal("in_progress")).toBe(false);
    expect(isTerminal("expired")).toBe(false); // an expired invitation can be re-invited as a new session; the row itself stays
  });
});
