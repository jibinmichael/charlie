// voice/live.mjs — the live path in functions: one turn of the call, the first line of a
// conversation, the OpenAI-compatible stream the provider expects, and the post-call reconcile
// that turns the provider's transcript into the canonical one. No HTTP here; server/voice.ts
// binds these to routes, and voice/live.test.mjs runs them against the in-memory fake.
//
// WHO DECIDES WHAT. decide() (voice/controller.mjs) picks the move from the cursor and the
// candidate's latest turn. The judge's hint is waited for at most JUDGE_WAIT_MS and then ignored
// for this turn (the decision shape is the same with or without it). The writer may
// reword the move's line and may not change it (on any failure the scripted line is
// spoken). Nothing that arrives from the provider chooses a state: the session moves only through
// voice/session.mjs, and only on decide()'s `end` or the webhook's arrival.
//
// TWO RECORDS. Every turn here writes one vv_events row (turn.recorded): the candidate's words as
// the provider delivered them mid-call, the plan item, the move, latency, fallback. The canonical
// transcript is written once, by reconcileTranscript() from the post-call webhook, and evidence
// extraction reads only that.
import { createHash, randomUUID } from "node:crypto";
import { decide, markResume } from "./controller.mjs";
import { sortItems, LIMITS } from "./policy.mjs";
import { writeUtterance } from "./writer.mjs";
import { startJudge } from "./judge.mjs";
import { emit } from "./events.mjs";

export const LIVE_VERSION = "2026-09-22.1";

/** How long a turn waits for the judge before deciding without it. Time, not a retry. */
export const JUDGE_WAIT_MS = 1500;

/** The dynamic variable the candidate page passes at session start; the agent's first message is `{{charlie_first_message}}`. */
export const FIRST_MESSAGE_VAR = "charlie_first_message";

/** The agent's system prompt is this template; the platform substitutes the conversation id before it reaches /voice/llm. */
export const AGENT_SYSTEM_PROMPT = "charlie conversation_id={{system__conversation_id}}";
const CONVERSATION_ID_RE = /conversation_id=([A-Za-z0-9_-]{4,})/;

/**
 * Spoken when a request reaches the endpoint that cannot be tied to a session, or the session
 * cannot be read. Scripted, never a model call, and it promises nothing.
 */
export const TROUBLE_LINE = "Something has gone wrong on my side and I can't carry on right now. Please close this page and open the same link again in a little while.";

const textOfContent = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ") : "");

/** The provider conversation id, from the substituted system message. Null when it is not there. */
export function conversationIdFrom(messages = []) {
  for (const m of messages) {
    if (m.role !== "system") continue;
    const hit = CONVERSATION_ID_RE.exec(textOfContent(m.content));
    if (hit) return hit[1];
  }
  return null;
}

/** The exchanges as the writer and judge read them: agent and candidate lines, in order, nothing else. */
export function exchangesFrom(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = textOfContent(m.content).trim();
    if (!text) continue;
    out.push({ speaker: m.role === "assistant" ? "agent" : "candidate", text });
  }
  return out;
}

/** Seconds spoken so far across every conversation of the session, from the server's own clock. */
export function elapsedSeconds(conversations = [], now = Date.now()) {
  let s = 0;
  for (const c of conversations) {
    const a = new Date(c.started_at).getTime();
    const b = c.ended_at ? new Date(c.ended_at).getTime() : now;
    if (Number.isFinite(a) && b > a) s += (b - a) / 1000;
  }
  return Math.round(s);
}

const liveCursor = (session) => (session?.cursor && session.cursor.phase ? session.cursor : null);

/**
 * The first thing Charlie says in a conversation: the intro for a fresh session, the resume line
 * (with the pending question) for a reconnect. Writes the cursor; a refused write throws, because
 * two starts at once is exactly what the optimistic version exists to catch.
 */
export async function beginConversation({ store, session, plan, mandate, resuming = false, elapsed = 0 }) {
  const items = { ...plan, items: sortItems(plan.items) };
  const context = { nextStepText: mandate?.next_step_text || null };
  let cursor = liveCursor(session);
  if (resuming && cursor) cursor = markResume(cursor);
  const d = decide({ plan: items, cursor, latestTurn: null, elapsed, context });
  const w = await store.writeCursor(session.id, d.cursor, session.version);
  if (!w.ok) throw new Error(w.reason);
  return { firstMessage: d.text, move: d.move };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * One turn: the candidate has just spoken (the last user message); decide, write the cursor, write
 * the line, log the turn. Returns what to say and whether the conversation is over. Never throws
 * for a model problem; a store problem propagates so the route can speak TROUBLE_LINE.
 * @param {{store:object, client:object|null, session:object, plan:object, mandate:object, candidate?:object|null, conversation:object, conversations?:Array, messages:Array, now?:number, judgeWaitMs?:number, log?:Function}} p
 */
export async function runTurn({ store, client, session, plan, mandate, candidate = null, conversation, conversations = [conversation], messages, now = Date.now(), judgeWaitMs = JUDGE_WAIT_MS, log = console.error }) {
  const started = Date.now();
  const sorted = { ...plan, items: sortItems(plan.items) };
  const context = { nextStepText: mandate?.next_step_text || null };
  const exchanges = exchangesFrom(messages);
  const last = messages[messages.length - 1];
  const latestTurn = last?.role === "user" ? { text: textOfContent(last.content).trim() } : null;
  const elapsed = elapsedSeconds(conversations, now);
  const cursor = liveCursor(session);

  // The judge reads the current item's exchanges. It is started, waited for briefly, then ignored.
  let hint;
  let judgeUsed = false;
  const currentItem = cursor && cursor.phase === "items" ? sorted.items[cursor.itemIndex] : null;
  if (currentItem && latestTurn && client) {
    const handle = startJudge({ client, item: currentItem, exchanges: exchanges.slice(-8), log });
    hint = await Promise.race([handle.settled.then(() => handle.latest()), sleep(judgeWaitMs).then(() => undefined)]);
    judgeUsed = Boolean(hint);
    if (!judgeUsed) await emit(store, session, "judge.unavailable", { conversation_id: conversation.id, item_id: currentItem.id });
  }

  const d = decide({ plan: sorted, cursor, latestTurn, hint, elapsed, context });
  const item = d.itemId ? sorted.items.find((i) => i.id === d.itemId) : null;

  let text = d.text;
  let fallbackUsed = true;
  let reason = "scripted";
  const w = await store.writeCursor(session.id, d.cursor, session.version);
  if (!w.ok) {
    reason = "stale_cursor";
    log(`[vv-live] ${w.reason}`);
  } else {
    const r = await writeUtterance({ client, move: d.move, scriptedText: d.text, purpose: item?.evidence_contract?.establishes || "", candidateName: candidate?.name_as_given || "", exchanges, log });
    text = r.text; fallbackUsed = r.fallbackUsed; reason = r.reason;
  }

  const latencyMs = Date.now() - started;
  await emit(store, session, "turn.recorded", {
    conversation_id: conversation.id, provider_conversation_id: conversation.provider_conversation_id,
    seq: messages.length, candidate_text: latestTurn?.text ?? null, agent_text: text,
    plan_item_id: d.itemId, move: d.move, end: d.end, end_reason: d.endReason, elapsed,
    latency_ms: latencyMs, fallback_used: fallbackUsed, writer_reason: reason, judge_used: judgeUsed, live_version: LIVE_VERSION,
  });

  let completed = false;
  if (d.end && w.ok && session.state === "in_progress") {
    const t = await store.transitionSession(session.id, "session.completed", { reason: d.endReason, conversation_id: conversation.id });
    completed = t.ok;
  }
  return { text, move: d.move, itemId: d.itemId, end: d.end, endReason: d.endReason, fallbackUsed, reason, judgeUsed, latencyMs, cursorWritten: w.ok, completed };
}

// ── the OpenAI-compatible answer ─────────────────────────────────────────────

const chunk = (id, created, delta, finish = null) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "charlie", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/**
 * The whole streamed answer as one string: role, the line, an `end_call` tool call when the
 * conversation is over and the provider offered that tool, the finish, [DONE]. The line is
 * complete before anything is sent (the lint has to see it whole), so this is one write.
 */
export function sseAnswer({ text, endCall = false, id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000) }) {
  let s = chunk(id, created, { role: "assistant", content: "" });
  s += chunk(id, created, { content: text });
  if (endCall) {
    s += chunk(id, created, { tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: "end_call", arguments: "{}" } }] });
    s += chunk(id, created, {}, "tool_calls");
  } else {
    s += chunk(id, created, {}, "stop");
  }
  return `${s}data: [DONE]\n\n`;
}

/** The same answer for a non-streaming request. */
export function jsonAnswer({ text, id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000) }) {
  return { id, object: "chat.completion", created, model: "charlie", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] };
}

/** True when the provider's request offers the end_call system tool. */
export const offersEndCall = (tools = []) => (tools || []).some((t) => t?.function?.name === "end_call" || t?.name === "end_call");

// ── the post-call reconcile ──────────────────────────────────────────────────

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The provider's transcript, entry by entry, into canonical turns. The plan item and move come from
 * the live log: an agent line is matched to the turn.recorded event that produced it, and a
 * candidate line belongs to the question just before it. A line the live log does not know keeps a
 * null item; nothing is guessed. `usable` is the same rule the controller applies live.
 * @param {{transcript:Array, events:Array}} p
 * @returns {{turns:Array, hash:string, unmatchedAgentLines:number}}
 */
export function reconcileTranscript({ transcript = [], events = [] }) {
  const byAgentText = new Map();
  for (const e of events) if (e.type === "turn.recorded" && e.payload?.agent_text) byAgentText.set(norm(e.payload.agent_text), e.payload);
  const entries = transcript.filter((t) => String(t.message || "").trim());
  const turns = [];
  let lastItem = null;
  let unmatched = 0;
  for (let i = 0; i < entries.length; i++) {
    const t = entries[i];
    const next = entries[i + 1];
    const text = String(t.message).trim();
    const speaker = t.role === "agent" ? "agent" : "candidate";
    let plan_item_id = null, move = null;
    if (speaker === "agent") {
      const hit = byAgentText.get(norm(text));
      if (hit) { plan_item_id = hit.plan_item_id ?? null; move = hit.move ?? null; lastItem = plan_item_id; }
      else unmatched++;
    } else {
      plan_item_id = lastItem;
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    turns.push({
      seq: i, speaker, text,
      t_start: t.time_in_call_secs ?? null,
      t_end: next?.time_in_call_secs ?? null,
      stt_confidence: null,
      usable: speaker === "agent" ? true : words >= LIMITS.MIN_USABLE_WORDS,
      plan_item_id, move,
    });
  }
  const hash = createHash("sha256").update(JSON.stringify(turns.map((t) => [t.seq, t.speaker, t.text, t.t_start]))).digest("hex");
  return { turns, hash, unmatchedAgentLines: unmatched };
}
