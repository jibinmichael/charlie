// lib/schemas/inbound-signal.mjs — what one message told us about one person, validated at the model boundary.
//
// FACTS AND TRAITS ARE SEPARATE FIELDS AND THAT IS DELIBERATE. Pay expectation, notice period and
// "remote only" are FACTS with columns that already exist and sit empty. Traits are the discovered
// part. Conflating them buries a queryable fact inside a label nobody can filter on, which is how
// "she said 19.95 LPA" becomes an unusable string.
//
// A BAD FIELD COSTS ITS FIELD, NOT THE RECORD. One over-long label must not discard a whole message:
// that is a guard that stops protecting and starts discarding while reporting success. `coerceInboundSignal` salvages the record and returns a count of what it dropped,
// so the loss shows up in the run output instead of hiding in a pass rate.
import { z } from "zod";

/** Every label carries the words that produced it. A trait we cannot point at is not usable. */
const Label = z.object({
  label: z.string().min(2).max(90),
  quote: z.string().min(5).max(400),
});

export const InboundSignal = z.object({
  // Discovered, not from a fixed list.
  traits: z.array(Label).max(8).default([]),
  facts: z.object({
    pay_expected: z.string().max(120).nullable().default(null),
    notice: z.string().max(120).nullable().default(null),
    work_mode: z.string().max(120).nullable().default(null),
    location: z.string().max(120).nullable().default(null),
    seeking: z.enum(["open", "not_looking", "has_offer", "unclear"]).catch("unclear").default("unclear"),
  }).default({}),
  // True when the message contains an account of work they did. This matters most for people whose
  // form answers were too thin to quote.
  has_work_evidence: z.boolean().catch(false).default(false),
});

/** Whitespace only. Never a length cut: a chopped label or fact reads as a claim nobody made. */
const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const field = (v, n) => { const c = clean(v); return c && c.length <= n ? c : null; };

/**
 * Salvage one model response into a valid InboundSignal.
 * A trait that will not validate is dropped and counted; the rest of the message survives. A fact
 * that will not validate becomes null, which is the honest reading of "we could not record this".
 * Nothing is truncated to make it fit. Returns { ok, data, droppedTraits }.
 */
export function coerceInboundSignal(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, data: null, droppedTraits: 0 };
  const inTraits = Array.isArray(raw.traits) ? raw.traits : [];
  const traits = [];
  for (const t of inTraits.slice(0, 8)) {
    const p = Label.safeParse({ label: clean(t?.label), quote: clean(t?.quote) });
    if (p.success) traits.push(p.data);
  }
  const f = raw.facts && typeof raw.facts === "object" ? raw.facts : {};
  const p = InboundSignal.safeParse({
    traits,
    facts: {
      pay_expected: field(f.pay_expected, 120), notice: field(f.notice, 120),
      work_mode: field(f.work_mode, 120), location: field(f.location, 120), seeking: f.seeking,
    },
    has_work_evidence: raw.has_work_evidence,
  });
  return { ok: p.success, data: p.success ? p.data : null, droppedTraits: inTraits.length - traits.length };
}
