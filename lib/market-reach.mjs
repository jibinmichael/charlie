// lib/market-reach.mjs — how much of what we scan can anyone we serve actually take?
//
// WHY. A large share of scanned roles sit in markets Charlie does not serve: they are fetched, parsed,
// embedded, stored and carried in memory, yet cannot be sent to a single person on the list. That dead
// weight inflates jobs.json toward V8's hard single-string ceiling, where the daily run aborts on heap
// exhaustion and sends nothing.
//
// SHADOW FIRST, AND THAT IS NOT A FORMALITY. This module decides what to DELETE at scan time, so a bug
// here removes roles from everyone at once rather than skipping one role for one person, and a
// reachability rule that reads the wrong field still reports green. So `shadow` counts and logs and
// changes nothing, and only a human reading a real shadow report may turn on `enforce`.
//
// It reuses reachabilityVerdict from quality-gate.mjs rather than reimplementing the rule. One
// definition of "can this person take this job", used by the send gate and by this filter, so the two
// can never drift into disagreeing about the same role.
import { reachabilityVerdict } from "../quality-gate.mjs";

/** The markets Charlie actually serves. Adding one here is a business decision, not a refactor. */
export const MARKETS = ["india", "us"];

/**
 * Mode, read at CALL TIME so a test (and a deploy) can change it without reimporting.
 * A module-level const would freeze the value at import and silently ignore the env var.
 * @returns {"off"|"shadow"|"enforce"}
 */
export function reachMode() {
  const v = String(process.env.MARKET_REACH_FILTER || "off").toLowerCase();
  // `enforce` IS DELIBERATELY NOT HONOURED YET, and asking for it gets a warning rather than silence.
  //
  // The basis this filter would delete on, `foreign-place-named`, is not what its name says. It is
  // the fall-through label, returned for "Office based" and "HQ" — which name no place at all — and
  // for many plainly-US "City, ST" roles: US_PLACE matches city and state NAMES and never bare
  // two-letter codes, on purpose, because "Perth, WA" and "Seattle, WA" would otherwise collide.
  //
  // Enforcing on that signal would delete real, reachable US roles for every user at once. The geo
  // rule has to be fixed and re-measured first. Until then this module MEASURES ONLY, and the code
  // refuses rather than trusting a future reader to know.
  if (v === "enforce") {
    console.error("[market-reach] MARKET_REACH_FILTER=enforce is refused: the geo basis it deletes on is unverified (see lib/market-reach.mjs). Running in shadow.");
    return "shadow";
  }
  return v === "shadow" ? v : "off";
}

/**
 * Can ANY market we serve take this role?
 *
 * FAILS OPEN on any error. An exception here must never delete a role: a kept-but-unreachable role
 * costs a few kilobytes and is dropped later by the send gate anyway, while a wrongly-deleted role is
 * gone for every user with no trace. That asymmetry is the whole reason this file exists.
 */
export function reachableByAnyMarket(job) {
  for (const m of MARKETS) {
    try {
      if (reachabilityVerdict(job, m)?.reachable) return true;
    } catch {
      return true; // unreadable role -> keep it, never delete on an error
    }
  }
  return false;
}

// THE BAR FOR DELETING IS HIGHER THAN THE BAR FOR NOT SENDING, and this set is where that lives.
//
// The send gate is deliberately strict: it refuses a role it cannot place, because not sending is
// recoverable tomorrow. Deleting is not. So this filter acts only on POSITIVE EVIDENCE — the posting
// NAMES a place, and that place is outside every market we serve. `foreign-place-named` is that
// evidence.
//
// Everything else is uncertainty, not foreignness, and uncertainty is kept:
//   · no-location-not-remote      we cannot read where it is; it could be in Bengaluru
//   · remote-company-unconfirmed  a placeless remote role at a company whose footprint we do not know
//   · onsite-no-city              an office we failed to locate
//   · remote-restricted           the JD restricts it, but that is the send gate's judgement to make
//
// A test asserts a role with no location survives. If that test is ever "fixed" to match the send
// gate, this filter starts deleting roles for everyone on the basis of a missing field.
const DELETABLE_BASIS = new Set(["foreign-place-named"]);

/**
 * May the scan DELETE this role? True only when every served market rejected it because the posting
 * named a place we do not serve.
 *
 * Fails CLOSED on error, where "closed" means keep: an exception can never cause a deletion.
 */
export function safeToDelete(job) {
  for (const m of MARKETS) {
    let v;
    try {
      v = reachabilityVerdict(job, m);
    } catch {
      return false; // unreadable -> keep
    }
    if (v?.reachable) return false;             // someone can take it
    if (!DELETABLE_BASIS.has(v?.basis)) return false; // uncertainty, not foreignness -> keep
  }
  return true;
}

/**
 * Measure what an enforcing filter WOULD remove, without removing anything.
 *
 * @param {object[]} jobs the roles the scan is about to write
 * @returns {{total:number, unreachable:number, pct:string, bySource:object, samples:string[]}}
 */
export function shadowReport(jobs) {
  const bySource = {};
  const samples = [];
  let unreachable = 0;

  for (const j of jobs || []) {
    if (!safeToDelete(j)) continue;   // measure what we would ACTUALLY delete
    unreachable++;
    const src = String(j?.id || "").split(":")[0] || "unknown";
    bySource[src] = (bySource[src] || 0) + 1;
    // Samples are what a human actually reads to decide whether the rule is right. Location is the
    // field the rule turns on, so it is the field worth showing.
    if (samples.length < 15) {
      const loc = typeof j?.location === "string" ? j.location : JSON.stringify(j?.location ?? null);
      samples.push(`${j?.company || "?"} — ${String(j?.title || "?").slice(0, 60)} | ${String(loc).slice(0, 60)}`);
    }
  }

  const total = (jobs || []).length;
  return {
    total,
    unreachable,
    pct: total ? ((100 * unreachable) / total).toFixed(1) : "0.0",
    bySource,
    samples,
  };
}

/**
 * Print the shadow report. Deliberately loud and specific: this output is the ONLY artifact a human
 * has when deciding whether `enforce` is safe, so it names the sources and shows real rows rather
 * than reporting a single reassuring percentage.
 */
export function logShadowReport(rep, mode) {
  console.log(`\n— market reach (${mode}) —`);
  console.log(`  markets served:      ${MARKETS.join(", ")}`);
  // SHARE, NOT MEGABYTES. These in-memory objects still carry UNCAPPED descriptions (scan-jobs applies
  // capKeepingRequirements only when building the jobs.json payload), so bytes measured here would
  // overstate the on-disk saving. Density per role is uniform, so the share is the honest figure and
  // the reader can apply it to the jobs.json size printed a few lines above.
  console.log(`  reachable by none:   ${rep.unreachable} of ${rep.total} (${rep.pct}% of the pool, apply to the jobs.json size above)`);
  const src = Object.entries(rep.bySource).sort((a, b) => b[1] - a[1]);
  if (src.length) console.log(`  by source:           ${src.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (mode === "shadow") {
    console.log(`  NOTHING WAS DROPPED. Read the samples below, then set MARKET_REACH_FILTER=enforce.`);
    for (const s of rep.samples) console.log(`    · ${s}`);
  }
}
