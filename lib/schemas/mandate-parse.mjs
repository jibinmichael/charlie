// lib/schemas/mandate-parse.mjs — the shape of one parsed hiring mandate, validated where the model's
// output enters the system.
//
// EVERY REQUIREMENT CARRIES A VERBATIM QUOTE, and that is not decoration. scripts/mandate-parse.mjs
// checks each quote against the JD text and DROPS any requirement whose quote is not there. It is
// citeOrDrop (grounding-enforce.mjs) pointed at a job description instead of a person: the rule
// "never invent a hard constraint" is enforced by the parser, not requested in a prompt.
import { z } from "zod";

// The caps are sized to fit real job lines: a restated requirement, a location or a contradiction note
// must not get a whole post refused. Every value stays bounded.
const Quoted = z.object({
  requirement: z.string().min(3).max(400),
  // Verbatim from the JD. The one field that makes a requirement checkable.
  quote: z.string().min(3).max(400),
  // What would have to be true of a candidate's material to establish it.
  evidence_needed: z.string().min(3).max(300),
});

/** A capability is never asserted, only observed. `observable` is what to actually look for. */
const Capability = Quoted.extend({
  observable: z.array(z.string().min(3).max(300)).min(1).max(8),
});

/** A phrase that sounds measurable and is not, plus what it has to become to be usable. */
const Ambiguity = z.object({
  phrase: z.string().min(2).max(120),
  quote: z.string().min(3).max(400),
  translated_to: z.array(z.string().min(3).max(300)).min(1).max(8),
});

/** Two lines of the same JD that cannot both be true. Both quotes required. */
const Contradiction = z.object({
  what: z.string().min(3).max(400),
  quote_a: z.string().min(3).max(400),
  quote_b: z.string().min(3).max(400),
});

export const MandateParse = z.object({
  role: z.string().min(2).max(120),
  // Null when the JD does not name the employer, which is normal for a confidential mandate and is
  // never to be guessed at from context.
  company: z.string().max(120).nullable(),
  location: z.string().max(300).nullable(),
  hard: z.array(Quoted).max(20),
  preferred: z.array(Quoted).max(20),
  capabilities: z.array(Capability).max(20),
  ambiguous: z.array(Ambiguity).max(20),
  contradictions: z.array(Contradiction).max(10),
  // Things a hiring team will be asked and the JD does not answer. Not requirements.
  unknowns: z.array(z.string().min(3).max(240)).max(20),
});

const BUCKETS = { hard: Quoted, preferred: Quoted, capabilities: Capability, ambiguous: Ambiguity, contradictions: Contradiction };
const issuesOf = (err) => err.issues.slice(0, 3).map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ");

/**
 * The model's mandate, validated item by item: a bad item is dropped and REPORTED, the same
 * way an unverifiable quote is, and the rest of the post is kept. A location past its cap becomes null and is reported
 * (the ATS's own location is used first anyway). The post is refused only when what is left still does not validate,
 * for example no role. Pure.
 * @returns {{success: true, data: object, dropped: Array<{bucket:string,requirement:string,quote:string,reason:string}>} | {success: false, error: string}}
 */
export function salvageMandate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { success: false, error: "the mandate is not an object" };
  const dropped = [];
  const candidate = { ...raw };
  for (const [bucket, schema] of Object.entries(BUCKETS)) {
    const items = Array.isArray(raw[bucket]) ? raw[bucket] : [];
    candidate[bucket] = items.flatMap((it) => {
      const r = schema.safeParse(it);
      if (r.success) return [r.data];
      dropped.push({ bucket, requirement: String(it?.requirement || it?.phrase || it?.what || "(unnamed)").slice(0, 200), quote: String(it?.quote || it?.quote_a || "").slice(0, 400), reason: `schema: ${issuesOf(r.error)}` });
      return [];
    });
  }
  candidate.unknowns = (Array.isArray(raw.unknowns) ? raw.unknowns : []).filter((u) => typeof u === "string" && u.trim().length >= 3 && u.length <= 240);
  if (typeof raw.location === "string" && raw.location.length > 300) {
    dropped.push({ bucket: "location", requirement: "location", quote: raw.location.slice(0, 400), reason: "schema: longer than 300 characters" });
    candidate.location = null;
  }
  candidate.location ??= null;
  candidate.company ??= null;
  const ok = MandateParse.safeParse(candidate);
  return ok.success ? { success: true, data: ok.data, dropped } : { success: false, error: issuesOf(ok.error) };
}
