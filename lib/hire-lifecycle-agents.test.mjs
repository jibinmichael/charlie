// lib/hire-lifecycle-agents.test.mjs — agents act through the one engine, each only inside its scope (the
// approved autonomy table), and Qualify & Submit's conversation moves are the engine's rules.
import { describe, it, expect } from "vitest";
import { AGENT_SCOPES, QUALIFY_STAGES, QUALIFY_MOVES, qualifyMove, createPursuit, transition } from "./hire-lifecycle.mjs";

const yes = { state: "GRANTED", confirm_hash: "h1", confirmed_hash: "h1", company_shown: "Acme", evidence: "email-1" };
const move = (from, to, actor = "agent", thread = {}, agent = actor === "agent" ? "outreach" : null) => qualifyMove({ from, to, actor, agent, thread, at: 1 });

describe("an agent acts only inside its scope", () => {
  it("Qualify & Submit may move its conversations; an agent without that scope and an unknown agent may not", () => {
    expect(move("verify_sent", "reminded").ok).toBe(true);
    // an id that is not an agent here is refused like any other
    expect(move("verify_sent", "reminded", "agent", {}, "followup").ok).toBe(false);
    expect(move("verify_sent", "reminded", "agent", {}, "rogue").ok).toBe(false);
    expect(move("verify_sent", "reminded", "agent", {}, null).ok).toBe(false);
  });

  it("on the outreach path, no agent may cause the follow-up timer now Follow-up is gone", () => {
    const job = { id: "j1", employer_id: "Acme", company: "Acme", lifecycle: "active" };
    const p = createPursuit({ id: "p1", job, person: { id: "a" }, source: "pool", open_gaps: [], at: 1 });
    const sent = transition(p, { type: "outreach.sent", actor: "charlie", at: 2, ask_id: "q1", sent_to: "a@x.com", wording_version: "w" }, { job, person: { email: "a@x.com", consent_pool: true }, assessment: { eligibility_status: "ELIGIBLE", disposition: "EVIDENCE_SUPPORTED", employer_review: "NONE", open: [] } });
    expect(sent.ok).toBe(true);
    const due = sent.pursuit.ask.due_at + 1;
    expect(transition(sent.pursuit, { type: "time.tick", actor: "agent", agent: "followup", at: due }, { job }).ok).toBe(false);
    expect(transition(sent.pursuit, { type: "time.tick", actor: "agent", agent: "outreach", at: due }, { job })).toMatchObject({ ok: false, reason: expect.stringMatching(/outreach may not cause time.tick/) });
  });

  it("the scopes are exactly the approved table", () => {
    expect(AGENT_SCOPES).toEqual({ outreach: ["qualify.moved"] });
  });
});

describe("Qualify & Submit's moves are the engine's rules", () => {
  it("the hand-off to the employer needs the candidate's plain YES to exactly the details that go", () => {
    expect(move("ready", "submitting", "agent", { consent: yes }).ok).toBe(true);
    expect(move("ready", "submitting", "agent", { consent: { ...yes, confirmed_hash: "old" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/not to the details/) });
    expect(move("ready", "submitting", "agent", { consent: { ...yes, state: "REPLIED" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/no YES/) });
    expect(move("ready", "submitting", "agent", { consent: { ...yes, evidence: null } })).toMatchObject({ ok: false, reason: expect.stringMatching(/no consent to this company/) });
    expect(move("ready", "submitting", "person", { consent: yes }).ok).toBe(false);
    expect(move("confirming", "ready", "candidate", { consent: yes }).ok).toBe(true);
    expect(move("confirming", "ready", "agent", { consent: yes }).ok).toBe(false);
  });

  it("closing on fit needs a person's approval; closing for anything else does not", () => {
    expect(move("answered", "closed", "agent", { close_reason: "fit is potential after their answers" })).toMatchObject({ ok: false, reason: expect.stringMatching(/approval/) });
    expect(move("answered", "closed", "agent", { close_reason: "fit is potential after their answers", overrides: { close: { fit: true } } }).ok).toBe(true);
    expect(move("answered", "closed", "agent", { close_reason: "expects 9 lakh; the role pays up to 6" }).ok).toBe(false);
    expect(move("answered", "closed", "agent", { close_reason: "experience check after their answers: INELIGIBLE" }).ok).toBe(false);
    expect(move("answered", "closed", "agent", { close_reason: "said no" }).ok).toBe(true);
    expect(move("reminded", "closed", "agent", { close_reason: "no reply" }).ok).toBe(true);
  });

  it("a person moves a held conversation on only with their decision on it; nothing leaves a closed or submitted one", () => {
    expect(move("held", "answered", "person", { overrides: { keep: { fit: true } } }).ok).toBe(true);
    expect(move("held", "answered", "person", { overrides: {} }).ok).toBe(false);
    for (const to of QUALIFY_STAGES) for (const a of ["agent", "candidate", "person"]) {
      expect(move("closed", to, a).ok, `closed>${to} by ${a}`).toBe(false);
      expect(move("submitted", to, a).ok, `submitted>${to} by ${a}`).toBe(false);
    }
  });

  it("every move is named in the rules: no stage can be reached from anywhere by anyone", () => {
    let legal = 0;
    for (const from of [null, ...QUALIFY_STAGES]) for (const to of QUALIFY_STAGES) for (const a of ["agent", "candidate", "person", "employer", "system"]) {
      const named = QUALIFY_MOVES.some(([fs, t, actors]) => fs.includes(from) && t === to && actors.includes(a));
      const r = move(from, to, a, { consent: yes, overrides: { close: { fit: true }, keep: { fit: true } }, close_reason: "no reply" });
      if (!named) expect(r.ok, `${from}>${to} by ${a}`).toBe(false);
      if (r.ok) legal++;
    }
    expect(legal).toBeLessThan(40);
  });
});

describe("one stage function and one timer policy", () => {
  it("Qualify's timers and the engine's policy are one source", async () => {
    const { DEFAULT_POLICY, QUALIFY_REMIND_HOURS, QUALIFY_CLOSE_HOURS } = await import("./hire-lifecycle.mjs");
    const { REMIND_AFTER_HOURS, CLOSE_AFTER_HOURS } = await import("./qualify/agent.mjs");
    expect(REMIND_AFTER_HOURS).toBe(DEFAULT_POLICY.follow_up_hours);
    expect(CLOSE_AFTER_HOURS).toBe(DEFAULT_POLICY.follow_up_hours + DEFAULT_POLICY.give_up_hours);
    expect([QUALIFY_REMIND_HOURS, QUALIFY_CLOSE_HOURS]).toEqual([REMIND_AFTER_HOURS, CLOSE_AFTER_HOURS]);
  });

  it("the Inbox's Qualify stage is the engine's function, not a second copy", async () => {
    const view = await import("./qualify/view.mjs");
    const { qualifyStageOf } = await import("./hire-lifecycle.mjs");
    expect(view.stageOf).toBe(qualifyStageOf);
  });
});

describe("lifecycle engine edge cases (each fails without its fix)", () => {
  it("a role that closes while someone is ready: the agent's close is legal (no false alarm, no one stuck under enforce)", () => {
    expect(move("ready", "closed", "agent", { close_reason: "the role is no longer open" }).ok).toBe(true);
  });

  it("a person's approval to close is for that check only", () => {
    expect(move("answered", "closed", "agent", { close_reason: "expects 9 lakh; the role pays up to 6", overrides: { close: { gate: true } } }).ok).toBe(false);
    expect(move("answered", "closed", "agent", { close_reason: "expects 9 lakh; the role pays up to 6", overrides: { close: { pay: true } } }).ok).toBe(true);
    expect(move("answered", "closed", "agent", { close_reason: "experience check after their answers: no answer", overrides: { close: { gate: true } } }).ok).toBe(true);
  });

  // the timers come from the engine's one policy
  it("the timers are 48 hours to the reminder and 96 to the quiet close", async () => {
    const { DEFAULT_POLICY } = await import("./hire-lifecycle.mjs");
    const { REMIND_AFTER_HOURS, CLOSE_AFTER_HOURS } = await import("./qualify/agent.mjs");
    expect([DEFAULT_POLICY.follow_up_hours, DEFAULT_POLICY.give_up_hours]).toEqual([48, 48]);
    expect([REMIND_AFTER_HOURS, CLOSE_AFTER_HOURS]).toEqual([48, 96]);
  });
});
