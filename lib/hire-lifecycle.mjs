// lib/hire-lifecycle.mjs — the candidate lifecycle for one person and one job (a "pursuit").
// Pure code, no schema, no imports. It CONSUMES the Hiring Decision Contract's assessment (eligibility,
// disposition, open gaps, the employer's review) and never writes it: a reply can add a fact, only the
// gate decides eligibility. Lifecycle state is never a substitute for the contract.
//
// Kept apart on purpose, never folded into one status:
//   assessment   (input, read only)  eligibility_status · disposition · open · employer_review
//   engagement   has Charlie reached the person, and what have they said about THIS job
//   permissions  contact (live basis) · screening consent · employer-disclosure consent (job + employer)
//   screening    are the material unknowns resolved (never "failed": a failed fact is the contract's)
//   handoff      has an employer-ready person been handed over
// The stage a human reads and the next action are derived (stageOf), never stored.
//
// Every change is an event through transition(): it checks the from-state, the actor, the job, then
// the guard, and appends a record (who, what, when, from, to, the message or question that caused it).
// Pursuits come back frozen, so `pursuit.engagement = "INTERESTED"` throws instead of quietly working.

const H = 3_600_000;

export const LIFECYCLE_VERSION = "lifecycle-2026-10-05.1";
export const SOURCES = ["pool", "sourced"]; // where a person came from (the pool, or found outside it), never a separate kind of candidate
export const ENGAGEMENT = ["NOT_CONTACTED", "AWAITING_REPLY", "INTERESTED", "NOT_INTERESTED", "NO_RESPONSE", "UNREACHABLE", "WITHDREW", "OPTED_OUT"];
export const CONSENT = ["NOT_REQUESTED", "REQUESTED", "GRANTED", "DENIED", "WITHDRAWN"];
export const SCREENING = ["NOT_REQUIRED", "REQUIRED", "REQUESTED", "IN_PROGRESS", "INCOMPLETE", "COMPLETED", "EXPIRED"];
export const HANDOFF = ["NOT_HANDED_OFF", "HANDED_OFF", "EMPLOYER_PROGRESSING", "EMPLOYER_DECLINED", "RECALLED"];
export const EMPLOYER_REVIEW = ["NONE", "SHORTLISTED", "PASSED", "RESCUED"];

// What Charlie can be waiting for. Every open question has one of these, a due time, an owner and a
// follow-up policy; "awaiting a reply" with no question behind it cannot be represented.
export const ASKS = {
  INTEREST: { owner: "candidate", on_give_up: "NO_RESPONSE" },
  CV: { owner: "candidate", on_give_up: "NO_RESPONSE" },
  SCREENING_CONSENT: { owner: "candidate", on_give_up: "NO_RESPONSE" },
  DISCLOSURE_CONSENT: { owner: "candidate", on_give_up: "NO_RESPONSE" },
  SCREENING_ANSWER: { owner: "candidate", on_give_up: "SCREENING_EXPIRED" },
  CALL: { owner: "candidate", on_give_up: "SCREENING_EXPIRED" },
  EMPLOYER_FEEDBACK: { owner: "employer", on_give_up: "OVERDUE" },
};

// Defaults: a reminder after 48 hours, give up 48 hours after that, a call link valid for 14 days.
// Cold outreach is HELD: only an explicit cold_outreach: "allowed" lifts it.
export const DEFAULT_POLICY = Object.freeze({ follow_up_hours: 48, give_up_hours: 48, max_follow_ups: 1, call_link_hours: 14 * 24, employer_feedback_hours: 7 * 24, max_screening_rounds: 2, cold_outreach: "held" });

export const DIMENSIONS = {
  engagement: { values: ENGAGEMENT, read: (p) => p.engagement },
  screening_consent: { values: CONSENT, read: (p) => p.screening_consent.state },
  disclosure: { values: CONSENT, read: (p) => p.disclosure.state },
  screening: { values: SCREENING, read: (p) => p.screening.state },
  handoff: { values: HANDOFF, read: (p) => p.handoff },
  ask: { values: ["NONE", ...Object.keys(ASKS)], read: (p) => p.ask?.kind ?? "NONE" },
  to_read: { values: ["NONE", "SET"], read: (p) => (p.to_read ? "SET" : "NONE") },
  closed_out: { values: ["NO", "YES"], read: (p) => (p.closed_out ? "YES" : "NO") },
};

const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};
const policyOf = (ctx) => ({ ...DEFAULT_POLICY, ...(ctx?.policy ?? {}) });
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
const snap = (p) => ({ engagement: p.engagement, screening_consent: p.screening_consent.state, disclosure: p.disclosure.state, screening: p.screening.state, handoff: p.handoff, ask: p.ask ? p.ask.kind : null, to_read: !!p.to_read });

// ── the contract's output, read only ─────────────────────────────────────────────────────────────
const JUDGED = ["ELIGIBLE", "NO_CONSTRAINTS", "NEEDS_VERIFICATION", "INELIGIBLE", "EXCLUDED_BY_POLICY"];
const NOT_YET = ["RANK_CUT", "PROCESSING_ERROR", "ENRICHMENT_PENDING"];

// Anything missing or unrecognised reads as "not judged": the lifecycle fails closed, never open.
export function assessmentView(a) {
  if (!a || typeof a !== "object") return { judged: false, why: "no assessment" };
  const review = a.employer_review ?? "NONE";
  if (!EMPLOYER_REVIEW.includes(review)) return { judged: false, why: `unknown employer review ${review}` };
  if (NOT_YET.includes(a.disposition) || !JUDGED.includes(a.eligibility_status)) return { judged: false, why: a.disposition ?? a.eligibility_status ?? "unknown" };
  const rescued = review === "RESCUED";
  return {
    judged: true,
    rescued,
    passed: review === "PASSED",
    unsuitable: review === "PASSED" || (!rescued && ["INELIGIBLE", "EXCLUDED_BY_POLICY"].includes(a.eligibility_status)),
    eligible: rescued || ["ELIGIBLE", "NO_CONSTRAINTS"].includes(a.eligibility_status),
    supported: rescued || a.disposition === "EVIDENCE_SUPPORTED",
    open: Array.isArray(a.open) ? a.open : null,
  };
}

// ── pursuit ──────────────────────────────────────────────────────────────────────────────────────
export function createPursuit({ id, job, person, source, source_at = null, discovery_run = null, open_gaps, at }) {
  if (!id || !job?.id || !job?.employer_id || !person?.id) throw new Error("createPursuit: id, job.id, job.employer_id and person.id are required");
  if (!SOURCES.includes(source)) throw new Error(`createPursuit: unknown source ${source}`);
  if (!Array.isArray(open_gaps)) throw new Error("createPursuit: open_gaps from the assessment is required");
  if (!Number.isFinite(at)) throw new Error("createPursuit: needs a time");
  return deepFreeze({
    id, job_id: job.id, employer_id: job.employer_id, person_id: person.id,
    source, source_at, discovery_run,
    outreach_type: source === "pool" ? "warm" : "cold",
    contact: { state: "NONE", basis: null }, // the basis actually used is set when Charlie first writes
    engagement: "NOT_CONTACTED",
    screening_consent: { state: "NOT_REQUESTED" },
    disclosure: { state: "NOT_REQUESTED" },
    screening: { state: open_gaps.length ? "REQUIRED" : "NOT_REQUIRED", gaps: [...open_gaps], rounds: 0 },
    handoff: "NOT_HANDED_OFF",
    ask: null, keys: [], sent_to: null, to_read: null, closed_out: false,
    version: LIFECYCLE_VERSION,
    history: [{ type: "pursuit.created", actor: "charlie", at, pursuit_id: id, job_id: job.id, employer_id: job.employer_id, ref: discovery_run, from: null, to: null, effects: [], version: LIFECYCLE_VERSION }],
  });
}

// May Charlie write to this person about this job right now? Read live, every time.
export function contactability(p, ctx) {
  const no = (why) => ({ ok: false, why });
  const job = ctx?.job, person = ctx?.person ?? {};
  if (p.engagement === "OPTED_OUT" || p.contact.state === "WITHDRAWN") return no("opted out");
  if (person.suppressed) return no("address is suppressed");
  if (!person.email) return no("no address");
  if (job?.lifecycle !== "active") return no(`job is ${job?.lifecycle ?? "unknown"}`);
  if (p.source === "pool") return person.consent_pool === true ? { ok: true, basis: "pool_consent" } : no("no permission to contact");
  if (p.outreach_type === "cold") {
    if (policyOf(ctx).cold_outreach !== "allowed") return no("cold outreach is on hold");
    if (job.cold_outreach !== true) return no("this job has not enabled cold outreach");
    return { ok: true, basis: "cold_policy" };
  }
  return no("no permission to contact");
}

// The one handoff guard. Rescue (the employer's call) overrides eligibility and evidence; nothing
// overrides interest, the job, or THIS job's and THIS employer's disclosure consent.
export function handoffReadiness(p, ctx) {
  const missing = [];
  const a = assessmentView(ctx?.assessment);
  if (ctx?.job?.id !== p.job_id || ctx?.job?.employer_id !== p.employer_id) missing.push("context is for another job");
  if (ctx?.job?.lifecycle !== "active") missing.push("job is not active");
  if (p.engagement !== "INTERESTED") missing.push("not interested");
  const d = p.disclosure;
  if (d.state !== "GRANTED") missing.push("no consent to be introduced to this employer");
  else if (d.job_id !== p.job_id || d.employer_id !== p.employer_id || !same(d.company_shown, ctx?.job?.company)) missing.push("consent names a different job or employer");
  else if (!d.evidence || !d.wording_version) missing.push("consent has no recorded evidence");
  if (["DENIED", "WITHDRAWN"].includes(p.screening_consent.state)) missing.push("screening consent refused");
  const s = p.screening.state;
  const screened = ["COMPLETED", "NOT_REQUIRED"].includes(s) || (a.rescued && ["INCOMPLETE", "EXPIRED"].includes(s));
  if (!screened) missing.push("screening not done");
  if (!a.judged) missing.push(`not assessed (${a.why})`);
  else {
    if (a.passed) missing.push("employer passed");
    if (!a.eligible) missing.push("not eligible");
    if (!a.supported) missing.push("evidence not supported");
    if (!a.rescued && (a.open === null || a.open.length)) missing.push(a.open === null ? "open gaps unknown" : "open gaps remain");
  }
  if (p.ask) missing.push(`waiting on ${p.ask.kind}`);
  if (p.to_read) missing.push("a reply is unread");
  if (p.handoff !== "NOT_HANDED_OFF") missing.push("already handed off");
  return { ready: missing.length === 0, missing };
}

// ── transitions ──────────────────────────────────────────────────────────────────────────────────
const CANDIDATE = ["candidate", "operator"]; // an operator may only record what a real, unread reply said
const SENDER = ["charlie", "operator"];

function openAsk(p, kind, e, ctx, hours) {
  const pol = policyOf(ctx);
  p.ask = { id: e.ask_id, kind, waiting_for: kind, owner: ASKS[kind].owner, opened_at: e.at, due_at: e.at + (hours ?? pol.follow_up_hours) * H, follow_ups: 0, max_follow_ups: pol.max_follow_ups, give_up_hours: pol.give_up_hours };
  p.keys = [...p.keys, e.ask_id];
}
const newAsk = (p, e) => (typeof e.ask_id !== "string" || !e.ask_id ? "needs a question id" : p.keys.includes(e.ask_id) ? "question id already used" : p.ask ? `already waiting on ${p.ask.kind}` : null);
const answers = (kind) => (p, e) => (p.ask?.kind === kind && e.ask_id === p.ask.id ? null : "this is not the open question");
const ownKey = (p, e) => (p.keys.includes(e.ask_id) ? null : "not a reply to any question in this pursuit");
const interested = (p) => (p.engagement !== "INTERESTED" ? "only an interested person is asked" : p.handoff !== "NOT_HANDED_OFF" ? "already with the employer: nothing new is asked" : null);
const answered = (gaps, raw) => gaps.filter((g) => typeof raw?.[g] === "string" && raw[g].trim());
const all = (...gs) => (p, e, c) => { for (const g of gs) { const w = g(p, e, c); if (w) return w; } return null; };

function revertRequested(p, kind) {
  if (kind === "SCREENING_CONSENT" && p.screening_consent.state === "REQUESTED") p.screening_consent = { state: "NOT_REQUESTED" };
  if (kind === "DISCLOSURE_CONSENT" && p.disclosure.state === "REQUESTED") p.disclosure = { state: "NOT_REQUESTED" };
}
// An open question closed without an answer (bounce, opt-out, close-out) releases what it held, so
// nothing is left "requested" with no question behind it. A wait on the EMPLOYER survives anything the
// candidate's mailbox does; only `any` (opt-out, the employer answering) ends it.
function abandonAsk(p, any = false) {
  if (!p.ask || (p.ask.owner === "employer" && !any)) return;
  const kind = p.ask.kind;
  revertRequested(p, kind);
  if (["SCREENING_ANSWER", "CALL"].includes(kind) && ["REQUESTED", "IN_PROGRESS"].includes(p.screening.state)) p.screening = { ...p.screening, state: "INCOMPLETE" };
  p.ask = null;
}
function recall(p, fx) {
  if (["HANDED_OFF", "EMPLOYER_PROGRESSING"].includes(p.handoff)) { p.handoff = "RECALLED"; abandonAsk(p, true); fx.push("tell_employer:withdrawn"); }
}
function finishScreening(p, e) {
  const got = answered(p.screening.gaps, e.answers);
  const left = p.screening.gaps.filter((g) => !got.includes(g));
  p.screening = { ...p.screening, state: left.length ? "INCOMPLETE" : "COMPLETED", gaps: left };
  p.ask = null;
}

// dim + from: the only states the event may start from (anything else is illegal). `to` is the
// matrix's description. sends: refused unless the job is active. after_opt_out: still recorded.
export const RULES = {
  "outreach.sent": {
    dim: "engagement", from: ["NOT_CONTACTED"], to: "AWAITING_REPLY (waiting for INTEREST)", actors: SENDER, sends: true,
    guard: all(newAsk, (p) => (p.handoff === "NOT_HANDED_OFF" ? null : "already with the employer"), (p, e, c) => { const k = contactability(p, c); return k.ok ? null : k.why; }, (p, e, c) => { const a = assessmentView(c.assessment); return !a.judged ? `not assessed (${a.why})` : a.unsuitable ? "not suitable for this job" : null; }, (p, e) => (e.sent_to ? null : "needs the address written to")),
    apply: (p, e, c, fx) => { const k = contactability(p, c); p.engagement = "AWAITING_REPLY"; p.sent_to = e.sent_to; p.contact = { state: k.basis === "pool_consent" ? "PERMITTED" : "COLD", basis: k.basis }; openAsk(p, "INTEREST", e, c); fx.push("send:outreach"); },
  },
  "candidate.interested": {
    dim: "engagement", from: ["AWAITING_REPLY", "NO_RESPONSE", "NOT_INTERESTED", "WITHDREW"], to: "INTERESTED", actors: CANDIDATE, candidate: true,
    guard: (p, e) => (p.engagement === "AWAITING_REPLY" ? answers("INTEREST")(p, e) : ownKey(p, e)),
    apply: (p) => { p.engagement = "INTERESTED"; p.ask = null; },
  },
  "candidate.declined": {
    dim: "engagement", from: ["AWAITING_REPLY", "NO_RESPONSE", "INTERESTED"], to: "NOT_INTERESTED, or WITHDREW if they had said yes", actors: CANDIDATE, candidate: true,
    guard: (p, e) => (p.engagement === "AWAITING_REPLY" ? answers("INTEREST")(p, e) : ownKey(p, e)),
    apply: (p, e, c, fx) => {
      if (p.engagement === "INTERESTED") {
        p.engagement = "WITHDREW";
        for (const k of ["screening_consent", "disclosure"]) p[k] = { ...p[k], state: p[k].state === "GRANTED" ? "WITHDRAWN" : p[k].state === "REQUESTED" ? "DENIED" : p[k].state };
        recall(p, fx);
      } else p.engagement = "NOT_INTERESTED";
      abandonAsk(p);
      fx.push("send:close_out_ack", "move_up_next_ranked");
    },
  },
  "candidate.opted_out": {
    dim: "engagement", from: ENGAGEMENT.filter((s) => s !== "OPTED_OUT"), to: "OPTED_OUT (every job: see optOutEverywhere)", actors: [...CANDIDATE, "system"], candidate: true,
    apply: (p, e, c, fx) => {
      abandonAsk(p, true); p.engagement = "OPTED_OUT"; p.contact = { ...p.contact, state: "WITHDRAWN" };
      for (const k of ["screening_consent", "disclosure"]) if (p[k].state === "GRANTED") p[k] = { ...p[k], state: "WITHDRAWN" };
      recall(p, fx);
      fx.push("suppress_address");
    },
  },
  "send.bounced": { dim: "engagement", from: ["AWAITING_REPLY", "INTERESTED", "NO_RESPONSE"], to: "UNREACHABLE", actors: ["system"], apply: (p, e, c, fx) => { abandonAsk(p); p.engagement = "UNREACHABLE"; fx.push("move_up_next_ranked"); } },
  "address.missing": { dim: "engagement", from: ["NOT_CONTACTED"], to: "UNREACHABLE", actors: ["system", "operator"], apply: (p) => { p.engagement = "UNREACHABLE"; } },
  "address.updated": { dim: "engagement", from: ["UNREACHABLE"], to: "NOT_CONTACTED", actors: ["operator"], apply: (p) => { p.engagement = "NOT_CONTACTED"; } },

  "reply.unclear": { dim: null, to: "flags a reply for a person to read", actors: ["system"], after_opt_out: true, guard: (p, e) => (e.ref ? null : "needs the message"), apply: (p, e) => { p.to_read = { ref: e.ref, ask_id: e.ask_id ?? null, at: e.at }; } },
  "reply.read": { dim: "to_read", from: ["SET"], to: "clears the flag, nothing else changes", actors: ["operator"], after_opt_out: true, apply: (p) => { p.to_read = null; } },

  "cv.requested": { dim: "ask", from: ["NONE"], to: "waiting for CV", actors: SENDER, sends: true, guard: all(interested, newAsk), apply: (p, e, c, fx) => { openAsk(p, "CV", e, c); fx.push("send:ask_cv"); } },
  "cv.received": { dim: "ask", from: ["CV"], to: "question closed (the gate re-reads the CV)", actors: CANDIDATE, candidate: true, guard: answers("CV"), apply: (p, e, c, fx) => { p.ask = null; fx.push("regate"); } },

  "screening_consent.requested": {
    dim: "screening_consent", from: ["NOT_REQUESTED"], to: "REQUESTED", actors: SENDER, sends: true,
    guard: all(interested, newAsk, (p) => (["REQUIRED", "INCOMPLETE"].includes(p.screening.state) ? null : "nothing to screen"), (p, e) => (e.wording_version ? null : "the wording shown must be recorded")),
    apply: (p, e, c, fx) => { p.screening_consent = { state: "REQUESTED", wording_version: e.wording_version, requested_at: e.at }; openAsk(p, "SCREENING_CONSENT", e, c); fx.push("send:ask_screening_consent"); },
  },
  "screening_consent.granted": { dim: "screening_consent", from: ["REQUESTED"], to: "GRANTED", actors: CANDIDATE, candidate: true, guard: all(answers("SCREENING_CONSENT"), (p, e) => (e.ref ? null : "needs the message that said yes")), apply: (p, e) => { p.screening_consent = { ...p.screening_consent, state: "GRANTED", granted_at: e.at, evidence: e.ref }; p.ask = null; } },
  "screening_consent.denied": { dim: "screening_consent", from: ["REQUESTED"], to: "DENIED", actors: CANDIDATE, candidate: true, guard: answers("SCREENING_CONSENT"), apply: (p, e, c, fx) => { p.screening_consent = { ...p.screening_consent, state: "DENIED", denied_at: e.at }; p.ask = null; fx.push("send:close_out_ack"); } },
  "screening_consent.withdrawn": {
    dim: "screening_consent", from: ["GRANTED"], to: "WITHDRAWN (screening in flight stops)", actors: CANDIDATE, candidate: true, guard: ownKey,
    apply: (p, e) => {
      p.screening_consent = { ...p.screening_consent, state: "WITHDRAWN", withdrawn_at: e.at };
      if (["REQUESTED", "IN_PROGRESS"].includes(p.screening.state)) { p.screening = { ...p.screening, state: "INCOMPLETE" }; p.ask = null; }
    },
  },

  "disclosure.requested": {
    dim: "disclosure", from: ["NOT_REQUESTED"], to: "REQUESTED (job, employer, company and wording recorded)", actors: SENDER, sends: true,
    guard: all(interested, newAsk, (p, e, c) => (e.job_id === p.job_id && e.employer_id === p.employer_id ? null : "consent must name this job and this employer"), (p, e, c) => (same(e.company_shown, c.job.company) ? null : "the email must name the company"), (p, e) => (e.wording_version ? null : "the wording shown must be recorded")),
    apply: (p, e, c, fx) => { p.disclosure = { state: "REQUESTED", job_id: e.job_id, employer_id: e.employer_id, company_shown: e.company_shown, wording_version: e.wording_version, requested_at: e.at, request_ref: e.ask_id }; openAsk(p, "DISCLOSURE_CONSENT", e, c); fx.push("send:ask_disclosure_consent"); },
  },
  "disclosure.granted": { dim: "disclosure", from: ["REQUESTED"], to: "GRANTED (evidence = their message)", actors: CANDIDATE, candidate: true, guard: all(answers("DISCLOSURE_CONSENT"), (p, e) => (e.ref ? null : "needs the message that said yes")), apply: (p, e) => { p.disclosure = { ...p.disclosure, state: "GRANTED", granted_at: e.at, evidence: e.ref, source: e.source ?? "reply" }; p.ask = null; } },
  "disclosure.denied": { dim: "disclosure", from: ["REQUESTED"], to: "DENIED", actors: CANDIDATE, candidate: true, guard: answers("DISCLOSURE_CONSENT"), apply: (p, e, c, fx) => { p.disclosure = { ...p.disclosure, state: "DENIED", denied_at: e.at }; p.ask = null; fx.push("send:close_out_ack"); } },
  "disclosure.withdrawn": { dim: "disclosure", from: ["GRANTED"], to: "WITHDRAWN (a handoff is recalled)", actors: CANDIDATE, candidate: true, guard: ownKey, apply: (p, e, c, fx) => { p.disclosure = { ...p.disclosure, state: "WITHDRAWN", withdrawn_at: e.at }; recall(p, fx); } },

  "gate.recomputed": {
    dim: null, to: "screening REQUIRED / NOT_REQUIRED / COMPLETED from the contract's open gaps", actors: ["charlie"], after_opt_out: true,
    guard: (p, e) => (Array.isArray(e.open_gaps) ? null : "needs the contract's open gaps"),
    apply: (p, e) => {
      const s = p.screening, gaps = [...e.open_gaps];
      if (["REQUESTED", "IN_PROGRESS"].includes(s.state)) p.screening = { ...s, gaps };
      else if (!gaps.length) p.screening = { ...s, state: s.rounds > 0 || s.state === "COMPLETED" ? "COMPLETED" : "NOT_REQUIRED", gaps };
      else p.screening = { ...s, state: ["INCOMPLETE", "EXPIRED"].includes(s.state) ? s.state : "REQUIRED", gaps };
    },
  },
  "screening.sent": {
    dim: "screening", from: ["REQUIRED", "INCOMPLETE"], to: "REQUESTED (waiting for SCREENING_ANSWER or CALL)", actors: SENDER, sends: true,
    guard: all(interested, newAsk, (p) => (p.screening_consent.state === "GRANTED" ? null : "no permission to screen"), (p, e, c) => (p.screening.rounds < policyOf(c).max_screening_rounds ? null : "screening already asked the most times allowed"), (p, e) => (["questions", "call"].includes(e.mode) ? null : "mode is questions or call"), (p, e) => (Array.isArray(e.gaps) && e.gaps.length && e.gaps.every((g) => p.screening.gaps.includes(g)) ? null : "asks only the gaps still open")),
    apply: (p, e, c, fx) => { p.screening = { ...p.screening, state: "REQUESTED", rounds: p.screening.rounds + 1, asked: [...e.gaps] }; openAsk(p, e.mode === "call" ? "CALL" : "SCREENING_ANSWER", e, c, e.mode === "call" ? policyOf(c).call_link_hours : undefined); fx.push(`send:screening_${e.mode}`); },
  },
  "screening.answered": { dim: "screening", from: ["REQUESTED"], to: "COMPLETED, or INCOMPLETE if any gap has no answer", actors: CANDIDATE, candidate: true, guard: answers("SCREENING_ANSWER"), apply: (p, e, c, fx) => { finishScreening(p, e); fx.push("regate"); } },
  "call.started": { dim: "screening", from: ["REQUESTED"], to: "IN_PROGRESS", actors: ["system"], guard: answers("CALL"), apply: (p) => { p.screening = { ...p.screening, state: "IN_PROGRESS" }; } },
  "call.completed": { dim: "screening", from: ["IN_PROGRESS"], to: "COMPLETED, or INCOMPLETE if any gap has no answer", actors: ["system"], guard: answers("CALL"), apply: (p, e, c, fx) => { finishScreening(p, e); fx.push("regate"); } },
  "call.abandoned": { dim: "screening", from: ["REQUESTED", "IN_PROGRESS"], to: "INCOMPLETE (declined, unreachable or dropped call)", actors: ["system"], guard: answers("CALL"), apply: (p) => { p.screening = { ...p.screening, state: "INCOMPLETE" }; p.ask = null; } },

  "time.tick": {
    dim: null, to: "follow up once, then give up (NO_RESPONSE, screening EXPIRED, or employer overdue)", actors: ["system", "agent"], sends: true,
    guard: (p, e) => (!p.ask ? "nothing is waiting" : !Number.isFinite(p.ask.due_at) ? "already overdue" : e.at < p.ask.due_at ? "not due" : null),
    apply: (p, e, c, fx) => {
      const a = p.ask;
      if (a.follow_ups < a.max_follow_ups) { p.ask = { ...a, follow_ups: a.follow_ups + 1, due_at: e.at + a.give_up_hours * H }; fx.push(a.owner === "employer" ? "nudge_employer" : "send:follow_up"); return; }
      const end = ASKS[a.kind].on_give_up;
      if (end === "NO_RESPONSE") { p.engagement = "NO_RESPONSE"; revertRequested(p, a.kind); p.ask = null; fx.push("move_up_next_ranked"); }
      else if (end === "SCREENING_EXPIRED") { p.screening = { ...p.screening, state: p.screening.state === "IN_PROGRESS" ? "INCOMPLETE" : "EXPIRED" }; p.ask = null; }
      else { p.ask = { ...a, due_at: null, overdue: true }; fx.push("flag_employer_overdue"); }
    },
  },

  "handoff.sent": {
    dim: "handoff", from: ["NOT_HANDED_OFF"], to: "HANDED_OFF (waiting for EMPLOYER_FEEDBACK)", actors: ["operator"], sends: true,
    guard: (p, e, c) => { const r = handoffReadiness(p, c); return r.ready ? (typeof e.ask_id === "string" && !p.keys.includes(e.ask_id) ? null : "needs a new question id") : `not employer-ready: ${r.missing.join("; ")}`; },
    apply: (p, e, c, fx) => { p.handoff = "HANDED_OFF"; openAsk(p, "EMPLOYER_FEEDBACK", e, c, policyOf(c).employer_feedback_hours); fx.push("send:employer_pack"); },
  },
  "employer.progressing": { dim: "handoff", from: ["HANDED_OFF"], to: "EMPLOYER_PROGRESSING (Charlie stops here)", actors: ["employer", "operator"], apply: (p) => { p.handoff = "EMPLOYER_PROGRESSING"; abandonAsk(p, true); } },
  "employer.declined": { dim: "handoff", from: ["HANDED_OFF", "EMPLOYER_PROGRESSING"], to: "EMPLOYER_DECLINED", actors: ["employer", "operator"], apply: (p) => { p.handoff = "EMPLOYER_DECLINED"; abandonAsk(p, true); } },

  "closeout.sent": {
    dim: "closed_out", from: ["NO"], to: "closed out (the honest last word, once)", actors: SENDER, sends: true, any_job_state: true,
    guard: (p) => (p.sent_to ? null : "never contacted"),
    apply: (p, e, c, fx) => { abandonAsk(p); p.closed_out = true; fx.push("send:close_out"); },
  },
};

export function transition(p, e, ctx) {
  const refuse = (reason) => ({ ok: false, reason });
  const rule = RULES[e?.type];
  if (!rule) return refuse(`unknown event ${e?.type}`);
  if (!Number.isFinite(e.at)) return refuse("event needs a time");
  if (!ctx?.job) return refuse("needs the job");
  if (ctx.job.id !== p.job_id || ctx.job.employer_id !== p.employer_id) return refuse("context is for another job");
  if (!rule.actors.includes(e.actor)) return refuse(`${e.actor} cannot cause ${e.type}`);
  if (e.actor === "agent" && !AGENT_SCOPES[e.agent]?.includes(e.type)) return refuse(`agent ${e.agent ?? "unknown"} may not cause ${e.type}`);
  if (p.engagement === "OPTED_OUT" && !rule.after_opt_out) return refuse("opted out: nothing moves");
  if (rule.dim) {
    const cur = DIMENSIONS[rule.dim].read(p);
    if (!rule.from.includes(cur)) return refuse(`illegal: ${e.type} from ${rule.dim} ${cur}`);
  }
  if (rule.sends && !rule.any_job_state && ctx.job.lifecycle !== "active") return refuse(`job is ${ctx.job.lifecycle ?? "unknown"}: nothing is sent and waits are frozen`);
  if (rule.candidate && e.actor === "operator" && (!p.to_read || e.ref !== p.to_read.ref)) return refuse("an operator can only record what an unread reply said");
  const why = rule.guard?.(p, e, ctx);
  if (why) return refuse(why);
  const next = structuredClone(p);
  const effects = [];
  rule.apply(next, e, ctx, effects);
  if (rule.candidate && e.actor === "operator") next.to_read = null;
  const record = { type: e.type, actor: e.actor, at: e.at, pursuit_id: p.id, job_id: p.job_id, employer_id: p.employer_id, ref: e.ref ?? e.ask_id ?? null, from: snap(p), to: snap(next), effects, version: LIFECYCLE_VERSION };
  next.history = [...p.history, record];
  return { ok: true, pursuit: deepFreeze(next), record };
}

// An opt-out is about the person, not one job: every pursuit stops.
export function optOutEverywhere(pursuits, e, ctxOf) {
  return pursuits.map((p) => {
    if (p.engagement === "OPTED_OUT") return p;
    const r = transition(p, e, ctxOf(p));
    if (!r.ok) throw new Error(`opt-out refused for ${p.id}: ${r.reason}`); // never silently leave one contactable
    return r.pursuit;
  });
}

// Which pursuit does an inbound reply belong to? By the reply key Charlie minted per question; with
// no key, only when exactly one question is open to that address. Never "the latest ask".
export function routeReply({ key, from, pursuits }) {
  if (key) {
    const p = pursuits.find((x) => x.keys.includes(key));
    if (!p) return { to_read: true, reason: "unknown reply key" };
    if (!same(from, p.sent_to)) return { to_read: true, pursuit_id: p.id, reason: "sender does not match the address written to" };
    return { pursuit_id: p.id, ask_id: p.ask?.id === key ? key : null, basis: "reply_key" };
  }
  const open = pursuits.filter((x) => same(from, x.sent_to) && x.ask && ASKS[x.ask.kind].owner === "candidate");
  if (open.length === 1) return { pursuit_id: open[0].id, ask_id: open[0].ask.id, basis: "only_open_question" };
  return { to_read: true, reason: open.length ? "more than one open question" : "no open question", candidates: open.map((x) => x.id) };
}

// ── derived: where they are, why, what Charlie waits for, what happens next ─────────────────────
const LABEL = { INTEREST: "Waiting for reply", CV: "Waiting for CV", SCREENING_CONSENT: "Consent requested", DISCLOSURE_CONSENT: "Consent requested", SCREENING_ANSWER: "Screening", CALL: "Screening" };
const CLOSED = { NOT_INTERESTED: "Closed: not interested", WITHDREW: "Closed: withdrew", NO_RESPONSE: "Closed: no response", UNREACHABLE: "Can't reach" };

export function stageOf(p, ctx) {
  const out = (stage, next_action, owner = null, extra = {}) => ({ stage, next_action, owner, waiting_for: null, due_at: null, ...extra });
  const a = assessmentView(ctx?.assessment);
  const company = ctx?.job?.company ?? "the company";
  const pol = policyOf(ctx);

  if (p.engagement === "OPTED_OUT") return out("Opted out", p.to_read ? "Read their reply; write back only if they ask to return" : "Nothing, in any job", p.to_read ? "operator" : null);
  if (p.to_read) return out("Reply to read", "Read the reply and record what it says", "operator");
  if (ctx?.job?.lifecycle !== "active") {
    const closed = ctx?.job?.lifecycle === "closed";
    const owe = closed && p.sent_to && !p.closed_out && !["NOT_INTERESTED", "WITHDREW", "NO_RESPONSE", "UNREACHABLE"].includes(p.engagement) && !["EMPLOYER_PROGRESSING"].includes(p.handoff);
    return out(closed ? "Job closed" : "Job on hold", owe ? "Send the honest close-out, once" : "Nothing new until the job reopens", owe ? "charlie" : "employer");
  }
  if (p.handoff === "EMPLOYER_PROGRESSING") return out("With employer: progressing", "Nothing; the employer's process takes it from here", "employer");
  if (p.handoff === "EMPLOYER_DECLINED") return out("Employer declined", p.closed_out ? "Nothing" : "Tell them honestly, once", p.closed_out ? null : "charlie");
  if (p.handoff === "RECALLED") return out("Withdrew after introduction", "Nothing; the employer was told", null);
  if (p.handoff === "HANDED_OFF") return out("With employer", p.ask?.overdue ? "Employer feedback is overdue; ask the operator to chase" : "Wait for feedback; nudge on the due date", "employer", { waiting_for: "EMPLOYER_FEEDBACK", due_at: p.ask?.due_at ?? null });
  if (p.closed_out) return out("Closed out", "Nothing; they have had the last word");
  if (a.unsuitable) {
    const owe = p.sent_to && !p.closed_out && !["NOT_INTERESTED", "WITHDREW", "NO_RESPONSE", "UNREACHABLE"].includes(p.engagement);
    return out("Not suitable for this job", owe ? "Send the honest close-out, once" : "Nothing", owe ? "charlie" : null);
  }
  if (CLOSED[p.engagement]) return out(CLOSED[p.engagement], p.engagement === "UNREACHABLE" ? "Find a new address" : "Nothing; move up the next person", p.engagement === "UNREACHABLE" ? "operator" : null);
  if (["DENIED", "WITHDRAWN"].includes(p.disclosure.state)) return out(`Closed: consent ${p.disclosure.state === "DENIED" ? "declined" : "withdrawn"}`, "Nothing; move up the next person");
  if (["DENIED", "WITHDRAWN"].includes(p.screening_consent.state)) return out(`Closed: screening ${p.screening_consent.state === "DENIED" ? "declined" : "withdrawn"}`, "Employer decides: rescue without screening, or close", "employer");
  if (p.ask) {
    const left = p.ask.follow_ups < p.ask.max_follow_ups ? "follow up once" : "give up";
    return out(LABEL[p.ask.kind], `Wait; on ${new Date(p.ask.due_at).toISOString().slice(0, 10)} ${left}`, p.ask.owner, { waiting_for: p.ask.waiting_for, due_at: p.ask.due_at });
  }
  // Not yet assessed: whatever is open or closed above still shows; assessment gates only the next step.
  if (!a.judged) return out(p.engagement === "NOT_CONTACTED" ? "Discovered" : "Needs assessment", "Assess against the brief", "charlie");
  if (p.engagement === "NOT_CONTACTED") {
    const k = contactability(p, ctx);
    return out("Matched", k.ok ? "Send outreach (needs approval)" : `Can't contact: ${k.why}`, "operator");
  }
  if (p.engagement === "INTERESTED") {
    const s = p.screening.state, sc = p.screening_consent.state, d = p.disclosure.state;
    const needs = ["REQUIRED", "INCOMPLETE"].includes(s);
    if (handoffReadiness(p, ctx).ready) return out("Employer-ready", "Prepare the handoff for approval", "operator");
    if (needs && sc === "NOT_REQUESTED") return out("Interested", "Ask permission to screen", "charlie");
    if (d === "NOT_REQUESTED") return out(sc === "GRANTED" ? "Consent received" : "Interested", `Ask permission to introduce them to ${company}`, "charlie");
    if (s === "REQUIRED" || (s === "INCOMPLETE" && p.screening.rounds < pol.max_screening_rounds)) return out("Consent received", "Send screening for the open gaps only", "charlie");
    if (s === "INCOMPLETE" || s === "EXPIRED") return out("Screening stalled", "Employer decides: rescue as is, or close", "employer");
    if (!a.rescued && (a.open === null || a.open.length || a.eligible === false)) return out("Needs verification", "Re-run the gate with the answers; if still open, the employer decides", "charlie");
    if (!a.supported) return out("Needs a closer look", "Employer reviews the evidence: rescue or pass", "employer");
  }
  return out("Needs a person", "No rule matched; read the history", "operator", { unmatched: true });
}

// ── the candidacy lifecycle's system stages ──────────────────────────────────────────────────────────────
// The same few words for every organisation, every agent and every path (this pursuit, and Qualify & Submit's
// threads in lib/qualify/view.mjs), derived from the dimensions and never stored. A closed candidacy says which of
// four groups ended it. Only facts move these: a person's or employer's decision, the candidate's own reply, a
// timer. An assessment alone (an INELIGIBLE gate with no review) never shows anyone as closed.
export const SYSTEM_STAGES = ["Found", "Contacted", "Interested", "Qualifying", "Ready to introduce", "Introduced", "With employer", "Hired", "Closed"];
export const CLOSE_GROUPS = ["They chose", "No answer", "Not a fit", "Employer chose"];

/** {stage, group}: the system stage of a pursuit, and why it closed when it did. Pure. */
export function systemStageOf(p, ctx) {
  const closed = (group) => ({ stage: "Closed", group });
  const a = assessmentView(ctx?.assessment);
  if (["NOT_INTERESTED", "WITHDREW", "OPTED_OUT"].includes(p.engagement)) return closed("They chose");
  if (["DENIED", "WITHDRAWN"].includes(p.disclosure.state) || ["DENIED", "WITHDRAWN"].includes(p.screening_consent.state)) return closed("They chose");
  if (p.handoff === "RECALLED") return closed("They chose");
  if (["NO_RESPONSE", "UNREACHABLE"].includes(p.engagement)) return closed("No answer");
  if (p.handoff === "EMPLOYER_DECLINED" || a.passed || ctx?.job?.lifecycle === "closed") return closed("Employer chose");
  if (p.handoff === "EMPLOYER_PROGRESSING") return { stage: "With employer", group: null };
  if (p.handoff === "HANDED_OFF") return { stage: "Introduced", group: null };
  if (p.closed_out) return closed(null);
  if (p.engagement === "NOT_CONTACTED") return { stage: "Found", group: null };
  if (p.engagement === "AWAITING_REPLY") return { stage: "Contacted", group: null };
  if (p.engagement === "INTERESTED") {
    if (handoffReadiness(p, ctx).ready) return { stage: "Ready to introduce", group: null };
    const asked = p.screening_consent.state !== "NOT_REQUESTED" || p.disclosure.state !== "NOT_REQUESTED" || ["REQUESTED", "IN_PROGRESS", "INCOMPLETE", "COMPLETED", "EXPIRED"].includes(p.screening.state);
    return { stage: asked ? "Qualifying" : "Interested", group: null };
  }
  return { stage: null, group: null };
}

// ── agents, through the same engine ────────────────────────────────────────────────────────────────────
// An agent is an actor with an id, and acts only inside its scope: the autonomy table, made a rule here instead of a
// sentence. Anything outside it is refused, whatever the agent's code asks.
export const AGENT_SCOPES = Object.freeze({
  // Qualify & Submit: its own conversation's moves, the hand-off to the employer included, but only on the
  // candidate's plain YES to the exact details (QUALIFY_MOVES ready>submitting)
  outreach: Object.freeze(["qualify.moved"]),
});

// ── Qualify & Submit's conversation, as a rule set of the engine ─────────────────────────────────────────
// Each conversation (hire_qualify_threads) is its own record; the engine decides which stage moves are legal, for whom,
// and under which guard. Every move the agent's code makes is listed; anything else is refused. Terminal: closed and
// submitted (nothing moves out); failed waits for a person.
export const QUALIFY_STAGES = ["verify_sent", "reminded", "answered", "held", "confirming", "ready", "submitting", "submitted", "closed", "failed"];
const Q_OPEN = ["verify_sent", "reminded", "answered", "held", "confirming", "ready", "submitting"];
// a close on fit (the experience check, the fit bar, the pay band) is a person's decision (the candidacy lifecycle v1)
const NOT_A_FIT = /^(fit is|experience check|expects .* lakh)/i; // "the employer passed on them" is the employer's own decision, not this
// the check a fit close is for, read from its reason, and a person's approval for THAT check
const fitCheck = (reason) => (/^fit is/i.test(reason) ? "fit" : /^experience check/i.test(reason) ? "gate" : /^expects .* lakh/i.test(reason) ? "pay" : null);
const approvedClose = (t) => Boolean(t?.overrides?.close?.[fitCheck(String(t?.close_reason ?? ""))]);
const decided = (t) => Object.values(t?.overrides?.close ?? {}).some(Boolean) || Object.values(t?.overrides?.keep ?? {}).some(Boolean);
// the hand-off: their consent to THIS company, on record, and a YES to exactly the details that go
const confirmedYes = (t) => {
  const c = t?.consent ?? {};
  if (c.state !== "GRANTED") return "no YES to the details on record";
  if (!c.confirmed_hash || c.confirmed_hash !== c.confirm_hash) return "the YES is not to the details that would be sent";
  if (!c.company_shown || !c.evidence) return "no consent to this company on record";
  return null;
};
const closeGuard = (t) => (NOT_A_FIT.test(String(t?.close_reason ?? "")) && !approvedClose(t) ? "closing on fit needs a person's approval" : null);

/** [from stages, to stage, actors, guard on the conversation after the move]. null from = a new conversation. */
export const QUALIFY_MOVES = [
  [[null], "verify_sent", ["agent"]],
  [["verify_sent"], "reminded", ["agent"]],
  [["verify_sent", "reminded", "confirming", "answered", "ready"], "closed", ["agent"], closeGuard], // ready: the role closed first
  [["answered"], "held", ["agent"]],
  [["answered"], "verify_sent", ["agent"]],
  [["answered"], "confirming", ["agent"]],
  [["held"], "answered", ["agent", "person"], (t, a) => (a === "person" && !decided(t) ? "a person's decision is not on the conversation" : null)],
  [["ready"], "submitting", ["agent"], confirmedYes],
  [["ready"], "submitted", ["agent"]], // already with the employer: the submission is on record
  [["submitting"], "submitted", ["agent"]],
  [["submitting"], "ready", ["agent"]], // a transport failure, tried again
  [["submitting"], "closed", ["agent"]], // refused by the employer system
  [Q_OPEN, "failed", ["agent", "candidate"]],
  [["verify_sent", "reminded", "answered", "held", "confirming", "ready"], "answered", ["candidate"]],
  [["confirming"], "ready", ["candidate"], confirmedYes],
];

/**
 * May this actor move this conversation from `from` to `to`? `thread` is the conversation as it would be after the
 * move. Pure. {ok:true, record} or {ok:false, reason}.
 */
export function qualifyMove({ from = null, to, actor, agent = null, thread = {}, at = Date.now() }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!QUALIFY_STAGES.includes(to)) return refuse(`unknown stage ${to}`);
  if (from === to) return refuse(`not a move: ${to}`);
  if (actor === "agent" && !AGENT_SCOPES[agent]?.includes("qualify.moved")) return refuse(`agent ${agent ?? "unknown"} may not move a Qualify conversation`);
  const rule = QUALIFY_MOVES.find(([fs, t, actors]) => fs.includes(from) && t === to && actors.includes(actor));
  if (!rule) return refuse(`${actor}${agent ? ` ${agent}` : ""} cannot move a conversation from ${from ?? "nothing"} to ${to}`);
  const why = rule[3]?.(thread, actor);
  if (why) return refuse(why);
  return { ok: true, record: { type: "qualify.moved", actor, agent, at, from, to, version: LIFECYCLE_VERSION } };
}

// Qualify & Submit's timers come from the one policy: a reminder when the follow-up is due, closed quietly when the
// give-up after it passes (one source for every timer of these paths).
export const QUALIFY_REMIND_HOURS = DEFAULT_POLICY.follow_up_hours;
export const QUALIFY_CLOSE_HOURS = DEFAULT_POLICY.follow_up_hours + DEFAULT_POLICY.give_up_hours;
const plusHours = (iso, hours) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? new Date(t + hours * H).toISOString() : null; };

/**
 * A Qualify & Submit conversation's stage, who it waits for, and the next step with its date (the status map), read
 * straight from the conversation row; a date the row does not hold is not shown. Pure.
 * Lives in the engine beside stageOf (a pursuit's), so there is one place a stage is worked out.
 */
export function qualifyStageOf(t = {}) {
  const sent = t.verify_sent_at || null;
  switch (t.stage) {
    case "verify_sent":
      return (t.rounds ?? 1) >= 2
        ? { label: "Follow-up asked", waitingFor: "them", next: "Closes quietly if there is no reply", nextAt: plusHours(sent, QUALIFY_CLOSE_HOURS) }
        : t.consent?.recheck_asked
          ? { label: "Asked to confirm", waitingFor: "them", next: "Closes quietly if there is no reply", nextAt: plusHours(sent, QUALIFY_CLOSE_HOURS) }
          : { label: "Asked", waitingFor: "them", next: "One reminder", nextAt: plusHours(sent, QUALIFY_REMIND_HOURS) };
    case "reminded": return { label: "Reminded", waitingFor: "them", next: "Closes quietly if there is no reply", nextAt: plusHours(sent, QUALIFY_CLOSE_HOURS) };
    case "answered": return { label: "Reading reply", waitingFor: "charlie", next: "Read on the next run, within 15 minutes", nextAt: null };
    // the agent may not close someone on fit by itself: a person approves the close or keeps them
    case "held": return { label: "Needs you: close?", waitingFor: "you", next: "Approve the close, or keep them", nextAt: null };
    // the dated step is the agent's own timer: no reply by then closes it quietly
    case "confirming": return { label: "Confirming details", waitingFor: "their YES", next: "Closes quietly if there is no reply", nextAt: plusHours(t.consent?.confirm_sent_at, QUALIFY_CLOSE_HOURS) };
    case "ready": return { label: "Ready to submit", waitingFor: "charlie", next: "Submitted on the next run", nextAt: null };
    case "submitting": return { label: "Submitting", waitingFor: "pieworks", next: null, nextAt: null };
    case "submitted": return { label: t.close_reason ? "Already with the employer" : "Submitted", waitingFor: "employer", next: null, nextAt: null };
    case "closed": return { label: "Closed", waitingFor: null, next: t.close_reason || null, nextAt: null };
    case "failed": return { label: "Needs you", waitingFor: "you", next: t.last_error || null, nextAt: null };
    default: return { label: String(t.stage || "Unknown"), waitingFor: null, next: null, nextAt: null };
  }
}

// Checked after every transition in the tests; the same list will gate the dual-write later.
export function invariants(p) {
  const v = [];
  for (const [dim, d] of Object.entries(DIMENSIONS)) if (!d.values.includes(d.read(p))) v.push(`${dim} has an unknown value`);
  if (p.engagement === "AWAITING_REPLY" && !p.closed_out && p.ask?.kind !== "INTEREST") v.push("awaiting a reply without an open interest question");
  if (p.ask) {
    const a = p.ask;
    if (!a.id || !a.waiting_for || !a.owner || !(Number.isFinite(a.due_at) || a.overdue) || !Number.isInteger(a.max_follow_ups) || !Number.isFinite(a.give_up_hours)) v.push("an open question lacks waiting_for, due_at, owner or follow-up policy");
  }
  if (p.engagement === "OPTED_OUT" && (p.ask || p.contact.state !== "WITHDRAWN")) v.push("opted out but still waiting or contactable");
  const holds = { SCREENING_CONSENT: p.screening_consent.state === "REQUESTED", DISCLOSURE_CONSENT: p.disclosure.state === "REQUESTED", SCREENING: ["REQUESTED", "IN_PROGRESS"].includes(p.screening.state) };
  const asked = p.ask?.kind === "SCREENING_ANSWER" || p.ask?.kind === "CALL" ? "SCREENING" : p.ask?.kind;
  for (const [k, held] of Object.entries(holds)) if (held && asked !== k) v.push(`${k.toLowerCase()} requested with no open question behind it`);
  if (["HANDED_OFF", "EMPLOYER_PROGRESSING"].includes(p.handoff)) {
    const d = p.disclosure;
    if (d.state !== "GRANTED" || d.job_id !== p.job_id || d.employer_id !== p.employer_id || !d.evidence) v.push("with the employer without this job's and employer's consent");
  }
  if (!["NOT_CONTACTED", "UNREACHABLE", "OPTED_OUT"].includes(p.engagement) && !p.sent_to) v.push("engaged without ever being written to");
  if (!p.history.length || p.history.some((h) => !h.type || !h.actor || !Number.isFinite(h.at) || h.job_id !== p.job_id)) v.push("history incomplete");
  return v;
}

export function transitionTable() {
  return Object.entries(RULES).map(([type, r]) => ({ event: type, dimension: r.dim ?? "(any)", from: r.from ?? ["(any)"], to: r.to, actors: r.actors, sends: !!r.sends }));
}
