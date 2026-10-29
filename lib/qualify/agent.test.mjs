// lib/qualify/agent.test.mjs — the Qualify & Submit agent end to end, in memory. No database, no model, no network.
import { describe, it, expect } from "vitest";
import { runQualify, onQualifyReply, personAllowed, greetingName, settingsOf, openMustHaves, withdraws, addressOf, confirmFacts } from "./agent.mjs";
import { classifyInviteReply } from "../role-invite-reply.mjs";
import { qualifyMove } from "../hire-lifecycle.mjs";
import { ADAPTERS } from "./adapters.mjs";
import { renderQualifyHandoff } from "../../email-kit.mjs";

const H = 3_600_000;
const NOW = Date.parse("2026-10-07T06:30:00Z");
const SPEC = { id: "spec-1", status: "approved", criteria: [{ ref: "c1", kind: "must_have", label: "Billing support" }, { ref: "c2", kind: "must_have", label: "Zendesk" }] };
const ROLE_PAYLOAD = { id: 1000101, role: "Support Engineer", clientName: "Northwind Labs", location: "Pune", maxCtc: 8, status: "Hot" };

const NAMES = ["", "Asha Rao", "Bina Shah", "Chitra Iyer", "Deepa Nair", "Esha Menon", "Farah Khan"];
const person = (n, fit, over = {}) => ({ candidate_id: `c-${n}`, fit, retrieval: { distance: 0.2 + n / 100 }, criteria: [{ ref: "c1", level: "strong", evidence_ids: ["e1"] }, { ref: "c2", level: "unknown", evidence_ids: [] }], person: { email: `p${n}@x.com`, full_name: NAMES[n] }, ...over });
const pool = (n, over = {}) => ({ email: `p${n}@x.com`, full_name: NAMES[n], consent_pool: true, seeking_status: null, total_years: 3, linkedin_url: `https://linkedin.com/in/person-${n}`, current_company: "Acme", city: "Ajmer", phone: "+91 98765 4321" + (n % 10), notice_days: 30, comp_expected: 500000, ...over });

function world({ mode = "live", evals = [person(1, "strong")], pools = [pool(1)], gate = "ELIGIBLE", lastFull = null, threads = [], subs = [], suppressed = [], evaluate = null, justification = { ok: true, text: "Person 1 resolved billing tickets and wrote Zendesk macros for a payroll product across two releases at Acme." } } = {}) {
  const conn = { id: "conn-1", key: "pieworks", name: "Pieworks", mode, source: { type: "pieworks", statuses: ["Hot", "Warm"] }, destination: { type: "pieworks", via: "Pieworks" }, sequence: {}, settings: { last_full_at: lastFull } };
  const T = [...threads], S = [...subs], sent = [], submitted = [];
  let n = 0, ver = 0;
  const cstore = {
    connections: async () => [conn],
    saveConnection: async (key, patch) => { Object.assign(conn, patch); return conn; },
    roles: async () => [{ connection_id: "conn-1", external_id: "1000101", job_id: "job-1", payload: ROLE_PAYLOAD }],
    // reads return copies, as the database does, so a stale read stays stale
    threads: async (_id, stages) => T.filter((t) => !stages || stages.includes(t.stage)).map((t) => structuredClone(t)),
    threadsForJob: async (jobId) => T.filter((t) => t.job_id === jobId).map((t) => structuredClone(t)),
    openEmails: async () => new Set(T.filter((t) => ["verify_sent", "reminded", "answered", "confirming", "ready", "submitting"].includes(t.stage)).map((t) => t.email)),
    openThread: async (row) => { const t = { id: `t-${++n}`, rounds: 1, answers: {}, ...row }; T.push(t); return t; },
    // like the store: every write moves updated_at; a conditional write checks the stage and each `match` key
    updateThread: async (id, patch) => structuredClone(Object.assign(T.find((t) => t.id === id), patch, { updated_at: `v${++ver}` })),
    updateThreadIf: async (id, stage, patch, match = {}) => { const t = T.find((x) => x.id === id); return t && t.stage === stage && Object.entries(match).every(([k, v]) => (t[k] ?? null) === (v ?? null)) ? structuredClone(Object.assign(t, patch, { updated_at: `v${++ver}` })) : null; },
    threadByKey: async (key) => { const t = T.find((x) => x.reply_key === key); return t ? structuredClone(t) : null; },
    submissionsForJob: async (jobId) => S.filter((s) => s.job_id === jobId),
    recordSubmission: async (row) => { S.push(row); return row; },
  };
  const deps = {
    cstore,
    // the employer approved the person for the job unless a test says otherwise (nothing is put forward
    // without that approval); a test that passes on them sets decisionFor itself
    hire: { getJob: async () => ({ job: { id: "job-1", title: "Support Engineer", client: "Northwind Labs", lifecycle: "active" } }), currentSpec: async () => SPEC, decisionFor: async () => ({ decision: "saved" }) },
    adapters: { pieworks: { listRoles: async () => ({ roles: [], skipped: [] }), toCandidate: (f, j) => ({ name: f.name?.value, justification: j }), submit: async (_c, x) => { submitted.push(x); return { status: "sent", result: 200, message: "Saved" }; } } },
    syncRoles: async () => ({ created: 1, rebriefed: 0, paused: 0, closed: 0, skipped: 0, failed: 0, items: [] }),
    ensureEvaluated: async () => evals,
    personFacts: async () => ({ pool: new Map(pools.map((p) => [p.email, p])), suppressed: new Set(suppressed), status: new Map() }),
    gate: async () => ({ eligibility_status: gate }),
    evaluate: evaluate || (async () => ({ fit: "strong", criteria: [{ ref: "c1", level: "strong", evidence_ids: ["e1"] }], evidence: [{ id: "e1", quote: "Resolved billing tickets" }] })),
    writeJustification: async () => justification,
    yesNo: (span) => classifyInviteReply(span).answer,
    send: async (x) => { sent.push(x); return { status: "sent" }; },
    render: {
      verify: (a) => ({ subject: `verify ${a.role}`, text: a.questions.join("\n"), html: "<p/>" }),
      reminder: () => ({ subject: "reminder", text: "r", html: "<p/>" }),
      closed: () => ({ subject: "closed", text: "c", html: "<p/>" }),
      putForward: () => ({ subject: "put forward", text: "p", html: "<p/>" }),
      confirm: (a) => ({ subject: "confirm", text: `${a.again ? "again\n" : ""}${a.facts.join("\n")}`, html: "<p/>" }),
    },
    cv: { get: async () => ({ bytes: new Uint8Array([1]), filename: "cv.pdf" }) },
    newReplyKey: () => `key${++n}abcdefgh`,
  };
  const run = (remaining = 30, now = NOW) => runQualify({ cfg: {}, now, remaining, runId: "run-1", deps });
  return { conn, T, S, sent, submitted, deps, run };
}

/**
 * The person replies to the final confirm email (the details shown, "reply with just YES"). Nothing is submitted
 * without this step, so every test that ends in a submission goes through it.
 */
async function reply(w, body = "YES", { filer = async () => [], cvFile = null } = {}) {
  const outs = [];
  for (const t of w.T.filter((x) => x.stage === "confirming" || x.stage === "ready")) {
    outs.push(await onQualifyReply(t, { body, from: t.email, cvFile, ref: "email-yes", now: NOW }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: filer, cv: { put: async (id, f) => `${id}/${f.filename}` } }));
  }
  return outs;
}

describe("who may be written to", () => {
  it("needs the pool, consent, not suppressed, not paused, still looking", () => {
    expect(personAllowed({ pool: pool(1) })).toEqual({ ok: true });
    expect(personAllowed({ pool: null }).reason).toMatch(/talent pool/);
    expect(personAllowed({ pool: pool(1, { consent_pool: false }) }).reason).toMatch(/agreed/);
    expect(personAllowed({ pool: pool(1), suppressed: true }).reason).toMatch(/suppressed/);
    expect(personAllowed({ pool: pool(1), status: "paused" }).reason).toMatch(/paused/);
    expect(personAllowed({ pool: pool(1, { seeking_status: "not_looking" }) }).reason).toMatch(/not looking/);
    expect(greetingName("ASHA Rao")).toBe("Asha Rao");
    expect(greetingName("Pune, India")).toBeNull();
  });
  it("defaults to the approved limits: strong, 16 per role, batches of 4", () => {
    expect(settingsOf({ settings: {} })).toMatchObject({ min_fit: "strong", per_role_cap: 16, batch_size: 4 });
    expect(openMustHaves(SPEC, person(1, "strong"))).toEqual([{ ref: "c2", label: "Zendesk" }]);
  });
});

describe("a run", () => {
  it("off does nothing; shadow judges and says what it would ask, but writes no thread and sends nothing", async () => {
    const off = world({ mode: "off" });
    expect((await off.run()).items[0].reason).toMatch(/every connection is off/);
    const sh = world({ mode: "shadow" });
    const r = await sh.run();
    expect(sh.T).toHaveLength(0);
    expect(sh.sent).toHaveLength(0);
    expect(r.items).toContainEqual(expect.objectContaining({ who: "Asha Rao", result: "shadow", reason: expect.stringMatching(/would ask/) }));
  });

  it("live: writes to the strong fit with consent first; skips potential, no consent, suppressed and an ineligible gate", async () => {
    const w = world({ evals: [person(1, "strong"), person(2, "potential"), person(3, "strong"), person(4, "excellent")], pools: [pool(1), pool(2), pool(3, { consent_pool: false }), pool(4)], suppressed: ["p4@x.com"] });
    const r = await w.run();
    expect(w.T.map((t) => t.email)).toEqual(["p1@x.com"]);
    expect(w.T[0]).toMatchObject({ stage: "verify_sent", fit: "strong", external_role_id: "1000101" });
    expect(w.T[0].questions[0]).toEqual({ id: "consent", text: "May I put you forward to Northwind Labs for the Support Engineer role?" });
    expect(w.T[0].questions.map((q) => q.id)).toEqual(expect.arrayContaining(["consent", "currentPay", "workFrom", "must:c2", "cv"]));
    expect(w.T[0].questions.map((q) => q.id)).not.toContain("noticePeriod");
    expect(w.sent).toEqual([expect.objectContaining({ email: "p1@x.com", template: "qualify-verify", dedupeKey: `${w.T[0].id}:verify` })]);
    expect(w.T[0].questions.map((q) => q.id)).not.toContain("linkedInUrl");
    expect(r.items.filter((i) => i.result === "not written to").map((i) => i.reason)).toEqual(expect.arrayContaining(["has not agreed to hear about other roles", "unsubscribed or suppressed"]));
    const g = world({ gate: "NEEDS_VERIFICATION" });
    await g.run();
    expect(g.T).toHaveLength(0);
  });

  it("Checked is everyone judged against the role, not only those at the bar", async () => {
    const evals = Object.assign([person(1, "potential"), person(2, "potential"), person(3, "weak")], { checked: 3 });
    const w = world({ evals, pools: [pool(1), pool(2), pool(3)] });
    const r = await w.run();
    expect(r.counts.considered).toBe(3);
    expect(w.sent).toHaveLength(0);
    // a pass that only re-reads the stored evaluations looked at nobody new
    const again = world({ evals: Object.assign([person(1, "potential")], { checked: 0 }), pools: [pool(1)] });
    expect((await again.run()).counts.considered).toBe(0);
  });

  // a pass that judged a whole role and found no fit must still show what it did
  it("a run says what it did: the judging per role, and when only replies were read", async () => {
    const evals = Object.assign([person(1, "potential"), person(2, "potential")], { checked: 2 });
    const r = await world({ evals, pools: [pool(1), pool(2)] }).run();
    expect(r.items).toContainEqual(expect.objectContaining({ who: "Support Engineer", action: "judge", result: "judged", reason: "2 scored this run; 0 of 2 passed the scorer" }));
    // a role that is full is said, not skipped silently
    const full = await world({ threads: [1, 2, 3, 4].map((i) => ({ id: `t${i}`, job_id: "job-1", candidate_id: `c-${i}`, email: `p${i}@x.com`, stage: "verify_sent" })) }).run();
    expect(full.items).toContainEqual(expect.objectContaining({ action: "judge", result: "not judged", reason: "full: 4 in conversation, 0 put forward" }));
    const quiet = await world({ lastFull: new Date(NOW - 2 * H).toISOString() }).run();
    expect(quiet.items).toContainEqual(expect.objectContaining({ who: "Pieworks", result: "not due", reason: expect.stringMatching(/^read replies only; the next search for new fits is after .+ IST$/) }));
  });

  it("opens at most a batch of 4 per role, and nobody already in a conversation", async () => {
    const evals = [1, 2, 3, 4, 5, 6].map((i) => person(i, "strong"));
    const w = world({ evals, pools: [1, 2, 3, 4, 5, 6].map((i) => pool(i)), threads: [{ id: "old", job_id: "job-9", candidate_id: "c-2", email: "p2@x.com", stage: "verify_sent" }] });
    const r = await w.run();
    // p2 is mid-conversation about another role: skipped, and the batch of 4 fills from p1, p3, p4, p5
    expect(w.T.filter((t) => t.job_id === "job-1").map((t) => t.email)).toEqual(["p1@x.com", "p3@x.com", "p4@x.com", "p5@x.com"]);
    expect(r.items).toContainEqual(expect.objectContaining({ who: "Bina Shah", reason: "already in a conversation about another role" }));
    expect(w.T[1].consent).toMatchObject({ state: "ASKED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1" });
  });

  it("the full pass runs at most every 11 hours; the daily limit stops sends", async () => {
    const recent = world({ lastFull: new Date(NOW - 2 * H).toISOString() });
    await recent.run();
    expect(recent.T).toHaveLength(0);
    const capped = world();
    const r = await capped.run(0);
    expect(capped.sent).toHaveLength(0);
    expect(r.counts.waiting).toBe(1);
  });
});

describe("timers", () => {
  const thread = (over) => ({ id: "t-9", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, verify_sent_at: new Date(NOW - 49 * H).toISOString(), stage: "verify_sent", ...over });
  it("one reminder at 48 hours, then closed quietly at 96", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [thread()] });
    await w.run();
    expect(w.T[0].stage).toBe("reminded");
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-reminder"]);
    const later = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [thread({ stage: "reminded", verify_sent_at: new Date(NOW - 97 * H).toISOString() })] });
    await later.run();
    expect(later.T[0]).toMatchObject({ stage: "closed", close_reason: "no reply" });
    expect(later.sent).toHaveLength(0);
  });
});

describe("answers", () => {
  const FULL = { name: { value: "Person 1" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/p1" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (answers, over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [], ...over });

  it("a full yes with every detail is submitted once, with a put-forward email", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes, please go ahead", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" })] });
    // every detail in now sends the confirm email, not a submission
    await w.run();
    expect(w.T[0].stage).toBe("confirming");
    expect(w.submitted).toHaveLength(0);
    await reply(w);
    const r = await w.run();
    expect(w.T[0].stage).toBe("submitted");
    expect(w.T[0].consent).toMatchObject({ state: "GRANTED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" });
    expect(w.submitted).toEqual([expect.objectContaining({ roleId: "1000101", candidate: expect.objectContaining({ name: "Person 1" }) })]);
    expect(w.S).toEqual([expect.objectContaining({ status: "sent", mode: "live", attempt: 1 })]);
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm", "qualify-put-forward"]);
    expect(r.counts.submitted).toBe(1);
    // a second run never submits again
    w.T[0].stage = "ready";
    await w.run();
    expect(w.submitted).toHaveLength(1);
  });

  it.each([
    ["said no", { consent: "No thanks", currentPay: "4 lakh fixed, no variable" }, {}, /said no/],
    ["will not work from the city", { consent: "Yes", currentPay: "4 lakh fixed, no variable", workFrom: "No, I cannot relocate" }, {}, /city/],
    ["expects more than the band", { consent: "Yes", currentPay: "4 lakh fixed, no variable" }, { fields: { ...FULL, expectedCtc: { value: 9 } } }, /expects 9 lakh/],
  ])("closes with one closing email when the person %s", async (_, ans, over, why) => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered(ans, over)] });
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: expect.stringMatching(why) });
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-closed"]);
    expect(w.submitted).toHaveLength(0);
  });

  it("missing details get ONE follow-up; still missing after it, the thread closes", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes", currentPay: "15 LPA" })] });
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });
    expect(w.sent.map((s) => s.dedupeKey)).toEqual(["t-1:verify:2"]);
    const again = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes", currentPay: "15 LPA" }, { rounds: 2 })] });
    await again.run();
    expect(again.T[0]).toMatchObject({ stage: "closed", close_reason: expect.stringMatching(/still missing/) });
    expect(again.submitted).toHaveLength(0);
  });

  it("no justification that passes the checks means no submission", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes", currentPay: "4 lakh fixed, no variable" })], justification: { ok: false, reason: "the grounding check refused it" } });
    await w.run(); await reply(w); await w.run();
    expect(w.T[0]).toMatchObject({ stage: "failed", last_error: expect.stringMatching(/grounding/) });
    expect(w.submitted).toHaveLength(0);
  });

  it("already with the employer: recorded as such, no put-forward email", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes", currentPay: "4 lakh fixed, no variable" })] });
    w.deps.adapters.pieworks.submit = async () => ({ status: "duplicate", result: 300, message: "This candidate is already discovered for this role" });
    await w.run(); await reply(w); await w.run();
    expect(w.T[0]).toMatchObject({ stage: "submitted", close_reason: expect.stringMatching(/already had/) });
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm"]);
  });

  it("a transport failure is logged and retried, and fails the thread after three attempts", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes", currentPay: "4 lakh fixed, no variable" })] });
    w.deps.adapters.pieworks.submit = async () => { throw new Error("HTTP 502"); };
    await w.run(); await reply(w);
    await w.run(); await w.run(); await w.run();
    expect(w.S.map((s) => [s.status, s.attempt])).toEqual([["failed", 1], ["failed", 2], ["failed", 3]]);
    expect(w.T[0].stage).toBe("failed");
  });
});

describe("a reply", () => {
  const deps = (T) => ({
    cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T },
    ownWords: (b) => b,
    fileAnswers: async (questions) => questions.map((q) => ({ question: q, answer: /forward/.test(q) ? "Yes, go ahead" : null })),
    cv: { put: async (id, f) => `${id}/${f.filename}` },
  });
  it("files the answers verbatim, keeps the PDF, and records where the consent came from", async () => {
    const T = { id: "t-1", stage: "verify_sent", rounds: 1, questions: [{ id: "consent", text: "May I put you forward to Northwind Labs for the Support Engineer role?" }, { id: "noticePeriod", text: "What is your notice period, in days?" }], answers: {} };
    const out = await onQualifyReply(T, { body: "Yes, go ahead", cvFile: { bytes: new Uint8Array([1]), filename: "cv.pdf" }, ref: "email-123", now: NOW }, deps(T));
    expect(out).toMatch(/answered/);
    expect(T).toMatchObject({ stage: "answered", answers: { consent: "Yes, go ahead" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", evidence: "email-123" } });
  });
  it("a reply to a closed thread changes nothing", async () => {
    const T = { id: "t-1", stage: "closed" };
    expect(await onQualifyReply(T, { body: "yes" }, deps(T))).toMatch(/kept/);
    expect(T.stage).toBe("closed");
  });
});


describe("edge cases (each test fails without its fix)", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const thread = (stage, answers = {}, over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage, external_role_id: "1000101", fields: FULL, answers, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }], verify_sent_at: new Date(NOW - 49 * H).toISOString(), ...over });
  const YES = { consent: "Yes please", currentPay: "4 lakh fixed, no variable" };
  const later = (threads, opts = {}) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads, ...opts });

  it("a reply that takes the yes back stops a thread that was ready, and nobody is submitted", async () => {
    const T = thread("ready", YES, { consent: { state: "GRANTED", company_shown: "Northwind Labs", evidence: "reply:x" } });
    const replyDeps = { cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" }, yesNo: (w) => classifyInviteReply(w).answer };
    expect(await onQualifyReply(T, { body: "Sorry, please do not put me forward", from: "Asha Rao <p1@x.com>", now: NOW }, replyDeps)).toBe("took back their yes");
    const w = later([T]);
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "took back their yes" });
    expect(withdraws("I'm no longer interested, thanks")).toBe(true);
    expect(withdraws("Yes, please go ahead")).toBe(false);
  });

  it("only the person's own address can answer; a reply after submission is kept, not acted on", async () => {
    const T = thread("verify_sent");
    const deps = { cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: async (q) => q.map(() => ({ answer: "yes" })), cv: { put: async () => "" } };
    expect(await onQualifyReply(T, { body: "yes", from: "someone.else@x.com" }, deps)).toMatch(/not from the person/);
    expect(T.stage).toBe("verify_sent");
    expect(addressOf("Asha <P1@X.com>")).toBe("p1@x.com");
    const S = thread("submitted");
    const deps2 = { ...deps, cstore: { updateThread: async (_id, p) => Object.assign(S, p), updateThreadIf: async (_id, st, p) => (S.stage === st ? Object.assign(S, p) : null), threadByKey: async () => S } };
    expect(await onQualifyReply(S, { body: "I got another offer", from: "p1@x.com", now: NOW }, deps2)).toBe("kept after submitted");
    expect(S.answers._after).toEqual([expect.objectContaining({ words: "I got another offer" })]);
  });

  it("shadow changes no thread: an answered one is not read, a due reminder is not sent or recorded", async () => {
    const w = later([thread("answered", YES), thread("verify_sent", {}, { id: "t-2", candidate_id: "c-2", email: "p2@x.com" })], { mode: "shadow" });
    const r = await w.run();
    expect(w.T.map((t) => t.stage)).toEqual(["answered", "verify_sent"]);
    expect(w.sent).toHaveLength(0);
    expect(r.items.filter((i) => i.result === "shadow").map((i) => i.reason)).toEqual(expect.arrayContaining(["would read their answers", "would remind"]));
  });

  it("consent must be for the company the email named, with the reply it came from", async () => {
    const other = later([thread("answered", YES, { consent: { state: "REPLIED", company_shown: "Another Co", evidence: "reply:x" } })]);
    await other.run();
    expect(other.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });       // asked again, not submitted
    expect(other.submitted).toHaveLength(0);
    const noEvidence = later([thread("ready", YES, { consent: { state: "GRANTED", company_shown: "Northwind Labs", evidence: null } })]);
    await noEvidence.run();
    expect(noEvidence.submitted).toHaveLength(0);
    expect(noEvidence.T[0].last_error).toMatch(/no consent/);
  });

  it("no CV PDF means no submission; a name that is not a name is never written to", async () => {
    const w = later([thread("ready", YES, { cv_path: null, consent: { state: "GRANTED", company_shown: "Northwind Labs", evidence: "reply:x" } })]);
    await w.run();
    expect(w.submitted).toHaveLength(0);
    const n = world({ pools: [pool(1, { full_name: "Pune, India" })] });
    await n.run();
    expect(n.T).toHaveLength(0);
  });

  it("an unclear answer to 'would you work from there' is not a yes: it is asked again", async () => {
    const w = later([thread("answered", { ...YES, workFrom: "Only remote please" }, { questions: [{ id: "consent", text: "x" }, { id: "workFrom", text: "y" }] })]);
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });
    expect(w.submitted).toHaveLength(0);
  });

  it("a role with no stated top of its band is submitted and says so; a follow-up gets no reminder and closes at 96h", async () => {
    const w = later([thread("answered", YES)]);
    w.deps.cstore.roles = async () => [{ external_id: "1000101", job_id: "job-1", payload: { ...ROLE_PAYLOAD, maxCtc: null } }];
    const r = await w.run();
    await reply(w); await w.run();
    expect(w.submitted).toHaveLength(1);
    expect(r.items).toContainEqual(expect.objectContaining({ result: "no ceiling" }));
    const f = later([thread("verify_sent", {}, { rounds: 2 })]);
    await f.run();
    expect(f.sent).toHaveLength(0);
    expect(f.T[0].stage).toBe("verify_sent");
    const g = later([thread("verify_sent", {}, { rounds: 2, verify_sent_at: new Date(NOW - 97 * H).toISOString() })]);
    await g.run();
    expect(g.T[0]).toMatchObject({ stage: "closed", close_reason: "no reply" });
  });

  it("at the daily limit a thread is not closed without its closing email; a held put-forward goes on a later run", async () => {
    const w = later([thread("answered", { consent: "No thanks" })]);
    await w.run(0);
    expect(w.T[0].stage).toBe("answered");
    const p = later([thread("answered", YES)]);
    await p.run(0);
    expect(p.T[0].stage).toBe("answered");          // the confirm email is held too; nothing moves without it
    await p.run(5); await reply(p);
    await p.run(0);
    expect(p.submitted).toHaveLength(1);
    expect(p.T[0].stage).toBe("submitted");
    expect(p.sent.map((s) => s.template)).toEqual(["qualify-confirm"]);
    await p.run(5);
    expect(p.sent.map((s) => s.template)).toEqual(["qualify-confirm", "qualify-put-forward"]);
    await p.run(5);
    expect(p.sent).toHaveLength(2);
  });
});


describe("edge cases, set 2 (each test fails without its fix)", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const GRANTED = { state: "GRANTED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" };
  const thread = (stage, answers = {}, over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage, external_role_id: "1000101", fields: FULL, answers, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const YES = { consent: "Yes please", currentPay: "4 lakh fixed, no variable" };
  const later = (threads, opts = {}) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads, ...opts });
  const replyTo = async (T, body) => onQualifyReply(T, { body, from: "p1@x.com", now: NOW }, { cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" }, yesNo: (w) => classifyInviteReply(w).answer });

  it.each([
    ["in a follow-up, a withdrawal the filer did not file", { rounds: 2 }, "Sorry, I don't want to be put forward any more."],
    ["a plain no", {}, "no thanks, I'll pass on this one"],
  ])("%s: never submitted", async (_, over, body) => {
    const T = thread("ready", YES, { consent: GRANTED, ...over });
    await replyTo(T, body);
    const w = later([T]);
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0].stage).toBe("closed");
  });

  // after the final YES, any other reply sends the details to confirm again
  it("a later reply that is not a clear yes holds the submission until the yes is confirmed", async () => {
    const T = thread("ready", YES, { consent: GRANTED });
    await replyTo(T, "Thanks, one question: is the role hybrid?");
    expect(T).toMatchObject({ stage: "answered", consent: expect.objectContaining({ state: "CONFIRM_UNCLEAR", confirmed_hash: null }) });
    const w = later([T]);
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "confirming" });
    expect(w.sent[0]).toMatchObject({ template: "qualify-confirm", dedupeKey: expect.stringMatching(/^t-1:confirm-details:1:[0-9a-f]{12}$/) });
  });

  // strict about yes: a yes with a "don't" in it is never closed, and never
  // submitted unconfirmed: it gets one confirm question.
  it("yes with an unrelated 'don't' is never closed: it is confirmed once", async () => {
    const T = thread("ready", YES, { consent: GRANTED });
    await replyTo(T, "yes, go ahead. Please don't share my phone with recruiters");
    expect(T.consent.state).toBe("CONFIRM_UNCLEAR");
    const w = later([T]);
    await w.run();
    expect(w.T[0].stage).not.toBe("closed");
    expect(w.sent.map((m) => m.dedupeKey)).toEqual([expect.stringMatching(/^t-1:confirm-details:1:/)]);
    expect(w.submitted).toHaveLength(0);
  });

  it("a person who cannot be emailed is closed once, not re-judged every run", async () => {
    let evaluations = 0;
    const w = later([thread("answered", { consent: "Yes" })], { evaluate: async () => { evaluations++; return { fit: "strong", criteria: [], evidence: [] }; } });
    w.deps.send = async () => ({ status: "suppressed" });
    await w.run(); await w.run(); await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "cannot be emailed (suppressed or blocked)" });
    expect(evaluations).toBe(1);
  });

  it("a role closed before submission is not submitted", async () => {
    const w = later([thread("ready", YES, { consent: GRANTED })]);
    w.deps.hire.getJob = async () => ({ job: { id: "job-1", title: "Support Engineer", client: "Northwind Labs", lifecycle: "closed" } });
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "the role is no longer open" });
  });

  it("guards the first round left untested: consent for another company at submit; shadow at submit; asked before", async () => {
    const other = later([thread("ready", YES, { consent: { ...GRANTED, company_shown: "OtherCo" } })]);
    await other.run();
    expect(other.submitted).toHaveLength(0);
    const sh = later([thread("ready", YES, { consent: GRANTED })], { mode: "shadow" });
    await sh.run();
    expect(sh.submitted).toHaveLength(0);
    expect(sh.T[0].stage).toBe("ready");
    const before = world({ threads: [{ id: "old", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", stage: "closed" }] });
    const r = await before.run();
    expect(before.T).toHaveLength(1);
    expect(r.items).toContainEqual(expect.objectContaining({ reason: "already asked about this role" }));
  });

  it("an answered thread without consent evidence, or without a CV, is asked again, not made ready", async () => {
    const noEvidence = later([thread("answered", YES, { consent: { state: "REPLIED", company_shown: "Northwind Labs", evidence: null } })]);
    await noEvidence.run();
    expect(noEvidence.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });
    expect(noEvidence.sent[0].mail.text).toMatch(/May I put you forward/);
    const noCv = later([thread("answered", YES, { cv_path: null })]);
    await noCv.run();
    expect(noCv.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });
    expect(noCv.sent[0].mail.text).toMatch(/CV as a PDF/);
  });

  it("names that are placeholders are refused", () => {
    for (const n of ["N/A", "Unknown", ".", "x"]) expect(greetingName(n)).toBeNull();
  });
});


describe("edge cases, set 3 (each test fails without its fix)", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const REPLIED = { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" };
  const thread = (stage, answers = {}, over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 2, stage, external_role_id: "1000101", fields: FULL, answers, cv_path: "t-1/cv.pdf", consent: REPLIED, questions: [{ id: "consent", text: "May I put you forward?" }, { id: "workFrom", text: "Would you work from there?", round: 2 }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const deps = (T, filed = []) => ({ cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: async () => filed, cv: { put: async () => "" }, yesNo: (w) => classifyInviteReply(w).answer });

  // an answer that starts with "No" is never a withdrawal and never closes
  // anyone, but after a yes it holds the submission behind ONE confirm question (wording cannot tell "No problem"
  // from "No thanks"; a willing person loses one line, a real no is never submitted).
  // each reply filed as a real filer would: the city answer only where the reply answers the city question
  it.each([["No problem, I can work from there.", true], ["No. My notice is 30 days.", false], ["No worries, attaching CV", false], ["No notice period, I can join immediately.", false]])("an answer starting with No is never a withdrawal, and never closes: %s", async (body, cityAnswer) => {
    expect(withdraws(body)).toBe(false);
    const T = thread("verify_sent", { consent: "Yes", currentPay: "4 lakh fixed, no variable", ...(cityAnswer ? {} : { workFrom: "Yes" }) });
    expect(await onQualifyReply(T, { body, from: "p1@x.com", now: NOW }, deps(T, [{ answer: cityAnswer ? body : null }]))).toMatch(/answered/);
    // read with the answer reader, "No problem/No worries" are agreement; a real "No." asks to confirm
    expect(T.consent.state).not.toBe("WITHDRAWN");
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run();
    expect(w.T[0].stage).not.toBe("closed");
  });

  it("a second mail while answers are being read asks to confirm; it never closes a person who said yes", async () => {
    const T = thread("answered", { consent: "Yes", workFrom: "Yes" });
    await onQualifyReply(T, { body: "Attaching my CV again", from: "p1@x.com", now: NOW }, deps(T));
    expect(T.consent.state).toBe("RECHECK");
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run();
    expect(w.T[0].stage).not.toBe("closed");
  });

  it("an explicit 'hold off' is a withdrawal; an unconfirmed recheck closes once, never submits", async () => {
    expect(withdraws("Please hold off for now")).toBe(true);
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [thread("answered", { consent: "Yes", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, { consent: { ...REPLIED, state: "RECHECK", recheck_asked: true } })] });
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "their yes was not confirmed" });
  });
});


describe("after a yes, a no is never submitted at any stage", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const ALL_IN = { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" };
  const mk = (stage, rounds, consentState) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds, stage, external_role_id: "1000101", fields: FULL, answers: { ...ALL_IN }, cv_path: "t-1/cv.pdf", consent: { state: consentState, company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?", round: 1 }, { id: "workFrom", text: "Would you work from there?", round: rounds }], verify_sent_at: new Date(NOW - 10 * H).toISOString() });
  const cases = [];
  for (const body of ["No thanks.", "Not anymore, sorry."]) for (const [stage, rounds, st] of [["answered", 1, "REPLIED"], ["answered", 2, "REPLIED"], ["ready", 1, "GRANTED"], ["ready", 2, "GRANTED"], ["verify_sent", 2, "REPLIED"]]) for (const filer of ["nothing", "consent"]) cases.push([body, stage, rounds, st, filer]);
  it.each(cases)("%s at %s round %s (%s), filer files %s: never submitted", async (body, stage, rounds, st, filer) => {
    const T = mk(stage, rounds, st);
    const open = (T.questions || []).filter((q) => (q.round ?? 1) === rounds);
    const filed = open.map((q) => ({ answer: filer === "consent" && q.id === "consent" ? body : null }));
    await onQualifyReply(T, { body, from: "p1@x.com", now: NOW }, { cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: async () => filed, cv: { put: async () => "" }, yesNo: (w) => classifyInviteReply(w).answer });
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(0);
  });

  it("the confirm question, answered yes, submits once", async () => {
    const T = mk("ready", 1, "GRANTED");
    const replyDeps = (filed) => ({ cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: async () => filed, cv: { put: async () => "" }, yesNo: (w) => classifyInviteReply(w).answer });
    await onQualifyReply(T, { body: "Not anymore, sorry.", from: "p1@x.com", now: NOW }, replyDeps([]));
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run();
    // the confirm is now the details email, and its YES makes them ready
    expect(w.sent.map((m) => m.dedupeKey)).toEqual([expect.stringMatching(/^t-1:confirm-details:1:/)]);
    await onQualifyReply(w.T[0], { body: "Yes", from: "p1@x.com", now: NOW }, replyDeps([]));
    expect(w.T[0]).toMatchObject({ stage: "ready", consent: expect.objectContaining({ state: "GRANTED" }) });
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(1);
  });
});


describe("willing people end to end, and the confirm question", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const base = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 2, stage: "verify_sent", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?", round: 1 }, { id: "workFrom", text: "This role is based in Pune. Would you work from there?", round: 2 }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const rd = (T, filer) => ({ cstore: { updateThread: async (_id, p) => Object.assign(T, p), updateThreadIf: async (_id, st, p) => (T.stage === st ? Object.assign(T, p) : null), threadByKey: async () => T }, ownWords: (b) => b, fileAnswers: filer, cv: { put: async () => "" }, yesNo: (w) => classifyInviteReply(w).answer });

  it.each(["No problem, I can work from there.", "No issues, I can relocate"])("'%s' to the city question is a yes: submitted, never closed", async (body) => {
    const T = base();
    await onQualifyReply(T, { body, from: "p1@x.com", now: NOW }, rd(T, async (qs) => qs.map((q) => ({ answer: /work from there/.test(q) ? body : null }))));
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run();
    expect(w.T[0].stage).toBe("confirming");
    await reply(w); await w.run();
    expect(w.submitted).toHaveLength(1);
  });

  it("'No, I can't relocate' to the city question closes; 'Yes, but only if hybrid' is asked again", async () => {
    const no = base({ stage: "answered", answers: { consent: "Yes", currentPay: "4 lakh fixed, no variable", workFrom: "No, I can't relocate" } });
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [no] });
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "will not work from the role's city" });
    const cond = base({ stage: "answered", rounds: 1, answers: { consent: "Yes, but only if hybrid", currentPay: "4 lakh fixed, no variable" } });
    const c = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [cond] });
    await c.run();
    expect(c.submitted).toHaveLength(0);
    expect(c.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });
  });

  it("a reply to the confirm question that does not answer it is asked once more, and a plain Yes counts even if the filer files nothing", async () => {
    const T = base({ stage: "verify_sent", answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, consent: { state: "RECHECK", company_shown: "Northwind Labs", evidence: "reply:x", recheck_asked: true, confirms: 1 } });
    await onQualifyReply(T, { body: "Sorry, forgot the attachment, here it is", from: "p1@x.com", now: NOW }, rd(T, async () => []));
    expect(T.consent).toMatchObject({ state: "RECHECK", recheck_asked: false });
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run();
    expect(w.sent.map((m) => m.dedupeKey)).toEqual(["t-1:confirm:2"]);
    await onQualifyReply(w.T[0], { body: "Yes", from: "p1@x.com", now: NOW }, rd(w.T[0], async () => { throw new Error("model down"); }));
    expect(w.T[0].consent.state).toBe("REPLIED");
    await w.run();
    expect(w.T[0].stage).toBe("confirming");
    await reply(w); await w.run();
    expect(w.submitted).toHaveLength(1);
  });

  it("confirms are capped at two; the third unclear reply closes without submitting", async () => {
    const T = base({ stage: "answered", consent: { state: "RECHECK", company_shown: "Northwind Labs", evidence: "reply:x", recheck_asked: false, confirms: 2 } });
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [T] });
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "their yes was not confirmed" });
    expect(w.submitted).toHaveLength(0);
  });
});

describe("end to end: a refusal is never submitted, an agreement is never closed", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (answers) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }, { id: "workFrom", text: "Would you work from there?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString() });
  it.each(["Absolutely not", "Definitely not", "Ok, don't", "Ok will check"])("consent '%s' is never submitted", async (c) => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: c, currentPay: "4 lakh fixed, no variable", workFrom: "Yes" })] });
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(0);
  });
  it.each(["Definitely not", "Absolutely not"])("city '%s' is never submitted", async (c) => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "Yes", currentPay: "4 lakh fixed, no variable", workFrom: c })] });
    await w.run();
    expect(w.submitted).toHaveLength(0);
  });
  it("'No objection' to either question is a yes: submitted, never closed", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ consent: "No objection", currentPay: "4 lakh fixed, no variable", workFrom: "No objection" })] });
    await w.run(); await reply(w); await w.run();
    expect(w.submitted).toHaveLength(1);
  });
});


describe("the final YES (each test fails on dbb6447)", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/Asha_Rao_CV.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }, { id: "workFrom", text: "Would you work from there?" }, { id: "expectedPay", text: "What do you expect, in lakh a year?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const fresh = (over) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered(over)] });

  it("every detail in sends ONE confirm email listing exactly what will be sent, and nothing is submitted", async () => {
    const w = fresh();
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "confirming", consent: expect.objectContaining({ state: "CONFIRM_ASKED", confirm_asks: 1 }) });
    // the dedupe key carries the facts' hash: a "duplicate" from the guard can only mean these facts were delivered
    expect(w.sent).toEqual([expect.objectContaining({ template: "qualify-confirm", dedupeKey: expect.stringMatching(/^t-1:confirm-details:1:[0-9a-f]{12}$/) })]);
    const text = w.sent[0].mail.text;
    for (const line of ["Current pay: 4 lakh fixed, 0 lakh variable", "Expected pay: 5 lakh a year", "Notice period: 30 days", "CV: Asha_Rao_CV.pdf", "Phone: +91 9876543211"]) expect(text).toContain(line);
  });

  it.each([
    "Okay. I've accepted another offer.", "Ok, stop", "Ok.\n\nUnfortunately I have accepted another offer and joined there.\n\nRegards,\nAsha",
    "Yes, I'll let you know", "Ok, give me a day to decide", "Sure, please remove me from this", "Yes, after I finish my notice in March",
    "Ok", "Sure", "Okay, I'll check with my family and let you know", "Ok, I have decided to stay with my current company",
  ])("%j to the confirm is not a YES: confirmed once more, then closed, never submitted", async (body) => {
    const w = fresh();
    await w.run();
    await reply(w, body);
    expect(w.T[0].stage).toBe("answered");
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "confirming", consent: expect.objectContaining({ confirm_asks: 2 }) });
    expect(w.sent.at(-1)).toMatchObject({ dedupeKey: expect.stringMatching(/^t-1:confirm-details:2:/) });
    expect(w.sent.at(-1).mail.text).toMatch(/^again/);
    await reply(w, body);
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "did not reply YES to the details" });
  });

  it.each(["YES", "Yes", "yes!", "Yes, please go ahead.", "Hi,\n\nYes, please go ahead.\n\nThanks,\nAsha", "Hi Charlie,\nYes\n\nRegards, Asha Rao\nSent from my iPhone", "Yes thanks", "Haan ji"])("%j to the confirm submits once", async (body) => {
    const w = fresh();
    await w.run();
    expect(await reply(w, body)).toEqual(["confirmed: YES"]);
    await w.run();
    expect(w.submitted).toHaveLength(1);
    expect(w.T[0].consent).toMatchObject({ state: "GRANTED", evidence_confirmed: "email-yes" });
  });

  it("no reply to the confirm closes quietly at 96 hours; a reply after the YES that is not YES confirms again", async () => {
    const w = fresh();
    await w.run();
    await w.run(30, NOW + 97 * H);
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "no reply to the confirm" });
    expect(w.submitted).toHaveLength(0);
    const v = fresh();
    await v.run();
    await reply(v, "YES");
    expect(v.T[0].stage).toBe("ready");
    expect(await reply(v, "Thanks!")).toEqual(["kept: still confirmed"]);
    expect(v.T[0].stage).toBe("ready");
    await reply(v, "Actually, one thing: is it hybrid?");
    expect(v.T[0]).toMatchObject({ stage: "answered", consent: expect.objectContaining({ confirmed_hash: null }) });
    await v.run();
    expect(v.submitted).toHaveLength(0);
    expect(v.T[0].stage).toBe("confirming");
  });

  it("a correction is filed and shown in the next confirm; a YES that brings a new CV confirms the new file", async () => {
    const w = fresh();
    await w.run();
    await reply(w, "My expected is 5.5 lakh, the rest is right", { filer: async (qs) => qs.map((q) => ({ answer: /expect/.test(q) ? "My expected is 5.5 lakh" : null })) });
    await w.run();
    expect(w.sent.at(-1).mail.text).toContain("Expected pay: 5.5 lakh a year");
    expect(w.T[0].answers.consent).toBe("Yes please");          // a correction never re-reads consent or the city
    await reply(w, "YES");
    await w.run();
    expect(w.submitted).toHaveLength(1);
    const c = fresh();
    await c.run();
    await reply(c, "YES", { cvFile: { bytes: new Uint8Array([1]), filename: "Asha_new_CV.pdf" } });
    expect(c.T[0].stage).toBe("answered");
    await c.run();
    expect(c.sent.at(-1).mail.text).toContain("CV: Asha_new_CV.pdf");
  });

  it("a ready thread whose details changed after the YES is not submitted", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    w.T[0].fields = { ...w.T[0].fields, expectedCtc: { value: 6 } };
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "failed", last_error: "what would be sent is not what they confirmed" });
  });

  it("a withdrawal at the confirm closes with one closing email", async () => {
    const w = fresh();
    await w.run();
    expect(await reply(w, "Please don't put me forward, I've changed my mind")).toEqual(["took back their yes"]);
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "took back their yes" });
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm", "qualify-closed"]);
    expect(confirmFacts({}, null)).toContain("CV: ");
  });
});


describe("what is confirmed is what is sent, and no reply is lost to a race", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/Asha_Rao_CV.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", role_shown: "Support Engineer", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }, { id: "workFrom", text: "Would you work from there?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const fresh = (over, opts = {}) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered(over)], ...opts });

  it("the note about them is in the confirm, and it is exactly the note sent", async () => {
    const w = fresh();
    await w.run();
    expect(w.sent[0].mail.text).toContain("What I will say about you: Person 1 resolved billing tickets");
    await reply(w); await w.run();
    expect(w.submitted[0].candidate.justification).toMatch(/^Person 1 resolved billing tickets/);
  });

  it.each(["अभी मत भेजिए", "+91 99999 00000", "90", "👎", "Yes?"])("after the YES, %j is not a bare thanks: the details are confirmed again", async (body) => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    expect(await reply(w, body)).not.toEqual(["kept: still confirmed"]);
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0].stage).toBe("confirming");
  });

  it("a detail from their record (the phone) can be corrected; consent and the city are never re-read from a correction", async () => {
    const w = fresh();
    await w.run();
    const first = w.sent[0].dedupeKey;
    await reply(w, "My phone is wrong, it is +91 99999 00000", { filer: async (qs) => qs.map((q) => ({ answer: /phone/.test(q) ? "+91 99999 00000" : "No thanks" })) });
    expect(w.T[0].answers).toMatchObject({ consent: "Yes please", workFrom: "Yes", phone: "+91 99999 00000" });
    await w.run();
    expect(w.sent.at(-1).mail.text).toContain("Phone: +91 9999900000");
    expect(w.sent.at(-1).dedupeKey).not.toBe(first);
  });

  it("a withdrawal that lands while a submission is being prepared wins: nothing is sent", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    const stale = { ...w.T[0] };
    w.deps.cv.get = async () => { await onQualifyReply(stale, { body: "Please don't put me forward, I've changed my mind", from: "p1@x.com", now: NOW }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" } }); return { bytes: new Uint8Array([1]), filename: "cv.pdf" }; };
    const r = await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(r.items).toContainEqual(expect.objectContaining({ reason: "a reply changed the thread just now" }));
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "took back their yes" });
  });

  it("a YES that arrives after the 96-hour close does not reopen it; a thread stopped mid-submission is never sent blind", async () => {
    const w = fresh();
    await w.run();
    const stale = { ...w.T[0] };
    await w.run(30, NOW + 97 * H);
    expect(w.T[0].stage).toBe("closed");
    expect(await onQualifyReply(stale, { body: "YES", from: "p1@x.com", now: NOW + 98 * H }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" } })).toBe("kept after closed");
    await w.run(30, NOW + 99 * H);
    expect(w.submitted).toHaveLength(0);
    const m = fresh({ stage: "submitting", updated_at: new Date(NOW - 2 * H).toISOString() });
    await m.run();
    expect(m.submitted).toHaveLength(0);
    expect(m.T[0]).toMatchObject({ stage: "failed", last_error: expect.stringMatching(/mid-submission/) });
  });
});


describe("the run never writes over a reply, and a reply is never dropped", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", replied_at: "2026-10-06T00:00:00Z", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/Asha_Rao_CV.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", role_shown: "Support Engineer", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const fresh = (over, opts = {}) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered(over)], ...opts });
  const replyDeps = (w) => ({ cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" } });
  const NO = "Please withdraw my application, I accepted another offer";

  it("a withdrawal during a submit that then fails is not lost: the thread stops, nothing is submitted", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    w.deps.adapters.pieworks.submit = async () => { await onQualifyReply({ ...w.T[0] }, { body: NO, from: "p1@x.com", now: NOW + 1 }, replyDeps(w)); throw new Error("timeout"); };
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "failed", last_error: expect.stringMatching(/a reply arrived/) });
    w.deps.adapters.pieworks.submit = async (_c, x) => { w.submitted.push(x); return { status: "sent" }; };
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(0);
  });

  it("a failed submit with no reply in between goes back to ready and is retried", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    let first = true;
    w.deps.adapters.pieworks.submit = async (_c, x) => { if (first) { first = false; throw new Error("HTTP 502"); } w.submitted.push(x); return { status: "sent" }; };
    await w.run();
    expect(w.T[0].stage).toBe("ready");
    await w.run();
    expect(w.submitted).toHaveLength(1);
  });

  it("a withdrawal while the note is being written: no confirm is sent, and the withdrawal stands", async () => {
    const w = fresh();
    w.deps.writeJustification = async () => { await onQualifyReply({ ...w.T[0] }, { body: NO, from: "p1@x.com", now: NOW + 1 }, replyDeps(w)); return { ok: true, text: "Asha resolved billing tickets and wrote Zendesk macros for a payroll product across two releases at Acme." }; };
    await w.run();
    expect(w.sent.map((m) => m.template)).not.toContain("qualify-confirm");
    expect(w.T[0].consent.state).toBe("WITHDRAWN");
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "took back their yes" });
    expect(w.submitted).toHaveLength(0);
  });

  it("an old YES that is applied after a newer confirm went out is not a YES to the newer one", async () => {
    const w = fresh();
    await w.run();
    const a = { ...w.T[0] };                                           // read while confirm 1 was out
    await reply(w, "Wait, let me check with my wife first");
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "confirming", consent: expect.objectContaining({ confirm_asks: 2 }) });
    await onQualifyReply(a, { body: "YES", from: "p1@x.com", now: NOW }, replyDeps(w));
    expect(w.T[0].stage).not.toBe("ready");
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(0);
  });

  it("a reply that cannot be applied in order is kept, and the thread stops for a person", async () => {
    const w = fresh();
    await w.run();
    const deps = { ...replyDeps(w), cstore: { ...w.deps.cstore, updateThreadIf: async () => null } };
    expect(await onQualifyReply({ ...w.T[0] }, { body: NO, from: "p1@x.com", now: NOW }, deps)).toBe("kept: could not be applied in order");
    expect(w.T[0]).toMatchObject({ stage: "failed", answers: expect.objectContaining({ _after: [expect.objectContaining({ words: NO, unread: true })] }) });
  });

  it("the note is drafted once while the confirm is held; an empty note sends nothing; a submission in flight counts as in flight", async () => {
    let calls = 0;
    const w = fresh({}, { justification: { ok: true, text: "Asha resolved billing tickets and wrote Zendesk macros for a payroll product across two releases at Acme." } });
    const orig = w.deps.writeJustification;
    w.deps.writeJustification = async (x) => { calls++; return orig(x); };
    await w.run(0); await w.run(0); await w.run(0);
    expect(calls).toBe(1);
    await w.run(5);
    expect(calls).toBe(1);
    expect(w.T[0].stage).toBe("confirming");
    const e = fresh({}, { justification: { ok: true, text: "  " } });
    await e.run();
    expect(e.sent).toHaveLength(0);
    expect(e.T[0].stage).toBe("failed");
    const { OPEN_STAGES } = await import("./agent.mjs");
    expect(OPEN_STAGES).toContain("submitting");
  });
});


describe("versions, not clocks; the exact file; an honest close", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", replied_at: "2026-10-06T00:00:00Z", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/Asha_Rao_CV.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", role_shown: "Support Engineer", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const fresh = (over, opts = {}) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered(over)], ...opts });
  const replyDeps = (w) => ({ cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" } });
  const NO = "Not anymore, sorry";

  it("a reply that read the thread before the claim and lands after it stops a failing submit", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    const readEarly = structuredClone(w.T[0]);                     // read while still ready
    w.deps.adapters.pieworks.submit = async () => { await onQualifyReply(readEarly, { body: NO, from: "p1@x.com", now: NOW - 5 }, replyDeps(w)); throw new Error("timeout"); };
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "failed", answers: expect.objectContaining({ _after: [expect.objectContaining({ words: NO, unread: true })] }) });
    w.deps.adapters.pieworks.submit = async (_c, x) => { w.submitted.push(x); return { status: "sent" }; };
    await w.run();
    expect(w.submitted).toHaveLength(0);
  });

  it("a new file under the same name after the YES is not what they confirmed", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    w.T[0].cv_path = "t-1/999/Asha_Rao_CV.pdf";
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0].last_error).toBe("what would be sent is not what they confirmed");
  });

  it("a withdrawal while the 'just to confirm' question is being sent stands", async () => {
    const w = fresh({ consent: { state: "RECHECK", company_shown: "Northwind Labs", evidence: "reply:x" } });
    const send = w.deps.send;
    w.deps.send = async (x) => { await onQualifyReply(structuredClone(w.T[0]), { body: "Please do not put me forward", from: "p1@x.com", now: NOW + 1 }, replyDeps(w)); return send(x); };
    await w.run();
    expect(w.T[0].consent.state).toBe("WITHDRAWN");
    w.deps.send = send;
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "took back their yes" });
  });

  it("closed after two confirms without a plain YES: the closing email says nothing was sent, never that they said no", async () => {
    const seen = [];
    const w = fresh({ consent: { state: "CONFIRM_UNCLEAR", company_shown: "Northwind Labs", evidence: "reply:x", confirm_asks: 2 } });
    const closed = w.deps.render.closed;
    w.deps.render.closed = (a) => { seen.push(a); return closed(a); };
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "did not reply YES to the details" });
    expect(seen).toEqual([expect.objectContaining({ noYes: true })]);
  });
});


describe("a reply kept during a submit is never rolled over", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", replied_at: "2026-10-06T00:00:00Z", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/Asha_Rao_CV.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", role_shown: "Support Engineer", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [{ id: "consent", text: "May I put you forward?" }], verify_sent_at: new Date(NOW - 10 * H).toISOString(), ...over });
  const fresh = () => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()] });
  const replyDeps = (w) => ({ cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "" } });

  it("read while submitting, written after the failed submit put it back to ready: read again, never submitted", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    let seen = null;
    w.deps.adapters.pieworks.submit = async () => { seen = structuredClone(w.T.find((t) => t.id === "t-1")); throw new Error("timeout"); };
    await w.run();
    expect(w.T[0].stage).toBe("ready");
    expect(seen.stage).toBe("submitting");
    await onQualifyReply(seen, { body: "Please withdraw my application, I accepted another offer", from: "p1@x.com", now: NOW + 1 }, replyDeps(w));
    w.deps.adapters.pieworks.submit = async (_c, x) => { w.submitted.push(x); return { status: "sent" }; };
    await w.run(); await w.run();
    expect(w.submitted).toHaveLength(0);
  });

  it("a ready thread with an unread kept reply is never submitted", async () => {
    const w = fresh();
    await w.run(); await reply(w, "YES");
    w.T[0].answers = { ...w.T[0].answers, _after: [{ at: "x", words: "stop", unread: true }] };
    await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "failed", last_error: "a reply is waiting to be read before anything else" });
  });
});


describe("the final YES is read from the raw body", () => {
  const FULL = { name: { value: "Asha Rao" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/asha-rao" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const t0 = { id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Asha Rao", reply_key: "k", rounds: 1, stage: "answered", replied_at: "x", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", role_shown: "Support Engineer", evidence: "reply:x" }, questions: [{ id: "consent", text: "x" }], verify_sent_at: new Date(NOW).toISOString() };
  it("a correction typed inside Gmail's quote is not a YES, even when ownWords would cut it away", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [structuredClone(t0)] });
    await w.run();
    const body = "Yes\n\nOn Mon, 6 Oct 2026 at 10:00, Charlie <apply+k@mail.example.com> wrote:\n> Notice period: 30 days\nIt's 60 days now";
    const ownWordsCuts = (b) => b.split("\n\nOn Mon")[0];
    const t = w.T[0];
    expect(await onQualifyReply(structuredClone(t), { body, from: "p1@x.com", now: NOW }, { cstore: w.deps.cstore, ownWords: ownWordsCuts, fileAnswers: async () => [], cv: { put: async () => "" } })).not.toBe("confirmed: YES");
    await w.run();
    expect(w.submitted).toHaveLength(0);
  });
});

describe("the candidacy lifecycle: closing on fit is a person's decision (each test fails without it)", () => {
  const FULL = { name: { value: "Person 1" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/p1" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes, please go ahead", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [], ...over });
  const potential = async () => ({ fit: "potential", criteria: [{ ref: "c1", level: "partial", evidence_ids: ["e1"] }], evidence: [{ id: "e1", quote: "Resolved billing tickets" }] });
  // the store once the candidacy migration is applied: proposals are kept here
  const withCandidacy = (w) => {
    const P = [];
    Object.assign(w.deps.cstore, {
      candidacyReady: async () => true,
      propose: async (p) => { const row = { id: `p-${P.length + 1}`, status: "pending", ...p }; P.push(row); return row; },
      voidProposals: async (t) => { P.filter((p) => p.thread.id === t.id && p.status === "pending").forEach((p) => (p.status = "void")); },
    });
    return P;
  };
  const world1 = (over = {}, opts = {}) => world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered(over)], ...opts });

  it("a fit below the bar holds them for a person, with the evidence; nobody is emailed or closed", async () => {
    const w = world1({}, { evaluate: potential });
    const P = withCandidacy(w);
    const r = await w.run();
    expect(w.T[0].stage).toBe("held");
    expect(P).toEqual([expect.objectContaining({ kind: "close_not_fit", check_id: "fit", reason: "fit is potential after their answers", evidence: { fit: "potential", score: null } })]);
    expect(w.sent).toHaveLength(0);
    expect(r.items).toContainEqual(expect.objectContaining({ action: "propose", result: "needs you" }));
  });

  it("pay above the band is held the same way", async () => {
    const w = world1({ fields: { ...FULL, expectedCtc: { value: 9 } } });
    const P = withCandidacy(w);
    await w.run();
    expect(w.T[0].stage).toBe("held");
    expect(P[0]).toMatchObject({ check_id: "pay", evidence: { expected: 9, max: 8 } });
  });

  it("before the candidacy migration, today's behaviour stands: closed at once with the honest email", async () => {
    const w = world1({}, { evaluate: potential });
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "fit is potential after their answers" });
  });

  it("a person who chose to keep them: the agent carries on past that check to the confirm", async () => {
    const w = world1({ overrides: { keep: { fit: true } } }, { evaluate: potential });
    withCandidacy(w);
    await w.run();
    expect(w.T[0].stage).toBe("confirming");
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm"]);
  });

  it("a person who approved the close: closed with the honest closing email", async () => {
    const w = world1({ overrides: { close: { fit: true } } }, { evaluate: potential });
    const P = withCandidacy(w);
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "fit is potential after their answers" });
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-closed"]);
    expect(P).toHaveLength(0);
  });

  it("a reply while held voids the open question and is read again from their words", async () => {
    const w = world1({ stage: "held", updated_at: "v0" });
    const P = withCandidacy(w);
    P.push({ id: "p-1", status: "pending", thread: { id: "t-1" } });
    const out = await onQualifyReply(structuredClone(w.T[0]), { body: "Also I can join in 15 days", from: "p1@x.com", ref: "email-9", now: NOW }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [] });
    expect(out).toMatch(/answered/);
    expect(w.T[0].stage).toBe("answered");
    expect(P[0].status).toBe("void");
  });

  it("the history says a person was asked only once the thread is held; a question lost to a reply is withdrawn, unrecorded", async () => {
    const w = world1({}, { evaluate: potential });
    const P = withCandidacy(w);
    const events = [];
    w.deps.cstore.recordEvent = async (e) => events.push(e);
    await w.run();
    expect(events).toEqual([expect.objectContaining({ type: "proposal.made", thread_id: "t-1", approval_id: "p-1" })]);
    // a reply lands between the question and the hold
    const r = world1({}, { evaluate: potential });
    const Q = withCandidacy(r);
    const ev2 = [];
    r.deps.cstore.recordEvent = async (e) => ev2.push(e);
    const realIf = r.deps.cstore.updateThreadIf;
    r.deps.cstore.updateThreadIf = async (id, stage, patch, match) => (patch.stage === "held" ? null : realIf(id, stage, patch, match));
    await r.run();
    expect(Q.map((p) => p.status)).toEqual(["void"]);
    expect(ev2).toEqual([]);
  });

  it("an approval never outlives new words: a withdrawal and a correction at the confirm both cancel it", async () => {
    const yes = { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" };
    const w = world1({ overrides: { close: { fit: true }, keep: { pay: true } }, consent: yes });
    withCandidacy(w);
    await onQualifyReply(structuredClone(w.T[0]), { body: "Actually I do not want to be put forward any more", from: "p1@x.com", ref: "e1", now: NOW }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [] });
    expect(w.T[0].overrides).toEqual({ close: {}, keep: { pay: true } });
    const c = world1({ stage: "confirming", overrides: { close: { fit: true } }, consent: { ...yes, state: "CONFIRM_ASKED", confirm_hash: "h" } });
    withCandidacy(c);
    await onQualifyReply(structuredClone(c.T[0]), { body: "Notice period is 60 days now, not 30", from: "p1@x.com", ref: "e2", now: NOW }, { cstore: c.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [] });
    expect(c.T[0].stage).toBe("answered");
    expect(c.T[0].overrides).toEqual({ close: {} });
  });

  it("one held thread that cannot be moved never stops the rest of the run", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ id: "t-h", stage: "held", email: "h@x.com", reply_key: "kh" }), answered({ overrides: { keep: { fit: true } } })], evaluate: potential });
    const P = withCandidacy(w);
    w.deps.cstore.pendingProposals = async () => P.filter((p) => p.status === "pending").map((p) => ({ thread_id: p.thread.id }));
    const realIf = w.deps.cstore.updateThreadIf;
    w.deps.cstore.updateThreadIf = async (id, ...rest) => { if (id === "t-h") throw new Error("fetch failed"); return realIf(id, ...rest); };
    const r = await w.run();
    expect(w.T.find((t) => t.id === "t-1").stage).toBe("confirming");
    expect(r.items).toContainEqual(expect.objectContaining({ who: "Person 1", action: "propose", result: "failed" }));
  });

  it("the experience check is held for a person too, not closed", async () => {
    const w = world1({}, { gate: "INELIGIBLE" });
    const P = withCandidacy(w);
    await w.run();
    expect(w.T[0].stage).toBe("held");
    expect(P[0]).toMatchObject({ check_id: "gate", evidence: { gate: "INELIGIBLE" } });
    expect(w.sent).toHaveLength(0);
  });

  it("the question comes first: if it cannot be asked, the thread is not parked and the run says it failed", async () => {
    const w = world1({}, { evaluate: potential });
    withCandidacy(w);
    w.deps.cstore.propose = async () => { throw new Error("fetch failed"); };
    const r = await w.run();
    expect(w.T[0].stage).toBe("answered");
    expect(r.items).toContainEqual(expect.objectContaining({ action: "answers", result: "failed" }));
  });

  it("a held thread whose question is gone goes back to the agent, never stuck", async () => {
    const w = world1({ stage: "held" }, { evaluate: potential });
    const P = withCandidacy(w);
    w.deps.cstore.pendingProposals = async () => P.filter((p) => p.status === "pending").map((p) => ({ thread_id: p.thread.id }));
    await w.run();
    // read again, still below the bar: asked again, held again with a question
    expect(w.T[0].stage).toBe("held");
    expect(P.filter((p) => p.status === "pending")).toHaveLength(1);
  });

  it("a reply after a person approved the close cancels that approval: their new words are judged first", async () => {
    const w = world1({ overrides: { close: { fit: true } } });
    withCandidacy(w);
    await onQualifyReply(structuredClone(w.T[0]), { body: "I led billing support for 4 years at Acme", from: "p1@x.com", ref: "email-9", now: NOW }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [] });
    expect(w.T[0].overrides).toEqual({ close: {} });
  });

  it("the run's writes are the agent's, a reply's writes are the candidate's", async () => {
    const w = world1({}, { evaluate: potential });
    withCandidacy(w);
    const as = [];
    w.deps.cstore.as = (c) => { as.push(c); return w.deps.cstore; };
    await w.run();
    await onQualifyReply(structuredClone({ ...w.T[0], stage: "answered", updated_at: w.T[0].updated_at }), { body: "Yes", from: "Person 1 <p1@x.com>", ref: "email-7", now: NOW }, { cstore: w.deps.cstore, ownWords: (b) => b, fileAnswers: async () => [] });
    // the run acts as the agent; the reply (and its one re-read after a race) only ever as the candidate
    expect(as[0]).toEqual({ actor_type: "agent", actor_id: "outreach", ref: "run-1" });
    expect(as.length).toBeGreaterThan(1);
    for (const c of as.slice(1)) expect(c).toEqual({ actor_type: "candidate", actor_id: "p1@x.com", ref: "email-7" });
  });

  it("a held conversation is still open: it counts as one conversation for the person", async () => {
    const { OPEN_STAGES } = await import("./agent.mjs");
    expect(OPEN_STAGES).toContain("held");
  });
});

describe("the candidacy history is never silently incomplete", () => {
  it("a change the store could not record is said in the run and marks it for review", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString() });
    let n = 0;
    w.deps.cstore.as = function () { return this; };
    Object.defineProperty(w.deps.cstore, "eventFailures", { get: () => n });
    w.deps.cstore.connections = async () => { n += 2; return [w.conn]; };
    const r = await w.run();
    expect(r.items).toContainEqual(expect.objectContaining({ action: "record", result: "not recorded", reason: "2 changes could not be added to the history" }));
    expect(r.needsReview).toBe(true);
  });
});

describe("the one engine agrees with every move Qualify & Submit makes (shadow must not cry wolf)", () => {
  // wrap the fake store so every stage change is judged by the engine, with the actor the real store would record
  const engineChecked = (w) => {
    const refused = [];
    // every judged move counts, so a flow where nothing was checked can never pass as "no refusals"
    Object.defineProperty(refused, "checked", { value: 0, writable: true, enumerable: false });
    const judge = (from, patch, after, cause) => {
      if (!patch.stage || patch.stage === from) return;
      const v = qualifyMove({ from: from ?? null, to: patch.stage, actor: cause.actor_type, agent: cause.actor_type === "agent" ? cause.actor_id : null, thread: after });
      refused.checked++;
      if (!v.ok) refused.push(`${from ?? "new"}>${patch.stage} by ${cause.actor_type}: ${v.reason}`);
    };
    const base = w.deps.cstore;
    const view = (cause) => ({
      ...base,
      as: (c) => view(c),
      openThread: async (row) => { const t = await base.openThread(row); judge(null, row, t, cause); return t; },
      updateThread: async (id, patch) => { const from = w.T.find((t) => t.id === id)?.stage; const t = await base.updateThread(id, patch); judge(from, patch, t, cause); return t; },
      updateThreadIf: async (id, stage, patch, match) => { const t = await base.updateThreadIf(id, stage, patch, match); if (t) judge(stage, patch, t, cause); return t; },
    });
    w.deps.cstore = view({ actor_type: "agent", actor_id: "outreach" });
    return refused;
  };
  const FULL = { name: { value: "Person 1" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/p1" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes, please go ahead", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [], ...over });

  it("open, confirm, the candidate's YES, submit: every move legal", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()] });
    const refused = engineChecked(w);
    await w.run();
    expect(w.T[0].stage).toBe("confirming");
    const t = w.T[0];
    await onQualifyReply(structuredClone(t), { body: "YES", from: t.email, ref: "email-yes", now: NOW }, { cstore: w.deps.cstore.as({ actor_type: "candidate", actor_id: t.email }), ownWords: (b) => b, fileAnswers: async () => [], cv: { put: async () => "x" } });
    expect(w.T[0].stage).toBe("ready");
    await w.run();
    expect(w.T[0].stage).toBe("submitted");
    expect(refused).toEqual([]);
    expect(refused.checked).toBeGreaterThan(0);
  });

  it("a new conversation, its reminder and its quiet close: every move legal", async () => {
    const w = world({ lastFull: null });
    const refused = engineChecked(w);
    await w.run();
    expect(w.T[0].stage).toBe("verify_sent");
    w.T[0].verify_sent_at = new Date(NOW - 49 * H).toISOString();
    w.conn.settings.last_full_at = new Date(NOW).toISOString();
    await w.run();
    expect(w.T[0].stage).toBe("reminded");
    w.T[0].verify_sent_at = new Date(NOW - 97 * H).toISOString();
    await w.run();
    expect(w.T[0].stage).toBe("closed");
    expect(refused).toEqual([]);
    expect(refused.checked).toBeGreaterThan(0);
  });

  it("a follow-up for missing details, and a close after it: every move legal", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ answers: { consent: "Yes", currentPay: "15 LPA" }, fields: { name: { value: "Person 1" } }, cv_path: null })] });
    const refused = engineChecked(w);
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "verify_sent", rounds: 2 });
    w.T[0].stage = "answered";
    await w.run();
    expect(w.T[0].stage).toBe("closed");
    expect(refused).toEqual([]);
    expect(refused.checked).toBeGreaterThan(0);
  });

  it("a fit below the bar is held, a person keeps them, the agent carries on; an approved close is legal, an unapproved one is not", async () => {
    const potential = async () => ({ fit: "potential", criteria: [{ ref: "c1", level: "partial", evidence_ids: ["e1"] }], evidence: [{ id: "e1", quote: "x" }] });
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()], evaluate: potential });
    Object.assign(w.deps.cstore, { candidacyReady: async () => true, propose: async (p) => ({ id: "p-1", ...p }), voidProposals: async () => 0, pendingProposals: async () => [{ thread_id: "t-1" }], recordEvent: async () => true });
    const refused = engineChecked(w);
    await w.run();
    expect(w.T[0].stage).toBe("held");
    // a person keeps them
    const person = w.deps.cstore.as({ actor_type: "person", actor_id: "workspace" });
    await person.updateThreadIf("t-1", "held", { stage: "answered", overrides: { keep: { fit: true } } }, {});
    await w.run();
    expect(w.T[0].stage).toBe("confirming");
    expect(refused).toEqual([]);
    expect(refused.checked).toBeGreaterThan(0);
    // the engine refuses a close on fit that no person approved
    expect(qualifyMove({ from: "answered", to: "closed", actor: "agent", agent: "outreach", thread: { close_reason: "fit is potential after their answers" } }).ok).toBe(false);
  });
});

describe("the run says what the engine thought, and enforce sends nothing it refuses", () => {
  it("a run that moved conversations reports the engine's check; a disagreement marks it for review", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [{ id: "t-9", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, verify_sent_at: new Date(NOW - 49 * H).toISOString(), stage: "verify_sent", questions: [], answers: {} }] });
    let moves = 0, refusals = 0;
    w.deps.cstore.as = function () { return this; };
    Object.defineProperty(w.deps.cstore, "engineMoves", { get: () => moves });
    Object.defineProperty(w.deps.cstore, "engineRefusals", { get: () => refusals });
    w.deps.cstore.engineMode = "shadow";
    w.deps.cstore.engineReasons = ["x cannot y"];
    const realIf = w.deps.cstore.updateThreadIf;
    w.deps.cstore.updateThreadIf = async (...a) => { moves++; return realIf(...a); };
    const ok = await w.run();
    expect(ok.items).toContainEqual(expect.objectContaining({ action: "engine", result: "agreed", reason: "1 move checked by the lifecycle engine (shadow)" }));
    expect(ok.needsReview).toBe(false);
    w.T[0].stage = "verify_sent"; w.T[0].verify_sent_at = new Date(NOW - 49 * H).toISOString();
    w.deps.cstore.updateThreadIf = async (...a) => { moves++; refusals++; return realIf(...a); };
    const bad = await w.run();
    expect(bad.items).toContainEqual(expect.objectContaining({ action: "engine", result: "disagreed", reason: expect.stringMatching(/^1 move the lifecycle engine would refuse \(shadow\): x cannot y/) }));
    expect(bad.needsReview).toBe(true);
  });

  it("enforce: the confirm email asks the engine first; a refused confirm is not sent", async () => {
    const FULL = { name: { value: "Person 1" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/p1" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [{ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes, please go ahead", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [] }] });
    w.deps.cstore.as = function () { return this; };
    w.deps.cstore.engineMode = "enforce";
    const asked = [];
    w.deps.cstore.mayMove = (t, to) => { asked.push(to); return to === "confirming" ? { ok: false, reason: "no" } : { ok: true }; };
    await w.run();
    expect(asked).toContain("confirming");
    expect(w.sent).toHaveLength(0);
  });

  it("enforce: when the engine refuses the move an email is for, nothing is sent", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [{ id: "t-9", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, verify_sent_at: new Date(NOW - 49 * H).toISOString(), stage: "verify_sent", questions: [], answers: {} }] });
    w.deps.cstore.as = function () { return this; };
    w.deps.cstore.engineMode = "enforce";
    w.deps.cstore.mayMove = () => ({ ok: false, reason: "not allowed in this test" });
    const r = await w.run();
    expect(w.sent).toHaveLength(0);
    expect(w.T[0].stage).toBe("verify_sent");
    expect(r.items).toContainEqual(expect.objectContaining({ result: "engine refused", reason: "qualify-reminder: not allowed in this test" }));
  });
});

describe("who is written to: the scorer's pass, never someone a person passed on", () => {
  const passed = { decision: "passed" };
  const first = (w) => w.T.map((t) => t.email);
  it("people the scorer passes (fit strong), exactly as before; never someone a person passed on", async () => {
    const w = world({ evals: [person(1, "strong"), person(2, "strong", { decision: passed }), person(3, "insufficient")], pools: [pool(1), pool(2), pool(3)] });
    await w.run();
    expect(first(w)).toEqual(["p1@x.com"]);
  });

  it("a stored audience or min_fit setting is ignored: the scorer is the bar", () => {
    expect(settingsOf({ settings: { audience: "approved", min_fit: "excellent" } })).toMatchObject({ min_fit: "strong" });
    expect(settingsOf({ settings: {} }).audience).toBeUndefined();
  });
});

describe("a person approves before anyone is put forward (each fails without its fix)", () => {
  const FULL = { name: { value: "Person 1" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/p1" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = (over = {}) => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes, please go ahead", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [], ...over });
  const potential = async () => ({ fit: "potential", criteria: [{ ref: "c1", level: "partial", evidence_ids: ["e1"] }], evidence: [{ id: "e1", quote: "Resolved billing tickets" }] });

  // a Strong score alone never puts anyone forward: a human approval is the final decision. A ready, consented
  // person is put forward only once the employer
  // approved them for the job; until then the thread waits, unchanged, and the run says why
  it("a strong fit nobody approved is never put forward; the thread waits and the run says why", async () => {
    const yes = { state: "GRANTED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x", confirm_hash: "h", confirmed_hash: "h", justification: "x" };
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ stage: "ready", consent: yes })] });
    w.deps.hire.decisionFor = async () => null;
    const r = await w.run();
    expect(w.submitted).toHaveLength(0);
    expect(w.T[0].stage).toBe("ready");
    expect(r.items).toContainEqual(expect.objectContaining({ action: "submit", reason: expect.stringMatching(/waiting for a person to approve them in the Inbox/) }));
  });

  it("a person passed on mid-conversation is closed honestly, never confirmed and never submitted", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()] });
    w.deps.hire.decisionFor = async () => ({ candidate_id: "c-1", decision: "passed" });
    await w.run();
    expect(w.T[0]).toMatchObject({ stage: "closed", close_reason: "a person chose not to put them forward for this role" });
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-closed"]);
    const yes = { state: "GRANTED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x", confirm_hash: "h", confirmed_hash: "h", justification: "x" };
    const r = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered({ stage: "ready", consent: yes })] });
    r.deps.hire.decisionFor = async () => ({ candidate_id: "c-1", decision: "passed" });
    await r.run();
    expect(r.submitted).toHaveLength(0);
    expect(r.T[0].stage).toBe("closed");
  });

  it("a person passed on is counted on the judge line, never silently dropped", async () => {
    const w = world({ evals: [person(1, "strong"), person(2, "strong", { decision: { decision: "passed" } })], pools: [pool(1), pool(2)] });
    const r = await w.run();
    expect(r.items).toContainEqual(expect.objectContaining({ action: "judge", reason: expect.stringMatching(/1 passed on by a person, never written to/) }));
  });
});

describe("the hand-off by email", () => {
  const FULL = { name: { value: "Person 1" }, emailId: { value: "p1@x.com" }, experience: { value: 3 }, linkedInUrl: { value: "https://www.linkedin.com/in/p1" }, currentCompany: { value: "Acme" }, currentLocation: { value: "Ajmer" }, phoneNo: { value: "9876543211" }, countryCode: { value: "+91" }, expectedCtc: { value: 5 }, noticePeriod: { value: "30" } };
  const answered = () => ({ id: "t-1", job_id: "job-1", candidate_id: "c-1", email: "p1@x.com", name: "Person 1", reply_key: "k", rounds: 1, stage: "answered", external_role_id: "1000101", fields: FULL, answers: { consent: "Yes, please go ahead", currentPay: "4 lakh fixed, no variable", workFrom: "Yes" }, cv_path: "t-1/cv.pdf", consent: { state: "REPLIED", company_shown: "Northwind Labs", wording_version: "qualify-verify-1", evidence: "reply:x" }, questions: [] });
  // the real email adapter and the real template; only the send and the store are in memory
  function emailWorld({ to = "hiring@northwind.example", org = "Acme Talent", send = null, mode = "live", type = "email" } = {}) {
    const w = world({ mode, evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()] });
    w.conn.destination = { type, to, name: "Meera Pillai" };
    w.deps.adapters.email = ADAPTERS.email;
    w.orgAsked = [];
    w.deps.cstore.orgName = async (id) => { w.orgAsked.push(id); return org; };
    w.conn.org_id = "acme-talent";
    w.deps.render.handoff = (a) => renderQualifyHandoff({ ...a, unsubUrl: "https://x/u" });
    if (send) { const base = w.deps.send; w.deps.send = async (x) => (x.template === "qualify-handoff" ? send(x, w) : base(x)); }
    return w;
  }
  const toYes = async (w) => { await w.run(); await reply(w); return w.run(); };

  it("on the YES, one pack to the hiring contact: the confirmed facts, the CV attached, from Charlie on behalf of the workspace", async () => {
    const w = emailWorld();
    const r = await toYes(w);
    const packs = w.sent.filter((s) => s.template === "qualify-handoff");
    expect(packs).toHaveLength(1);
    const [p] = packs;
    expect(p).toMatchObject({ email: "hiring@northwind.example", dedupeKey: "t-1:handoff", fromName: "Charlie on behalf of Acme Talent" });
    // the connection's own organisation; and the candidate's thread key never goes to the employer
    expect(w.orgAsked).toEqual(["acme-talent"]);
    expect(p.replyKey).toBeTruthy();
    expect(p.replyKey).not.toBe(w.T[0].reply_key);
    expect(p.attachments).toEqual([{ filename: "cv.pdf", content: Buffer.from(new Uint8Array([1])).toString("base64") }]);
    // exactly the lines the person said YES to; only the note's label speaks to the employer
    const facts = confirmFacts(w.T[0].fields, w.T[0].cv_path, w.T[0].consent.justification);
    for (const f of facts.slice(0, -1)) expect(p.mail.text).toContain(f);
    expect(p.mail.text).toContain(`About them: ${w.T[0].consent.justification}`);
    expect(p.mail.text).toMatch(/On behalf of Acme Talent, I am introducing Person 1 for the Support Engineer role at Northwind Labs/);
    expect(p.mail.text).toMatch(/please write to Person directly at p1@x\.com/);
    expect(w.T[0].stage).toBe("submitted");
    expect(w.S).toEqual([expect.objectContaining({ status: "sent", mode: "live", attempt: 1 })]);
    expect(r.counts.submitted).toBe(1);
    // to the person: the confirm before, the put-forward after, and nothing else
    expect(w.sent.filter((s) => s.email === "p1@x.com").map((s) => s.template)).toEqual(["qualify-confirm", "qualify-put-forward"]);
    w.T[0].stage = "ready";
    await w.run();
    expect(w.sent.filter((s) => s.template === "qualify-handoff")).toHaveLength(1);
  });

  it("a workspace that is Charlie itself is plainly Charlie, never 'on behalf of Charlie'", async () => {
    for (const org of ["Charlie", null]) {
      const w = emailWorld({ org });
      await toYes(w);
      const [p] = w.sent.filter((s) => s.template === "qualify-handoff");
      expect(p.fromName).toBe("Charlie");
      expect(p.mail.text).not.toMatch(/on behalf of/i);
    }
  });

  it.each([["missing", ""], ["not an address", "hiring at northwind"]])("a contact address %s: nothing is sent to anyone, and the person is never closed", async (_, to) => {
    const w = emailWorld({ to });
    await toYes(w);
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm"]);
    expect(w.T[0].stage).toBe("ready");
    expect(w.S).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it.each(["suppressed", "failed", "duplicate", undefined])("a send that comes back %s is not a hand-off: no put-forward, retried, then left for a person", async (status) => {
    const w = emailWorld({ send: async () => ({ status }) });
    await toYes(w);
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm"]);
    expect(w.T[0].stage).toBe("ready");
    await w.run(); await w.run();
    expect(w.T[0].stage).toBe("failed");
    expect(w.S.map((s) => s.status)).toEqual(["failed", "failed", "failed"]);
    expect(w.sent.filter((s) => s.template === "qualify-put-forward")).toHaveLength(0);
  });

  it("nothing goes to the employer that the person did not say YES to", async () => {
    const w = emailWorld();
    await w.run(); await reply(w);
    w.T[0].fields = { ...w.T[0].fields, expectedCtc: { value: 9 } };
    await w.run();
    expect(w.sent.filter((s) => s.template === "qualify-handoff")).toHaveLength(0);
    expect(w.T[0]).toMatchObject({ stage: "failed", last_error: expect.stringMatching(/not what they confirmed/) });
  });

  it("in shadow, it only says it would submit", async () => {
    const w = emailWorld({ mode: "shadow" });
    w.T[0].stage = "ready";
    const r = await w.run();
    expect(w.sent).toHaveLength(0);
    expect(r.items).toContainEqual(expect.objectContaining({ action: "submit", result: "shadow", reason: "would submit" }));
  });

  it("a destination with no adapter submits nothing and says so; the person stays ready", async () => {
    const w = emailWorld({ type: "fax" });
    const r = await toYes(w);
    expect(r.items).toContainEqual(expect.objectContaining({ action: "submit", result: "not submitted", reason: "no destination for fax" }));
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm"]);
    expect(w.S).toHaveLength(0);
    expect(w.T[0].stage).toBe("ready");
  });

  it("an empty destination type hands off to the source, as a missing one does", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()] });
    w.conn.destination = { type: "", via: "Pieworks" };
    await toYes(w);
    expect(w.submitted).toHaveLength(1);
  });

  it("Pieworks still hands off to Pieworks: its own submit, no email pack", async () => {
    const w = world({ evals: [], lastFull: new Date(NOW).toISOString(), threads: [answered()] });
    w.deps.adapters.email = { submit: async () => { throw new Error("the email destination must not be used"); } };
    await toYes(w);
    expect(w.submitted).toHaveLength(1);
    expect(w.sent.map((s) => s.template)).toEqual(["qualify-confirm", "qualify-put-forward"]);
  });
});
