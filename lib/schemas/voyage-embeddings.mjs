// lib/schemas/voyage-embeddings.mjs — Zod schema for the Voyage AI embeddings response.
// External boundary: the JSON returned by POST https://api.voyageai.com/v1/embeddings, consumed by
// lib/voyage.mjs. safeParse'd where the data enters so a malformed/changed
// response is logged + skipped (that item falls back to lexical ranking), never fed into cosine math.
// Shape: { data: [{ embedding: number[], index }], model?, usage? }. With output_dtype "int8" the
// embedding is an array of small integers; we validate structure, not the dtype.
import { z } from "zod";

export const VoyageEmbeddings = z
  .object({
    data: z
      .array(
        z.object({
          embedding: z.array(z.number()).min(1), // the vector (float or int8 values)
          index: z.number().int().nonnegative(), // position in the input batch
        }),
      )
      .min(1),
    model: z.string().optional(),
    usage: z.object({ total_tokens: z.number() }).partial().optional(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof VoyageEmbeddings>} VoyageEmbeddingsType */
