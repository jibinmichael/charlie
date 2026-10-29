// lib/schemas/inbound-intent.mjs — the boundary for prompts/inbound-intent.mjs: model output is validated before use.
//
// UNREADABLE MUST MEAN "other", NEVER a write. `intent` is an enum with a catch, so a model that
// invents a label degrades to the one that routes to a human rather than failing the whole parse and
// leaving the caller to decide what to do with nothing.
import { z } from "zod";

export const INTENTS = [
  "preference_change", "consent_grant", "dispute", "status_update",
  "question", "answer", "off_topic", "courtesy", "other",
];

export const InboundIntent = z.object({
  intent: z.enum(INTENTS).catch("other"),
  confidence: z.enum(["high", "low"]).catch("low"),
  why: z.string().catch(""),
  quote: z.string().catch(""),
}).passthrough();
