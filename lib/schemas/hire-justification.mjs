// lib/schemas/hire-justification.mjs — the shape of prompts/hire-justification.mjs's reply. A reply
// that does not match is not used: no justification, no submission.
import { z } from "zod";

export const JustificationOutput = z.object({
  justification: z.string().trim().min(1).max(1500).nullable(),
  evidence_ids: z.array(z.string().min(1)).max(30),
}).strict();
