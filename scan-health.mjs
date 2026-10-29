// scan-health.mjs — tell "this board is empty" apart from "this board stopped talking to us".
//
// A blocked ATS does not error. apply.workable.com answers a datacenter IP with HTTP 200 and
// `{"jobs": []}` — so fetchBoard returns ok, the board counts as RESOLVED, and the scan prints
// "✓ <company> (workable) — 0 jobs" and walks on. An honest empty board looks exactly the same, so
// from one run's data the two are indistinguishable.
//
// Yesterday's counts are what make it decidable. A board that RESOLVED, yielded 0, and had roles
// in the last snapshot has not emptied — it has stopped answering. That is a failure, and it is
// reported as one.
//
// Deliberately pure (no I/O): the caller supplies both snapshots, so this is testable and can
// never break a scan.

/**
 * Where everything a scan fetched actually went, as counts that account for the whole intake.
 *
 * WHY THIS EXISTS: a scan pools far fewer roles than it fetches, and `fetched - pooled` cannot say
 * where the rest went, because the two survivable
 * explanations have opposite fixes: roles aged out by the 45-day cutoff (a coverage DECISION we could
 * revisit) versus roles collapsing into each other on id (dedupe working correctly, nothing to fix).
 * Reading one number as the other is how "the pool can be 2.5x bigger" becomes a claim nobody checked.
 *
 * `dedupe` is deliberately the REMAINDER, not a counter: every other exit is counted at its own
 * `continue`, so whatever is left over collapsed inside `byId`. Making it the remainder means a future
 * exit path added without a counter shows up as impossible dedupe rather than vanishing silently.
 *
 * @param {{fetched?:number, invalid?:number, noDesc?:number, stale?:number, pooled?:number,
 *          remoteKept?:number}} funnel  as persisted at scan-health.json `funnel`
 * @returns {{fetched:number, invalid:number, noDesc:number, stale:number, dedupe:number,
 *            pooled:number, accountedFor:boolean}}  `pooled` counts ATS roles only (remote-board
 *   roles are merged into the same pool but were never part of `fetched`). `accountedFor` is false
 *   when the counts cannot be reconciled — treat the breakdown as untrustworthy, do not act on it.
 */
export function funnelBreakdown(funnel) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const fetched = n(funnel?.fetched);
  const invalid = n(funnel?.invalid);
  const noDesc = n(funnel?.noDesc);
  const stale = n(funnel?.stale);
  const pooled = n(funnel?.pooled) - n(funnel?.remoteKept); // ATS-sourced survivors only
  const dedupe = fetched - invalid - noDesc - stale - pooled;
  return { fetched, invalid, noDesc, stale, dedupe, pooled, accountedFor: dedupe >= 0 && pooled >= 0 };
}

/**
 * Boards that resolved, yielded nothing, and used to yield something.
 *
 * @param {object} args
 * @param {Record<string, number>} args.previousCounts  company -> open_count from the last snapshot
 * @param {Record<string, number>} args.todayCounts     company -> kept-role count from this run
 * @param {Map<string, string>}    args.resolvedBoards  company -> "source:slug", ONLY for boards that
 *   resolved this run. A board that failed to resolve is already logged as a ⚠ and is not a silent
 *   zero, so it is not reported here — that would double-count a known failure as a new one.
 * @returns {{company: string, board: string, had: number}[]} worst first
 */
export function detectSilentZeros({ previousCounts, todayCounts, resolvedBoards }) {
  const prev = previousCounts || {};
  const today = todayCounts || {};
  const resolved = resolvedBoards || new Map();
  const out = [];
  for (const [company, had] of Object.entries(prev)) {
    if (!(Number(had) > 0)) continue; // nothing to lose
    if ((today[company] || 0) > 0) continue; // still yielding — fine
    const board = resolved.get(company);
    if (!board) continue; // board didn't resolve: already a loud ⚠, not a silent zero
    out.push({ company, board, had: Number(had) });
  }
  return out.sort((a, b) => b.had - a.had || a.company.localeCompare(b.company));
}

/**
 * Segments that carried roles last run and carry none now.
 *
 * detectSilentZeros above can only speak about boards that were ASKED — a board that resolved and
 * said nothing. It is blind to a board that was never asked at all, and a whole segment can go
 * unasked: the yc/india feeds are regenerated into watchlist-yc.json / watchlist-india.json every
 * run, and scan-jobs merges them only `if (existsSync(p))`. yc-ingest treats an unreachable feed
 * as non-fatal and keeps "any prior watchlist-yc.json" — but the cron gets a fresh container each
 * run, so there IS no prior file (same wipe that makes every first_seen today's date). The feed
 * hiccups, the file is absent, the merge is skipped, those companies are never fetched, no ⚠ is
 * ever printed, and the segment silently contributes zero while the scan reports a healthy pool.
 * A segment that had roles and now has none is that failure.
 *
 * @param {object} args
 * @param {Record<string, {roles: number}>} args.previousSegments  coverageBySegment from the last run
 * @param {Record<string, {roles: number}>} args.todaySegments     coverageBySegment from this run
 * @returns {{segment: string, had: number}[]} worst first
 */
export function detectSegmentCollapse({ previousSegments, todaySegments }) {
  const prev = previousSegments || {};
  const today = todaySegments || {};
  const out = [];
  for (const [segment, v] of Object.entries(prev)) {
    const had = Number(v?.roles ?? 0);
    if (!(had > 0)) continue; // nothing to lose. india sits at 0 while its seed is empty — not a collapse.
    if (Number(today[segment]?.roles ?? 0) > 0) continue; // still contributing
    out.push({ segment, had });
  }
  return out.sort((a, b) => b.had - a.had || a.segment.localeCompare(b.segment));
}

/**
 * Roll the silent zeros into the shape we persist + log. `lostRoles` is the honest headline:
 * how many roles a real person could have been shown today and wasn't.
 */
export function summarizeScanHealth({ previousCounts, todayCounts, resolvedBoards, poolSize, at, previousSegments, todaySegments }) {
  const silentZeros = detectSilentZeros({ previousCounts, todayCounts, resolvedBoards });
  const segmentCollapses = detectSegmentCollapse({ previousSegments, todaySegments });
  const bySource = {};
  for (const z of silentZeros) {
    const src = String(z.board).split(":")[0] || "unknown";
    bySource[src] = (bySource[src] || 0) + 1;
  }
  return {
    at: at ?? null,
    poolSize: poolSize ?? null,
    silentZeros,
    silentZeroBoards: silentZeros.length,
    lostRoles: silentZeros.reduce((n, z) => n + z.had, 0),
    bySource,
    hadPrevious: Object.keys(previousCounts || {}).length > 0, // false => first run / no history yet
    segmentCollapses,
    lostSegmentRoles: segmentCollapses.reduce((n, s) => n + s.had, 0),
    // false => no previous stats to compare against, so an empty segmentCollapses is "don't know",
    // not "all clear". Same discipline as hadPrevious: never report health we have no evidence for.
    hadPreviousSegments: Object.keys(previousSegments || {}).length > 0,
  };
}
