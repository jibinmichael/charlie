// journey-watchdog.mjs — fire a due journey watchdog (the durable safety net).
//
// A watchdog is a durable timer (`scheduled_tasks`, kind onb_watchdog / interro_nudge /
// hunt_heartbeat) scheduled by charlie-store.enterState when a state is entered. When it comes due,
// runTaskSweep hands it here. The contract:
//
//   1. UNCHANGED-GUARD — fire ONLY if the journey is still exactly the entry that scheduled this
//      timer (same state + journey_id + entered_at). If the user moved on, this is a stale timer from
//      a prior state: no-op. This is what makes "fires only if state unchanged at runAt" true, and
//      it means we never cancel timers on transition — stale ones harmlessly no-op.
//   2. On fire, apply the state's watchdog POLICY from journey.mjs:
//        advance         → move to the declared next state (delivers; enterState schedules its watchdog)
//        pulse           → send the heartbeat, reschedule another pulse (hunting never goes silent)
//        nudge_then_park → send ONE nudge + reschedule a FINAL timer; on the final fire, send the
//                          parked note and move to `parked`
//        park            → send the parked note and move to `parked`
//   3. Every send routes through `sendGuarded` (the ONE physical send door — suppression +
//      sent_emails idempotency), keyed so a retry can't double-send but a legit reschedule can.
//
// PURE-ish + fully injectable: all I/O (getCandidate, enterState, scheduleTask, sendGuarded, resend)
// comes in via `deps`, so journey.test.mjs drives every path and asserts on the queued sendGuarded
// payload with NO live send. Copy is injectable too (`deps.buildMessage`); journeyMessage below is
// the honest minimal default (including the real `parked` message) so the spine is never silent.

import { journeyOf, watchdogFor } from "./journey.mjs";
import { emailShell, esc, unsubUrlFor } from "./email-kit.mjs";
import { nextSendWindow } from "./lib/local-window.mjs"; // coarse timezone + quiet-hours
import { lintMessage } from "./lib/convo-lint.mjs";       // honesty copy-lint (pre-send gate)

const FROM = () => process.env.CHARLIE_FROM || "charlie@mail.example.com";

// The default copy the watchdog sends. Honest, plain, clean sentence case, no em dash, one genuine
// question, always a costless exit — the doctrine convo-lint enforces. Returns { subject, html, text }
// or null (no message for that phase). Callers may inject richer copy.
export function journeyMessage(state, phase, candidate) {
  const email = candidate?.email || "";
  const shell = (preheader, title, bodyText) => ({
    subject: title,
    html: emailShell({
      preheader,
      title,
      contentHtml: bodyText.split("\n\n").map((para) => `<p style="margin:0 0 16px">${esc(para)}</p>`).join(""),
      unsubUrl: unsubUrlFor(email),
    }),
    text: `${bodyText}\n\nCharlie`,
  });

  if (phase === "park") {
    return shell(
      "Nothing lost, reply anytime.",
      "Still here whenever you are",
      "No rush at all, and nothing's lost. Whenever you have a minute, just reply and we'll pick up right where we left off.\n\nWant me to keep an eye out in the meantime?",
    );
  }
  if (phase === "nudge") {
    return shell(
      "No pressure, just checking in.",
      "Whenever you're ready",
      "Just checking in, no pressure at all. When you get a moment, reply and we'll keep going.\n\nIs now a bad time, or should I hold off?",
    );
  }
  if (phase === "pulse") {
    return shell(
      "A quick note on where things stand.",
      "Where things stand",
      "Quick note. Nothing cleared your bar this week, so I'm holding rather than sending you noise. No rush on your end.\n\nAnything you'd want me to weigh differently?",
    );
  }
  return null;
}

/**
 * Fire one due journey watchdog. Returns a small result object describing what it did (for logging
 * and tests). Never throws for a normal no-op; a genuine downstream error propagates so the sweep
 * completes the task (poison-task guard) rather than looping.
 *
 * @param {object}   o
 * @param {{email:string, kind:string, run_at:string, payload:object}} o.task  the due scheduled_task.
 * @param {object}   o.deps  { getCandidate, enterState, scheduleTask, sendGuarded, resend,
 *                             buildMessage?, log?, now? } — injected for testability. `now` (ms)
 *                             pins the clock for the quiet-hours check (default Date.now()).
 */
export async function runJourneyWatchdog({ task, deps } = {}) {
  const {
    getCandidate, enterState, scheduleTask, sendGuarded, resend,
    buildMessage = journeyMessage, log = console.error,
  } = deps || {};
  const nowMs = typeof deps?.now === "number" ? deps.now : Date.now();
  const { email, run_at, payload = {} } = task || {};

  const cand = await getCandidate(email).catch(() => null);
  const j = journeyOf(cand);

  // (1) unchanged-guard: this timer only fires against the exact entry that scheduled it.
  if (!j || j.state !== payload.state || j.journey_id !== payload.journey_id || j.entered_at !== payload.entered_at) {
    return { action: "stale", expected: payload.state ?? null, actual: j?.state ?? null };
  }

  const state = j.state;
  const w = watchdogFor(state);
  if (!w) return { action: "none", state }; // terminal / rest state: nothing to chase

  // Quiet hours: a fire that would SEND (pulse / nudge / park) but lands in the recipient's
  // local night or on a holiday defers to their next local morning instead — reschedule the SAME
  // watchdog (payload preserved) and don't touch journey state. Advance-only fires have no send, so
  // they proceed. v2-only by construction (only v2 candidates carry a journey).
  const communicates = w.policy === "pulse" || w.policy === "nudge_then_park" || w.policy === "park";
  if (communicates) {
    const when = nextSendWindow(cand, nowMs);
    if (when > nowMs) {
      await scheduleTask({ email, kind: w.kind, runAt: new Date(when).toISOString(), payload });
      return { action: "deferred", state, until: new Date(when).toISOString() };
    }
  }

  // Route a phase's message through the ONE send door, keyed so a task retry is idempotent but the
  // next scheduled fire (new run_at) is allowed to send again.
  const send = async (phase) => {
    const msg = buildMessage(state, phase, cand);
    if (!msg) return { status: "skipped" };
    // Honesty copy-lint: every v2 message clears the doctrine gate BEFORE the send door.
    // Fail closed — a manipulative or careless line never reaches a real inbox. Drop + log; the
    // journey is unaffected (a missed nudge is invisible, a bad line is not).
    const lint = lintMessage({ subject: msg.subject, text: msg.text, userFacts: msg.userFacts || [] });
    if (!lint.ok) {
      log(`[journey] convo-lint DROP ${state}/${phase} ${email}: ${lint.violations.map((v) => v.rule).join(", ")}`);
      return { status: "lint_dropped", violations: lint.violations };
    }
    return sendGuarded({
      resend,
      email,
      template: `journey:${phase}`,
      dedupeKey: `${j.journey_id}:${state}:${phase}:${run_at}`,
      idempotencyKey: `journey/${j.journey_id}/${state}/${phase}/${run_at}`,
      payload: {
        from: FROM(),
        to: email,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: {
          "List-Unsubscribe": `<${unsubUrlFor(email)}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      log,
    });
  };
  const nowISO = () => new Date().toISOString();
  const inMs = (ms) => new Date(Date.now() + ms).toISOString();

  switch (w.policy) {
    case "advance": {
      await enterState(email, w.next, { at: nowISO() });
      return { action: "advanced", from: state, to: w.next };
    }
    case "pulse": {
      const r = await send("pulse");
      // Reschedule the next heartbeat on the durable table (same entry → same payload).
      await scheduleTask({ email, kind: w.kind, runAt: inMs(w.after), payload });
      return { action: "pulsed", state, send: r };
    }
    case "nudge_then_park": {
      if (!payload.final) {
        const r = await send("nudge");
        await scheduleTask({
          email, kind: w.kind, runAt: inMs(w.final_after ?? w.after),
          payload: { ...payload, final: true },
        });
        return { action: "nudged", state, send: r };
      }
      const r = await send("park");
      await enterState(email, "parked", { at: nowISO() });
      return { action: "parked", from: state, send: r };
    }
    case "park": {
      const r = await send("park");
      await enterState(email, "parked", { at: nowISO() });
      return { action: "parked", from: state, send: r };
    }
    default:
      log(`[journey] unknown watchdog policy "${w.policy}" for state "${state}"`);
      return { action: "unknown_policy", policy: w.policy };
  }
}
