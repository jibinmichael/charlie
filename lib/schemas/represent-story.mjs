// lib/schemas/represent-story.mjs — the model boundary for the story.
import { z } from "zod";

export const StoryEvidence = z.object({
  claim: z.string().min(1),
  source: z.string().default("form"),
}).passthrough();

export const StoryBuild = z.object({
  story: z.string(),
  evidence: z.array(StoryEvidence).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
}).passthrough();

export const StoryVerdict = z.object({
  grounded: z.boolean(),
  violations: z.array(z.string()).default([]),
  reason: z.string().default(""),
}).passthrough();
