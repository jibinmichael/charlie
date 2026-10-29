// lib/schemas/remote-access-verdict.mjs — Zod schema for the remote-accessibility verifier.
//
// External boundary, validated before use: the JSON prompts/remote-access-verify.mjs asks Haiku to return when
// judging whether a REMOTE role is genuinely workable from the candidate's home region (India). The
// consumer (remote-access-verify.mjs → quality-gate.mjs) only lets a role through when the verdict is an
// explicit accessible=true, so this schema fails CLOSED: any shape it cannot understand resolves to
// not-accessible/low, never to a wrongly-surfaced role. "Rather drop than dump" is the whole point.
//
// Contract: accessible is a boolean; confidence is "high" | "medium" | "low" (lowercase); reason a string.
import { z } from "zod";

// Permissive on raw strings so drift ("True", "HIGH") reaches the normalizers below rather than failing
// the parse and being mistaken for a transport error. Shape mirrors prompts/remote-access-verify.mjs.
export const RemoteAccessVerdict = z
  .object({
    accessible: z.union([z.boolean(), z.string()]).optional(),
    confidence: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof RemoteAccessVerdict>} RemoteAccessVerdictType */

// FAIL CLOSED: only an explicit true (or "true") is accessible; anything else (false, absent,
// unparseable) means the role is NOT confirmed open to the region, so it is dropped.
export function normalizeAccessible(raw) {
  if (raw === true) return true;
  return String(raw ?? "").trim().toLowerCase() === "true";
}

// Resolve confidence to the three-value scale. FAIL CLOSED: unrecognized → "low".
export function normalizeConfidence(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

/**
 * Parse + normalize a raw verdict. Never throws.
 * @returns {{ accessible: boolean, confidence: "high"|"medium"|"low", reason: string, malformed: boolean }}
 */
export function parseRemoteAccessVerdict(raw) {
  const p = RemoteAccessVerdict.safeParse(raw);
  if (!p.success) return { accessible: false, confidence: "low", reason: "", malformed: true };
  const v = p.data;
  return {
    accessible: normalizeAccessible(v.accessible),
    confidence: normalizeConfidence(v.confidence),
    reason: String(v.reason ?? "").trim().slice(0, 200),
    malformed: false,
  };
}
