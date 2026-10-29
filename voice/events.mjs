// voice/events.mjs — the append-only event log.
//
// Every stage transition, every live turn, every failure is a row. `kind` rides in every row, copied
// from the session, so a metric can filter test sessions out without a join and cannot forget to.
// The event types the state machine consumes are in voice/session.mjs EVENTS; the operational ones
// (turn.recorded, fallback.used, judge.unavailable, ...) are free strings under a fixed prefix set.

export const EVENT_PREFIXES = ["mandate", "plan", "session", "consent", "conversation", "turn", "transcript", "evidence", "signals", "report", "review", "dispute", "candidate", "fallback", "judge", "writer"];

export function validEventType(type) {
  const p = String(type || "").split(".")[0];
  return EVENT_PREFIXES.includes(p) && /^[a-z]+\.[a-z_]+$/.test(String(type || ""));
}

/**
 * @param {object} store  voice/store.mjs (or a fake)
 * @param {{id:string, kind:'candidate'|'test'}} session
 * @param {string} type
 * @param {object} [payload]
 */
export async function emit(store, session, type, payload = {}) {
  if (!validEventType(type)) throw new Error(`emit: "${type}" is not a valid event type`);
  if (!session?.id || (session.kind !== "candidate" && session.kind !== "test")) throw new Error("emit: session with id and kind is required");
  return store.insertEvent({ session_id: session.id, kind: session.kind, type, payload: { ...payload, kind: session.kind } });
}
