// voice/writer.mjs — the live utterance writer with a hard deadline, a lint, and one fallback.
//
// INVARIANT 10 IN CODE (docs/ARCHITECTURE.md, "Voice verification invariants"). writeUtterance() always returns something Charlie can say. The model is
// asked once, with a deadline; on deadline, error, non-JSON, schema failure, or lint failure the
// scripted text is returned with `fallbackUsed: true` and the reason. It NEVER retries (a retry
// doubles the latency and the fallback already exists) and it never returns a model line that did
// not pass the lint. Moves the writer is not used for (intro, wrap_up, resume, audio_check,
// handle_meta, handle_refusal) return the script directly: those lines are fixed and approved.
//
// WHY NOT STREAMING. The lint has to see the whole line before it is spoken; a verdict word at the
// end of a streamed sentence cannot be unsaid. The writer is capped at ~60 words, which a fast model
// returns well inside the deadline, and the live endpoint covers the wait with the provider's
// buffer word. The cost is a few hundred milliseconds; the alternative is an unlintable line.
//
// NO DEFAULT MODEL. VOICE_WRITER_MODEL missing means the scripted line is spoken and the reason is
// logged, which is the fail-closed behaviour .env.example promises.
import { VV_WRITER_SYSTEM, VV_WRITER_PROMPT_VERSION, WRITER_MOVES, buildWriterMessages } from "../prompts/vv-writer.mjs";
import { WriterOutput } from "../lib/schemas/vv-writer.mjs";
import { lintMessage } from "../lib/convo-lint.mjs";
import { MECHANISM_RE, EM_DASH } from "./plan.mjs";

export { WRITER_MOVES, VV_WRITER_PROMPT_VERSION };

/** Evaluative language: a verdict leak and a manipulation risk. */
export const VERDICT_RE = /\b(great|good|excellent|impressive|brilliant|perfect|wonderful|fantastic|amazing|strong|weak|well done|nice one|spot on|not quite|that'?s (right|correct|wrong|incorrect)|you (passed|failed|nailed))\b/i;
/** Promises the agent may not make. */
export const PROMISE_RE = /\b(you('ll| will) (hear|get|receive|be (contacted|invited))|we('ll| will) (be in touch|get back|contact|call)|guarantee|i promise|next (round|stage) (is|will))\b/i;

export const DEFAULT_DEADLINE_MS = 2500;

/**
 * Dashes become a comma before the lint, the same discipline as the email path's `esc`: the model
 * writes em dashes however firmly the prompt forbids them,
 * and a dash is a pause in speech, not a claim. Everything else the lint catches stays a fallback.
 */
export function normalizeUtterance(text) {
  return String(text || "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*,\s*,+/g, ",")
    .replace(/([.?!])\s*,\s*/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Phrases that attribute something to the candidate. What follows one must be in their own words. */
export const ATTRIBUTION_RE = /\b(you (mentioned|said|described|told me|talked about|brought up|built|ran|did)|earlier you|as you (said|put it))\b/gi;
const STOP = new Set(["that", "this", "there", "then", "than", "with", "from", "about", "your", "were", "what", "when", "where", "which", "have", "been", "into", "over", "just", "some", "very", "also", "them", "they", "their", "those", "these", "here", "much", "many", "more", "most", "such", "only", "nothing", "something", "anything", "everything", "thing", "things", "time", "role", "work"]);
// Hyphens split ("300-person" is "300" and "person"); a number of two or more digits counts as content.
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => (w.length >= 4 || /^\d{2,}$/.test(w)) && !STOP.has(w));

/**
 * Cite-or-drop pointed at the agent, before the line is spoken: every clause that says "you
 * mentioned X" must have a content word of X in the candidate's own turns. A prompt rule alone does
 * not stop the writer attributing Charlie's own question to the candidate.
 * @returns {string[]} the attributed fragments that are not grounded
 */
export function ungroundedAttributions(text, candidateText) {
  const said = new Set(words(candidateText));
  const out = [];
  const t = String(text || "");
  let m;
  ATTRIBUTION_RE.lastIndex = 0;
  while ((m = ATTRIBUTION_RE.exec(t))) {
    const rest = t.slice(m.index + m[0].length).split(/[.?!,;:]/)[0];
    const content = words(rest);
    if (content.length && !content.some((w) => said.has(w) || [...said].some((s) => s.startsWith(w.slice(0, 5)) && w.length >= 5))) out.push(`${m[0]}${rest}`.trim());
  }
  return out;
}

/**
 * The utterance lint. PURE. Every wall the prompt states, enforced.
 * @param {string} text
 * @param {{candidateText?:string}} [ctx]  the candidate's own turns; when given, attributions must be grounded in them
 * @returns {{ok:boolean, violations:string[]}}
 */
export function lintUtterance(text, { candidateText } = {}) {
  const t = String(text || "").trim();
  const v = [];
  if (candidateText !== undefined) for (const a of ungroundedAttributions(t, candidateText)) v.push(`ungrounded attribution "${a}"`);
  if (!t) v.push("empty");
  if (t.length > 400) v.push("too long");
  if (EM_DASH.test(t)) v.push("em dash");
  const m = MECHANISM_RE.exec(t); if (m) v.push(`mechanism word "${m[0]}"`);
  const vd = VERDICT_RE.exec(t); if (vd) v.push(`verdict word "${vd[0]}"`);
  const pr = PROMISE_RE.exec(t); if (pr) v.push(`promise "${pr[0]}"`);
  if ((t.match(/\?/g) || []).length > 1) v.push("more than one question");
  if (/!/.test(t)) v.push("exclamation mark");
  const universal = lintMessage({ text: t, conversational: false });
  for (const x of universal.violations || []) v.push(`convo-lint ${x.rule || x.kind}`);
  return { ok: v.length === 0, violations: v };
}

function textOf(res) {
  return (res?.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

/**
 * @param {{client:object, model?:string, move:string, scriptedText:string, purpose?:string, candidateName?:string, exchanges?:Array, deadlineMs?:number, log?:Function}} p
 * @returns {Promise<{text:string, fallbackUsed:boolean, reason:string, latencyMs:number}>}
 */
export async function writeUtterance({ client, model, move, scriptedText, purpose = "", candidateName = "", exchanges = [], deadlineMs = DEFAULT_DEADLINE_MS, log = console.error }) {
  const started = Date.now();
  const scripted = String(scriptedText || "").trim();
  const fallback = (reason) => { if (reason !== "scripted") log(`[vv-writer] fallback (${reason}) move=${move}`); return { text: scripted, fallbackUsed: reason !== "scripted", reason, latencyMs: Date.now() - started }; };

  if (!WRITER_MOVES.includes(move)) return fallback("scripted");
  if (!scripted) return fallback("no_script");
  const m = String(model || process.env.VOICE_WRITER_MODEL || "").trim();
  if (!m) return fallback("no_model");
  if (!client) return fallback("no_client");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  let res;
  try {
    res = await Promise.race([
      client.messages.create(
        { model: m, max_tokens: 300, temperature: 0, system: VV_WRITER_SYSTEM, messages: buildWriterMessages({ move, scriptedText: scripted, purpose, candidateName, exchanges }) },
        { signal: ac.signal },
      ),
      new Promise((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error("deadline")))),
    ]);
  } catch (e) {
    clearTimeout(timer);
    return fallback(ac.signal.aborted || /deadline|abort/i.test(String(e?.message)) ? "deadline" : "error");
  }
  clearTimeout(timer);

  let parsed;
  try { parsed = JSON.parse(textOf(res)); } catch { return fallback("not_json"); }
  const ok = WriterOutput.safeParse(parsed);
  if (!ok.success) return fallback("schema");
  const text = normalizeUtterance(ok.data.text);
  const candidateText = exchanges.filter((x) => x.speaker === "candidate").map((x) => x.text).join("\n");
  const lint = lintUtterance(text, { candidateText });
  if (!lint.ok) { log(`[vv-writer] lint: ${lint.violations.join("; ")}`); return fallback("lint"); }
  return { text, fallbackUsed: false, reason: "model", latencyMs: Date.now() - started };
}
