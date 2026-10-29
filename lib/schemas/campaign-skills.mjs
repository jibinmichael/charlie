// lib/schemas/campaign-skills.mjs — Zod boundary for the reject-board skill coverage output.
// External boundary: the JSON prompts/campaign-skills.mjs returns — one coverage per role skill, scored
// against the resume. safeParse'd in campaign-board.scoreSkills; on failure the board is empty and the
// reject email sends without a chart (never with a fabricated one). coverage is a closed enum so a
// hallucinated grade cannot ride out.
import { z } from "zod";

export const SkillCoverage = z
  .object({
    name: z.string().trim().min(1),
    coverage: z.enum(["strong", "partial", "none"]),
  })
  .strict();

export const CampaignSkills = z
  .object({
    skills: z.array(SkillCoverage).min(1).max(12),
  })
  .strict();

/** @typedef {import("zod").infer<typeof CampaignSkills>} CampaignSkillsType */
