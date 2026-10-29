// stats.mjs — per-run measurement counters (the "baseline can't decrease" seatbelt).
//
// Pure helpers that turn a daily run's own data into a KPI snapshot + a rolling history. NO
// behavior change anywhere — this only observes, so it can never regress a send/score path. It exists
// so every later score/send change can be flipped ON only when a counter proves the baseline went UP
// (OFF -> shadow -> ON).
//
// Counters (computable from data the run already has):
//   - match_positive_rate  = passed_bar / scored           (did more roles clear the bar?)
//   - borderline_share     = scores in [60,80] / scored    (sizes the borderline band)
//   - cost_usd.match       = the Haiku batch cost           (per-feature AI cost; the dominant call)
//   - outcomes             = role_sent / digested / silent_no_send_users / grounding_held / grounding_dropped / failed
//   - per-segment coverage = written by scan-jobs into the existing pool stats
// Not yet counted: dead_apply_link_rate (needs a post-send re-fetch) and the grounding violation
// rate in SENDS; grounding HOLDS and cite-or-drop prunes are counted as the available proxy.

const BORDERLINE_LO = Number(process.env.BORDERLINE_LO || 60);
const BORDERLINE_HI = Number(process.env.BORDERLINE_HI || 80);

/**
 * Compute the match-side KPIs from a run's byEmail scores.
 * @param {Map<string, Array<{match?:{score?:number}, passed_bar?:boolean}>>} byEmail
 * @returns {{scored:number, passed_bar:number, borderline:number, match_positive_rate:number, borderline_share:number}}
 */
export function computeMatchKpis(byEmail) {
  let scored = 0;
  let passed = 0;
  let borderline = 0;
  const groups = byEmail && typeof byEmail.values === "function" ? byEmail.values() : [];
  for (const arr of groups) {
    for (const j of arr || []) {
      const s = j?.match?.score;
      if (typeof s !== "number" || Number.isNaN(s)) continue;
      scored++;
      if (j.passed_bar) passed++;
      if (s >= BORDERLINE_LO && s <= BORDERLINE_HI) borderline++;
    }
  }
  const rate = (n) => (scored ? Number((n / scored).toFixed(4)) : 0);
  return { scored, passed_bar: passed, borderline, match_positive_rate: rate(passed), borderline_share: rate(borderline) };
}

/**
 * Where the roles that CLEAR the bar were sitting in the retrieval ranking, measured at score time.
 *
 * WHY THIS EXISTS. A replay of today's ranker against stored verdicts cannot tell a bad ranker from
 * a drifting one, because the verdicts were produced against past pools and past dossiers. The
 * retrieval rank AT SCORE TIME is the missing number; `finds.slot` records the MATCHER's rank of the
 * sent role (scheduler.mjs), which is a different number entirely.
 *
 * This records it, live, per run. `above_bar_rank_p90` answers the question that matters before
 * anyone touches K: are the good roles near the top of retrieval, or scattered? Cheap, observational,
 * and it changes no decision on its own.
 *
 * `_retrievalRank` is stamped in match-batch.mjs (0-based index into selectForUser's output). It is
 * safe to carry on the job object: lib/match-cache-key.mjs projects through the JOB_KEY_FIELDS
 * ALLOWLIST, so a new field cannot alter a cache key or invalidate a stored verdict.
 *
 * @param {Map<string, Array<{_retrievalRank?:number, passed_bar?:boolean}>>} byEmail
 * @returns {{ranked:number, above_bar_ranked:number, above_bar_rank_p50:number|null, above_bar_rank_p90:number|null, above_bar_rank_max:number|null}}
 */
export function computeRetrievalRankKpis(byEmail) {
  const groups = byEmail && typeof byEmail.values === "function" ? byEmail.values() : [];
  const aboveBar = [];
  let ranked = 0;
  for (const arr of groups) {
    for (const j of arr || []) {
      if (typeof j?._retrievalRank !== "number" || !Number.isFinite(j._retrievalRank)) continue;
      ranked++;
      if (j.passed_bar) aboveBar.push(j._retrievalRank);
    }
  }
  aboveBar.sort((a, b) => a - b);
  // nearest-rank percentile; null rather than 0 when there is nothing to report, so an empty day is
  // never read as "every good role was rank 0".
  const pct = (p) => (aboveBar.length ? aboveBar[Math.min(aboveBar.length - 1, Math.ceil((p / 100) * aboveBar.length) - 1)] : null);
  return {
    ranked,
    above_bar_ranked: aboveBar.length,
    above_bar_rank_p50: pct(50),
    above_bar_rank_p90: pct(90),
    above_bar_rank_max: aboveBar.length ? aboveBar[aboveBar.length - 1] : null,
  };
}

/**
 * Merge a snapshot into a rolling history: dedup by date (last write wins for the day), keep the
 * newest `cap` days. Pure — the caller persists the result.
 * @param {Array<{date:string}>} history
 * @param {{date:string}} snapshot
 * @param {number} [cap]
 * @returns {Array<{date:string}>}
 */
export function mergeKpiHistory(history, snapshot, cap = 90) {
  const list = Array.isArray(history) ? history.filter((s) => s && s.date !== snapshot.date) : [];
  list.push(snapshot);
  list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return list.slice(-cap);
}

/** One-line human summary of a snapshot for the run log. */
export function formatKpiLine(s) {
  const pct = (x) => `${(Number(x || 0) * 100).toFixed(1)}%`;
  const o = s.outcomes || {};
  return (
    `KPI ${s.date}: match+ ${pct(s.match_positive_rate)} (${s.passed_bar}/${s.scored}) · ` +
    `borderline ${pct(s.borderline_share)} · $match ${Number(s.cost_usd?.match || 0).toFixed(4)} · ` +
    `sent ${o.role_sent ?? 0} digest ${o.digested ?? 0} silent ${o.silent_no_send_users ?? 0} ` +
    // `pruned` = ungrounded claims cite-or-drop removed before sending, printed so the enforcement
    // step's day-to-day work is visible in the run log.
    `held ${o.grounding_held ?? 0} pruned ${o.grounding_dropped ?? 0} failed ${o.failed ?? 0}` +
    (s.silent_no_send ? " · ⚠ SILENT NO-SEND" : "")
  );
}
