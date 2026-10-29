// lib/schemas/edge-match.mjs — Zod schema for the Edge Engine's rare-FIT gate output.
//
// External boundary, validated before use: the JSON prompts/edge-match.mjs asks Haiku to return when judging whether
// ONE role is genuinely in a domain where the person's verified edge is a differentiator. The consumer
// (lib/edge-match.mjs → scheduler/first-role) only prints the loud "Rare find" label when this resolves
// TRUE, so the schema fails CLOSED: any shape it cannot understand resolves to not-a-rare-fit.
//
// Sibling of edge-verdict.mjs and deliberately the same shape of contract: permissive on the raw strings
// so drift ("True", "yes") reaches the normalizer rather than being mistaken for a transport error, then
// normalized down to a single boolean that only an explicit affirmative can turn on.
import { z } from "zod";

export const EdgeMatch = z
  .object({
    rare_fit: z.union([z.boolean(), z.string()]).optional(),
    reason: z.string().optional(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof EdgeMatch>} EdgeMatchType */

// FAIL CLOSED: only an explicit true (or "true"/"yes") is a rare fit. Anything else — false, absent,
// "maybe", a number, drift — is not. "Rare" is a loud word; uncertainty must never earn it.
export function normalizeRareFit(raw) {
  if (raw === true) return true;
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "true" || s === "yes";
}

/**
 * Parse + normalize a raw rare-fit verdict. Never throws.
 * @returns {{ rareFit: boolean, reason: string, malformed: boolean }}
 *          malformed=true means the payload did not match the schema at all; the caller treats that as
 *          uncertainty (rareFit=false), never as a rare find.
 */
export function parseEdgeMatch(raw) {
  const p = EdgeMatch.safeParse(raw);
  if (!p.success) return { rareFit: false, reason: "", malformed: true };
  return {
    rareFit: normalizeRareFit(p.data.rare_fit),
    reason: String(p.data.reason ?? "").trim(),
    malformed: false,
  };
}
