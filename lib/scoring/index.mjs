// lib/scoring/index.mjs — the pluggable candidate scorer. Qualify & Submit (lib/qualify/wiring.mjs) asks it one
// question per person and role: does this person fit well enough to be asked about the role (and, after they answer,
// to be put forward)? Nothing else in the codebase decides fit.
//
// CHOOSING ONE. CANDIDATE_SCORER selects the scorer (read when createScorer is called):
//   pieworks  (the default) the AI score Pieworks sends with a person in its 2call webhook (POST /webhooks/pieworks,
//             stored by lib/pieworks-activation.mjs in pieworks_activations.candidate). Passes at or above
//             PIEWORKS_SCORE_THRESHOLD (default 70, on a 0..100 scale). A person Pieworks has sent no score for does
//             not pass: no score is never read as a good score.
//   none      everyone passes with no score, for teams that review every person by hand. The agent still asks each
//             person's consent first, and still submits nobody until a person approves them in the Inbox.
//   <yours>   any name you register with registerScorer() before the agent runs (see below).
//
// THE INTERFACE (plug your own):
//
//   import { registerScorer } from "./lib/scoring/index.mjs";
//   registerScorer("my-model", ({ env, db }) => ({
//     name: "my-model",
//     async score(candidate, role) {
//       const s = await myModel(candidate, role);          // anything: a model, rules, a vendor API
//       return { score: s, pass: s >= 60, reasons: ["Has shipped mobile releases", "4 years, inside the band"] };
//     },
//   }));
//   // then run with CANDIDATE_SCORER=my-model
//
// The result is checked on the way out (normalizeResult): score is a number from 0 to 100 or null, pass is a boolean,
// reasons are at most 10 short strings. A scorer that throws, or returns anything else, is read as
// { score: null, pass: false } with the reason: a broken scorer fails closed and never lets anyone through.
// Reasons are shown to the people running the agent; they are never emailed and never sent to an employer.

/**
 * What a scorer is given about a person. Everything comes from Charlie's own records (talent_pool) and, after the
 * person replies, from their own answers. Fields can be null.
 * @typedef {object} ScoringCandidate
 * @property {string} candidate_id  a stable id for the person (derived from their address)
 * @property {string} email
 * @property {string|null} full_name
 * @property {string|null} current_title
 * @property {string|null} current_company
 * @property {string|null} headline
 * @property {number|null} total_years
 * @property {string|null} city
 * @property {string|null} country
 * @property {string|null} linkedin_url
 * @property {string[]|null} top_skills
 * @property {Array<{question: string, answer: string}>} [answers]  their verbatim answers, once they replied
 * @property {string|null} [cv_text]  the text of the CV they sent, once they sent one
 */

/**
 * What a scorer is given about the role: the employer system's own fields, never a model's reading of them.
 * @typedef {object} ScoringRole
 * @property {string} id  the job id (hire_jobs)
 * @property {string|null} external_id  the role's id in the source system (for Pieworks, its requirementId)
 * @property {string|null} source  the connection's source type ("pieworks", ...)
 * @property {string} title
 * @property {string} client
 * @property {string|null} location
 * @property {string[]} must_haves  the role's mandatory skills, one line each, verbatim
 * @property {{min: number, max: number|null}|null} experience  the role's years band
 * @property {object} payload  the role exactly as the source sent it
 */

/**
 * @typedef {object} ScoreResult
 * @property {number|null} score  0..100, or null when the scorer has no number (the "none" scorer, a missing score)
 * @property {boolean} pass  true when the person may be asked about the role (and later put forward)
 * @property {string[]} reasons  why, in plain words; at most 10
 */

/**
 * @typedef {object} Scorer
 * @property {string} name
 * @property {(candidate: ScoringCandidate, role: ScoringRole) => Promise<ScoreResult>} score
 */

/** @typedef {(ctx: { env: Record<string, string|undefined>, db: any }) => Scorer} ScorerFactory */

export const DEFAULT_SCORER = "pieworks";
export const DEFAULT_PIEWORKS_THRESHOLD = 70;

/** A scorer's answer made safe: anything malformed fails closed. Pure. */
export function normalizeResult(r, name = "scorer") {
  if (!r || typeof r !== "object" || typeof r.pass !== "boolean") return { score: null, pass: false, reasons: [`${name} returned no usable answer`] };
  const n = r.score == null ? null : Number(r.score);
  if (n != null && (!Number.isFinite(n) || n < 0 || n > 100)) return { score: null, pass: false, reasons: [`${name} returned a score outside 0 to 100`] };
  const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 10);
  return { score: n == null ? null : Math.round(n * 10) / 10, pass: r.pass, reasons };
}

/** The threshold from PIEWORKS_SCORE_THRESHOLD, or the default when it is missing or not a number in 0..100. Pure. */
export function pieworksThreshold(env = process.env) {
  const raw = String(env.PIEWORKS_SCORE_THRESHOLD ?? "").trim();
  const v = raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_PIEWORKS_THRESHOLD;
}

/** The numeric AI score inside a stored Pieworks webhook record, or null. Pieworks' field name is read leniently. Pure. */
export function pieworksScoreOf(record) {
  if (!record || typeof record !== "object") return null;
  for (const k of ["aiScore", "ai_score", "score", "matchScore"]) {
    const v = record[k];
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return null;
}

/**
 * The latest Pieworks score for this person: the row for this role when there is one, else their latest row.
 * Reads pieworks_activations (migration 20261026120000) by address. Impure.
 */
export async function pieworksLookup(db, candidate, role) {
  const email = String(candidate?.email || "").trim().toLowerCase();
  if (!db || !email) return null;
  const { data, error } = await db.from("pieworks_activations").select("requirement_id, candidate, received_at").eq("email", email).order("received_at", { ascending: false }).limit(20);
  if (error) throw new Error(`pieworks_activations: ${error.message}`);
  const rows = data || [];
  const ext = role?.external_id == null ? null : String(role.external_id);
  const forRole = ext ? rows.find((r) => String(r.requirement_id) === ext) : null;
  for (const r of forRole ? [forRole, ...rows] : rows) {
    const s = pieworksScoreOf(r.candidate);
    if (s != null) return { score: s, same_role: r === forRole };
  }
  return null;
}

/** @type {Record<string, ScorerFactory>} */
const FACTORIES = {
  none: () => ({
    name: "none",
    async score() { return { score: null, pass: true, reasons: ["No scorer: every person is passed on for a person to review"] }; },
  }),
  pieworks: ({ env, db, lookup = pieworksLookup }) => {
    const threshold = pieworksThreshold(env);
    return {
      name: "pieworks",
      async score(candidate, role) {
        const hit = await lookup(db, candidate, role);
        if (!hit) return { score: null, pass: false, reasons: ["Pieworks has sent no score for this person"] };
        const pass = hit.score >= threshold;
        return { score: hit.score, pass, reasons: [`Pieworks AI score ${hit.score} ${pass ? "is at or above" : "is below"} ${threshold}${hit.same_role ? "" : " (scored for another role)"}`] };
      },
    };
  },
};

/** Add (or replace) a scorer by name. Call before createScorer. */
export function registerScorer(name, factory) {
  const n = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(n)) throw new Error(`a scorer name is 1 to 40 of a-z, 0-9, _ and -: "${name}"`);
  if (typeof factory !== "function") throw new Error("registerScorer needs a factory function");
  FACTORIES[n] = factory;
}

/** The names that can be chosen with CANDIDATE_SCORER. */
export const scorerNames = () => Object.keys(FACTORIES);

/**
 * The scorer CANDIDATE_SCORER names (default "pieworks"). An unknown name throws: the agent then fails its run loudly
 * rather than guessing who fits. Every result passes through normalizeResult, and a throw becomes a fail-closed answer.
 * @param {{ name?: string, env?: Record<string, string|undefined>, db?: any, lookup?: Function }} [opts]
 * @returns {Scorer}
 */
export function createScorer({ name, env = process.env, db = null, lookup } = {}) {
  const chosen = String(name ?? env.CANDIDATE_SCORER ?? "").trim().toLowerCase() || DEFAULT_SCORER;
  const factory = FACTORIES[chosen];
  if (!factory) throw new Error(`CANDIDATE_SCORER="${chosen}" is not a known scorer (known: ${scorerNames().join(", ")})`);
  const inner = factory({ env, db, ...(lookup ? { lookup } : {}) });
  return {
    name: inner.name || chosen,
    async score(candidate, role) {
      try {
        return normalizeResult(await inner.score(candidate, role), inner.name || chosen);
      } catch (e) {
        return { score: null, pass: false, reasons: [`the ${inner.name || chosen} scorer failed: ${String(e?.message || e).slice(0, 160)}`] };
      }
    },
  };
}
