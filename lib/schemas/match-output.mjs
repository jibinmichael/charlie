// lib/schemas/match-output.mjs — Zod schema for the matching/scoring model output.
// External boundary: the JSON a scoring call (matcher.md) is expected to return. Callers
// (match-batch.mjs / match-one.mjs) safeParse against this; on failure they log + skip the
// record (score it 0), never crash the run. Shape mirrors matcher.md's OUTPUT block.
import { z } from "zod";

export const MatchOutput = z
  .object({
    score: z.number().min(0).max(100), // 0-100
    verdict: z.enum(["exceptional", "strong", "worth a look", "skip"]),
    chips: z
      .array(z.object({ text: z.string(), kind: z.enum(["good", "warn"]) }))
      .optional(), // 3-5 signal chips
    // 1-2 grounded sentences. NULLABLE, not just optional: matcher.md tells the model to "say less"
    // when it cannot ground the tie-in, and unconstrained Haiku expresses that as `null`. Rejecting
    // the record over it would throw away the model's REAL score (the reject path forces score 0 /
    // skip), silently dropping matched roles. `null` is already a first-class value for this field downstream: grounding-enforce
    // sets it to null when a claim is ungrounded (grounding-enforce.mjs `dropProse("why_you")`).
    why_you: z.string().nullable().optional(),
    flag: z.string().nullable().optional(), // the one honest caution, or null
    dealbreaker_hit: z.boolean().optional(), // true → conflicts with a stated dealbreaker
  })
  .passthrough(); // tolerate extra keys the model may add; we only rely on the above

/** @typedef {import("zod").infer<typeof MatchOutput>} MatchOutputType */

// ── Constrained-decoding format ──────────────────────────────────────────────
// The `output_config.format` value for the Haiku scoring call (Batch + on-demand). Structured
// outputs make the model's JSON schema-valid BY CONSTRUCTION, so the JSON.parse -> null "unparseable
// score" path in match-batch.mjs / match-one.mjs does not fire on syntax. `MatchOutput.safeParse`
// STAYS as the semantic gate (a hallucinated-but-valid score is still caught).
//
// This is a HAND-MIRROR of the Zod schema above + matcher.md's OUTPUT block, because the raw Batch
// request can't use the SDK's zod->format helper (which would strip unsupported keywords for us).
// Two deliberate divergences the constrained schema CANNOT express — both still enforced by the
// Zod safeParse downstream, so nothing is lost:
//   - score bounds (0-100): JSON-schema `minimum`/`maximum` are unsupported by structured outputs.
//   - extra keys: the Zod schema is `.passthrough()`, but structured outputs REQUIRE
//     `additionalProperties:false`. matcher.md emits exactly these six fields, so constraining to
//     them is faithful (the model is not meant to add keys; Zod only tolerates them).
// All six fields are `required` because matcher.md always emits all six (flag may be null, not absent).
// If this ever drifts from the Zod schema, match-output.test.mjs fails.
const matchOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "number" }, // 0-100 range enforced by MatchOutput.safeParse, not here
    verdict: { type: "string", enum: ["exceptional", "strong", "worth a look", "skip"] },
    chips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: ["good", "warn"] },
        },
        required: ["text", "kind"],
      },
    },
    why_you: { type: ["string", "null"] }, // null = "nothing groundable to say" (mirrors the Zod .nullable())
    flag: { type: ["string", "null"] }, // the one honest caution, or null
    dealbreaker_hit: { type: "boolean" },
  },
  required: ["score", "verdict", "chips", "why_you", "flag", "dealbreaker_hit"],
};

/** The `output_config.format` object to attach to the scoring request when constrained decoding is on. */
export const MatchOutputFormat = { type: "json_schema", schema: matchOutputSchema };
