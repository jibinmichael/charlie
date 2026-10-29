// prompts/match-scoring.mjs — the matching / scoring request builder.
//
// WHAT IT DOES: assembles the Anthropic request that scores ONE job against ONE candidate's
//   dossier. The rubric itself is human-edited in `matcher.md` (loaded here, never inlined).
//   This centralizes the request scaffolding (system prefix caching + the `## DOSSIER` /
//   `## TODAY` / `## JOB` block wrappers) shared by match-batch.mjs, match-one.mjs and the debug scripts.
// MODEL: Haiku 4.5 (the caller passes the model id; the daily path uses the Batch API).
// EXPECTED OUTPUT: JSON conforming to lib/schemas/match-output.mjs (MatchOutput) —
//   { score, verdict, chips?, why_you?, flag?, dealbreaker_hit? }.
// VALIDATED AT: match-batch.mjs / match-one.mjs (MatchOutput.safeParse on the reply; log + skip on fail).
//
//

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MatchOutputFormat } from "../lib/schemas/match-output.mjs"; // constrained-decoding format

const RUBRIC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "matcher.md");

/** Load the human-edited scoring rubric (matcher.md). */
export function loadMatcherRubric() {
  return readFileSync(RUBRIC_PATH, "utf8");
}

/**
 * Build the message-shaped scoring request (system blocks + user message) for one job.
 * The matcher rubric + dossier are cache-controlled prefixes so repeated scoring is cheap.
 *
 * @param {object}  o
 * @param {string}  o.matcherText   the rubric text (from loadMatcherRubric())
 * @param {string}  o.dossierText   the candidate dossier as text/JSON
 * @param {unknown} o.job           the job posting object (JSON-serialized into the user turn)
 * @param {string|null} [o.todayLine]  the TODAY line (e.g. `2026-07-12 (a past date is not "future")`); null = omit the TODAY block
 * @param {boolean} [o.constrained]  attach `output_config.format` (MatchOutputFormat) so the
 *   reply is schema-valid by construction. The Zod `MatchOutput.safeParse` stays the semantic gate.
 * @param {boolean} [o.cache]  attach cache_control to the matcher + dossier system blocks. Default
 *   true (match-one's sequential reuse genuinely warms the prefix). The batch
 *   caller passes false when MATCH_BATCH_CACHE=off, since its concurrent siblings never warm the
 *   shared prefix and the cache_write would bill 1.25x for reads that never happen. Prompt bytes are
 *   identical either way — only the billing envelope changes.
 * @returns {{ system: Array<object>, messages: Array<object>, output_config?: object }}
 */
export function buildScoringMessages({ matcherText, dossierText, job, todayLine = null, constrained = false, cache = true }) {
  const cc = cache ? { cache_control: { type: "ephemeral" } } : {};
  const system = [
    { type: "text", text: matcherText, ...cc },
    { type: "text", text: `## DOSSIER\n\n${dossierText}`, ...cc },
  ];
  const content = `${todayLine ? `## TODAY\n\n${todayLine}\n\n` : ""}## JOB\n\n${JSON.stringify(job, null, 2)}`;
  // output_config is a response-format constraint, NOT part of the cached system/messages prefix, so
  // attaching it doesn't invalidate the matcher/dossier prompt cache (structured-output schemas are
  // compiled + cached separately by the API).
  return { system, messages: [{ role: "user", content }], ...(constrained ? { output_config: { format: MatchOutputFormat } } : {}) };
}

/** Convenience: the full `messages.create` params (adds model + max_tokens). */
export function buildScoringRequest({ matcherText, dossierText, job, model, maxTokens, todayLine = null, constrained = false, cache = true }) {
  return { model, max_tokens: maxTokens, ...buildScoringMessages({ matcherText, dossierText, job, todayLine, constrained, cache }) };
}
