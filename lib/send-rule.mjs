// lib/send-rule.mjs — the SEND rule (proportional D1 + the level gate). SHADOW ONLY.
//
// STATUS: imported by nothing that decides or sends. It sits ABOVE the frozen operator and never
// reaches into it: every protection `lib/fit-decision.mjs` enforces is inherited by calling
// `requirementOutcome`, never by re-implementing a rule here.
//
// WHY IT IS A SEPARATE MODULE. The operator answers "what does this person's record show about each
// stated requirement". This module answers a different one — "how much of that must be shown before
// Charlie will put the role in front of someone" — which is a PRODUCT decision. Keeping them apart
// means the product question can move without editing the operator.
//
// WHAT IT IMPLEMENTS
//   D1  proportional: at least 70% of the posting's stated gating requirements demonstrated. The 0.70
//       sits in the gap between the cases worth defending (~0.7 and above) and the ones that are not
//       (~0.4 and below).
//   L   the level gate, below.
//
// EVERYTHING ELSE IS INHERITED, NOT RESTATED: contradiction is never a send; met+self-reported and
// partial+adjacent never satisfy; at least one direct anchor; tolerated may not exceed satisfied; the
// decided floor of 3. Change any of those in fit-decision.mjs and this module changes with it.

import { requirementOutcome } from "./fit-decision.mjs";

/** The share of stated requirements that must be demonstrated. Not a knob — see the header. */
export const D1_RATIO = 0.70;

// ── THE LEVEL GATE ───────────────────────────────────────────────────────────────────────────────
//
// A role whose TITLE states a level the person's OWN RECORD does not claim for themselves is a
// CONTRADICTION, not a near-miss. This is protection 1 on an axis the engine already has.
//
// THE CASE IT EXISTS FOR: a "Sr. Firmware Engineer" posting proposed to a short record whose
// own preferences read "Embedded Engineer II" — a band below the title, in the person's own words. D1
// sends it because 5 of 7 clears 70%, and nothing else in the pipeline compares a title's level to a
// person's. The posting states no years floor, so durationVerdict has no band to compute against.
//
// WHY IT READS THEIR WORDS AND NOT OURS. `preferences.seniority` and `preferences.role` are what the
// person wrote about themselves during onboarding. Judging their level from anything else — a title we
// parsed, a duration we derived — would be Charlie deciding who someone is. If they say senior, senior
// is what they get measured against.
//
// WHY IT IS NOT A SCORE. The bands below are a LATTICE OF WORDS, compared for ORDER only. Nothing is
// summed, averaged or weighted, no number was chosen, and there is no threshold to tune. Two labels
// are either in the same band or one is above the other.
//
// IT IS SUBTRACTIVE. It can only remove a candidate, never create one — so it is structurally
// incapable of introducing a false positive.
//
// THE GAP, STATED HERE RATHER THAN DISCOVERED LATER: many users state no level in either field, and
// for them this gate cannot fire at all. It is a gate, not a solution.
const BANDS = [
  [1, /\b(intern|fresher|trainee|graduate|entry[- ]?level|apprentice|student)\b/i],
  [2, /\b(junior|jr\.?|associate|engineer i{1,2}\b|analyst i{1,2}\b|developer i{1,2}\b)\b/i],
  [3, /\b(mid[- ]?level|intermediate)\b/i],
  [4, /\b(senior|sr\.?)\b/i],
  [5, /\b(staff|principal|lead|architect)\b/i],
  [6, /\b(director|head of|vp|vice president|chief|founding|cto|cpo|cio)\b/i],
];

/** The highest level word present in a string. 0 when it states none. */
export function levelBand(text) {
  let b = 0;
  for (const [n, re] of BANDS) if (re.test(String(text || ""))) b = Math.max(b, n);
  return b;
}

/** The highest level the person states for THEMSELVES, across the two fields they filled in. */
export function claimedBand(dossier) {
  const p = dossier?.preferences || {};
  return Math.max(levelBand(p.seniority), levelBand(p.role));
}

/**
 * A level contradiction, or null.
 * Fails OPEN in two places, both deliberate and both narrow:
 *   - the title states no senior-band level  -> there is nothing to contradict
 *   - the person states no level at all      -> we will not infer one for them (see THE GAP above)
 */
export function levelContradiction(jobTitle, dossier) {
  const role = levelBand(jobTitle);
  if (role < 4) return null;
  const claim = claimedBand(dossier);
  if (claim === 0) return null;
  return claim < role ? { role, claim } : null;
}

// ── THE SEND DECISION ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object[]} requirements  the engine's enriched requirement records
 * @param {object}   [opts]
 * @param {string}   [opts.jobTitle]
 * @param {object}   [opts.dossier]
 * @param {number}   [opts.gatingFloor=3]
 * @returns {{send: boolean, why: string, satisfied: number, total: number, anchors: number, unmet: object[]}}
 */
export function sendDecision(requirements, opts = {}) {
  const floor = Number.isFinite(opts.gatingFloor) ? opts.gatingFloor : 3;
  const gating = (Array.isArray(requirements) ? requirements : [])
    .filter((r) => r && r.gating === true && r.kind !== "constraint");
  const no = (why) => ({ send: false, why, satisfied: 0, total: gating.length, anchors: 0, unmet: [] });

  if (gating.length < Math.max(1, floor)) return no(`only ${gating.length} required things stated — too few to be a screen`);

  const scored = gating.map((r) => ({ r, o: requirementOutcome(r, () => true) }));
  if (scored.some((x) => x.o.why === "contradicted" || /^(over|under)-/.test(x.o.why || "")))
    return no("their record contradicts something the posting requires");

  const satisfied = scored.filter((x) => x.o.outcome === "satisfied");
  const tolerated = scored.filter((x) => x.o.outcome !== "satisfied" && x.o.blocks === false);
  const unmet = scored.filter((x) => x.o.outcome !== "satisfied").map((x) => x.r);
  const anchors = satisfied.filter((x) => x.o.anchors).length;
  const base = { satisfied: satisfied.length, total: gating.length, anchors, unmet };

  if (satisfied.length < Math.max(1, floor)) return { ...base, send: false, why: `only ${satisfied.length} of ${gating.length} decided` };
  if (!anchors) return { ...base, send: false, why: "nothing is shown directly" };
  if (tolerated.length > satisfied.length) return { ...base, send: false, why: "more of this role was assumed than demonstrated" };

  // THE LEVEL GATE RUNS LAST AND ONLY ON A CANDIDATE THAT HAS OTHERWISE CLEARED. It is a veto over a
  // decision already made, never an input to one — which is what keeps it subtractive.
  const lc = levelContradiction(opts.jobTitle, opts.dossier);
  if (lc) return { ...base, send: false, why: `the posting is a level above what their own record claims (${lc.role} vs ${lc.claim})` };

  if (satisfied.length / gating.length < D1_RATIO)
    return { ...base, send: false, why: `${satisfied.length} of ${gating.length} demonstrated` };

  return { ...base, send: true, why: `${satisfied.length} of ${gating.length} required things shown in their own record (${anchors} direct)` };
}
