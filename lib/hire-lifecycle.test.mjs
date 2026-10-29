// lib/hire-lifecycle.test.mjs — the pursuit model (lib/hire-lifecycle.mjs). Every legal
// transition is exercised, every illegal one is generated and refused, and a seeded random walk checks
// the invariants after every accepted event: above all, no one reaches the employer without consent
// to be introduced to THAT employer for THAT job.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createPursuit, transition, stageOf, handoffReadiness, routeReply, optOutEverywhere, invariants, contactability, transitionTable, RULES, DIMENSIONS, SCREENING, ENGAGEMENT } from "./hire-lifecycle.mjs";
// the dispositions an assessment can carry (they were read from the hiring contract schema, which is not part of this codebase)
const DISPOSITIONS = ["RANK_CUT", "PROCESSING_ERROR", "ENRICHMENT_PENDING", "INELIGIBLE", "EXCLUDED_BY_POLICY", "NEEDS_VERIFICATION", "EVIDENCE_SUPPORTED", "LOW_EVIDENCE"];

const H = 3_600_000;
const T0 = Date.parse("2026-10-05T09:00:00Z");
const JOB_A = { id: "job-a", employer_id: "emp-acme", company: "Acme", lifecycle: "active" };
const JOB_B = { id: "job-b", employer_id: "emp-acme", company: "Acme", lifecycle: "active" };
const JOB_C = { id: "job-c", employer_id: "emp-zeta", company: "Zeta", lifecycle: "active" };
const ASHA = { id: "person-asha", email: "asha@example.com", consent_pool: true, suppressed: false };
const RAVI = { id: "person-ravi", email: "ravi@example.com", consent_pool: false, suppressed: false };
const GAP = "exp:total:2-4";
const GOOD = { eligibility_status: "ELIGIBLE", disposition: "EVIDENCE_SUPPORTED", open: [], employer_review: "NONE" };
const NEEDS = { eligibility_status: "NEEDS_VERIFICATION", disposition: "NEEDS_VERIFICATION", open: [GAP], employer_review: "NONE" };
const INELIGIBLE = { eligibility_status: "INELIGIBLE", disposition: "INELIGIBLE", open: [], employer_review: "NONE" };
const ctx = (job = JOB_A, assessment = GOOD, person = ASHA, policy) => ({ job, assessment, person, policy });

const accepted = new Set(); // every event type some test drove through successfully
let clock = T0;
const ev = (type, extra = {}) => ({ type, actor: RULES[type].actors[0], at: (clock += H), ...extra });
function run(p, c, ...events) {
  for (const e of events) {
    const r = transition(p, e, c);
    if (!r.ok) throw new Error(`${e.type}: ${r.reason}`);
    expect(invariants(r.pursuit)).toEqual([]);
    accepted.add(e.type);
    p = r.pursuit;
  }
  return p;
}
const refused = (p, c, e) => { const r = transition(p, e, c); expect(r.ok).toBe(false); return r.reason; };
const fresh = ({ job = JOB_A, person = ASHA, source = "pool", gaps = [], id } = {}) =>
  createPursuit({ id: id ?? `${person.id}:${job.id}`, job, person, source, source_at: source === "sourced" ? T0 - 24 * H : null, discovery_run: source === "sourced" ? "run-1" : null, open_gaps: gaps, at: T0 });

// the steps of the pool path, so other tests can stop anywhere along it
const contact = (p, c, k = "k1") => run(p, c, ev("outreach.sent", { ask_id: k, sent_to: c.person.email }));
const yes = (p, c, k = "k1") => run(p, c, ev("candidate.interested", { ask_id: k, ref: `m-${k}` }));
const screenConsent = (p, c) => run(p, c, ev("screening_consent.requested", { ask_id: "k2", wording_version: "sc-v1" }), ev("screening_consent.granted", { ask_id: "k2", ref: "m-k2" }));
const disclose = (p, c, job = c.job) => run(p, c, ev("disclosure.requested", { ask_id: "k3", job_id: job.id, employer_id: job.employer_id, company_shown: job.company, wording_version: "dc-v1" }), ev("disclosure.granted", { ask_id: "k3", ref: "m-k3" }));
const screen = (p, c, answers = { [GAP]: "3 years 2 months at Ather" }, k = "k4") => run(p, c, ev("screening.sent", { ask_id: k, mode: "questions", gaps: p.screening.gaps }), ev("screening.answered", { ask_id: k, answers }));

describe("the pool path, end to end", () => {
  it("matched → contacted → interested → screening consent → disclosure consent → screened → employer-ready → handed off", () => {
    const c = ctx(JOB_A, NEEDS);
    let p = fresh({ gaps: [GAP] });
    expect(stageOf(p, c)).toMatchObject({ stage: "Matched", next_action: "Send outreach (needs approval)", owner: "operator" });
    p = contact(p, c);
    expect(p.contact).toEqual({ state: "PERMITTED", basis: "pool_consent" });
    expect(stageOf(p, c)).toMatchObject({ stage: "Waiting for reply", waiting_for: "INTEREST", owner: "candidate", due_at: p.ask.opened_at + 48 * H });
    p = yes(p, c);
    expect(stageOf(p, c)).toMatchObject({ stage: "Interested", next_action: "Ask permission to screen" });
    p = screenConsent(p, c);
    expect(stageOf(p, c)).toMatchObject({ stage: "Consent received", next_action: "Ask permission to introduce them to Acme" });
    p = disclose(p, c);
    expect(p.disclosure).toMatchObject({ state: "GRANTED", job_id: "job-a", employer_id: "emp-acme", company_shown: "Acme", wording_version: "dc-v1", evidence: "m-k3" });
    expect(stageOf(p, c)).toMatchObject({ stage: "Consent received", next_action: "Send screening for the open gaps only" });
    p = screen(p, c);
    expect(p.screening.state).toBe("COMPLETED");
    // the answers go back to the Hiring Contract; the lifecycle only sees its new verdict
    expect(stageOf(p, c)).toMatchObject({ stage: "Needs verification" });
    const c2 = ctx(JOB_A, GOOD);
    p = run(p, c2, ev("gate.recomputed", { open_gaps: [] }));
    expect(stageOf(p, c2)).toMatchObject({ stage: "Employer-ready", next_action: "Prepare the handoff for approval", owner: "operator" });
    p = run(p, c2, ev("handoff.sent", { ask_id: "k5" }));
    const handed = p;
    expect(stageOf(p, c2)).toMatchObject({ stage: "With employer", waiting_for: "EMPLOYER_FEEDBACK", owner: "employer" });
    p = run(p, c2, ev("employer.progressing"));
    expect(stageOf(p, c2).stage).toBe("With employer: progressing");
    expect(refused(p, c2, ev("cv.requested", { ask_id: "k9" }))).toMatch(/already with the employer/);
    const bounced = run(handed, c2, ev("send.bounced"));
    expect(bounced.ask).toMatchObject({ kind: "EMPLOYER_FEEDBACK" }); // the candidate's mailbox never ends the employer's wait
    const declined = run(p, c2, ev("employer.declined"));
    expect(stageOf(declined, c2)).toMatchObject({ stage: "Employer declined", next_action: "Tell them honestly, once" });
  });

  it("with no open gaps, screening is not required and no screening consent is asked", () => {
    const c = ctx();
    let p = yes(contact(fresh(), c), c);
    expect(stageOf(p, c).next_action).toBe("Ask permission to introduce them to Acme");
    expect(refused(p, c, ev("screening_consent.requested", { ask_id: "kx", wording_version: "v" }))).toMatch(/nothing to screen/);
    p = disclose(p, c);
    expect(handoffReadiness(p, c)).toEqual({ ready: true, missing: [] });
  });

  it("every step is an event: who, when, from, to and the message that caused it", () => {
    const c = ctx();
    const p = yes(contact(fresh(), c), c);
    const last = p.history.at(-1);
    expect(last).toMatchObject({ type: "candidate.interested", actor: "candidate", pursuit_id: p.id, job_id: "job-a", employer_id: "emp-acme", ref: "m-k1", from: { engagement: "AWAITING_REPLY", ask: "INTEREST" }, to: { engagement: "INTERESTED", ask: null } });
  });

  it("history is append-only and a pursuit cannot be edited in place", () => {
    const c = ctx();
    const p1 = contact(fresh(), c);
    const p2 = yes(p1, c);
    expect(p2.history.slice(0, p1.history.length)).toEqual(p1.history);
    expect(() => { p2.engagement = "OPTED_OUT"; }).toThrow(TypeError);
    expect(() => { p2.disclosure.state = "GRANTED"; }).toThrow(TypeError);
    expect(() => { p2.history.push({}); }).toThrow(TypeError);
  });
});

describe("employer-ready needs this job's and this employer's disclosure consent", () => {
  const readyUpToConsent = (job = JOB_A) => { const c = ctx(job); return { c, p: yes(contact(fresh({ job }), c), c) }; };

  it("interest alone is not consent; a screening consent is not disclosure consent", () => {
    const { c, p } = readyUpToConsent();
    expect(handoffReadiness(p, c).missing).toContain("no consent to be introduced to this employer");
    expect(refused(p, c, ev("handoff.sent", { ask_id: "kh" }))).toMatch(/no consent to be introduced/);
  });

  it("the request must name this job, this employer and the company, and record its wording", () => {
    const { c, p } = readyUpToConsent();
    const base = { ask_id: "k3", job_id: "job-a", employer_id: "emp-acme", company_shown: "Acme", wording_version: "dc-v1" };
    expect(refused(p, c, ev("disclosure.requested", { ...base, job_id: "job-b" }))).toMatch(/this job and this employer/);
    expect(refused(p, c, ev("disclosure.requested", { ...base, employer_id: "emp-zeta" }))).toMatch(/this job and this employer/);
    expect(refused(p, c, ev("disclosure.requested", { ...base, company_shown: "" }))).toMatch(/name the company/);
    expect(refused(p, c, ev("disclosure.requested", { ...base, wording_version: undefined }))).toMatch(/wording/);
    expect(refused(p, c, ev("disclosure.granted", { ask_id: "k3", ref: "m" }))).toMatch(/illegal/); // a grant with no request
  });

  it("a yes to the consent question is recorded with its evidence; a yes without the message is refused", () => {
    const { c, p } = readyUpToConsent();
    const asked = run(p, c, ev("disclosure.requested", { ask_id: "k3", job_id: "job-a", employer_id: "emp-acme", company_shown: "Acme", wording_version: "dc-v1" }));
    expect(refused(asked, c, ev("disclosure.granted", { ask_id: "k3" }))).toMatch(/needs the message/);
    expect(refused(asked, c, ev("disclosure.granted", { ask_id: "k1", ref: "m" }))).toMatch(/not the open question/);
  });

  it("a consent carried over from another job, or another employer, does not count", () => {
    const { c, p } = readyUpToConsent();
    const granted = disclose(p, c);
    for (const job of [JOB_B, JOB_C]) {
      const cj = ctx(job);
      const other = yes(contact(fresh({ job }), cj), cj);
      const forged = { ...structuredClone(other), disclosure: structuredClone(granted.disclosure) };
      expect(handoffReadiness(forged, cj).missing).toContain("consent names a different job or employer");
      expect(refused(forged, cj, ev("handoff.sent", { ask_id: "kh" }))).toMatch(/different job or employer/);
    }
  });

  it("a rescue overrides eligibility and evidence, never consent", () => {
    const rescued = { ...INELIGIBLE, employer_review: "RESCUED" };
    const { p } = readyUpToConsent();
    const c = ctx(JOB_A, rescued);
    expect(handoffReadiness(p, c).missing).toEqual(["no consent to be introduced to this employer"]);
    const granted = disclose(p, c);
    expect(handoffReadiness(granted, c).ready).toBe(true);
    expect(run(granted, c, ev("handoff.sent", { ask_id: "kh" })).handoff).toBe("HANDED_OFF");
  });

  it("the employer passing blocks the handoff even for an eligible, supported person", () => {
    const { c, p } = readyUpToConsent();
    const granted = disclose(p, c);
    const cp = ctx(JOB_A, { ...GOOD, employer_review: "PASSED" });
    expect(handoffReadiness(granted, cp).missing).toContain("employer passed");
    expect(stageOf(granted, cp)).toMatchObject({ stage: "Not suitable for this job", next_action: "Send the honest close-out, once" });
  });

  it("only an operator hands off, and only once", () => {
    const { c, p } = readyUpToConsent();
    const granted = disclose(p, c);
    expect(refused(granted, c, { ...ev("handoff.sent", { ask_id: "kh" }), actor: "charlie" })).toMatch(/charlie cannot cause/);
    const sent = run(granted, c, ev("handoff.sent", { ask_id: "kh" }));
    expect(refused(sent, c, ev("handoff.sent", { ask_id: "kh2" }))).toMatch(/illegal/);
  });
});

describe("saying no, withdrawing, no response", () => {
  it("a no before any yes is NOT_INTERESTED, closed for this job only", () => {
    const c = ctx();
    const p = run(contact(fresh(), c), c, ev("candidate.declined", { ask_id: "k1", ref: "m" }));
    expect(p.engagement).toBe("NOT_INTERESTED");
    expect(p.history.at(-1).effects).toEqual(["send:close_out_ack", "move_up_next_ranked"]);
    expect(stageOf(p, c)).toMatchObject({ stage: "Closed: not interested" });
    expect(refused(p, c, ev("outreach.sent", { ask_id: "k9", sent_to: ASHA.email }))).toMatch(/illegal/);
    expect(refused(p, c, ev("cv.requested", { ask_id: "k9" }))).toMatch(/only an interested person/);
  });

  it("a no after a yes is WITHDREW; granted consents are withdrawn and a handoff is recalled", () => {
    const c = ctx();
    let p = disclose(yes(contact(fresh(), c), c), c);
    p = run(p, c, ev("handoff.sent", { ask_id: "kh" }), ev("candidate.declined", { ask_id: "k1", ref: "m" }));
    expect(p).toMatchObject({ engagement: "WITHDREW", handoff: "RECALLED", disclosure: { state: "WITHDRAWN" } });
    expect(p.history.at(-1).effects).toContain("tell_employer:withdrawn");
    expect(stageOf(p, c).stage).toBe("Withdrew after introduction");
  });

  it("consent denied and consent withdrawn close the pursuit, with the reason kept", () => {
    const c = ctx();
    const p = yes(contact(fresh(), c), c);
    const asked = run(p, c, ev("disclosure.requested", { ask_id: "k3", job_id: "job-a", employer_id: "emp-acme", company_shown: "Acme", wording_version: "dc-v1" }));
    const denied = run(asked, c, ev("disclosure.denied", { ask_id: "k3", ref: "m" }));
    expect(stageOf(denied, c).stage).toBe("Closed: consent declined");
    expect(handoffReadiness(denied, c).ready).toBe(false);
    const withdrawn = run(disclose(p, c), c, ev("disclosure.withdrawn", { ask_id: "k3", ref: "m" }));
    expect(stageOf(withdrawn, c).stage).toBe("Closed: consent withdrawn");
    const sc = ctx(JOB_A, NEEDS);
    const asks = run(yes(contact(fresh({ gaps: [GAP] }), sc), sc), sc, ev("screening_consent.requested", { ask_id: "k2", wording_version: "sc-v1" }));
    const noScreen = run(asks, sc, ev("screening_consent.denied", { ask_id: "k2", ref: "m" }));
    expect(stageOf(noScreen, sc)).toMatchObject({ stage: "Closed: screening declined", owner: "employer" });
    expect(handoffReadiness(noScreen, sc).missing).toContain("screening consent refused");
    expect(refused(withdrawn, c, ev("handoff.sent", { ask_id: "kh" }))).toMatch(/no consent/);
  });

  it("no response: one follow-up at 48 hours, give up 48 hours later, nothing before it is due", () => {
    const c = ctx();
    let p = contact(fresh(), c);
    const due = p.ask.due_at;
    expect(refused(p, c, { type: "time.tick", actor: "system", at: due - 1 })).toBe("not due");
    p = run(p, c, { type: "time.tick", actor: "system", at: due });
    expect(p.ask.follow_ups).toBe(1);
    expect(p.history.at(-1).effects).toEqual(["send:follow_up"]);
    expect(stageOf(p, c).next_action).toMatch(/give up$/);
    p = run(p, c, { type: "time.tick", actor: "system", at: p.ask.due_at });
    expect(p).toMatchObject({ engagement: "NO_RESPONSE", ask: null });
    expect(stageOf(p, c).stage).toBe("Closed: no response");
    clock = Math.max(clock, p.ask?.due_at ?? 0, due + 200 * H);
    const late = yes(p, c); // a late yes reopens it
    expect(late.engagement).toBe("INTERESTED");
  });

  it("silence on a consent question gives up too, and the unanswered request is not left dangling", () => {
    const c = ctx();
    let p = run(yes(contact(fresh(), c), c), c, ev("disclosure.requested", { ask_id: "k3", job_id: "job-a", employer_id: "emp-acme", company_shown: "Acme", wording_version: "dc-v1" }));
    p = run(p, c, { type: "time.tick", actor: "system", at: p.ask.due_at });
    p = run(p, c, { type: "time.tick", actor: "system", at: p.ask.due_at });
    expect(p).toMatchObject({ engagement: "NO_RESPONSE", disclosure: { state: "NOT_REQUESTED" } });
  });

  it("a bounce is UNREACHABLE, distinct from no response; a new address reopens it", () => {
    const c = ctx();
    const p = run(contact(fresh(), c), c, ev("send.bounced"));
    expect(stageOf(p, c)).toMatchObject({ stage: "Can't reach", next_action: "Find a new address" });
    expect(run(p, c, ev("address.updated")).engagement).toBe("NOT_CONTACTED");
    expect(run(fresh(), c, ev("address.missing")).engagement).toBe("UNREACHABLE");
  });
});

describe("opting out is global", () => {
  it("stops every pursuit for that person, in every job and every employer, and nothing moves after", () => {
    const pursuits = [JOB_A, JOB_B, JOB_C].map((job) => { const c = ctx(job); return contact(fresh({ job }), c, `k-${job.id}`); });
    const out = optOutEverywhere(pursuits, { type: "candidate.opted_out", actor: "system", at: (clock += H), ref: "unsub" }, (p) => ctx([JOB_A, JOB_B, JOB_C].find((j) => j.id === p.job_id)));
    for (const p of out) {
      expect(p).toMatchObject({ engagement: "OPTED_OUT", contact: { state: "WITHDRAWN" }, ask: null });
      expect(invariants(p)).toEqual([]);
      const c = ctx([JOB_A, JOB_B, JOB_C].find((j) => j.id === p.job_id));
      expect(refused(p, c, ev("candidate.interested", { ask_id: `k-${p.job_id}`, ref: "m" }))).toMatch(/opted out/);
      expect(refused(p, c, ev("closeout.sent"))).toMatch(/opted out/);
      expect(stageOf(p, c)).toMatchObject({ stage: "Opted out", next_action: "Nothing, in any job" });
    }
    expect(out[0].history.at(-1).effects).toContain("suppress_address");
  });

  it("a reply after opting out is still recorded and shown, never answered automatically", () => {
    const c = ctx();
    const p = run(contact(fresh(), c), c, ev("candidate.opted_out", { ref: "m" }), ev("reply.unclear", { ref: "m2" }));
    expect(stageOf(p, c)).toMatchObject({ stage: "Opted out", owner: "operator" });
  });
});

describe("screening", () => {
  const atScreening = (c = ctx(JOB_A, NEEDS)) => disclose(screenConsent(yes(contact(fresh({ gaps: [GAP, "loc:maharashtra"] }), c), c), c), c);

  it("screening needs permission to screen, and asks only the gaps still open", () => {
    const c = ctx(JOB_A, NEEDS);
    const p = disclose(yes(contact(fresh({ gaps: [GAP] }), c), c), c);
    expect(refused(p, c, ev("screening.sent", { ask_id: "k4", mode: "questions", gaps: [GAP] }))).toMatch(/no permission to screen/);
    const s = atScreening();
    expect(refused(s, c, ev("screening.sent", { ask_id: "k4", mode: "questions", gaps: ["exp:other"] }))).toMatch(/only the gaps still open/);
  });

  it("incomplete: a partial answer keeps only what is still open, asks once more, then the employer decides", () => {
    const c = ctx(JOB_A, NEEDS);
    let p = screen(atScreening(), c, { [GAP]: "3 years", "loc:maharashtra": "  " });
    expect(p.screening).toMatchObject({ state: "INCOMPLETE", gaps: ["loc:maharashtra"], rounds: 1 });
    expect(refused(p, c, ev("screening.sent", { ask_id: "k5", mode: "questions", gaps: [GAP] }))).toMatch(/only the gaps still open/);
    p = screen(p, c, {}, "k5");
    expect(p.screening).toMatchObject({ state: "INCOMPLETE", rounds: 2 });
    expect(refused(p, c, ev("screening.sent", { ask_id: "k6", mode: "questions", gaps: ["loc:maharashtra"] }))).toMatch(/most times/);
    expect(stageOf(p, c)).toMatchObject({ stage: "Screening stalled", owner: "employer" });
  });

  it("every answer null is never COMPLETED", () => {
    const p = screen(atScreening(), ctx(JOB_A, NEEDS), { [GAP]: null, "loc:maharashtra": null });
    expect(p.screening.state).toBe("INCOMPLETE");
  });

  it("'screening failed' is not a screening state: the answers go to the contract, which says INELIGIBLE", () => {
    expect(SCREENING).not.toContain("FAILED");
    const p = screen(atScreening(), ctx(JOB_A, NEEDS), { [GAP]: "8 years", "loc:maharashtra": "Bengaluru" });
    expect(p.screening.state).toBe("COMPLETED");
    expect(p.history.at(-1).effects).toEqual(["regate"]);
    const c = ctx(JOB_A, INELIGIBLE); // the Hiring Contract's verdict on the answers
    expect(stageOf(p, c)).toMatchObject({ stage: "Not suitable for this job", next_action: "Send the honest close-out, once" });
    expect(handoffReadiness(p, c).missing).toContain("not eligible");
    const closed = run(p, c, ev("closeout.sent"));
    expect(stageOf(closed, c)).toMatchObject({ stage: "Closed out", next_action: "Nothing; they have had the last word" });
    expect(p.screening.state).toBe("COMPLETED");
  });

  it("a call: started, completed; a dropped call is INCOMPLETE; an unused link EXPIRES", () => {
    const c = ctx(JOB_A, NEEDS);
    const s = atScreening();
    const called = run(s, c, ev("screening.sent", { ask_id: "k4", mode: "call", gaps: [GAP, "loc:maharashtra"] }));
    expect(called.ask).toMatchObject({ kind: "CALL", due_at: called.ask.opened_at + 14 * 24 * H });
    expect(run(called, c, ev("call.started", { ask_id: "k4" }), ev("call.completed", { ask_id: "k4", answers: { [GAP]: "3 years", "loc:maharashtra": "Pune" } })).screening.state).toBe("COMPLETED");
    expect(run(called, c, ev("call.started", { ask_id: "k4" }), ev("call.abandoned", { ask_id: "k4" })).screening.state).toBe("INCOMPLETE");
    let x = run(called, c, { type: "time.tick", actor: "system", at: called.ask.due_at });
    x = run(x, c, { type: "time.tick", actor: "system", at: x.ask.due_at });
    expect(x.screening.state).toBe("EXPIRED");
    expect(stageOf(x, c).stage).toBe("Screening stalled");
  });

  it("withdrawing screening consent mid-screening stops it; the employer decides", () => {
    const c = ctx(JOB_A, NEEDS);
    const s = run(atScreening(), c, ev("screening.sent", { ask_id: "k4", mode: "questions", gaps: [GAP] }), ev("screening_consent.withdrawn", { ask_id: "k2", ref: "m" }));
    expect(s).toMatchObject({ screening: { state: "INCOMPLETE" }, ask: null, screening_consent: { state: "WITHDRAWN" } });
    expect(stageOf(s, c).stage).toBe("Closed: screening withdrawn");
  });

  it("asking for a CV, receiving it, and the contract recomputing the gaps", () => {
    const c = ctx(JOB_A, NEEDS);
    let p = run(yes(contact(fresh({ gaps: [GAP] }), c), c), c, ev("cv.requested", { ask_id: "kc" }));
    expect(stageOf(p, c)).toMatchObject({ stage: "Waiting for CV", waiting_for: "CV" });
    p = run(p, c, ev("cv.received", { ask_id: "kc", ref: "m-cv" }), ev("gate.recomputed", { open_gaps: [] }));
    expect(p.screening.state).toBe("NOT_REQUIRED");
    expect(run(p, c, ev("gate.recomputed", { open_gaps: ["new"] })).screening.state).toBe("REQUIRED");
  });
});

describe("a person found outside the pool is a source, not a separate kind of candidate", () => {
  const SOURCED_JOB = { ...JOB_A, cold_outreach: true };

  it("records where the person came from and that any contact would be cold, with no contact permission", () => {
    const p = fresh({ person: RAVI, source: "sourced" });
    expect(p).toMatchObject({ source: "sourced", source_at: T0 - 24 * H, discovery_run: "run-1", outreach_type: "cold", contact: { state: "NONE", basis: null } });
  });

  it("cold outreach is on hold: refused even on a job that enabled it", () => {
    const p = fresh({ person: RAVI, source: "sourced", job: SOURCED_JOB });
    const c = ctx(SOURCED_JOB, GOOD, RAVI);
    expect(contactability(p, c)).toEqual({ ok: false, why: "cold outreach is on hold" });
    expect(refused(p, c, ev("outreach.sent", { ask_id: "k1", sent_to: RAVI.email }))).toBe("cold outreach is on hold");
    expect(stageOf(p, c)).toMatchObject({ stage: "Matched", next_action: "Can't contact: cold outreach is on hold" });
  });

  it("if the hold is ever lifted, the job must also enable it, and the basis is recorded as cold", () => {
    const p = fresh({ person: RAVI, source: "sourced" });
    expect(refused(p, ctx(JOB_A, GOOD, RAVI, { cold_outreach: "allowed" }), ev("outreach.sent", { ask_id: "k1", sent_to: RAVI.email }))).toMatch(/not enabled cold outreach/);
    const c = ctx(SOURCED_JOB, GOOD, RAVI, { cold_outreach: "allowed" });
    const sent = contact(fresh({ person: RAVI, source: "sourced", job: SOURCED_JOB }), c);
    expect(sent.contact).toEqual({ state: "COLD", basis: "cold_policy" });
  });

  it("a strong profile never skips a step: no interest without a reply, no consent ask before interest, no handoff", () => {
    const c = ctx(SOURCED_JOB, GOOD, RAVI, { cold_outreach: "allowed" });
    const p = fresh({ person: RAVI, source: "sourced", job: SOURCED_JOB });
    expect(refused(p, c, ev("candidate.interested", { ask_id: "k1", ref: "m" }))).toMatch(/illegal/);
    expect(refused(p, c, ev("disclosure.requested", { ask_id: "k3", job_id: "job-a", employer_id: "emp-acme", company_shown: "Acme", wording_version: "v" }))).toMatch(/only an interested person/);
    expect(refused(p, c, ev("handoff.sent", { ask_id: "kh" }))).toMatch(/not interested; no consent/);
    const sent = contact(p, c);
    expect(refused(sent, c, { ...ev("candidate.interested", { ask_id: "k1", ref: "m" }), actor: "operator" })).toMatch(/unread reply/);
  });

  it("once in, the same machinery: identical events give identical readiness for pool and sourced", () => {
    const pool = ctx(SOURCED_JOB, GOOD, ASHA);
    const cold = ctx(SOURCED_JOB, GOOD, RAVI, { cold_outreach: "allowed" });
    const a = disclose(yes(contact(fresh({ job: SOURCED_JOB }), pool), pool), pool);
    const b = disclose(yes(contact(fresh({ person: RAVI, source: "sourced", job: SOURCED_JOB }), cold), cold), cold);
    expect(handoffReadiness(a, pool)).toEqual(handoffReadiness(b, cold));
    expect(stageOf(a, pool)).toEqual(stageOf(b, cold));
  });

  it("a pool person without contact permission cannot be written to either", () => {
    const c = ctx(JOB_A, GOOD, { ...ASHA, consent_pool: false });
    expect(refused(fresh(), c, ev("outreach.sent", { ask_id: "k1", sent_to: ASHA.email }))).toBe("no permission to contact");
  });
});

describe("one person, several jobs and employers", () => {
  const two = () => {
    const ca = ctx(JOB_A), cb = ctx(JOB_B), cc = ctx(JOB_C);
    return { ca, cb, cc, a: contact(fresh({ job: JOB_A }), ca, "ka"), b: contact(fresh({ job: JOB_B }), cb, "kb"), c: contact(fresh({ job: JOB_C }), cc, "kc") };
  };

  it("a reply that carries job A's key goes to job A, even though job B was asked later", () => {
    const { a, b, c } = two();
    expect(routeReply({ key: "ka", from: "Asha@Example.com", pursuits: [a, b, c] })).toEqual({ pursuit_id: a.id, ask_id: "ka", basis: "reply_key" });
  });

  it("an ambiguous reply with two open questions is never guessed", () => {
    const { a, b } = two();
    expect(routeReply({ from: ASHA.email, pursuits: [a, b] })).toEqual({ to_read: true, reason: "more than one open question", candidates: [a.id, b.id] });
  });

  it("a key from another sender, or an unknown key, goes to a person; one open question routes by itself", () => {
    const { a, b } = two();
    expect(routeReply({ key: "ka", from: "someone@else.com", pursuits: [a, b] })).toMatchObject({ to_read: true, reason: "sender does not match the address written to" });
    expect(routeReply({ key: "nope", from: ASHA.email, pursuits: [a, b] })).toEqual({ to_read: true, reason: "unknown reply key" });
    expect(routeReply({ from: ASHA.email, pursuits: [a] })).toEqual({ pursuit_id: a.id, ask_id: "ka", basis: "only_open_question" });
  });

  it("an event for one job cannot move another job's pursuit", () => {
    const { a, cb } = two();
    expect(refused(a, cb, ev("candidate.interested", { ask_id: "ka", ref: "m" }))).toBe("context is for another job");
    const { b, cb: cb2 } = two();
    expect(refused(b, cb2, ev("candidate.interested", { ask_id: "ka", ref: "m" }))).toMatch(/not the open question/);
  });

  it("no to job A leaves job B and job C untouched; consent to Acme for job A is not consent for Zeta", () => {
    const { a, b, c, ca, cc } = two();
    const declined = run(a, ca, ev("candidate.declined", { ask_id: "ka", ref: "m" }));
    expect(declined.engagement).toBe("NOT_INTERESTED");
    expect([b.engagement, c.engagement]).toEqual(["AWAITING_REPLY", "AWAITING_REPLY"]);
    const cYes = yes(c, cc, "kc");
    expect(handoffReadiness(cYes, cc).missing).toContain("no consent to be introduced to this employer");
  });

  it("an unclear reply is flagged for a person; the operator then records what it said", () => {
    const { a, ca } = two();
    let p = run(a, ca, ev("reply.unclear", { ref: "m-q", ask_id: "ka" }));
    expect(stageOf(p, ca)).toMatchObject({ stage: "Reply to read", owner: "operator" });
    expect(refused(p, ca, { ...ev("candidate.interested", { ask_id: "ka", ref: "other" }), actor: "operator" })).toMatch(/unread reply/);
    p = run(p, ca, { ...ev("candidate.interested", { ask_id: "ka", ref: "m-q" }), actor: "operator" });
    expect(p).toMatchObject({ engagement: "INTERESTED", to_read: null });
    expect(run(run(a, ca, ev("reply.unclear", { ref: "m-t" })), ca, ev("reply.read")).to_read).toBeNull();
  });
});

describe("paused and closed jobs", () => {
  const PAUSED = { ...JOB_A, lifecycle: "paused" }, CLOSED = { ...JOB_A, lifecycle: "closed" };

  it("paused: no outreach, no follow-up, no handoff; replies still land; nothing is deleted", () => {
    const active = ctx();
    const waiting = contact(fresh(), active);
    const c = ctx(PAUSED);
    expect(refused(fresh(), c, ev("outreach.sent", { ask_id: "k1", sent_to: ASHA.email }))).toMatch(/job is paused/);
    expect(refused(waiting, c, { type: "time.tick", actor: "system", at: waiting.ask.due_at + 1000 * H })).toMatch(/job is paused/);
    const replied = yes(waiting, c);
    expect(replied.engagement).toBe("INTERESTED");
    expect(replied.history.length).toBe(waiting.history.length + 1);
    expect(refused(disclose(yes(waiting, active), active), c, ev("handoff.sent", { ask_id: "kh" }))).toMatch(/job is paused/);
    expect(stageOf(replied, c)).toMatchObject({ stage: "Job on hold", next_action: "Nothing new until the job reopens" });
    expect(stageOf(run(replied, c, ev("reply.unclear", { ref: "m" })), c).stage).toBe("Reply to read");
  });

  it("someone already closed out stays closed out when the assessment changes later", () => {
    const p = run(contact(fresh(), ctx()), ctx(JOB_A, INELIGIBLE), ev("closeout.sent"));
    expect(stageOf(p, ctx(JOB_A, { ...GOOD, disposition: "LOW_EVIDENCE" }))).toMatchObject({ stage: "Closed out", next_action: "Nothing; they have had the last word" });
  });

  it("closed: no new outreach; the honest close-out is still allowed, once", () => {
    const active = ctx();
    const p = yes(contact(fresh(), active), active);
    const c = ctx(CLOSED);
    expect(stageOf(p, c)).toMatchObject({ stage: "Job closed", next_action: "Send the honest close-out, once" });
    const done = run(p, c, ev("closeout.sent"));
    expect(stageOf(done, c).next_action).toBe("Nothing new until the job reopens");
    expect(refused(done, c, ev("closeout.sent"))).toMatch(/illegal/);
    expect(refused(fresh(), c, ev("outreach.sent", { ask_id: "k1", sent_to: ASHA.email }))).toMatch(/job is closed/);
  });
});

describe("illegal transitions, generated from the table", () => {
  const base = () => structuredClone(fresh());
  const setDim = (p, dim, value) => {
    if (dim === "engagement") p.engagement = value;
    else if (dim === "screening_consent" || dim === "disclosure") p[dim] = { state: value };
    else if (dim === "screening") p.screening = { ...p.screening, state: value };
    else if (dim === "handoff") p.handoff = value;
    else if (dim === "ask") p.ask = value === "NONE" ? null : { id: "kz", kind: value, waiting_for: value, owner: "candidate", due_at: T0, follow_ups: 0, max_follow_ups: 1, give_up_hours: 48 };
    else if (dim === "to_read") p.to_read = value === "SET" ? { ref: "m" } : null;
    else if (dim === "closed_out") p.closed_out = value === "YES";
    return p;
  };
  const pairs = [];
  for (const [type, rule] of Object.entries(RULES)) if (rule.dim) for (const s of DIMENSIONS[rule.dim].values) if (!rule.from.includes(s)) pairs.push([type, rule.dim, s]);

  it(`${pairs.length} (event, state) pairs outside the table are all refused`, () => {
    expect(pairs.length).toBeGreaterThan(80);
    for (const [type, dim, s] of pairs) {
      const p = setDim(base(), dim, s);
      const r = transition(p, { type, actor: RULES[type].actors[0], at: T0 + H, ask_id: "kz", ref: "m", sent_to: ASHA.email }, ctx());
      expect(r.ok, `${type} from ${dim}=${s}`).toBe(false);
      expect(r.reason, `${type} from ${dim}=${s}`).toMatch(/^illegal|opted out/);
    }
  });

  it("an unknown event, a missing time, a wrong actor or a missing job is refused", () => {
    const p = fresh();
    expect(transition(p, { type: "status.set", actor: "operator", at: T0 }, ctx()).reason).toMatch(/unknown event/);
    expect(transition(p, { type: "address.missing", actor: "system" }, ctx()).reason).toMatch(/needs a time/);
    expect(transition(p, { type: "address.missing", actor: "candidate", at: T0 }, ctx()).reason).toMatch(/cannot cause/);
    expect(transition(p, { type: "address.missing", actor: "system", at: T0 }, {}).reason).toMatch(/needs the job/);
  });
});

describe("the contract's outputs, read only", () => {
  it("every disposition the contract can produce gets a stage, and anything unrecognised fails closed", () => {
    const p = fresh();
    for (const disposition of DISPOSITIONS) for (const eligibility_status of ["ELIGIBLE", "NO_CONSTRAINTS", "NEEDS_VERIFICATION", "INELIGIBLE", "EXCLUDED_BY_POLICY", "NOT_JUDGED"]) {
      const s = stageOf(p, ctx(JOB_A, { eligibility_status, disposition, open: [], employer_review: "NONE" }));
      expect(s.unmatched, `${disposition}/${eligibility_status}`).toBeUndefined();
    }
    expect(stageOf(p, ctx(JOB_A, null)).stage).toBe("Discovered");
    expect(stageOf(p, ctx(JOB_A, { ...GOOD, employer_review: "MAYBE" })).stage).toBe("Discovered");
    expect(refused(p, ctx(JOB_A, null), ev("outreach.sent", { ask_id: "k1", sent_to: ASHA.email }))).toMatch(/not assessed/);
    expect(refused(p, ctx(JOB_A, INELIGIBLE), ev("outreach.sent", { ask_id: "k1", sent_to: ASHA.email }))).toBe("not suitable for this job");
  });

  it("the lifecycle imports nothing and never writes the assessment", () => {
    const src = readFileSync(new URL("./hire-lifecycle.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/hire_assessments|writeAssessment|eligibility_status\s*=/);
  });
});

describe("random walk: invariants hold after every accepted event", () => {
  const rng = (seed) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; };
  const ASSESSMENTS = [GOOD, NEEDS, INELIGIBLE, { ...INELIGIBLE, employer_review: "RESCUED" }, { ...GOOD, disposition: "LOW_EVIDENCE" }, { ...GOOD, employer_review: "PASSED" }, { eligibility_status: "NOT_JUDGED", disposition: "RANK_CUT", open: [] }];

  it("2,000 walks of 80 events: no handoff without matching consent, no cold contact while held, a stage for every state", () => {
    const r = rng(20261005);
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const types = Object.keys(RULES);
    let handoffs = 0;
    for (let walk = 0; walk < 2000; walk++) {
      const sourced = r() < 0.4;
      const job = { ...JOB_A, cold_outreach: r() < 0.5 };
      const person = sourced ? RAVI : { ...ASHA, consent_pool: r() < 0.9 };
      let p = fresh({ person, source: sourced ? "sourced" : "pool", job, gaps: r() < 0.5 ? [GAP] : [] });
      let t = T0;
      let assessment = pick(ASSESSMENTS);
      const policy = r() < 0.5 ? { cold_outreach: "allowed" } : undefined;
      for (let step = 0; step < 80; step++) {
        t += Math.floor(r() * 12) * H;
        if (r() < 0.05) assessment = pick(ASSESSMENTS);
        const c = { job: { ...job, lifecycle: r() < 0.9 ? "active" : pick(["paused", "closed"]) }, assessment, person, policy };
        // mostly events whose from-state matches, so walks get deep; the rest are anything at all
        // endings (opt-out, no, bounce, refusal) are legal almost everywhere; kept rare so walks get deep
        const ending = /opted_out|declined|bounced|missing|denied|withdrawn|closeout/;
        const legal = types.filter((x) => RULES[x].dim && RULES[x].from.includes(DIMENSIONS[RULES[x].dim].read(p)) && (!ending.test(x) || r() < 0.03));
        const roll = r();
        const type = roll < 0.8 && legal.length ? pick(legal) : roll < 0.9 ? pick(types.filter((x) => !RULES[x].dim)) : pick(types);
        const gaps = p.screening.gaps;
        const e = {
          type, actor: pick(RULES[type].actors), at: t,
          ask_id: p.ask && r() < 0.7 ? p.ask.id : r() < 0.5 && p.keys.length ? pick(p.keys) : `k${Math.floor(r() * 1e9)}`,
          ref: p.to_read && r() < 0.6 ? p.to_read.ref : `m${Math.floor(r() * 1e9)}`,
          sent_to: person.email, source: "reply",
          job_id: r() < 0.85 ? p.job_id : "job-x", employer_id: r() < 0.85 ? p.employer_id : "emp-x", company_shown: r() < 0.85 ? job.company : "Other", wording_version: "v1",
          mode: pick(["questions", "call"]), gaps: gaps.length ? gaps.slice(0, 1 + Math.floor(r() * gaps.length)) : [GAP],
          answers: Object.fromEntries(gaps.map((g) => [g, r() < 0.6 ? "an answer" : null])),
          open_gaps: r() < 0.5 ? [] : [GAP],
        };
        const before = p;
        const res = transition(p, e, c);
        if (!res.ok) { expect(res.pursuit).toBeUndefined(); continue; }
        p = res.pursuit;
        accepted.add(type);
        expect(invariants(p), `${type} @ walk ${walk} step ${step}`).toEqual([]);
        if (type === "handoff.sent") {
          handoffs++;
          expect(handoffReadiness(before, c).ready).toBe(true);
          expect(p.disclosure).toMatchObject({ state: "GRANTED", job_id: p.job_id, employer_id: p.employer_id });
        }
        if (type === "outreach.sent" && sourced) expect(c.policy?.cold_outreach === "allowed" && c.job.cold_outreach === true).toBe(true);
        const s = stageOf(p, c);
        expect(s.unmatched, `${JSON.stringify(p.history.at(-1).to)} under ${JSON.stringify(c.assessment)}`).toBeUndefined();
      }
    }
    expect(handoffs).toBeGreaterThan(20); // the walk really does reach the employer, many times
  }, 60_000); // 2,000 random walks: give it room on a slow or busy machine
});

afterAll(() => {
  // every rule in the table was driven through at least once, somewhere in this file
  const missing = Object.keys(RULES).filter((t) => !accepted.has(t));
  expect(missing).toEqual([]);
  expect(transitionTable().length).toBe(Object.keys(RULES).length);
  expect(ENGAGEMENT).toHaveLength(8);
});
