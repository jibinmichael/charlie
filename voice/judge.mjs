// voice/judge.mjs — the sufficiency hint, fire-and-forget.
//
// NEVER AWAITED, NEVER RETRIED, NEVER A HARD DEPENDENCY.
// startJudge() fires one model call and returns a handle; the controller reads handle.latest() at
// decision time and gets the hint if it has arrived, or null. A null hint is the deterministic
// default (voice/controller.mjs): one probe, then move on. A slow judge is ignored for that turn; a
// broken judge is ignored for the session; the candidate cannot tell the difference. Every outcome
// is logged as a condition (judge.unavailable) so the package can say how often the hint was there.
import { VV_JUDGE_SYSTEM, VV_JUDGE_PROMPT_VERSION, buildJudgeMessages } from "../prompts/vv-judge.mjs";
import { JudgeOutput } from "../lib/schemas/vv-judge.mjs";

export { VV_JUDGE_PROMPT_VERSION };
export const DEFAULT_JUDGE_DEADLINE_MS = 4000;

function textOf(res) {
  return (res?.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

/**
 * One judge call, bounded. Resolves to a hint or null; never throws.
 * @returns {Promise<{present:string[], relevant:boolean}|null>}
 */
export async function judgeOnce({ client, model, item, exchanges = [], deadlineMs = DEFAULT_JUDGE_DEADLINE_MS, log = console.error }) {
  const m = String(model || process.env.VOICE_JUDGE_MODEL || "").trim();
  if (!m) { log("[vv-judge] unavailable (no_model)"); return null; }
  if (!client) { log("[vv-judge] unavailable (no_client)"); return null; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const res = await Promise.race([
      client.messages.create({ model: m, max_tokens: 200, temperature: 0, system: VV_JUDGE_SYSTEM, messages: buildJudgeMessages({ item, exchanges }) }, { signal: ac.signal }),
      new Promise((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error("deadline")))),
    ]);
    let parsed;
    try { parsed = JSON.parse(textOf(res)); } catch { log("[vv-judge] unavailable (not_json)"); return null; }
    const ok = JudgeOutput.safeParse(parsed);
    if (!ok.success) { log("[vv-judge] unavailable (schema)"); return null; }
    return ok.data;
  } catch (e) {
    log(`[vv-judge] unavailable (${ac.signal.aborted ? "deadline" : "error"}): ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire and forget. `latest()` is what the controller reads; `settled` exists for tests only.
 * @returns {{latest:() => object|null, settled: Promise<void>}}
 */
export function startJudge(params) {
  let hint = null;
  const settled = judgeOnce(params).then((h) => { hint = h; }).catch(() => { hint = null; });
  return { latest: () => hint, settled };
}
