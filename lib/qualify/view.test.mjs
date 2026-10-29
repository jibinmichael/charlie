// lib/qualify/view.test.mjs — the Inbox's view of a Qualify & Submit conversation follows the approved status map.
import { describe, it, expect } from "vitest";
import { stageOf, permissionOf, threadView, systemStageOf, closeGroupOf, SYSTEM_STAGES } from "./view.mjs";

const SENT = "2026-10-06T04:00:00.000Z";

describe("the approved status map", () => {
  it.each([
    [{ stage: "verify_sent", verify_sent_at: SENT }, "Asked", "them", "2026-10-08T04:00:00.000Z"],
    [{ stage: "verify_sent", rounds: 2, verify_sent_at: SENT }, "Follow-up asked", "them", "2026-10-10T04:00:00.000Z"],
    [{ stage: "reminded", verify_sent_at: SENT }, "Reminded", "them", "2026-10-10T04:00:00.000Z"],
    [{ stage: "answered" }, "Reading reply", "charlie", null],
    [{ stage: "confirming", consent: { confirm_sent_at: SENT, confirm_asks: 1 } }, "Confirming details", "their YES", "2026-10-10T04:00:00.000Z"],
    [{ stage: "ready" }, "Ready to submit", "charlie", null],
    [{ stage: "submitting" }, "Submitting", "pieworks", null],
    [{ stage: "submitted" }, "Submitted", "employer", null],
    [{ stage: "submitted", close_reason: "the employer already had them for this role" }, "Already with the employer", "employer", null],
    [{ stage: "closed", close_reason: "no reply" }, "Closed", null, null],
    [{ stage: "failed", last_error: "no CV PDF on record" }, "Needs you", "you", null],
  ])("%j", (t, label, waitingFor, nextAt) => expect(stageOf(t)).toMatchObject({ label, waitingFor, nextAt }));

  it("a date the row does not hold is not shown", () => {
    expect(stageOf({ stage: "verify_sent" }).nextAt).toBeNull();
  });

  it("permission: asked, replied, confirmed YES only with a confirmed hash, withdrawn", () => {
    expect(permissionOf({ state: "ASKED" }).label).toBe("Asked");
    expect(permissionOf({ state: "CONFIRM_ASKED", evidence: "e1" })).toMatchObject({ label: "Replied", ref: "e1" });
    expect(permissionOf({ state: "GRANTED" }).label).toBe("Replied");
    expect(permissionOf({ state: "GRANTED", confirmed_hash: "h", evidence_confirmed: "e2" })).toMatchObject({ label: "Confirmed YES", ref: "e2" });
    expect(permissionOf({ state: "WITHDRAWN" }).label).toBe("Withdrawn");
  });
});

describe("the thread view", () => {
  const t = {
    id: "t-1", name: "Asha Rao", email: "p1@x.com", reply_key: "secretkey", cv_text: "private cv text", stage: "confirming", fit: "strong", external_role_id: "1000101",
    fields: { name: { value: "Asha Rao" }, noticePeriod: { value: "30" } }, cv_path: "t-1/1/Asha_CV.pdf",
    consent: { state: "CONFIRM_ASKED", confirm_hash: "h", confirm_asks: 1, confirm_sent_at: SENT, justification: "Asha resolved billing tickets.", company_shown: "Northwind Labs", role_shown: "Support Engineer" },
    questions: [{ id: "consent", text: "May I put you forward?" }], answers: { consent: "Yes please", _confirm: [{ at: "2026-10-06T05:00:00Z", words: "Hmm" }], _after: [{ at: "2026-10-06T06:00:00Z", words: "stop", unread: true }] },
  };
  it("shows what was confirmed, the answers and kept replies; never the reply key or the CV text", () => {
    const v = threadView(t, { role: { payload: { role: "Support Engineer", clientName: "Northwind Labs", location: "Pune" } }, submissions: [{ status: "failed", attempt: 1, response: { error: "HTTP 502" } }, { status: "sent", attempt: 2, response: { message: "Saved" } }] });
    expect(v).toMatchObject({ label: "Confirming details", company: "Northwind Labs", city: "Pune", submission: { status: "sent", attempt: 2, message: "Saved" } });
    expect(v.confirm.lines).toContain("CV: Asha_CV.pdf");
    expect(v.confirm.lines).toContain("What I will say about you: Asha resolved billing tickets.");
    expect(v.questions).toEqual([{ id: "consent", text: "May I put you forward?", round: 1, answer: "Yes please" }]);
    // the confirm's dated step is the agent's own timer: closed quietly with no reply
    expect(v.next).toBe("Closes quietly if there is no reply");
    expect(v.kept).toEqual([{ at: "2026-10-06T05:00:00Z", words: "Hmm", unread: false }, { at: "2026-10-06T06:00:00Z", words: "stop", unread: true }]);
    expect(JSON.stringify(v)).not.toMatch(/secretkey|private cv text/);
  });
  it("no confirm sent yet: no confirm block", () => {
    expect(threadView({ ...t, consent: { state: "REPLIED" } }).confirm).toBeNull();
  });
});

describe("the candidacy lifecycle in the view", () => {
  it("every thread stage maps to one of the fixed system stages", () => {
    for (const stage of ["verify_sent", "reminded", "answered", "held", "confirming", "ready", "submitting", "submitted", "closed", "failed"]) expect(SYSTEM_STAGES, stage).toContain(systemStageOf({ stage }));
    expect(systemStageOf({ stage: "verify_sent" })).toBe("Contacted");
    expect(systemStageOf({ stage: "verify_sent", rounds: 2 })).toBe("Qualifying");
    expect(systemStageOf({ stage: "ready" })).toBe("Ready to introduce");
    expect(systemStageOf({ stage: "submitted" })).toBe("Introduced");
  });

  it("every close reason the agent writes falls in one of the four groups", () => {
    const g = (close_reason) => closeGroupOf({ stage: "closed", close_reason });
    expect(g("said no")).toBe("They chose");
    expect(g("took back their yes")).toBe("They chose");
    expect(g("will not work from the role's city")).toBe("They chose");
    expect(g("no reply")).toBe("No answer");
    expect(g("did not reply YES to the details")).toBe("No answer");
    expect(g("details still missing after a follow-up: cv")).toBe("No answer");
    expect(g("cannot be emailed (suppressed or blocked)")).toBe("No answer");
    expect(g("fit is potential after their answers")).toBe("Not a fit");
    expect(g("experience check after their answers: INELIGIBLE")).toBe("Not a fit");
    expect(g("expects 9 lakh; the role pays up to 6")).toBe("Not a fit");
    expect(g("the role is no longer open")).toBe("Employer chose");
    expect(g("refused by the employer system: closed")).toBe("Employer chose");
    expect(closeGroupOf({ stage: "answered", close_reason: "said no" })).toBeNull();
    expect(g("their yes was not confirmed")).toBe("No answer");
    expect(g("the employer passed on them for this role")).toBe("Employer chose");
    // the employer system's own words never decide the group
    expect(g("refused by the employer system: candidate said no to the fit")).toBe("Employer chose");
  });

  it("a held thread needs you and carries its question; events say who did what, never a candidate's address", () => {
    const v = threadView(
      { id: "t1", stage: "held", consent: {} },
      { proposal: { id: "p1", kind: "close_not_fit", check_id: "fit", reason: "fit is potential", evidence: { fit: "potential" }, proposed_by: "outreach", created_at: "2026-10-06T06:00:00Z" }, events: [{ at: "x", type: "stage.changed", actor_type: "candidate", actor_id: "a@x.com", from_stage: "verify_sent", to_stage: "answered" }, { at: "y", type: "proposal.made", actor_type: "agent", actor_id: "outreach", reason: "fit is potential" }] },
    );
    expect(v).toMatchObject({ label: "Needs you: close?", waitingFor: "you", needs_you: true, handled_by: null, system_stage: "Qualifying", proposal: { id: "p1", check: "fit" } });
    expect(v.events).toEqual([expect.objectContaining({ actor: "candidate", actor_id: null, from: "verify_sent", to: "answered" }), expect.objectContaining({ actor: "agent", actor_id: "outreach" })]);
    expect(threadView({ id: "t2", stage: "verify_sent", consent: {} })).toMatchObject({ handled_by: "Qualify & Submit", needs_you: false, proposal: null, events: [] });
  });
});
