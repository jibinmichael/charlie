// lib/schemas/wedge.mjs — Zod boundary for the wedge drip's compose model output.
//
// External boundary: the JSON the compose model (prompts/wedge.mjs) is expected to return. The sweep
// (wedge.mjs) `safeParse`s it; on failure it logs + falls back to renderWedge's grounded hand-written
// copy: never crashes, never trusts unvalidated output. The one grounded fact (the
// rare combination itself) is NOT in here: it is the dossier's verified `edge.combo`, code-rendered by
// the template. The model only writes the warm connective prose around it, so every field is a bounded
// free string.
import { z } from "zod";

export const WedgeCopy = z
  .object({
    subject: z.string().min(1).max(140),
    opening: z.string().min(1).max(600),      // warm, on-their-side; "I went back through everything, one thing stands out"
    edge_line: z.string().min(1).max(600),    // frames the combination as the rare, valuable thing they bring (refers to it as "that combination"/"it", never restates it)
    advantage_line: z.string().min(1).max(600), // the KIND of room it's an edge in — opportunity, never a named market fact
    honest_line: z.string().min(1).max(600),  // the honest half: some rooms won't see it, and Charlie won't send those. Never a deficiency.
    close_line: z.string().min(1).max(600),   // the turn: from here on, hunting for roles where the combination is the whole point
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof WedgeCopy>} WedgeCopyType */
