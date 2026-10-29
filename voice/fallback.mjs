// voice/fallback.mjs — every scripted line the agent can say without a model.
//
// INVARIANT: every candidate-facing failure has deterministic fallback behaviour. The plan carries
// four scripted lines per item (anchor, probe, move_on, clarify) and the plan's own questions are
// themselves scripts; this file carries the session-level lines (intro, wrap-up, resume, audio,
// refusal) and the fixed, approved answers to the questions a candidate may ask. If the writer
// times out, errors, or fails the lint, the controller speaks these. It never improvises.
//
// VOICE. Warm, plain, sentence case, one question at a time, no em dashes, never evaluative, never
// the mechanism (no probe, evidence, verify, assess, score, test, rubric, evaluate). voice/fallback.test.mjs
// runs the same wall voice/plan.mjs applies to plan text over every line here.
//
// NO INVENTED TIMELINE. The wrap-up says what happens next only in HR's own sentence
// (vv_mandates.next_step_text); with none, Charlie says it does not set the timeline.

export const REFUSAL_ACK = "That's fine, we can leave that one.";

export const META_ANSWERS = Object.freeze({
  what_is_this: "This is a conversation about the work behind the role you applied for. The hiring team asked me to talk it through with you so they can hear it in your own words.",
  who_sees: "The hiring team for this role. They get the recording, a written transcript, and notes drawn from what you say. Nobody else.",
  how_long: null, // built from the plan budget, see fallbackText
  can_skip: "Yes. Say skip and we'll move on, no questions asked.",
  can_stop: "Yes. You can stop at any point, and if you come back with the same link we'll pick up where we left off.",
  is_recorded: "Yes, this conversation is recorded, and you'll be able to read the transcript afterwards.",
  are_you_ai: "I'm an AI agent called Charlie. There's no person on the line right now; the hiring team will read what you say afterwards.",
  what_next: null, // HR's sentence or the honest default, see fallbackText
  pause: "Of course. Take your time, and just start talking when you're ready.",
  unknown: "I don't know that one, but the hiring team will. Let's carry on.",
});

const minutes = (plan) => Math.max(1, Math.round((plan?.session_budget_seconds || 0) / 60));
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const stripDot = (s) => String(s || "").trim().replace(/[.!?]+$/, "");

function whatNext(context) {
  const hr = String(context?.nextStepText || "").trim();
  return hr || "The hiring team takes it from here. I don't set the timeline, so I can't tell you when you'll hear.";
}

/**
 * The scripted line for a move. `item` may be null for session-level moves.
 * @param {object|null} item        a plan item (for item-level moves)
 * @param {string} move             one of policy.mjs MOVES
 * @param {{plan?:object, context?:{nextStepText?:string}, meta?:string}} [ctx]
 */
export function fallbackText(item, move, ctx = {}) {
  const fb = item?.evidence_contract?.fallback_text;
  const c = item?.evidence_contract;
  switch (move) {
    case "intro":
      return `Hi, I'm Charlie. I'm an AI agent, and this conversation is recorded. I'm going to ask you about the work behind this role, one question at a time, for about ${minutes(ctx.plan)} minutes. You can say skip, repeat that, or I need a moment, whenever you like. Ready when you are.`;
    case "wrap_up":
      return `Thank you, that's everything I wanted to ask. ${whatNext(ctx.context)} You'll get an email with a link to the transcript. Goodbye for now.`;
    case "resume":
      return "It looks like we were cut off. Let's pick up where we left off.";
    case "audio_check":
      return "I can't hear you clearly. Could you check your microphone and say that again? I'll wait.";
    case "restart_item":
      return "Of course. Let's take that one from the top.";
    case "handle_refusal":
      return REFUSAL_ACK;
    case "handle_meta": {
      const key = ctx.meta && Object.hasOwn(META_ANSWERS, ctx.meta) ? ctx.meta : "unknown";
      if (key === "how_long") return `About ${minutes(ctx.plan)} minutes in all, and less if you'd like to keep it short.`;
      if (key === "what_next") return whatNext(ctx.context);
      return META_ANSWERS[key];
    }
    case "redirect":
      return `The thing I'm after is ${lowerFirst(stripDot(c?.establishes))}. ${c?.anchor_question || ""}`.trim();
    case "ask_anchor":
      return c?.anchor_question || fb?.anchor || "";
    case "probe_specifics":
      return fb?.probe || "";
    case "probe_depth":
      return fb?.probe || "";
    case "probe_ownership":
      return c?.ownership_probe || fb?.probe || "";
    case "scenario":
      return c?.scenario || fb?.probe || "";
    case "clarify_own_question":
      return fb?.clarify || "";
    case "acknowledge_move_on":
      return fb?.move_on || "";
    default:
      throw new Error(`fallbackText: unknown move "${move}"`);
  }
}

/** Every session-level line, for the voice test. */
export function allSessionLines(plan = { session_budget_seconds: 900 }) {
  const lines = ["intro", "wrap_up", "resume", "audio_check", "restart_item", "handle_refusal"].map((m) => fallbackText(null, m, { plan, context: {} }));
  for (const meta of Object.keys(META_ANSWERS)) lines.push(fallbackText(null, "handle_meta", { plan, context: {}, meta }));
  lines.push(fallbackText(null, "wrap_up", { plan, context: { nextStepText: "We will be in touch within a week." } }));
  return lines;
}
