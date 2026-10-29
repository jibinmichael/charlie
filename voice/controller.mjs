// voice/controller.mjs — decide(): the next move, from deterministic state, the latest candidate
// turn, and an optional judge hint. PURE: no I/O, no clock, no model.
//
// THE JUDGE ADVISES, THE CONTROLLER DECIDES, IN ONE FUNCTION SIGNATURE. decide({ plan, cursor, latestTurn, hint, elapsed,
// context }) returns { move, text, itemId, end, endReason, cursor }. `hint` may be undefined, late,
// or garbage, and the decision shape is identical either way; with no hint the item gets the
// deterministic default (one probe minimum, then the next unasked probe, then move on). The text
// returned is always the scripted line (voice/fallback.mjs or the plan's own question); the writer
// (voice/writer.mjs) may reword it and may not change the move. Nothing here ever reads a dollar figure: the
// budgets are seconds and turns.
//
// THE CURSOR IS THE ONLY STATE, and it is never mutated: the caller gets a new one back and writes
// it with the optimistic version (voice/store.mjs writeCursor). A refused write means the next call
// sees the old cursor and makes the same decision again, which is why decisions must be functions
// of their inputs and nothing else.
import { classifyTurn, validHint, LIMITS, QUESTION_MOVES, sortItems, requiredElements, coreElement } from "./policy.mjs";
import { fallbackText, REFUSAL_ACK } from "./fallback.mjs";

export const CONTROLLER_VERSION = "2026-09-22.1";

/** A fresh cursor for a plan. */
export function initCursor() {
  return {
    phase: "intro",          // intro -> ready -> items -> done
    itemIndex: -1,
    items: {},               // itemId -> item state (see openItem)
    unusableStreak: 0,
    metaCount: 0,
    conversationCount: 1,
    resumePending: false,
    lastQuestion: null,
    turnCount: 0,
    endReason: null,
  };
}

function freshItemState(elapsed, restarts = 0) {
  return { status: "open", startedAt: elapsed, anchorAsked: true, probesAsked: 0, probeIdx: [], ownershipAsked: false, specificsAsked: false, scenarioAsked: false, present: [], unusable: 0, offTopic: 0, restarts };
}

/**
 * @param {{plan:object, cursor?:object|null, latestTurn?:{text?:string, unusable?:boolean}|null, hint?:any, elapsed?:number, context?:{nextStepText?:string}}} p
 * @returns {{move:string, text:string, itemId:string|null, end:boolean, endReason:string|null, meta:string|null, probeIndex?:number, targets?:string, cursor:object}}
 */
export function decide({ plan, cursor = null, latestTurn = null, hint, elapsed = 0, context = {} }) {
  const items = sortItems(plan.items);
  const c = cursor ? structuredClone(cursor) : initCursor();
  const ctx = { plan, context };

  const out = (move, text, extra = {}) => {
    if (QUESTION_MOVES.has(move)) c.lastQuestion = text;
    return { move, text, itemId: extra.itemId ?? items[c.itemIndex]?.id ?? null, end: Boolean(extra.end), endReason: extra.endReason ?? null, meta: extra.meta ?? null, ...(extra.probeIndex != null ? { probeIndex: extra.probeIndex, targets: extra.targets } : {}), cursor: c };
  };
  const wrap = (reason, prefix = "") => {
    c.phase = "done"; c.endReason = reason;
    const text = `${prefix ? prefix + " " : ""}${fallbackText(null, "wrap_up", ctx)}`;
    return out("wrap_up", text, { end: true, endReason: reason, itemId: null });
  };
  const openItem = (idx) => { const it = items[idx]; c.itemIndex = idx; c.items[it.id] = freshItemState(elapsed); return it; };
  const advance = (prefix, move = "acknowledge_move_on") => {
    const next = c.itemIndex + 1;
    if (next >= items.length) return wrap("items_exhausted", prefix);
    const it = openItem(next);
    return out(move, `${prefix ? prefix + " " : ""}${it.evidence_contract.anchor_question}`, { itemId: it.id });
  };

  if (c.phase === "done") return out("wrap_up", fallbackText(null, "wrap_up", ctx), { end: true, endReason: c.endReason, itemId: null });
  if (latestTurn) c.turnCount++;

  if (c.resumePending) {
    c.resumePending = false;
    const text = `${fallbackText(null, "resume", ctx)}${c.lastQuestion ? " " + c.lastQuestion : ""}`;
    return out("resume", text);
  }

  if (c.phase === "intro") { c.phase = "ready"; return out("intro", fallbackText(null, "intro", ctx), { itemId: null }); }

  const cls = classifyTurn(latestTurn);

  if (c.phase === "ready") {
    if (cls.kind === "refusal") return wrap("declined_at_intro");
    if (cls.kind === "meta" || cls.kind === "pause") {
      c.metaCount++;
      return out("handle_meta", `${fallbackText(null, "handle_meta", { ...ctx, meta: cls.meta })} Ready when you are.`, { meta: cls.meta, itemId: null });
    }
    c.phase = "items";
    const it = openItem(0);
    return out("ask_anchor", it.evidence_contract.anchor_question, { itemId: it.id });
  }

  // phase: items
  const it = items[c.itemIndex];
  const st = c.items[it.id];
  const ct = it.evidence_contract;

  if (elapsed >= plan.session_budget_seconds - LIMITS.WRAP_MARGIN_SECONDS) return wrap("session_budget");

  if (cls.kind === "unusable") {
    st.unusable++; c.unusableStreak++;
    if (c.unusableStreak >= LIMITS.AUDIO_STRIKES_SESSION) { st.status = "insufficient_audio"; return wrap("audio"); }
    if (st.unusable >= LIMITS.AUDIO_STRIKES_ITEM) { st.status = "insufficient_audio"; return advance(ct.fallback_text.move_on); }
    return out("audio_check", fallbackText(it, "audio_check", ctx), { itemId: it.id });
  }
  c.unusableStreak = 0;

  if (cls.kind === "meta" || cls.kind === "pause") {
    c.metaCount++;
    return out("handle_meta", `${fallbackText(it, "handle_meta", { ...ctx, meta: cls.meta })} ${ct.fallback_text.clarify}`, { meta: cls.meta, itemId: it.id });
  }
  if (cls.kind === "repeat") return out("clarify_own_question", ct.fallback_text.clarify, { itemId: it.id });
  if (cls.kind === "restart") {
    c.items[it.id] = freshItemState(st.startedAt, st.restarts + 1);
    return out("restart_item", `${fallbackText(it, "restart_item", ctx)} ${ct.anchor_question}`, { itemId: it.id });
  }
  if (cls.kind === "refusal") { st.status = "declined"; return advance(REFUSAL_ACK, "handle_refusal"); }

  // an answer
  const h = validHint(hint, ct);
  if (h && h.relevant === false) {
    st.offTopic++;
    if (st.offTopic >= LIMITS.OFF_TOPIC_STRIKES) { st.status = "insufficient_irrelevant"; return advance(ct.fallback_text.move_on); }
    return out("redirect", fallbackText(it, "redirect", ctx), { itemId: it.id });
  }
  if (h) st.present = [...new Set([...st.present, ...h.present])];

  const required = requiredElements(ct);
  const missing = required.filter((e) => !st.present.includes(e));
  const itemSeconds = elapsed - st.startedAt;
  const scenarioFits = ct.scenario && !st.scenarioAsked && itemSeconds + LIMITS.SCENARIO_MIN_SECONDS <= it.budget_seconds;

  if (st.probesAsked >= LIMITS.MIN_PROBES && h && missing.length === 0) { st.status = "sufficient"; return advance(ct.fallback_text.move_on); }
  if (st.probesAsked >= LIMITS.MIN_PROBES && itemSeconds >= it.budget_seconds) { st.status = "moved_on"; return advance(ct.fallback_text.move_on); }
  if (st.probesAsked >= LIMITS.MAX_PROBES) {
    if (scenarioFits) { st.scenarioAsked = true; return out("scenario", ct.scenario, { itemId: it.id }); }
    st.status = "moved_on"; return advance(ct.fallback_text.move_on);
  }

  // choose the probe by the missing required element
  const core = coreElement(ct);
  if (h && core && !st.present.includes(core) && !st.specificsAsked) {
    st.specificsAsked = true; st.probesAsked++;
    return out("probe_specifics", fallbackText(it, "probe_specifics", ctx), { itemId: it.id });
  }
  const unasked = ct.depth_probes.map((p, i) => ({ p, i })).filter((x) => !st.probeIdx.includes(x.i));
  let pick = unasked.find((x) => missing.includes(x.p.targets));
  if (!pick && missing.includes("ownership") && ct.ownership_probe && !st.ownershipAsked) {
    st.ownershipAsked = true; st.probesAsked++;
    return out("probe_ownership", ct.ownership_probe, { itemId: it.id });
  }
  if (!pick) pick = unasked[0];
  if (pick) {
    st.probeIdx.push(pick.i); st.probesAsked++;
    return out("probe_depth", pick.p.text, { itemId: it.id, probeIndex: pick.i, targets: pick.p.targets });
  }
  if (ct.ownership_probe && !st.ownershipAsked) {
    st.ownershipAsked = true; st.probesAsked++;
    return out("probe_ownership", ct.ownership_probe, { itemId: it.id });
  }
  if (scenarioFits) { st.scenarioAsked = true; return out("scenario", ct.scenario, { itemId: it.id }); }
  st.status = "moved_on";
  return advance(ct.fallback_text.move_on);
}

/** Mark the cursor for a new conversation on the same session (a drop, then the same link). */
export function markResume(cursor) {
  const c = structuredClone(cursor);
  c.conversationCount = (c.conversationCount || 1) + 1;
  c.resumePending = c.phase === "items" || c.phase === "ready";
  return c;
}

/** Item statuses by ref, for reports and tests. Items never opened are absent (the evaluator reads them as not_assessed). */
export function itemStatuses(plan, cursor) {
  const out = {};
  for (const it of plan.items) if (cursor.items[it.id]) out[it.ref] = cursor.items[it.id].status;
  return out;
}
