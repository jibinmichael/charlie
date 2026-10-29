// journey.test.mjs — the journey state machine + durable watchdogs (deterministic, no DB).
//
// Proves the spine has no dead ends and no lost timers, without touching Supabase or Resend:
//   1. THE "NO THIRD OPTION" INVARIANT — every working state either delivers or communicates; a
//      planted silent dead-end fails the build.
//   2. advance is PURE, appends history, keeps journey_id stable, and rejects illegal transitions.
//   3. Every declared state is reachable from a fresh journey (no orphan states).
//   4. Each watchdog policy fires ONLY when the state is unchanged, and its send is QUEUED THROUGH
//      sendGuarded (asserted on the payload) with NO live send.
//   5. DURABILITY — a rescheduled watchdog survives a simulated server restart (it's a row, not a
//      setInterval); and enterState schedules on the durable table, never in-process.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATES, TRANSITIONS, STATE_NAMES, advance, canTransition, currentState,
  watchdogFor, assertNoSilentDeadEnds,
} from "./journey.mjs";
import { runJourneyWatchdog } from "./journey-watchdog.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const AT = "2026-07-14T09:00:00.000Z";
// A fixed DAYTIME clock for the harness so the quiet-hours guard never defers these
// policy tests. 2026-07-15 06:00 UTC = 11:30 IST (the default-market local time), a non-holiday
// weekday afternoon — squarely inside the allowed send window. (Deferral is tested separately.)
const DAYTIME = Date.UTC(2026, 6, 15, 6, 0, 0);
const cand = (journey) => ({ email: "walker@example.com", dossier: journey ? { meta: { journey } } : {} });

// ── 1. the "no third option" invariant ───────────────────────────────────────
describe("no silent dead ends — the core invariant", () => {
  it("every state is terminal, a communicated rest state, or carries a watchdog", () => {
    expect(assertNoSilentDeadEnds()).toBe(true);
    for (const [name, s] of Object.entries(STATES)) {
      const ok = Boolean(s.terminal || s.restState || s.watchdog);
      expect(ok, `state "${name}" has no communicated exit`).toBe(true);
    }
  });

  it("FAILS THE BUILD if a working state loses its communicated exit", () => {
    const saved = STATES.hunting.watchdog;
    try {
      STATES.hunting.watchdog = undefined; // plant a silent dead-end
      expect(() => assertNoSilentDeadEnds()).toThrow(/no communicated exit/);
    } finally {
      STATES.hunting.watchdog = saved;
    }
    expect(assertNoSilentDeadEnds()).toBe(true); // restored
  });

  it("parked is a communicated rest state (its entry speaks; it waits for the user)", () => {
    expect(STATES.parked.restState).toBe(true);
    expect(STATES.parked.watchdog).toBeUndefined(); // we never nag a parked user
    expect(TRANSITIONS.parked).toContain("hunting"); // but a reply pulls them back out
    expect(TRANSITIONS.parked).toContain("interrogating");
  });
});

// ── 2. advance: pure, logged, guarded ────────────────────────────────────────
describe("advance — the ONLY writer of journey state", () => {
  it("starts a fresh journey at received with a null-origin history entry", () => {
    const j = advance(cand(null), "received", { at: AT, journeyId: "j_test" });
    expect(j.state).toBe("received");
    expect(j.entered_at).toBe(AT);
    expect(j.journey_id).toBe("j_test");
    expect(j.history).toEqual([{ from: null, to: "received", at: AT }]);
  });

  it("appends to history and keeps journey_id stable across a transition", () => {
    const j1 = advance(cand(null), "received", { at: AT, journeyId: "j_test" });
    const j2 = advance(cand(j1), "ack", { at: "2026-07-14T10:00:00.000Z" });
    expect(j2.journey_id).toBe("j_test"); // stable for the whole life
    expect(j2.history).toHaveLength(2);
    expect(j2.history[1]).toEqual({ from: "received", to: "ack", at: "2026-07-14T10:00:00.000Z" });
  });

  it("does not mutate the input candidate (purity)", () => {
    const j1 = advance(cand(null), "received", { at: AT, journeyId: "j_test" });
    const c = cand(j1);
    const before = JSON.stringify(c);
    advance(c, "ack", { at: AT });
    expect(JSON.stringify(c)).toBe(before);
  });

  it("throws on an illegal transition and on an unknown state", () => {
    const j = advance(cand(null), "received", { at: AT });
    expect(() => advance(cand(j), "hunting", { at: AT })).toThrow(/illegal journey transition/);
    expect(() => advance(cand(null), "hunting", { at: AT })).toThrow(/illegal journey transition/);
    expect(() => advance(cand(j), "nonsense", { at: AT })).toThrow(/unknown journey state/);
  });

  it("walks the full happy path received → … → accepted with an intact history", () => {
    const path = ["received", "ack", "interrogating", "building", "delivered", "locked", "hunting", "match_sent", "opened", "accepted"];
    let j = null;
    for (const [i, to] of path.entries()) {
      j = advance(cand(j), to, { at: AT, journeyId: "j_walk" });
      expect(j.state).toBe(to);
      expect(j.history).toHaveLength(i + 1);
    }
    expect(currentState(cand(j))).toBe("accepted");
    expect(STATES.accepted.terminal).toBe(true);
  });
});

// ── 3. reachability: no orphan states ────────────────────────────────────────
describe("every declared state is reachable from a fresh journey", () => {
  it("BFS from null covers exactly STATE_NAMES", () => {
    const seen = new Set(TRANSITIONS.null); // legal first states
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of [...seen]) for (const to of TRANSITIONS[s] || []) {
        if (!seen.has(to)) { seen.add(to); changed = true; }
      }
    }
    expect([...seen].sort()).toEqual([...STATE_NAMES].sort());
  });

  it("canTransition agrees with the TRANSITIONS table", () => {
    expect(canTransition(null, "received")).toBe(true);
    expect(canTransition("received", "ack")).toBe(true);
    expect(canTransition("received", "hunting")).toBe(false);
  });
});

// ── 4. watchdog fire: unchanged-guard + queued-through-sendGuarded, no live send ──
// A harness that mimics the durable table + candidate store entirely in memory, so we can drive
// every policy and assert on the sendGuarded payload. resend.emails.send THROWS — if anything tried
// a live send the test would fail loudly.
function harness(initialJourney, email = "walker@example.com") {
  const state = { journey: initialJourney };
  const tasks = []; // the durable scheduled_tasks table
  const sends = []; // captured sendGuarded calls
  const getCand = () => ({ email, dossier: state.journey ? { meta: { journey: state.journey } } : {} });
  const deps = {
    getCandidate: async () => getCand(),
    // mimic charlie-store.enterState: apply pure advance + schedule the target's watchdog durably.
    enterState: async (e, to) => {
      state.journey = advance(getCand(), to, { at: AT, journeyId: state.journey?.journey_id });
      const w = watchdogFor(to);
      if (w) tasks.push({ email: e, kind: w.kind, run_at: "next", payload: { state: to, journey_id: state.journey.journey_id, entered_at: state.journey.entered_at } });
      return state.journey;
    },
    scheduleTask: async ({ email: e, kind, runAt, payload }) => { tasks.push({ email: e, kind, run_at: runAt, payload }); return true; },
    sendGuarded: async (args) => { sends.push(args); return { status: "sent" }; },
    resend: { emails: { send: () => { throw new Error("LIVE SEND attempted — must go through sendGuarded"); } } },
    now: DAYTIME, // pin the clock inside the allowed send window so policy fires never defer
  };
  return { deps, tasks, sends, state };
}
const taskFor = (j, run_at = "t0", extra = {}) => ({
  email: "walker@example.com", kind: watchdogFor(j.state).kind, run_at,
  payload: { state: j.state, journey_id: j.journey_id, entered_at: j.entered_at, ...extra },
});

describe("watchdog fire — unchanged-guard, policies, and the queued sendGuarded payload", () => {
  it("is a no-op (stale) when the journey has moved on since scheduling", async () => {
    const j = advance(cand(null), "received", { at: AT, journeyId: "j1" });
    const h = harness(advance(cand(j), "ack", { at: AT })); // user already advanced to ack
    const r = await runJourneyWatchdog({ task: taskFor(j), deps: h.deps }); // stale received-timer
    expect(r.action).toBe("stale");
    expect(h.sends).toHaveLength(0);
  });

  it("advance policy: received → ack, no send, next watchdog scheduled", async () => {
    const j = advance(cand(null), "received", { at: AT, journeyId: "j1" });
    const h = harness(j);
    const r = await runJourneyWatchdog({ task: taskFor(j), deps: h.deps });
    expect(r).toMatchObject({ action: "advanced", from: "received", to: "ack" });
    expect(h.state.journey.state).toBe("ack");
    expect(h.sends).toHaveLength(0);
    expect(h.tasks.some((t) => t.kind === "onb_watchdog" && t.payload.state === "ack")).toBe(true);
  });

  it("pulse policy: hunting sends a heartbeat THROUGH sendGuarded and reschedules", async () => {
    const hunt = { state: "hunting", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(hunt);
    const r = await runJourneyWatchdog({ task: taskFor(hunt), deps: h.deps });
    expect(r.action).toBe("pulsed");
    expect(h.sends).toHaveLength(1);
    const s = h.sends[0];
    expect(s.template).toBe("journey:pulse");
    expect(s.email).toBe("walker@example.com");
    expect(s.payload.to).toBe("walker@example.com");
    expect(s.payload.from).toBeTruthy();
    expect(s.payload.subject).toBeTruthy();
    expect(s.payload.html).toContain("<");
    expect(s.dedupeKey).toContain("hunting");
    // rescheduled another heartbeat (still hunting)
    expect(h.tasks.filter((t) => t.kind === "hunt_heartbeat")).toHaveLength(1);
  });

  it("nudge_then_park: first fire nudges + arms a final timer; final fire parks", async () => {
    const interro = { state: "interrogating", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(interro);
    // first fire → one nudge, reschedule with final:true
    const r1 = await runJourneyWatchdog({ task: taskFor(interro), deps: h.deps });
    expect(r1.action).toBe("nudged");
    expect(h.sends[0].template).toBe("journey:nudge");
    const final = h.tasks.find((t) => t.kind === "interro_nudge" && t.payload.final === true);
    expect(final).toBeTruthy();
    // final fire (still interrogating) → park message + move to parked
    const r2 = await runJourneyWatchdog({ task: { ...taskFor(interro), payload: final.payload }, deps: h.deps });
    expect(r2.action).toBe("parked");
    expect(h.state.journey.state).toBe("parked");
    expect(h.sends[1].template).toBe("journey:park");
    expect(h.sends[1].payload.text.toLowerCase()).toContain("nothing");
  });

  it("park policy: a stuck build parks with a communicated note", async () => {
    const building = { state: "building", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(building);
    const r = await runJourneyWatchdog({ task: taskFor(building), deps: h.deps });
    expect(r.action).toBe("parked");
    expect(h.state.journey.state).toBe("parked");
    expect(h.sends[0].template).toBe("journey:park");
  });

  it("never attempts a live send on any path (resend.emails.send is a landmine)", async () => {
    // covered implicitly above, but assert explicitly on a fresh pulse
    const hunt = { state: "hunting", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(hunt);
    await expect(runJourneyWatchdog({ task: taskFor(hunt), deps: h.deps })).resolves.toBeTruthy();
  });

  // A message that fails the honesty lint is dropped at the send door, never delivered.
  it("convo-lint: a manipulative message is dropped, not sent", async () => {
    const hunt = { state: "hunting", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(hunt);
    const manipulative = () => ({ subject: "Don't miss out", text: "Only 2 spots left, act now. Want in?", html: "<p>x</p>" });
    const r = await runJourneyWatchdog({ task: taskFor(hunt), deps: { ...h.deps, buildMessage: manipulative } });
    expect(r.action).toBe("pulsed"); // the fire ran…
    expect(r.send.status).toBe("lint_dropped"); // …but the send was dropped by the lint
    expect(h.sends).toHaveLength(0); // nothing reached sendGuarded
  });

  // A communicating fire that lands in the recipient's night defers instead of sending.
  it("quiet-hours: a pulse at 2am local reschedules to morning and sends nothing", async () => {
    const QUIET_IST = Date.UTC(2026, 6, 14, 20, 30, 0); // 02:00 IST (default market) on 2026-07-15
    const hunt = { state: "hunting", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(hunt);
    const r = await runJourneyWatchdog({ task: taskFor(hunt), deps: { ...h.deps, now: QUIET_IST } });
    expect(r.action).toBe("deferred");
    expect(h.sends).toHaveLength(0); // NOTHING sent in the middle of the night
    const rescheduled = h.tasks.filter((t) => t.kind === "hunt_heartbeat");
    expect(rescheduled).toHaveLength(1); // deferred to the morning window, same payload
    expect(Date.parse(rescheduled[0].run_at)).toBeGreaterThan(QUIET_IST);
    expect(h.state.journey.state).toBe("hunting"); // journey untouched — it just waits for morning
  });
});

// ── 5. durability: a timer is a row, not a setInterval ───────────────────────
describe("durable watchdogs survive a restart", () => {
  it("a rescheduled heartbeat fires again after the in-memory process is dropped", async () => {
    const hunt = { state: "hunting", entered_at: AT, journey_id: "j1", history: [] };
    const h = harness(hunt);
    await runJourneyWatchdog({ task: taskFor(hunt), deps: h.deps });
    const queued = h.tasks.filter((t) => t.kind === "hunt_heartbeat");
    expect(queued).toHaveLength(1); // the ONLY thing that survives a kill: this row

    // "restart": brand-new deps/harness, seeded ONLY with the surviving journey + the queued row.
    const h2 = harness(hunt);
    const r = await runJourneyWatchdog({ task: { ...queued[0], run_at: "t1" }, deps: h2.deps });
    expect(r.action).toBe("pulsed"); // the timer was not lost with the process
    expect(h2.sends).toHaveLength(1);
  });

  it("STRUCTURAL: enterState schedules on the durable table and uses NO setInterval", () => {
    const store = src("charlie-store.mjs");
    const enter = store.slice(store.indexOf("export async function enterState"));
    expect(/scheduleTask\s*\(/.test(enter), "enterState must schedule via the durable scheduleTask").toBe(true);
    expect(/setInterval|setTimeout/.test(enter), "enterState must not use an in-process timer").toBe(false);
  });

  it("STRUCTURAL: the three journey watchdog kinds are wired into runTaskSweep", () => {
    const remote = src("server/charlie-remote.ts");
    for (const kind of ["onb_watchdog", "interro_nudge", "hunt_heartbeat"]) {
      expect(remote.includes(`"${kind}"`), `runTaskSweep missing kind ${kind}`).toBe(true);
    }
    expect(/runJourneyWatchdog\s*\(/.test(remote)).toBe(true);
  });
});
