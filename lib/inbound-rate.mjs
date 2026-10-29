// lib/inbound-rate.mjs — how much one address may cost us in an hour.
//
// WHY. The expensive step on /inbound runs EARLY: a short body is enough to trigger a full Opus dossier
// build (email-onboard.mjs -> dossier-build.mjs) before anything checks whether the sender is job
// hunting at all. Without a brake, 200 emails from 200 fresh addresses is 200 Opus builds.
//
// IN MEMORY, DELIBERATELY. A restart clears the window: this is an abuse brake, not an accounting
// ledger. A database round-trip on every inbound would add latency and cost to the ordinary path to
// defend against the rare one. If a flood ever spans restarts, make it durable then.
//
// SILENT DROP, never a reply. Replying to a flood from the sending domain doubles the volume, and if
// the sender is spoofed it makes Charlie the one sending unsolicited mail. A dropped message is
// recoverable (they write again); a burnt sending domain is not.

const WINDOW_MS = 60 * 60 * 1000; // one hour

// Default 12/hour. A real person writing in, answering a question, sending a resume and following up
// might touch 5-6 in a burst; 12 leaves room for that and still turns 200 into 12.
const limitPerHour = () => {
  const n = Number(process.env.INBOUND_MAX_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? n : 12;
};

/** address -> timestamps within the window. Module-scoped so every caller shares one view. */
const hits = new Map();

/**
 * Record an inbound from `email` and say whether it is over the limit.
 *
 * FAILS OPEN on junk input: a missing/garbage address returns allowed, because refusing mail we cannot
 * even key is a bigger failure than letting it through — the sender-auth and signature checks upstream
 * are what defend against forged senders, not this.
 *
 * @returns {{allowed: boolean, count: number, limit: number}}
 */
export function noteInboundFrom(email, now = Date.now()) {
  const key = String(email || "").trim().toLowerCase();
  const limit = limitPerHour();
  if (!key) return { allowed: true, count: 0, limit };

  const fresh = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  fresh.push(now);
  hits.set(key, fresh);

  // Opportunistic sweep so a long-lived process does not hold every address that ever wrote in. Cheap
  // because it only runs when the map is already large, and it only drops entries with nothing live.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }

  return { allowed: fresh.length <= limit, count: fresh.length, limit };
}

/** Test seam: forget everything. Never called in production. */
export function _resetInboundRate() {
  hits.clear();
}
