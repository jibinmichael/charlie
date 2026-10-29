// lib/schemas/vv-judge.mjs — the shape of the live sufficiency hint, validated in voice/judge.mjs; a
// reply that does not match is a null hint, which the controller treats as "no hint".
import { z } from "zod";
import { ELEMENTS } from "./vv-plan.mjs";

export const JudgeOutput = z.object({
  present: z.array(z.enum(ELEMENTS)).max(ELEMENTS.length),
  relevant: z.boolean(),
});
