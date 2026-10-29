// lib/fit-veto.mjs — the ONE seam through which the Fit Engine may touch a real send.
//
// IT IS A VETO, NOT AN AUTHORITY, and that is the whole safety argument.
//
// The engine runs only AFTER the existing gate has already decided to send. It can turn that send into
// a hold. It can never turn a hold into a send, never reorder anything, never reach retrieval, and
// never see a role the gate did not already approve. So the live send set becomes
//
//     (what ships today)  MINUS  (what the engine rejects)
//
// which is strictly smaller than what ships today. The worst case of a bug in here is that Charlie
// sends FEWER emails — the safe failure direction.
//
// It is also why `off` costs nothing: with no authority the engine is never called, so there are no
// stage-1/stage-2 model calls and the send path is exactly the existing gate.
//
// Veto-only also means a role the engine would approve but the existing gate drops is still dropped.
// Giving the engine positive authority is a different and much larger change, and it has not been made.

import { fitAuthority } from "./fit-authority.mjs";
import { sendDecision } from "./send-rule.mjs";
import { fitDecisionRecord } from "./fit-record.mjs";
import { stage1Requirements, stage2Judge } from "./fit-stage.mjs";

/**
 * Ask the engine about a role the gate has already approved.
 *
 * @param {object} o
 * @param {string} o.email
 * @param {object} o.dossier
 * @param {object} o.job                 the approved posting
 * @param {Map}    [o.cache]             stage-1 cache, shared across a run
 * @param {function} [o.log]
 * @param {object} [o.deps]              injectable for tests: { stage1, stage2, authority, now }
 * @returns {Promise<{veto: boolean, record: object|null, authority: string}>}
 *          veto=true ONLY when authority is "enforce" AND the engine rejected it.
 */
export async function fitVeto({ email, dossier, job, cache, log = console.error, deps } = {}) {
  const authority = (deps?.authority || fitAuthority)(email);
  if (authority === "off") return { veto: false, record: null, authority: "off" };

  const stage1 = deps?.stage1 || stage1Requirements;
  const stage2 = deps?.stage2 || stage2Judge;
  try {
    // DESTRUCTURE. stage1Requirements returns { key, cached, requirements } — NOT the array. Reading
    // the return value as the array would make `Array.isArray(...)` always false, so the fail-open
    // branch below would fire on every call and the engine would silently decide nothing. Test
    // doubles must return the same shape, or they agree with the bug.
    const { requirements } = await stage1(job, cache);
    if (!Array.isArray(requirements) || !requirements.length) {
      // FAIL OPEN, DELIBERATELY. No requirement list means the engine has no opinion, and an engine
      // with no opinion must not silence an email the existing gate approved on its own evidence.
      log(`[fit-veto] ${email}: no requirement list for ${job?.id} — no opinion, send stands`);
      return { veto: false, record: null, authority };
    }
    const judged = await stage2({ requirements, dossier, job, today: deps?.now });
    const decision = sendDecision(judged, { jobTitle: job?.title, dossier });
    const record = fitDecisionRecord({
      email, jobId: job?.id, jobTitle: job?.title, decision, requirements: judged, authority, at: deps?.now,
    });
    const veto = authority === "enforce" && decision.send !== true;
    log(`[fit-veto] ${email}: ${job?.company} — ${decision.send ? "agrees" : "would hold"} (${decision.why}) · authority=${authority}${veto ? " · VETOED" : ""}`);
    return { veto, record, authority };
  } catch (err) {
    // FAIL OPEN ON INFRASTRUCTURE, NOT ON JUDGEMENT. A timeout, a 500 or a parse failure is not the
    // engine deciding someone is unqualified, and treating it as one would silence people for reasons
    // that have nothing to do with them. A JUDGEMENT to hold is honoured above; an ERROR is not.
    log(`[fit-veto] ${email}: engine error, send stands — ${err?.message}`);
    return { veto: false, record: null, authority };
  }
}
