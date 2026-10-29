// lib/role-level.mjs — what level is this ROLE, and is it beneath the level this person asked for?
//
// Without a role level, the person's level (`levelOf`, market-report.mjs) has nothing to be compared
// against, and the middle of the ladder is one undifferentiated blob: select-jobs.mjs drops interns
// for senior people and VP roles for non-execs, but "Product Designer II", "Group Product Manager"
// and "Product Management Director" would be equally eligible for everyone. A person asking for
// Director/VP roles would be sent Senior PM roles while the Director roles sat unsent.
//
// TWO RULES GOVERN EVERYTHING HERE:
//   1. Unknown is silent. Most live titles carry no level word, and a bare "Product Manager" is mid
//      at one company and senior at another. We return null and hold no opinion, exactly as
//      role-reqs.mjs returns null rather than inventing a years floor.
//   2. Compare against what they ASKED FOR, not what we think they are. See seniorityFloor.
import { extractMinYears } from "../role-reqs.mjs";

/** The ladder, low to high. Same vocabulary as levelOf() in market-report.mjs — deliberately. */
export const RUNG = { apm: 0, ic: 1, senior: 2, principalStaff: 3, director: 4, exec: 5 };

// Title patterns, highest first. Mirrors market-report.mjs's SELF_* set so the person side and the
// role side can never disagree about what a word means.
const TITLE_LEVEL = [
  ["exec", /\bchief\b(?! of staff)|\b(cpo|cto|coo|ceo|cfo|vp|svp|evp|vice president|head of)\b/i],
  ["director", /\bdirector\b/i],
  ["principalStaff", /\bprincipal\b|(?<!of )\bstaff\b|\bdistinguished\b|\bfellow\b/i],
  ["apm", /\b(intern|internship|fresher|entry.?level|graduate|new ?grad|trainee|apprentice|junior|jr\.?|associate)\b/i],
  ["senior", /\b(senior|sr\.?)\b/i],
];

// A company-internal ladder: "Analyst II", "Software Engineer III", "Designer 2". These are NOT
// comparable across employers — "Designer II" is Adobe's scale, not an industry rung — so the number
// is never decoded. It only marks the title as one we may read the JD's own years floor for.
const NUMBERED = /\b(I{1,3}|IV|[1-4])\b\s*$|\b(I{1,3}|IV|[1-4])\b\s*[,(]/;

/**
 * The rung a POSTING sits at, or null when the title says nothing unambiguous.
 *
 * Two readings, in order:
 *   1. An explicit level word in the title.
 *   2. Failing that, a numbered ladder with NO level word, decoded by the years floor the employer
 *      states in the JD — "Analytics Engineer II" says 3 years, "Product Security Engineer II" says 2. The number stays
 *      uninterpreted; the years are the same claim at every company.
 *
 * Years never buy a rung above `senior`, mirroring levelOf()'s identical restraint: a high floor
 * means experience, not authority, and a Staff role that asks for 5 years must not read as junior.
 *
 * @param {{title?:string, description?:string}} job
 * @returns {"apm"|"ic"|"senior"|"principalStaff"|"director"|"exec"|null}
 */
export function roleLevelOf(job) {
  const title = String(job?.title || "");
  if (!title.trim()) return null;
  for (const [rung, re] of TITLE_LEVEL) if (re.test(title)) return rung;
  if (!NUMBERED.test(title)) return null;
  const yrs = extractMinYears(`${title}. ${job?.description || ""}`);
  if (yrs == null) return null; // a numbered title with no stated floor stays unreadable
  if (yrs < 2) return "apm";
  if (yrs < 5) return "ic";
  return "senior";
}

/**
 * The LOWEST level this person said they would take, and whether they said it or we inferred it.
 *
 * THE POINT OF THIS FUNCTION. Someone whose stated target is "Chief Operating Officer, VP of Operations,
 * Director of Operations" has a `levelOf` of `exec`, because COO is the first thing the target names.
 * But they named three levels, so Director is INSIDE what they asked for, not one below it.
 * Comparing against the top rung would hold a well-matched Director role. A stated target is a
 * RANGE, and its floor is the bar.
 *
 * select-jobs.mjs already holds this line for role families: a stated preference gates, an
 * inferred one must not be enforced as if the person had said it. Hence `basis`, which the caller
 * uses to demand a wider gap before acting on a guess.
 *
 * @param {object} dossier
 * @param {(d:object)=>string} levelOf  injected from market-report.mjs (keeps this module dependency-light + testable)
 * @returns {{rung: string, basis: "stated"|"inferred"}}
 */
export function seniorityFloor(dossier, levelOf) {
  const p = (dossier && dossier.preferences) || {};
  const said = `${p.seniority || ""} ${p.role || ""}`;
  const named = TITLE_LEVEL.filter(([, re]) => re.test(said)).map(([rung]) => rung);
  if (named.length) return { rung: named.reduce((a, b) => (RUNG[a] <= RUNG[b] ? a : b)), basis: "stated" };
  return { rung: levelOf(dossier || {}), basis: "inferred" };
}

// How far below the floor a role must sit before we act. A STATED floor is the person's own bar, so
// anything under it is a miss they already told us about. An INFERRED floor is our read of them, so
// it takes a two-rung gap before we enforce it — over-blocking on a guess silently buries real roles.
const GAP_STATED = 1;
const GAP_INFERRED = 2;

export function seniorityMode() {
  return String(process.env.SENIORITY_GATE || "shadow").toLowerCase();
}

/**
 * Is this role beneath the level the person asked for? Null-safe and silent by default.
 * @returns {{below: boolean, roleRung: string|null, floor: string, basis: string, reason: string}}
 */
export function seniorityVerdict(job, dossier, levelOf) {
  const roleRung = roleLevelOf(job);
  const floor = seniorityFloor(dossier, levelOf);
  if (!roleRung) return { below: false, roleRung: null, floor: floor.rung, basis: floor.basis, reason: "role level unknown" };
  const gap = RUNG[floor.rung] - RUNG[roleRung];
  const need = floor.basis === "stated" ? GAP_STATED : GAP_INFERRED;
  if (gap < need) return { below: false, roleRung, floor: floor.rung, basis: floor.basis, reason: "at or above the level asked for" };
  return {
    below: true,
    roleRung,
    floor: floor.rung,
    basis: floor.basis,
    reason: `this is a ${roleRung} role and you asked for ${floor.rung} or above`,
  };
}
