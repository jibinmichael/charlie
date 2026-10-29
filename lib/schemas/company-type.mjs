// lib/schemas/company-type.mjs — what kind of organisation an employer is, validated at the model boundary.
//
// "unknown" IS THE EXPECTED ANSWER FOR MOST OF THE TAIL and it must stay cheap to give: most employers
// in the pool are small companies a model has never heard of.
// A guessed type is worse than a blank one, because the whole point of this field is to catch a
// claim that could not be true at the place it was made.
import { z } from "zod";

export const COMPANY_TYPES = ["product", "enterprise", "services", "agency", "consultancy", "startup", "unknown"];

export const CompanyType = z.object({
  type: z.enum(COMPANY_TYPES),
  // What the company does, one line, only when the model actually knows it.
  what: z.string().max(240).default(""),
  // A BAD SCALE MUST NOT DISCARD A GOOD TYPE. A strict enum here would fail the whole record when the
  // model returns a sensible headcount band in a wording the enum does not list. The type is the point of this
  // field; the scale is a convenience, so it degrades to "unknown" rather than taking the row with it.
  scale: z.enum(["under_50", "50_500", "500_5000", "over_5000", "unknown"]).catch("unknown").default("unknown"),
  // "high" only when the company is genuinely recognised. Anything else is treated as unknown by the
  // caller, so a low-confidence guess never reaches a board.
  confidence: z.enum(["high", "medium", "low"]),
}).superRefine((v, ctx) => {
  if (v.type !== "unknown" && v.confidence === "low")
    ctx.addIssue({ code: "custom", path: ["type"], message: "a low-confidence type must be reported as unknown" });
});
