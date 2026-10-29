// lib/schemas/fit-coverage.mjs — the model-output boundary for the grounded coverage call.
//
// WHY: every model boundary is safeParse'd. A reply status the code does not recognise (e.g. `partly`)
// must be visible in the logs, not silently coerced, because it changes a person's fit score.
//
// TWO LEVELS, ON PURPOSE, AND THE SPLIT IS THE WHOLE DESIGN:
//
//   CoverageReply       — TOLERANT. It models exactly what computeCoverage already tolerated: every
//                         field optional, because the code already defaulted every one of them. It
//                         rejects only a reply that is not a usable object at all. Making it stricter
//                         would turn a single bad requirement into `thin: {reason: "error"}`, and
//                         a thin coverage SKIPS the fit floor — i.e. strictness here would make the
//                         gate fail OPEN, not closed. See fit-coverage.mjs's own note on `reason`.
//
//   CoverageRequirement — STRICT, applied per element. A requirement that fails is kept in the array
//                         with status forced to `unknown`, and LOGGED. Not dropped: dropping it would
//                         remove it from the coverage DENOMINATOR and raise the score, which is
//                         fail-open. Forcing `unknown` scores it as unproven, which is both the
//                         fail-closed direction; the forcing is logged so it is visible.
//
// STAGE 1 FIELDS (`gating`, `kind`, `locator`) are optional here by design: a reply that omits them
// must keep working. Nothing reads them for a decision.
import { z } from "zod";

/** The four evidence verdicts. `contradicted` is accepted from the model but no decision consumes it:
 *  it counts as neither met nor partial, exactly like `unknown`. */
export const REQ_STATUSES = ["met", "partial", "unknown", "contradicted"];

/** What KIND of thing the JD is asking for. Asked of the model because a keyword regex misclassifies
 *  "5+ years as a BA" and "BE fluent in English" as credentials. */
export const REQ_KINDS = ["capability", "experience-duration", "credential", "domain", "constraint"];

/**
 * HOW GOOD is the evidence behind a met/partial verdict? (stage 2 enrichment)
 *
 * A regex over the evidence sentence cannot separate real evidence from an aspiration ("Profile
 * TARGETS Chief of Staff roles"), an unmarked seniority mismatch, or trivial satisfaction ("English
 * listed as spoken language"). So the distinction is asked for at the point where the sentence is
 * written, the same approach as `gating` and `kind`.
 */
export const EVIDENCE_STRENGTHS = ["direct", "adjacent", "self-reported", "aspirational", "trivial"];

export const CoverageRequirement = z
  .object({
    // The short label. The only required field: a requirement without one is dropped.
    req: z.string().min(1),
    status: z.enum(REQ_STATUSES),
    evidence: z.string().nullable().optional(),

    // ── Stage 1. Optional so an un-enriched reply validates unchanged.
    // Does the JD present this as REQUIRED, or merely preferred? The distinction exists in the
    // postings: "MBA preferred" must not carry the same weight as "Bachelor's in Engineering/CS".
    gating: z.boolean().optional(),
    kind: z.enum(REQ_KINDS).optional(),
    // WHERE in the dossier the evidence came from, so a citation can be checked mechanically
    // rather than trusted because it reads well.
    locator: z.string().nullable().optional(),

    // ── Stage 2. Also optional: a reply that predates them must keep working unchanged.
    evidence_strength: z.enum(EVIDENCE_STRENGTHS).nullable().optional(),
    // Is this requirement a named TOOL or LIBRARY, as opposed to a capability, a domain, or a level?
    // The coverage contract already says a missing tool is not a shortfall ("tools are learnable and
    // are usually just unlisted"), but `kind` is too coarse to act on it: "Kubernetes" and
    // "Information architecture" are both `capability`. Asking directly is the only honest route;
    // reading it off a 1-to-3-word label calls "5+ years as a BA" a credential.
    tool: z.boolean().nullable().optional(),
  })
  .passthrough();

const unitInterval = z.number().finite();

export const CoverageReply = z
  .object({
    requirements: z.array(z.unknown()).optional(), // elements validated individually, see above
    skills_overlap: unitInterval.optional(),
    seniority: z.object({ level: z.string().optional(), score: unitInterval.optional() }).passthrough().optional(),
    domain: unitInterval.optional(),
    parseable: unitInterval.optional(),
    top_move: z.string().nullable().optional(),
    reason_points: z.array(z.string()).optional(),
    reason: z.string().optional(), // tolerated legacy shape; fit-coverage.mjs falls back to it
    screen: z.object({}).passthrough().optional(),
  })
  .passthrough();

/**
 * Validate one requirement element.
 * @returns {{ ok: true, value: object } | { ok: false, why: string }}
 */
export function parseRequirement(raw) {
  const r = CoverageRequirement.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const why = r.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, why };
}
