// lib/schemas/edge-verdict.mjs — Zod schema for the Edge Engine verifier's model output.
//
// External boundary, validated before use: the JSON prompts/edge-verify.mjs asks Haiku to return when auditing a
// candidate `edge` against the person's source. The consumer (edge-verify.mjs → dossier-build.mjs) drops
// the edge unless the verdict is BOTH grounded AND high-confidence, so this schema fails CLOSED: any shape
// it cannot understand resolves to not-grounded/low, never to a trusted edge.
//
// Contract: grounded is a boolean; confidence is "high" | "medium" | "low" (lowercase).
import { z } from "zod";

// Permissive on the raw strings so drift ("High", "TRUE") reaches the normalizers below rather than
// failing the parse and being mistaken for a transport error. Shape mirrors prompts/edge-verify.mjs.
export const EdgeVerdict = z
  .object({
    grounded: z.union([z.boolean(), z.string()]).optional(),
    confidence: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof EdgeVerdict>} EdgeVerdictType */

// Resolve a possibly-drifted grounded value. FAIL CLOSED: only an explicit true (or "true") is grounded;
// anything else (false, absent, unparseable) is not grounded, so the edge is dropped.
export function normalizeGrounded(raw) {
  if (raw === true) return true;
  return String(raw ?? "").trim().toLowerCase() === "true";
}

// Resolve confidence to the three-value scale. FAIL CLOSED: unrecognized → "low" (an edge only earns the
// email treatment downstream when it is "high", so drift can never over-trust).
export function normalizeConfidence(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

/**
 * Parse + normalize a raw edge verdict. Never throws.
 * @returns {{ grounded: boolean, confidence: "high"|"medium"|"low", malformed: boolean }}
 *          malformed=true means the payload did not match the schema at all; the caller treats that as
 *          uncertainty (grounded=false), never as a trusted edge.
 */
export function parseEdgeVerdict(raw) {
  const p = EdgeVerdict.safeParse(raw);
  if (!p.success) return { grounded: false, confidence: "low", malformed: true };
  return {
    grounded: normalizeGrounded(p.data.grounded),
    confidence: normalizeConfidence(p.data.confidence),
    malformed: false,
  };
}
