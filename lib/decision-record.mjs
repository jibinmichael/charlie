// decision-record.mjs — the machine-readable answer to "why this role, for this person, today".
//
// A HELD role says why it was held (`composed.digest_rule`). This gives a SENT role the same: the gate
// name, an evidence summary, and what the sent role was chosen OVER. "Defend why this role is a good
// recommendation for this person" is a comparative claim, so the roles it beat are recorded on the
// find rather than left in log lines that age out.
//
// PURE, so the record can be asserted without a database, a model or a send.
//
// IT RECORDS, IT DOES NOT DECIDE. Nothing here gates anything. `matcher` is written down precisely so
// it can stop being authoritative while remaining measurable: a feature has to be logged before it can
// be evaluated.

/**
 * Requirements the JD stated, that the person's own material actually evidences.
 * `unknown` earns nothing — unproven is not credited (the same rule as fit-coverage.mjs).
 */
function evidenced(cov) {
  const reqs = Array.isArray(cov?.coverage) ? cov.coverage : [];
  return reqs.filter((r) => r && r.status === "met" && typeof r.evidence === "string" && r.evidence.trim()).length;
}

/**
 * The seed of the defensibility test the rebuild is aiming at: can the system NAME the evidence?
 *
 * Deliberately NOT a threshold on a score. It asks a structural question — is there at least one
 * requirement this posting actually asked for, which this person's own material actually shows, with
 * the citation attached. Recorded now, acting on nothing, so the criterion has a measured baseline
 * before it is ever allowed to gate a send.
 */
export function defensible(cov) {
  return evidenced(cov) >= 1;
}

/**
 * @param {{
 *   rule: string|null,                 the gate name that returned "send"
 *   job: any,                          the chosen role (carries the _retrieval* transport fields)
 *   match: any,                        the matcher verdict — recorded, never authoritative
 *   cov: any,                          the grounded coverage result, or {thin:true}
 *   slot: number|null,                 the sent role's matcher rank
 *   considered: any[],                 every role this walk judged, in order
 *   rankedBy: string[],                which re-rankers were live for this walk
 * }} args
 */
export function decisionRecord({ rule = null, job = null, match = null, cov = null, slot = null, considered = [], rankedBy = [] } = {}) {
  const list = Array.isArray(considered) ? considered : [];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const counts = cov?.counts && typeof cov.counts === "object" ? cov.counts : {};
  return {
    outcome: "send",
    rule,
    slot: num(slot),
    ranked_by: Array.isArray(rankedBy) ? rankedBy.filter(Boolean) : [],
    retrieval: {
      rank: num(job?._retrievalRank),
      lexical: num(job?._relScore),
      semantic: num(job?._semScore),
      blend: num(job?._blendScore),
    },
    // Written down, not obeyed. See the header.
    matcher: {
      score: num(match?.score),
      verdict: typeof match?.verdict === "string" ? match.verdict : null,
      dealbreaker_hit: match?.dealbreaker_hit === true,
    },
    grounded: {
      thin: cov?.thin === true,
      composite: num(cov?.composite),
      lane: typeof cov?.lane === "string" ? cov.lane : null,
      met: num(counts.met),
      partial: num(counts.partial),
      unknown: num(counts.unknown),
      evidenced: evidenced(cov),
      defensible: defensible(cov),
    },
    // What it beat. The losers carry their own gate name, so a disagreement between the matcher's
    // order and the gate's verdict is queryable rather than anecdotal.
    considered: list.map((c) => ({
      company: c?.company ?? null,
      title: c?.title ?? null,
      slot: num(c?.slot),
      retrieval_rank: num(c?.retrieval_rank),
      outcome: c?.outcome ?? null,
      rule: c?.rule ?? null,
    })),
  };
}
