// lib/schemas/vv-writer.mjs — the shape of the live utterance writer's reply, validated in
// voice/writer.mjs before the text is linted and spoken; anything else is the scripted fallback.
import { z } from "zod";

/** Under 60 spoken words; 400 characters is the hard ceiling. */
export const WriterOutput = z.object({
  text: z.string().trim().min(1).max(400),
});
