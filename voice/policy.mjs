// voice/policy.mjs — the conversation policy: the moves, the limits, how a candidate turn is
// classified, and what a judge hint may contain. PURE, no model.
//
// THE PLAN SAYS WHAT MUST BE ESTABLISHED. THIS SAYS HOW THE AGENT GETS THERE. Every
// rule here is a number or a regular expression a reader can argue with, and the controller
// (voice/controller.mjs) is the only consumer. The judge can suggest which contract elements
// are present; it cannot suggest a move, and classifyTurn() below never calls a model, so the
// candidate's own words decide meta, refusal, restart and repeat deterministically.

/** Every move the controller can make. The writer may reword the text of a move; it cannot pick one. */
export const MOVES = [
  "intro", "ask_anchor", "probe_depth", "probe_ownership", "probe_specifics", "scenario",
  "redirect", "clarify_own_question", "handle_meta", "handle_refusal", "acknowledge_move_on",
  "restart_item", "audio_check", "resume", "wrap_up",
];

/** Moves that ask the candidate something; their text is remembered as the pending question. */
export const QUESTION_MOVES = new Set(["ask_anchor", "probe_depth", "probe_ownership", "probe_specifics", "scenario", "redirect", "clarify_own_question", "restart_item", "acknowledge_move_on"]);

export const LIMITS = Object.freeze({
  MIN_PROBES: 1,                 // never zero probes: that produces stated_only everywhere
  MAX_PROBES: 2,                 // never unlimited: that produces an interrogation
  AUDIO_STRIKES_ITEM: 2,         // two consecutive unusable turns: the item becomes insufficient (audio)
  AUDIO_STRIKES_SESSION: 4,      // four in a row across items: the microphone is gone; close cleanly
  OFF_TOPIC_STRIKES: 2,          // one redirect, then move on
  WRAP_MARGIN_SECONDS: 45,       // close when this much of the session budget remains
  SCENARIO_MIN_SECONDS: 60,      // a scenario is asked only if at least this much of the item budget remains
  MIN_USABLE_WORDS: 2,           // a turn with fewer words is treated as unusable audio
});

/** Item statuses the cursor records. The evaluator turns these into insufficient / not_assessed reasons. */
export const ITEM_STATUSES = ["open", "sufficient", "moved_on", "declined", "insufficient_audio", "insufficient_irrelevant"];

// ── turn classification (deterministic) ──────────────────────────────────────

const RESTART_RE = /\b(start (over|again)|restart|redo (that|this)|from the top|take that again)\b/i;
const REPEAT_RE = /\b(repeat that|say that again|come again|what do you mean|didn'?t (catch|understand|get) that|sorry,? what|pardon)\b|^(sorry|what)\??$/i;
const PAUSE_RE = /\b(i need a (moment|minute|second)|give me a (moment|minute|second)|hold on|one (moment|second|sec))\b/i;
const META_RES = [
  ["who_sees", /\b(who (will |can |is going to )?(see|hear|listen|read)|who gets (this|the recording|the transcript))\b/i],
  ["how_long", /\b(how long|how many (questions|minutes))\b/i],
  ["can_skip", /\b(can i skip|am i allowed to skip|do i have to answer)\b/i],
  ["can_stop", /\b(can i stop|can we stop|can i pause|can i leave|can i come back)\b/i],
  ["is_recorded", /\b(is this (being )?recorded|are you recording)\b/i],
  ["are_you_ai", /\b(are you (a |an )?(bot|ai|robot|human|real person|machine)|am i talking to (a|an) (bot|ai|robot|human))\b/i],
  ["what_next", /\b(what happens (next|after|now)|what('s| is) the next step|when will i hear)\b/i],
  ["what_is_this", /\b(what is this( for| about)?|what('s| is) this (for|about)|why am i (here|doing this))\b/i],
];
const REFUSAL_RE = /^(skip|pass|next( question)?|no thanks?)\b|\b(i('d| would) rather not|don'?t want to (answer|say|talk about)|not (going to|gonna) answer|no comment|i('ll| will) skip|let'?s skip|skip (that|this|it))\b/i;

/**
 * @param {{text?:string, unusable?:boolean}|null} turn
 * @returns {{kind:'unusable'|'restart'|'repeat'|'pause'|'meta'|'refusal'|'answer', meta?:string}}
 */
export function classifyTurn(turn) {
  const text = String(turn?.text || "").trim();
  if (turn?.unusable || !text) return { kind: "unusable" };
  // The one-word commands the intro invites ("skip", "pardon") must never be mistaken for a bad
  // line, so the command patterns are checked before the word-count rule.
  if (RESTART_RE.test(text)) return { kind: "restart" };
  if (REPEAT_RE.test(text)) return { kind: "repeat" };
  if (PAUSE_RE.test(text)) return { kind: "pause", meta: "pause" };
  for (const [meta, re] of META_RES) if (re.test(text)) return { kind: "meta", meta };
  if (REFUSAL_RE.test(text)) return { kind: "refusal" };
  const words = text.split(/\s+/).length;
  if (words < LIMITS.MIN_USABLE_WORDS) return { kind: "unusable" };
  return { kind: "answer" };
}

// ── hints ────────────────────────────────────────────────────────────────────

/**
 * A judge hint is advisory and optional. It is used only if it is well-formed and names elements
 * that exist in THIS item's contract; anything else is ignored, so a broken or hostile hint cannot
 * move the conversation.
 * @returns {{present:string[], relevant?:boolean}|null}
 */
export function validHint(hint, contract) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  if (!Array.isArray(hint.present)) return null;
  const names = new Set((contract?.elements || []).map((e) => e.name));
  const present = hint.present.filter((p) => typeof p === "string" && names.has(p));
  const out = { present: [...new Set(present)] };
  if (typeof hint.relevant === "boolean") out.relevant = hint.relevant;
  return out;
}

// ── helpers the controller uses ──────────────────────────────────────────────

export const sortItems = (items) => [...items].sort((a, b) => a.priority - b.priority);
export const requiredElements = (contract) => contract.elements.filter((e) => e.required).map((e) => e.name);
export const coreElement = (contract) => contract.elements.find((e) => e.core)?.name ?? null;
