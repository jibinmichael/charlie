// lib/schemas/campaign-turn.mjs — Zod boundary for the join@ challenge-loop turn output.
// External boundary: the JSON prompts/campaign-challenge.mjs (Sonnet) returns each turn — the next
// message Charlie says (a probe or the next opener) plus a `done` signal. safeParse'd in the campaign
// loop; on failure the caller falls back to the next fixed opener or closes the loop to awaiting_verdict
// (log + degrade, never a malformed or ungoverned send). The message additionally clears convo-lint.
// NOTE, by design: there is NO verdict / score / pass field here. The model asks and probes; it never
// judges. A stray evaluative key would be rejected by .strict(), which is the point.
import { z } from "zod";

export const CampaignTurn = z
  .object({
    // what Charlie says next: a probe, the next opener verbatim, or (when done) a verdict-neutral close.
    message: z.string().trim().min(1),
    // true only when there are no openers left and the last thread is probed enough to hand to a human.
    // Advisory to the loop; the hard turn cap (JOIN_LOOP_MAX_TURNS) is the real stop.
    done: z.boolean(),
  })
  .strict(); // exactly these two fields; reject drift so a stray "verdict"/"score" key can't ride in

/** @typedef {import("zod").infer<typeof CampaignTurn>} CampaignTurnType */
