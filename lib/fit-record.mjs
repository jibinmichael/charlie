// lib/fit-record.mjs — the decision record persisted behind every engine-authorized send.
//
// WHY IT EXISTS. If Charlie ever tells someone "these are the things this role asks for that you have
// actually done", that claim has to be answerable months later, from storage, without re-running a
// model. Not a summary of the decision — THE decision: the same requirement rows the operator read,
// with the same statuses, the same evidence strengths and the same citations.
//
// IT IS NOT A SECOND SCORE. Nothing here is computed, weighted or graded. Every field is copied from
// what the engine already produced, plus the identifiers needed to tie it to a moment in time.
//
// WHERE IT LIVES. `finds.match.fit_decision` — an existing JSONB column on an existing table. No
// migration, per the standing constraint to prefer existing storage. A reader that does not know about
// `fit_decision` sees exactly the `match` object it saw before.

import { buildId } from "./build-id.mjs";

/** The engine identity that produced a decision. Kept separate so a replay can be attributed. */
export function engineStamp() {
  return { build: buildId() || null, model: process.env.FIT_MODEL || "claude-sonnet-4-6", rule: "D1+level" };
}

/**
 * Build the persisted record. Copies, never computes.
 *
 * @param {object}   o
 * @param {string}   o.email          who the decision was about
 * @param {string}   o.jobId          which posting
 * @param {string}   o.jobTitle
 * @param {object}   o.decision       the sendDecision() result
 * @param {object[]} o.requirements   the engine's enriched requirement rows
 * @param {string}   o.authority      "off" | "shadow" | "enforce" — what the engine was allowed to do
 * @param {string}   [o.at]           ISO timestamp; injectable so a test is not time-dependent
 */
export function fitDecisionRecord({ email, jobId, jobTitle, decision, requirements, authority, at } = {}) {
  const rows = Array.isArray(requirements) ? requirements : [];
  const gating = rows.filter((r) => r && r.gating === true && r.kind !== "constraint");
  // One shape for every row, so a satisfied and an unmet row are read the same way.
  const row = (r) => ({
    req: r.req ?? null,
    kind: r.kind ?? null,
    tool: r.tool ?? null,
    status: r.status ?? null,
    evidence_strength: r.evidence_strength ?? null,
    evidence: r.evidence ?? null,
    locator: r.locator ?? null,
    outcome: r.outcome ?? null,
    why: r.why ?? null,
    blocks: r.blocks ?? null,
  });
  return {
    email: String(email ?? "").toLowerCase() || null,
    job_id: jobId ?? null,
    job_title: jobTitle ?? null,
    authority: authority ?? "off",
    send: decision?.send === true,
    why: decision?.why ?? null,
    satisfied_count: decision?.satisfied ?? null,
    gating_total: decision?.total ?? null,
    anchors: decision?.anchors ?? null,
    satisfied: gating.filter((r) => r.outcome === "satisfied").map(row),
    unmet: gating.filter((r) => r.outcome !== "satisfied").map(row),
    // A contradiction is the one thing that must never be reconstructible only by inference later.
    contradictions: gating.filter((r) => r.status === "contradicted").map(row),
    engine: engineStamp(),
    at: at || new Date().toISOString(),
  };
}
