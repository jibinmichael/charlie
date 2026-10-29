// lib/schemas/inbound-reply.mjs — the shape of one composed conversational reply, validated where the
// model's output enters the system, before anything is sent.
import { z } from "zod";

export const InboundReply = z.object({
  // "answer"  they asked something the facts cover
  // "continue" they accepted or declined something Charlie just offered
  // "none"    nothing is needed from us; saying something would be manufacturing a turn
  // "cannot"  the facts do not cover it -> the existing human fallback runs
  kind: z.enum(["answer", "continue", "none", "cannot"]),
  // Empty for "none" and "cannot". Capped here as well as in the prompt, because a prompt is a
  // request and a schema is a wall.
  reply: z.string().max(400).default(""),
});
