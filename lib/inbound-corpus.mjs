// inbound-corpus.mjs — which inbound messages are a person telling us about themselves, and which
// are somebody selling us something. Pure, no model.
//
// WHY THIS RUNS FIRST. The inbound corpus is mixed: real candidate replies sit alongside job-board
// hiring-package mailers and sales pitches. The signal-discovery step derives labels from the corpus
// itself, so anything left in it becomes vocabulary. Let the vendor mail through and "hiring packages"
// and "CV database" end up as candidate traits.
//
// IT DROPS ON SENDER AND SHAPE, NEVER ON TOPIC. A candidate writing about recruitment tools is
// talking about their work. The tells here are the shape of bulk mail: an unsubscribe footer, a
// tracking link, a "Greetings from", a pitch addressed to us as a buyer.

const VENDOR = [
  /\bgreetings from\b/i,
  /\bunsubscribe\b.{0,40}\b(click|here|link)\b/i,
  /\b(hiring packages?|post a job|job posting credits|cv database|resume database)\b/i,
  /\bif unable to view (the|this) page\b/i,
  /\b(book a demo|schedule a demo|quick call to show you)\b/i,
  /\bwe help (companies|startups|founders)\b/i,
];

/** Addressed to us as a buyer of their thing, rather than as somebody they want to work with. */
const PITCH_AT_US = /\b(your (launch|product|website|landing page|SEO)|Product Hunt|we noticed (you|your)|I put (it |this )?together (from|using) your)\b/i;

/**
 * @returns {{keep: boolean, why: string}}
 */
export function isCandidateMessage({ subject = "", body = "" } = {}) {
  const t = `${subject}\n${body}`;
  for (const re of VENDOR) if (re.test(t)) return { keep: false, why: `vendor mail: ${String(t.match(re)[0]).slice(0, 40)}` };
  if (PITCH_AT_US.test(t)) return { keep: false, why: "a pitch aimed at us, not an application" };
  // A message with nothing in it cannot teach us anything, and an empty label set is noise.
  if (String(body || "").trim().length < 12) return { keep: false, why: "too short to carry a signal" };
  return { keep: true, why: "" };
}
