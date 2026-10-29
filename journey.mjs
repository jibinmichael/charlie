// journey.mjs — the onboarding/lifecycle journey state machine (pure, no I/O).
//
// A person mid-journey must NEVER fall into silence. Every state either DELIVERS (auto-advances
// to the next step) or COMMUNICATES (tells them something) — there is no silent third option. This
// module is the single source of truth for that contract: the named states, the legal transitions,
// the pure transition function `advance`, and the per-state watchdog + communicated-exit spec.
//
// State lives on the dossier as additive Json (no migration):
//   dossier.meta.journey = { state, entered_at, journey_id, history: [{ from, to, at }, ...] }
//
// SEPARATION OF CONCERNS:
//   - This file is PURE (no DB, no clock, no random). `advance` is the ONLY writer of journey state,
//     and it just returns the next journey object — the caller persists it.
//   - Persistence + timer scheduling lives in charlie-store.mjs `enterState` (reads → advance → save
//     → scheduleTask).
//   - Firing a due watchdog lives in journey-watchdog.mjs `runJourneyWatchdog` (deps injected).
//
// The whole thing is v2-only: it is driven by the onboarding-v2 cohort (isV2). Nobody has a journey
// until ONBOARDING_V2 is on, so it is dormant by default.

const H = (n) => n * 3_600_000; // hours → ms

// ── the states ───────────────────────────────────────────────────────────────
// Each state declares three enforced things (the "no third option" invariant, checked in
// journey.test.mjs via `assertNoSilentDeadEnds`):
//   entry     — a NAME for the action taken on entry (the side-effect itself is wired by the
//               caller; this file fixes the contract). Every state has one.
//   watchdog  — { kind, after, policy } | null. The durable max-silence timer scheduled on entry.
//               A state with a watchdog always either advances (delivers) or communicates on fire.
//   AND exactly one of:
//     terminal:  true  — a real end (accepted). No watchdog; nothing to chase.
//     restState: true  — a communicated safe harbour (parked). Its ENTRY already told the user
//                        "nothing lost, reply anytime"; it waits for THEM, so it needs no watchdog
//                        and is never a silent dead-end.
//     watchdog:  set   — every other (working) state must carry a watchdog.
//
// Watchdog policies (interpreted by journey-watchdog.mjs):
//   advance         — on fire (state unchanged), auto-advance to `next`. This is a "delivers" exit.
//   nudge_then_park — on fire, send ONE gentle nudge and reschedule a FINAL watchdog; on the final
//                     fire (still unchanged), move to `parked` (communicated). One nudge, then rest.
//   pulse           — on fire, send the state's heartbeat and reschedule another pulse. Hunting
//                     never goes silent > one window; it never parks itself (the user drives that).
//   park            — on fire, communicate + move to `parked` (used where there is nothing to
//                     auto-advance to and no point nudging, e.g. a stuck build).
export const STATES = {
  // ── onboarding ──
  received: {
    entry: "send_ack",
    watchdog: { kind: "onb_watchdog", after: H(1), policy: "advance", next: "ack" },
  },
  ack: {
    entry: "await_first_reply",
    watchdog: { kind: "onb_watchdog", after: H(24), policy: "nudge_then_park", final_after: H(48) },
  },
  interrogating: {
    entry: "ask_questions",
    watchdog: { kind: "interro_nudge", after: H(60), policy: "nudge_then_park", final_after: H(60) },
  },
  needs_input: {
    entry: "await_answer",
    watchdog: { kind: "interro_nudge", after: H(60), policy: "nudge_then_park", final_after: H(60) },
  },
  building: {
    entry: "build_dossier",
    // A build should finish in minutes; if this timer ever fires the build is stuck, so we don't
    // nudge into a void — we park and say so honestly.
    watchdog: { kind: "onb_watchdog", after: H(6), policy: "park" },
  },
  delivered: {
    entry: "send_first_role",
    watchdog: { kind: "onb_watchdog", after: H(24), policy: "advance", next: "locked" },
  },
  locked: {
    entry: "confirm_locked",
    watchdog: { kind: "onb_watchdog", after: H(1), policy: "advance", next: "hunting" },
  },

  // ── the steady state ──
  hunting: {
    entry: "begin_hunt",
    watchdog: { kind: "hunt_heartbeat", after: H(24 * 7), policy: "pulse" },
  },
  parked: {
    entry: "send_parked", // communicates "nothing lost, reply anytime" — its OWN communicated exit
    restState: true,      // waits for the user; a reply routes them back to hunting/interrogating
  },

  // ── outcome states (after a role is sent) ──
  match_sent: {
    entry: "await_open",
    watchdog: { kind: "onb_watchdog", after: H(24 * 3), policy: "advance", next: "hunting" },
  },
  opened: {
    entry: "await_decision",
    watchdog: { kind: "onb_watchdog", after: H(24 * 7), policy: "advance", next: "hunting" },
  },
  accepted: {
    entry: "celebrate",
    terminal: true, // they took the role. The end (a happy one).
  },
  passed: {
    entry: "back_to_hunt",
    watchdog: { kind: "onb_watchdog", after: H(1), policy: "advance", next: "hunting" },
  },
};

// ── the legal transitions ────────────────────────────────────────────────────
// `null` = no journey yet (a brand-new candidate). The ONLY legal first state is `received`.
// ⇄ pairs (interrogating⇄needs_input, hunting⇄parked) are encoded as edges in both directions.
export const TRANSITIONS = {
  null: ["received"],
  received: ["ack"],
  ack: ["interrogating", "parked"],
  interrogating: ["needs_input", "building", "parked"],
  needs_input: ["interrogating", "parked"],
  building: ["delivered", "parked"],
  delivered: ["locked"],
  locked: ["hunting"],
  hunting: ["match_sent", "parked"],
  parked: ["interrogating", "hunting"], // a reply pulls them back out of the harbour
  match_sent: ["opened", "hunting"],
  opened: ["accepted", "passed", "hunting"],
  passed: ["hunting"],
  accepted: [], // terminal
};

export const STATE_NAMES = Object.keys(STATES);

/** The journey object off a candidate/dossier, or null if none. Accepts a candidate row or a dossier. */
export function journeyOf(candidateOrDossier) {
  const dossier = candidateOrDossier?.dossier ?? candidateOrDossier;
  return dossier?.meta?.journey ?? null;
}

/** Current state name, or null if the candidate has no journey yet. */
export function currentState(candidateOrDossier) {
  return journeyOf(candidateOrDossier)?.state ?? null;
}

/** Is `to` a legal next state from `from` (from === null means "starting fresh")? */
export function canTransition(from, to) {
  return (TRANSITIONS[from ?? "null"] ?? []).includes(to);
}

/** The watchdog spec for a state (or null for terminal / rest states). */
export function watchdogFor(state) {
  return STATES[state]?.watchdog ?? null;
}

/**
 * advance — the ONE writer of journey state. PURE: returns the NEXT journey object; the caller
 * persists it (charlie-store.enterState). Throws on an illegal transition so a bad caller can never
 * strand a user in an undefined state.
 *
 * @param {object} candidateOrDossier  a candidate row or a dossier (to read the current journey).
 * @param {string} toState             the target state (must be legal from the current one).
 * @param {object} [opts]
 * @param {string} [opts.at]           ISO timestamp of the transition (injected — this stays pure).
 * @param {string} [opts.journeyId]    id for a FRESH journey (from null → received). Ignored once a
 *                                     journey exists (the id is stable for its whole life).
 * @returns {{state:string, entered_at:string, journey_id:string, history:Array}}
 */
export function advance(candidateOrDossier, toState, { at, journeyId } = {}) {
  const cur = journeyOf(candidateOrDossier);
  const from = cur?.state ?? null;
  if (!STATES[toState]) throw new Error(`unknown journey state "${toState}"`);
  if (!canTransition(from, toState)) {
    throw new Error(`illegal journey transition ${from ?? "(none)"} → ${toState}`);
  }
  const nowISO = at || cur?.entered_at || new Date(0).toISOString();
  return {
    state: toState,
    entered_at: nowISO,
    journey_id: cur?.journey_id || journeyId || `j_${toState}_${nowISO}`,
    history: [...(cur?.history ?? []), { from, to: toState, at: nowISO }],
  };
}

// ── the "no third option" invariant ──────────────────────────────────────────
// Exported so journey.test.mjs can FAIL THE BUILD if any working state could strand a user in
// silence. A state passes iff it is terminal, a communicated rest state, OR carries a watchdog whose
// policy always reaches the user (advance = delivers; nudge_then_park/park/pulse = communicates).
const COMMUNICATING_POLICIES = new Set(["advance", "nudge_then_park", "park", "pulse"]);

/** Throws with the offending state if any state is a silent dead-end. Returns true when all pass. */
export function assertNoSilentDeadEnds() {
  for (const [name, s] of Object.entries(STATES)) {
    if (s.terminal) continue;                 // a real, intended end
    if (s.restState) {                        // a communicated harbour must actually communicate
      if (!s.entry) throw new Error(`rest state "${name}" has no communicated entry action`);
      continue;
    }
    const w = s.watchdog;
    if (!w) throw new Error(`state "${name}" has no communicated exit (no watchdog, not terminal/rest)`);
    if (!COMMUNICATING_POLICIES.has(w.policy)) {
      throw new Error(`state "${name}" watchdog policy "${w.policy}" does not reach the user`);
    }
    // `advance` must point somewhere real; a park/rest must be reachable so no timer loops forever.
    if (w.policy === "advance" && !STATES[w.next]) {
      throw new Error(`state "${name}" advances to unknown state "${w.next}"`);
    }
  }
  return true;
}
