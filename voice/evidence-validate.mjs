// voice/evidence-validate.mjs — cite-or-drop, provenance, reliability, probe depth. PURE code.
//
// THE PROVENANCE CHAIN: audio segment -> transcript turn -> evidence
// quote -> signal. This is the step that makes the middle link true. An extractor item survives
// only if:
//   1. every turn it cites exists, is a candidate turn, and belongs to this item;
//   2. its quote, normalised the way lib/mandate-parse.mjs normalises, is found inside the text of
//      the cited turn(s) (cite-or-drop pointed at the transcript);
//   3. its contract element is in this item's contract.
// Then code adds what the model may not: provenance (turn ids, audio span from the turns'
// timestamps), reliability (from the turns' `usable` and stt confidence), and probe_depth (from
// the move of the agent turn that preceded the quoted turn). A drop is REPORTED with the quote and
// the reason, never silent: a clean extraction and one that lost three quotes must not look alike.
import { randomUUID } from "node:crypto";
import { norm } from "../lib/mandate-parse.mjs";
import { EvidenceItem } from "../lib/schemas/vv-evidence.mjs";

/**
 * Below this provider-reported STT confidence a turn's evidence is `low_confidence`. An engineering
 * placeholder until the bands are set from real sessions; it is named here so it can be found and
 * replaced.
 */
export const LOW_STT_CONFIDENCE = 0.5;

const PROBE_MOVES = new Set(["probe_depth", "probe_ownership", "probe_specifics", "scenario"]);
const RESET_MOVES = new Set(["ask_anchor", "restart_item", "acknowledge_move_on", "redirect", "clarify_own_question", "resume"]);

/** Probe depth of a candidate turn: how many probes this item had asked before it (capped at 2). */
export function probeDepthFor(turn, itemTurns) {
  let depth = 0;
  for (const t of itemTurns) {
    if (t.seq >= turn.seq && t.conversation_id === turn.conversation_id) break;
    if (t.speaker !== "agent") continue;
    if (RESET_MOVES.has(t.move) && t.move !== "clarify_own_question" && t.move !== "redirect") depth = t.move === "ask_anchor" || t.move === "restart_item" ? 0 : depth;
    if (PROBE_MOVES.has(t.move)) depth = Math.min(2, depth + 1);
  }
  return depth;
}

/** Reliability of a set of turns, worst wins. */
export function reliabilityOf(turns) {
  if (turns.some((t) => t.usable === false)) return "unusable";
  if (turns.some((t) => t.stt_confidence != null && Number(t.stt_confidence) < LOW_STT_CONFIDENCE)) return "low_confidence";
  return "usable";
}

/**
 * @param {{items:Array}} raw          the extractor's validated output for one item
 * @param {{item:object, sessionId:string, turns:Array, extractorVersion:string}} ctx
 *   `turns` are this item's canonical turns (vv_turns rows: id, conversation_id, seq, speaker, text,
 *   t_start, t_end, stt_confidence, usable, plan_item_id, move), in order.
 * @returns {{items:Array, dropped:Array<{quote:string, reason:string}>}}
 */
export function validateEvidence(raw, { item, sessionId, turns, extractorVersion }) {
  const itemTurns = [...(turns || [])].sort((a, b) => (a.conversation_id === b.conversation_id ? a.seq - b.seq : String(a.conversation_id).localeCompare(String(b.conversation_id))));
  const bySeq = new Map(itemTurns.map((t) => [t.seq, t]));
  const elementNames = new Set(item.evidence_contract.elements.map((e) => e.name));
  const out = [];
  const dropped = [];

  for (const r of raw?.items || []) {
    const cited = (r.turn_seqs || []).map((s) => bySeq.get(s)).filter(Boolean);
    if (cited.length !== (r.turn_seqs || []).length) { dropped.push({ quote: r.quote, reason: "cites a turn that does not exist in this item" }); continue; }
    if (cited.some((t) => t.speaker !== "candidate")) { dropped.push({ quote: r.quote, reason: "cites a turn that is not the candidate's" }); continue; }
    if (cited.some((t) => t.plan_item_id && t.plan_item_id !== item.id)) { dropped.push({ quote: r.quote, reason: "cites a turn from another item" }); continue; }
    const q = norm(r.quote);
    const hay = norm(cited.map((t) => t.text).join(" "));
    if (q.length < 3 || !hay.includes(q)) { dropped.push({ quote: r.quote, reason: "quote not found in the cited turn(s)" }); continue; }
    if (!elementNames.has(r.contract_element)) { dropped.push({ quote: r.quote, reason: `element "${r.contract_element}" is not in this item's contract` }); continue; }
    if (new Set(cited.map((t) => t.conversation_id)).size !== 1) { dropped.push({ quote: r.quote, reason: "quote spans two conversations" }); continue; }

    const starts = cited.map((t) => t.t_start).filter((x) => x != null).map(Number);
    const ends = cited.map((t) => t.t_end).filter((x) => x != null).map(Number);
    const candidate = {
      id: randomUUID(),
      session_id: sessionId,
      plan_item_id: item.id,
      requirement_id: item.requirement_id ?? null,
      contract_element: r.contract_element,
      type: r.type,
      quote: r.quote,
      specificity: r.type === "claim" ? 0 : r.specificity,
      ownership: r.ownership,
      typed_facts: (r.typed_facts || []).map((f) => ({ ...f, source: "candidate_turn" })),
      provenance: {
        conversation_id: cited[0].conversation_id,
        turn_ids: cited.map((t) => t.id),
        audio_start_secs: starts.length ? Math.min(...starts) : null,
        audio_end_secs: ends.length ? Math.max(...ends) : null,
      },
      reliability: reliabilityOf(cited),
      probe_depth: Math.max(...cited.map((t) => probeDepthFor(t, itemTurns))),
      extractor_version: extractorVersion,
    };
    const ok = EvidenceItem.safeParse(candidate);
    if (!ok.success) { dropped.push({ quote: r.quote, reason: `shape: ${ok.error.issues.map((i) => i.path.join(".")).join(",")}` }); continue; }
    out.push(ok.data);
  }
  return { items: out, dropped };
}
