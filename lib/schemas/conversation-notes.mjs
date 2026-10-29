// lib/schemas/conversation-notes.mjs — what prompts/conversation-notes.mjs returns (model output is validated
// at the boundary). Shapes only; lib/conversation-notes.mjs then checks each point against the candidate's own words.
import { z } from "zod";

export const ConversationNotePoint = z
  .object({
    text: z.string().trim().min(3).max(240),
    quote: z.string().trim().min(12).max(1000), // at least 3 words is checked after; 2 characters could quote "no"
    supports: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  })
  .strict();

export const ConversationNotesOutput = z
  .object({
    notes: z
      .array(
        z
          .object({
            n: z.number().int().min(0).max(40), // 0: something they wrote that answers none of the questions
            answered: z.boolean(),
            points: z.array(ConversationNotePoint).max(5).default([]),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
