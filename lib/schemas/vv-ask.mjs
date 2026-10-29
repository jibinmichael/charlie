// lib/schemas/vv-ask.mjs — the boundary for "ask the board": what the dashboard may send, and
// what the model's answer must be before the board applies it. An unknown field or operator
// fails the whole answer; nothing is partly applied.
import { z } from "zod";
import { ASK_FIELDS, ASK_OPS, ASK_COLUMNS } from "../../prompts/vv-ask.mjs";

export const AskInput = z.object({ question: z.string().trim().min(2).max(500) });

const FIELD = z.enum(Object.keys(ASK_FIELDS));
const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

export const AskFilter = z.object({
  field: FIELD,
  op: z.enum(ASK_OPS),
  value: z.union([scalar, z.array(z.union([z.string().max(200), z.number()])).max(50)]).optional().default(null),
});

export const AskQuery = z.object({
  filters: z.array(AskFilter).max(12).default([]),
  sort: z.object({ field: FIELD, dir: z.enum(["asc", "desc"]) }).nullable().default(null),
  columns: z.array(z.enum(ASK_COLUMNS)).max(20).nullable().default(null),
  aggregate: z.enum(["count"]).nullable().default(null),
  explanation: z.string().trim().max(400).default(""),
  refused: z.string().trim().max(300).nullable().default(null),
});

export const AskResponse = z.object({
  ok: z.boolean(),
  query: AskQuery.nullable(),
  refused: z.string().nullable(),
  prompt_version: z.string(),
});
