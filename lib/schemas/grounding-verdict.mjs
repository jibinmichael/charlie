// lib/schemas/grounding-verdict.mjs — Zod schema for the grounding auditor's model output.
//
// External boundary: the JSON prompts/grounding-verify.mjs asks Haiku to return when auditing an
// artifact against a person's source material. This is the last line of defence for the core rule:
// never invent, inflate, or upgrade a claim about a person.
//
// WHY IT MATTERS HERE MORE THAN ANYWHERE: the consumer branches on `severity === "high"` to HOLD a send.
// Comparing the raw string exactly would let any drift ("HIGH", "High", "critical", "high ") fall
// through to "low" and SEND the ungrounded email. Unlike a bad score, a missed inflation is the one
// unrecoverable failure. So this schema does NOT merely reject
// bad shapes — `normalizeSeverity` coerces the recoverable ones and fails CLOSED on the rest.
//
// Contract: severity is "high" | "low" | "none" (lowercase). violations is a list of offending claims.
import { z } from "zod";

// The raw model reply. Deliberately permissive on `severity` (a plain string, not an enum) so a drifted
// value reaches normalizeSeverity and is resolved there, rather than failing the parse and being
// mistaken for a transport error. Shape mirrors prompts/grounding-verify.mjs's OUTPUT block.
export const GroundingVerdict = z
  .object({
    severity: z.string().optional(), // normalized + fail-closed by normalizeSeverity below
    violations: z
      .array(z.union([z.string(), z.object({}).passthrough()]))
      .optional(), // the model emits objects; bare strings are also accepted.
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof GroundingVerdict>} GroundingVerdictType */

/**
 * Resolve the model's severity string to the enforced three-value scale. FAIL CLOSED.
 *
 *   "high" / "HIGH" / " High " -> "high"   (case + whitespace drift is recoverable)
 *   "low"  / "LOW"             -> "low"
 *   "none" / "" / absent, no violations -> "none"
 *   anything unrecognized WITH violations -> "high"
 *
 * That last rule is the important one. If the auditor found something it considered worth naming and
 * we cannot understand how bad it said it was, that is uncertainty about an invented claim, and
 * uncertainty holds. "critical", "severe", "HIGH" all land on "high".
 *
 * @param {unknown} raw            the model's `severity` value
 * @param {number}  violationCount how many violations it reported
 * @returns {"high"|"low"|"none"}
 */
export function normalizeSeverity(raw, violationCount = 0) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "high") return "high";
  if (s === "low") return "low";
  if (s === "none") return violationCount ? "high" : "none"; // said "none" but listed violations → contradiction → hold
  if (!violationCount) return "none";                        // no severity, nothing named → genuinely clean
  return "high";                                             // unrecognized severity + named violations → hold
}

/**
 * Parse + normalize a raw grounding verdict. Never throws.
 * @returns {{ severity: "high"|"low"|"none", violations: unknown[], malformed: boolean }}
 *          malformed=true means the payload did not match the schema at all; the caller must treat that
 *          as uncertainty (hold), never as a clean pass.
 */
export function parseGroundingVerdict(raw) {
  const p = GroundingVerdict.safeParse(raw);
  if (!p.success) return { severity: "high", violations: [], malformed: true };
  const violations = Array.isArray(p.data.violations) ? p.data.violations : [];
  return { severity: normalizeSeverity(p.data.severity, violations.length), violations, malformed: false };
}

// ── Constrained-decoding format ──────────────────────────────────────────────
// The `output_config.format` value for the verifier call (grounding-verify.mjs). Structured outputs
// make the auditor's JSON schema-valid BY CONSTRUCTION. `shouldHold` treats an unverifiable verdict
// as uncertainty and holds, so without this a JSON syntax flake would cost a real person their role
// for that day.
//
// `parseGroundingVerdict` STAYS the semantic gate. Constrained decoding fixes SYNTAX, never MEANING:
// a schema-valid verdict that says "none" while naming violations is still a contradiction, and
// normalizeSeverity still fails it closed. Nothing here relaxes anything downstream.
//
// This is a HAND-MIRROR of the Zod schema above + prompts/grounding-verify.mjs's OUTPUT block (same
// pattern, and same reason, as lib/schemas/match-output.mjs: the raw request can't use the SDK's
// zod->format helper). Two deliberate divergences the constrained schema cannot express, both still
// enforced by the Zod safeParse downstream, so nothing is lost:
//   - `severity` is an ENUM here but a plain string in Zod. Deliberate, and the constraint is STRICTER:
//     Zod stays permissive so drift ("HIGH", "critical") reaches normalizeSeverity and fails closed
//     rather than being mistaken for a transport error. Constrained decoding means the model cannot
//     emit that drift in the first place; the permissive path stays for un-constrained callers
//     (a retry, another model, VERIFY_MODEL pointed elsewhere).
//   - `violations` items are OBJECTS here, but Zod also accepts bare strings. The prompt emits
//     objects only, so constraining to objects is faithful.
// If this ever drifts from the Zod schema or the prompt, grounding-verdict.test.mjs fails.
const groundingVerdictSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["none", "low", "high"] },
    violations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" }, // the exact offending phrase from the ARTIFACT
          issue: { type: "string" }, // why it is ungrounded
        },
        required: ["claim", "issue"],
      },
    },
  },
  required: ["severity", "violations"],
};

/** The `output_config.format` object attached to the verifier request (see grounding-verify.mjs). */
export const GroundingVerdictFormat = { type: "json_schema", schema: groundingVerdictSchema };
