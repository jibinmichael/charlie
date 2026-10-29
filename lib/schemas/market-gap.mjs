// lib/schemas/market-gap.mjs — Zod boundaries for the weekly market-gap drop's two model outputs.
//
// External boundary: the JSON the compose model (prompts/market-gap.mjs) and the web-research model
// (prompts/market-research.mjs) are expected to return. The sweep (market-gap.mjs) `safeParse`s each;
// on failure it logs + falls back to the template's grounded hand-written copy (compose) or to no
// market line at all (research): never crashes, never trusts unvalidated output.
import { z } from "zod";

// The connective PROSE fields for the drop. The model states no fact/number/source (those are
// rendered in code from grounded data) — so these are all free strings, bounded to keep a nudge a
// nudge. `.passthrough()` tolerates extra keys; the template reads only the five below and supplies
// a grounded default for any that are missing.
export const MarketGapCopy = z
  .object({
    subject: z.string().min(1).max(140),
    opening: z.string().min(1).max(600),
    gap_framing: z.string().min(1).max(600),
    close_line: z.string().min(1).max(600),
    honest_line: z.string().min(1).max(600),
  })
  .passthrough();

// One SOURCED market line. `source` must be a URL — an unsourced market claim is not trustworthy
// and is dropped before it can render (Charlie never states market fact in its own
// voice). Kept permissive on the string itself; market-research.mjs enforces the http(s) shape.
export const MarketResearchLine = z.object({
  claim: z.string().min(1).max(400),
  source: z.string().min(1).max(600),
});

// The web-research output: 0 to 3 sourced lines. Empty is valid and expected when nothing solid
// was found — the drop still sends, just without a market line.
export const MarketResearchOutput = z
  .object({
    lines: z.array(MarketResearchLine).max(3).default([]),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof MarketGapCopy>} MarketGapCopyType */
/** @typedef {import("zod").infer<typeof MarketResearchOutput>} MarketResearchOutputType */
