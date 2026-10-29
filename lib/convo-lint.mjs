// lib/convo-lint.mjs — the conversational copy-lint + honesty guard (pure, deterministic).
//
// Every v2 message must earn a reply through CARE, never guilt — the brand dies on one manipulative
// line. This is the deterministic pre-send lint each v2 message clears before `sendGuarded`, the same
// fail-closed discipline as the grounding guard: on any violation the caller logs the offending rule
// + message id and DROPS the send (a manipulative line in a real inbox is not recoverable).
//
// Checks (structural on purpose — a structural gate can't be gamed and rarely false-positives):
//   HONESTY BLOCKLIST (always) — reject countdown/scarcity, streaks, "you've gone quiet / I've been
//     waiting", guilt-debt, sad-mascot, fake progress counters. This is the hard, non-negotiable gate.
//   VOICE (always) — no em dashes, non-empty.
//   ONE GENUINE QUESTION (always) — exactly one "?" across subject+text (earn the reply with a real ask).
//   COSTLESS EXIT (always) — a no-cost out ("no rush", "reply anytime", ...), so the message never
//     pressures.
//   REFLECTION (only when userFacts are supplied) — the opening must reference a specific prior user
//     fact. The watchdog safety-net messages carry no userFacts (they're system state, not a reply),
//     so reflection is skipped for them; conversational messages pass the fact they reflected.
//
// Patterns are intentionally narrow/phrase-anchored to avoid dropping a good message;
// tune them on fixtures in convo-lint.test.mjs, and every drop is logged for review.

const OPENING_CHARS = 200; // how much of the message counts as "the opening" for the reflection check

// Honesty blocklist: manipulation patterns. Each { rule, re } — a match rejects the message.
const BLOCKLIST = [
  // countdown / scarcity
  { rule: "scarcity-countdown", re: /\b(only|just)\s+\d+\s+(left|spots?|seats?|places?|remaining)\b/i },
  { rule: "scarcity-lastchance", re: /\blast chance\b/i },
  { rule: "scarcity-expiry", re: /\bexpires?\s+(tonight|today|soon|in\s+\d)/i },
  { rule: "scarcity-deadline", re: /\bends\s+(tonight|today|soon)\b|\bclosing soon\b|\bact now\b|\bhurry\b|\blimited (time|spots?)\b|\bdon'?t miss out\b/i },
  // streaks / "don't lose your spot"
  { rule: "streak", re: /\bstreak\b|\bdon'?t lose your (spot|place|streak|progress)\b|\byou'?ll lose your\b/i },
  // "you've gone quiet / I've been waiting"
  { rule: "waiting-guilt", re: /\byou'?ve gone quiet\b|\bi'?ve been waiting\b|\bstill waiting\b|\bhaven'?t heard (from|back from) you\b|\byou disappeared\b|\bwhere did you go\b/i },
  // guilt-debt
  { rule: "guilt-debt", re: /\byou owe\b|\bafter (all|everything) i'?ve done\b|\bleast you could do\b|\bi worked (so )?hard (on|to)\b/i },
  // sad-mascot
  { rule: "sad-mascot", re: /\bi'?m (so |really )?sad\b|\bfeeling lonely\b|[\u{1F97A}\u{1F622}\u{1F62D}]/iu },
  // fake progress counters
  { rule: "fake-progress", re: /\b\d{1,3}%\s+(complete|of the way|there|done)\b/i },
];

// A message satisfies "costless exit" if any of these appears — a no-penalty way to not reply/act.
const COSTLESS_EXIT = /\bno rush\b|\bno pressure\b|\bno worries\b|\bno hurry\b|\bnothing'?s? lost\b|\bwhenever you'?re ready\b|\bwhenever you have a minute\b|\bwhenever works\b|\bwhen you get a moment\b|\breply anytime\b|\btake your time\b|\bno need to\b/i;

/**
 * Lint one outgoing v2 message. PURE — no I/O. Returns { ok, violations }.
 * @param {object} o
 * @param {string} [o.subject]
 * @param {string} [o.text]      the plain-text body (the HTML is derived from it, so linting text covers both)
 * @param {string[]} [o.userFacts]  specific prior user facts the message claims to reflect; when
 *   non-empty, the opening MUST reference at least one (reflection check). Empty ⇒ reflection skipped.
 * @returns {{ ok: boolean, violations: Array<{rule:string, kind:string, detail?:string}> }}
 */
export function lintMessage({ subject = "", text = "", userFacts = [], conversational = true } = {}) {
  const violations = [];
  const body = String(text || "");
  const hay = `${subject || ""}\n${body}`;

  // ── UNIVERSAL rules (always) — the honesty guard that matters on any user-facing surface ──
  // non-empty
  if (!body.trim()) violations.push({ rule: "empty", kind: "structure" });

  // voice: no em dashes anywhere user-facing
  if (/[—–]/.test(hay)) violations.push({ rule: "em-dash", kind: "voice" });

  // honesty blocklist (manipulation patterns)
  for (const { rule, re } of BLOCKLIST) {
    if (re.test(hay)) violations.push({ rule, kind: "honesty" });
  }

  // ── CONVERSATIONAL rules (interrogation replies) — a single proactive ask that earns a reply.
  // These are WRONG for other message shapes (a hiring kickoff, a rejection, a probe), which have their
  // own reviewed copy. Callers of those pass conversational:false to run only the universal gate.
  if (conversational) {
    // exactly one genuine question
    const questions = (hay.match(/\?/g) || []).length;
    if (questions !== 1) violations.push({ rule: "question-count", kind: "structure", detail: `${questions} question marks (need exactly 1)` });

    // costless exit present
    if (!COSTLESS_EXIT.test(hay)) violations.push({ rule: "no-costless-exit", kind: "structure" });

    // reflection of a specific prior fact (only when facts are supplied)
    if (userFacts.length) {
      const opening = body.slice(0, OPENING_CHARS).toLowerCase();
      const reflected = userFacts.some((f) => f && opening.includes(String(f).toLowerCase()));
      if (!reflected) violations.push({ rule: "no-reflection", kind: "structure", detail: "opening does not reference a supplied user fact" });
    }
  }

  return { ok: violations.length === 0, violations };
}
