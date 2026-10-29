// voice/session.mjs — the session state machine. PURE: no I/O, no clock, no model.
//
// THE ONLY THING THAT CHANGES A SESSION'S STATE IS THIS TABLE. The store calls transition() and
// writes what it returns; nothing else writes `state`. Invariant 3 (numbered list in
// docs/ARCHITECTURE.md, "Voice verification invariants"): an LLM cannot choose the next workflow
// state, because no LLM output is an input here. Invariant 13: a test session walks the same states,
// minus human review and release, because nothing is being released about a real person.
//
// States:
//   invited -> consented -> in_progress -> completed -> transcript_ready -> evidence_ready
//   -> evaluated -> awaiting_review -> reviewed -> reported          (kind = candidate)
//   -> evaluated -> reported                                          (kind = test)
//   side exits: declined, unreachable, expired, abandoned; blocked (evaluator failure, held for review)

export const STATES = [
  "invited", "consented", "in_progress", "completed", "transcript_ready", "evidence_ready",
  "evaluated", "blocked", "awaiting_review", "reviewed", "reported",
  "declined", "unreachable", "expired", "abandoned",
];

export const EVENTS = [
  "consent.recorded", "session.declined", "session.unreachable", "session.expired",
  "conversation.started", "conversation.dropped", "conversation.resumed", "session.completed",
  "transcript.received", "evidence.extracted", "signals.computed", "signals.blocked",
  "report.rendered", "review.recorded", "report.released", "dispute.opened",
];

/** Nothing leaves these except deletion. */
export const TERMINAL = new Set(["reported", "declined", "unreachable"]);

// from -> event -> to. A function value decides on kind.
const T = {
  invited: {
    "consent.recorded": "consented",
    "session.declined": "declined",
    "session.unreachable": "unreachable",
    "session.expired": "expired",
  },
  consented: {
    "conversation.started": "in_progress",
    "session.declined": "declined",
    "session.expired": "expired",
  },
  in_progress: {
    "conversation.dropped": "in_progress",
    "conversation.resumed": "in_progress",
    "session.completed": "completed",
    "session.expired": "abandoned",
  },
  completed: { "transcript.received": "transcript_ready" },
  // An abandoned session with at least one conversation still gets its partial transcript extracted.
  abandoned: { "transcript.received": "transcript_ready" },
  transcript_ready: { "evidence.extracted": "evidence_ready" },
  evidence_ready: { "signals.computed": "evaluated", "signals.blocked": "blocked" },
  blocked: { "signals.computed": "evaluated" },
  evaluated: { "report.rendered": (kind) => (kind === "test" ? "reported" : "awaiting_review") },
  awaiting_review: { "review.recorded": "reviewed" },
  reviewed: { "report.released": "reported" },
  reported: { "dispute.opened": "reported" },
  expired: {},
  declined: {},
  unreachable: {},
};

/**
 * @param {{state:string, kind:'candidate'|'test'}} session
 * @param {string} event
 * @returns {{ok:true, state:string} | {ok:false, reason:string}}
 */
export function transition(session, event) {
  const state = session?.state;
  const kind = session?.kind;
  if (!STATES.includes(state)) return { ok: false, reason: `unknown state "${state}"` };
  if (kind !== "candidate" && kind !== "test") return { ok: false, reason: `unknown kind "${kind}"` };
  if (!EVENTS.includes(event)) return { ok: false, reason: `unknown event "${event}"` };
  if (kind === "test" && (event === "review.recorded" || event === "report.released")) {
    return { ok: false, reason: `a test session has no ${event}: nothing is released about a person` };
  }
  const next = T[state]?.[event];
  if (!next) return { ok: false, reason: `"${event}" is not allowed in state "${state}"` };
  return { ok: true, state: typeof next === "function" ? next(kind) : next };
}

/** Every (state, event) pair that is legal for a kind. For tests and for reading. */
export function legalTransitions(kind) {
  const out = [];
  for (const [from, evs] of Object.entries(T)) {
    for (const [ev, to] of Object.entries(evs)) {
      const r = transition({ state: from, kind }, ev);
      if (r.ok) out.push({ from, event: ev, to: r.state });
      void to;
    }
  }
  return out;
}

export const isTerminal = (state) => TERMINAL.has(state);
