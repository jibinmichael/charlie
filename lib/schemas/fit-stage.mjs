// lib/schemas/fit-stage.mjs — the model boundaries for the two-stage Fit Engine.
//
// Two calls, two shapes. Both follow the discipline already set by lib/schemas/fit-coverage.mjs:
// TOLERANT at the reply level, STRICT per requirement, and a failing requirement is kept in a
// fail-closed state rather than dropped — dropping removes it from the conjunction and makes the
// decision EASIER, which is the wrong direction for a guard.
import { z } from "zod";
import { REQ_KINDS, EVIDENCE_STRENGTHS } from "./fit-coverage.mjs";

/** Stage 1 statuses do not exist — it never sees a person. */
export const Stage1Requirement = z
  .object({
    req: z.string().min(1),
    gating: z.boolean(),
    kind: z.enum(REQ_KINDS),
    tool: z.boolean(),
  })
  .passthrough();

export const Stage1Reply = z.object({ requirements: z.array(z.unknown()).optional() }).passthrough();

/** Stage 2 statuses. `contradicted` is accepted and handled, though the model rarely emits it. */
export const STAGE2_STATUSES = ["met", "partial", "unknown", "contradicted"];

export const Stage2Requirement = z
  .object({
    req: z.string().min(1),
    status: z.enum(STAGE2_STATUSES),
    evidence: z.string().nullable().optional(),
    locator: z.string().nullable().optional(),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS).nullable().optional(),
  })
  .passthrough();

export const Stage2Reply = z.object({ requirements: z.array(z.unknown()).optional() }).passthrough();

const why = (r) => r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** @returns {{ok:true,value:object}|{ok:false,why:string}} */
export function parseStage1Requirement(raw) {
  const r = Stage1Requirement.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, why: why(r) };
}

/** @returns {{ok:true,value:object}|{ok:false,why:string}} */
export function parseStage2Requirement(raw) {
  const r = Stage2Requirement.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, why: why(r) };
}
