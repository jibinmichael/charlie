// lib/schemas/role-why.mjs — one grounded reason a role was sent to one person, validated where the
// model's output enters the system.
//
// THE LENGTHS ARE CONDITIONAL. The prompt tells the model to return an empty quote and an empty why
// when the person's material cannot support a specific reason, which is the honest and frequent
// answer. Minimum lengths apply only to a grounded reply, so a correct refusal is never an error.
import { z } from "zod";

export const RoleWhy = z.object({
  // Their own words, verbatim. The runner checks this appears in their material and DROPS the person
  // when it does not: no citation, no email.
  // The cap leaves headroom above real quote lengths, so it never deletes a valid record.
  quote: z.string().max(600),
  // One sentence connecting that quote to this role. Never about the person, always about the work.
  // The prompt allows two sentences; the cap leaves room for them. Length is a content rule in the
  // prompt, where it can be judged, not a wall that deletes.
  why: z.string().max(480),
  // The subject line. Generated per person because "Senior Product Designer at Dispatch" is a job
  // board, and the whole point of this email is that it is not one. Bounded hard: it must name the
  // company, so nobody opens it not knowing who it is about.
  subject: z.string().max(72).default(""),
  grounded: z.boolean(),
}).superRefine((v, ctx) => {
  if (!v.grounded) return; // a refusal carries nothing, by design
  if (v.quote.trim().length < 10) ctx.addIssue({ code: "custom", path: ["quote"], message: "a grounded reason needs a real quote" });
  if (v.why.trim().length < 20) ctx.addIssue({ code: "custom", path: ["why"], message: "a grounded reason needs a real sentence" });
  if (v.subject.trim().length < 8) ctx.addIssue({ code: "custom", path: ["subject"], message: "a grounded reason needs a subject line" });
});

/**
 * Phrases that mean nothing and appear when the model has nothing specific to say.
 *
 * The prompt forbids these by name, but a model still produces them: an instruction is a preference,
 * a check is a rule. The caller retries once with the offending phrase named, then refuses -- a formula is worse
 * than no email, which is the whole premise of this pipeline.
 */
const TICS = [
  "at scale", "same kind of", "the same thing", "the whole job", "the same problem",
  "heterogeneous", "seamless", "robust", "leverage", "cutting-edge", "best-in-class",
  "which is what this role", "which is exactly what", "aligns well", "strong fit", "perfect fit",
];

/** The banned phrases present in a sentence, or [] if it is clean. */
export function ticsIn(why) {
  const t = String(why || "").toLowerCase();
  return TICS.filter((x) => t.includes(x));
}
