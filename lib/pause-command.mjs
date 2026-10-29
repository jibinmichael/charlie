// lib/pause-command.mjs — "pause", "pause 2 weeks", "restart": a temporary stop the person controls.
//
// WHY. Without it a user's only control is `unsubscribe`: a permanent exit for what is usually a
// temporary feeling (landed a job, on holiday, need a quiet fortnight). Re-subscribing a genuine
// opt-out also costs sending reputation, so the product cannot undo it for them. `status='paused'`
// already drops a person from every sweep; this lets them set and clear it themselves.
//
// STRICTNESS IS THE WHOLE DESIGN. "I had to pause my search last year" must never stop someone's
// roles, and "restart" inside a sentence about a company must never resume a paused account. So a
// command is only a command when the message is essentially JUST the command. Everything else falls
// through to the ordinary reply path untouched.
//
// The asymmetry is deliberate. Failing to recognise a real "pause" costs one more email and they can
// say it again. Wrongly recognising one silences someone who was mid-conversation, and they may never
// find out why the roles stopped.

/** The longest a whole message can be and still be read as a bare command. */
const MAX_COMMAND_CHARS = 64;

// THE WHOLE MESSAGE MUST BE THE COMMAND. Anchoring only the START is not enough; each of these is a
// real reply, not a command:
//
//   "Hold on, I already applied to that one"          -> must not pause
//   "Not now, but ping me about design roles"         -> must not pause
//   "Stop for now on agencies, keep startups"         -> must not pause
//   "Continue with product roles only please"         -> must not resume (it is a preference)
//   "restart my search with a higher salary bar"      -> must not resume (it is a preference)
//   "Pause\n\nActually, focus on Bangalore roles"     -> must not pause (the second paragraph matters)
//
// So: strip courtesy and punctuation, then require what remains to be EXACTLY a command (plus an
// optional duration). Anything else is a message and goes to the ordinary reply path untouched.
// `for` and `me` are filler left behind once a duration is removed ("pause for a month" -> "pause for").
const COURTESY = /\b(please|pls|thanks|thank you|thankyou|for now|for a bit|a bit|for|me|my|search|ok|okay|hi|hey|charlie)\b/gi;
// "stop" is DELIBERATELY ABSENT in every form. Across email and SMS it is the universal opt-out word,
// so a person typing it expects to leave for good. Reading it as a pause would leave someone who
// wanted out merely quiet and still on the list, and the next thing they do is mark Charlie as spam —
// which costs the sending domain far more than a missed pause. "stop" and "unsubscribe" belong to the
// permanent door and stay there.
const PAUSE_WORDS = /^(pause|hold|snooze|take a break|not now|hold off)$/i;
const RESUME_WORDS = /^(restart|resume|unpause|un-?pause|start again|i'?m back|im back|continue|back on|go again)$/i;

// "pause 2 weeks", "pause for a month". Bare "pause" has no duration and is indefinite.
const DURATION = /\b(\d{1,3})\s*(day|days|week|weeks|month|months)\b|\b(a|one)\s+(week|month)\b/i;

/** Strip courtesy words and edge punctuation so "Pause please!" reads as "pause". */
function core(text) {
  return String(text || "")
    // Apostrophes are DELETED, not spaced: replacing them turns "I'm back" into "i m back", which
    // matches nothing. Every other punctuation mark becomes a space so words stay separated.
    .replace(/['\u2018\u2019]/g, "")
    .replace(COURTESY, " ")
    .replace(/[.,!?;:"'()\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Read a de-quoted reply body as a pause/resume command.
 *
 * @param {string} body  the sender's OWN words, already stripped of quoted history
 * @returns {{kind:"pause"|"resume", days:number|null}|null} null when this is not a command
 */
export function parsePauseCommand(body) {
  const raw = String(body || "").trim();
  // Measured on the WHOLE message, not the first line, so "Pause\n\nActually, focus on Bangalore" is
  // not read as a command.
  if (!raw || raw.length > MAX_COMMAND_CHARS) return null;

  const days = parseDuration(raw);
  // Remove the duration before the exact match, so "pause 2 weeks" reduces to "pause".
  const c = core(raw.replace(DURATION, " "));
  if (!c) return null;

  if (RESUME_WORDS.test(c)) return { kind: "resume", days: null };
  if (PAUSE_WORDS.test(c)) return { kind: "pause", days };
  return null;
}

/** Days in a stated duration, or null for an indefinite pause. Capped so a typo cannot lose someone. */
export function parseDuration(text) {
  const m = String(text || "").match(DURATION);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1; // "a week" / "one month"
  const unit = (m[2] || m[4] || "").toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  const days = unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30;
  // 180 days, not because a longer pause is wrong, but because "pause 999 months" is a typo and an
  // indefinite pause is the safer reading of one. They can always pause again.
  return Math.min(days, 180);
}
