// digest-select.mjs — the weekly digest's selection rule, extracted so it can be tested.
//
// WHY THIS IS ITS OWN MODULE: digest.mjs is a top-level script (it connects to Supabase and runs on
// import), so its selection loop could not be imported by a test. Testing only the parts
// (repeatDecision, dripGuard) misses defects in the loop that combines them, so the rule lives here,
// pure and injectable, and digest.mjs imports it.
//
// THE DEFECT THIS ENCODES AGAINST (do not undo it):
// getEmailedRoleSignatures reads statuses [emailed, digest, new] — which INCLUDES the 'digest' finds
// the digest is about to show. Called without excluding them, every near-miss matches its OWN canonical
// identity, repeatDecision drops all of them, and the digest sends nothing while consuming its queue.
// The caller MUST pass a signature set built with { excludeIds: <the digest finds' own ids> }. The
// same self-match trap applies in first-role.mjs.
//
// CONSUMPTION RULE: a find is consumed (retired to 'digest_sent') only when it is genuinely finished
// with — shown, already-emailed, or dead. A find we simply could not fit under the cap is NOT consumed;
// it rolls to next week. Never destroy a live near-miss the person was never shown.

import { roleKey } from "./charlie-store.mjs";
import { repeatDecision } from "./presend-guard.mjs";

/**
 * Decide what goes in this user's digest, and what is retired.
 *
 * @param {object[]} digestFinds  the user's status:'digest' finds
 * @param {object}   sig          getEmailedRoleSignatures(email, { excludeIds: ownIds }) — MUST exclude
 *                                the digestFinds' own ids, or every item self-drops. null = unavailable.
 * @param {Set}      emailedKeys  getEmailedRoleKeys(email) — roles already sent solo
 * @param {number}   cap          max items to show
 * @param {Function} isLive       async (job) => boolean — liveness re-verify
 * @param {Function} noteFor      (find) => string — the per-item "why it's here" line
 * @param {Function} introFor     (job, findId) => string|null — the warm-intro mailto
 * @returns {Promise<{items: object[], consumed: string[]}>}
 */
export async function selectDigestItems({ digestFinds = [], sig = null, emailedKeys = new Set(), cap = 5, isLive = async () => true, noteFor = () => "", introFor = () => null } = {}) {
  const seen = new Set();
  const items = [];
  const consumed = [];
  for (const f of digestFinds) {
    const job = f.job || {};
    const key = roleKey(job.company, job.title);
    if (emailedKeys.has(key) || seen.has(key)) { consumed.push(f.id); continue; } // already sent solo, or dup within this digest
    if (repeatDecision(job, sig)) { consumed.push(f.id); continue; }              // already emailed by ANY vector (or a retitled repost)
    if (items.length >= cap) continue;                                            // capped — leave it for next week, do NOT consume
    if (!(await isLive(job))) { consumed.push(f.id); continue; }                  // closed since we flagged it — drop
    seen.add(key);
    consumed.push(f.id);
    items.push({ role: job.title, company: job.company, location: job.location, applyUrl: job.apply_url, note: noteFor(f), introMailto: introFor(job, f.id) });
  }
  return { items, consumed };
}
