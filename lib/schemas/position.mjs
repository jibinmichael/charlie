// lib/schemas/position.mjs — the model boundary for the Position.
//
// Two replies cross a boundary here and both are validated before anything is trusted: the builder's
// proposed position, and the verifier's verdict on it. A reply that does not parse is not a soft
// failure to be worked around; the caller drops the position.

import { z } from "zod";

/** One fact the statement rests on, lifted from the dossier the builder was shown. */
export const PositionEvidence = z.object({
  claim: z.string().min(1),
  source: z.string().default("dossier"),
}).passthrough();

/**
 * The builder's reply.
 *
 * An EMPTY statement is valid and expected: the prompt is explicitly told to return "" when the
 * facts are too thin to say anything specific. That is a correct answer, not a parse failure, and
 * the caller stores nothing for that person.
 */
export const PositionBuild = z.object({
  statement: z.string(),
  evidence: z.array(PositionEvidence).default([]),
}).passthrough();

/** The verifier's verdict. `grounded` is the only field that decides anything. */
export const PositionVerdict = z.object({
  grounded: z.boolean(),
  violations: z.array(z.string()).default([]),
  reason: z.string().default(""),
}).passthrough();

/**
 * What is actually written to the dossier. Deliberately small: the sentence, what it rests on, and
 * enough provenance to know when it was made and by what. No score, no level, no title, no market.
 */
export const StoredPosition = z.object({
  statement: z.string().min(1),
  evidence: z.array(PositionEvidence).min(1),
  model: z.string(),
  at: z.string(),
}).passthrough();
