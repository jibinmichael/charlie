// voice/ask.mjs — Level 1 of "ask the board": a question becomes a validated rule. NO ROWS.
//
// The model sees the question and the field catalogue (prompts/vv-ask.mjs), never a person. The
// answer is validated by lib/schemas/vv-ask.mjs; anything that does not fit is a refusal with a
// reason, never a best guess. The board applies the rule to the rows it already holds.
import { VV_ASK_SYSTEM, VV_ASK_PROMPT_VERSION, buildAskMessages } from "../prompts/vv-ask.mjs";
import { AskQuery } from "../lib/schemas/vv-ask.mjs";

const textOf = (res) => (res?.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

/**
 * @param {{client:object|null, model?:string, question:string, log?:Function}} p
 * @returns {Promise<{ok:true, query:object, refused:null, prompt_version:string} | {ok:false, query:null, refused:string, prompt_version:string}>}
 */
export async function askBoard({ client, model, question, log = console.error }) {
  const m = String(model || process.env.VOICE_ASK_MODEL || process.env.VOICE_JUDGE_MODEL || "").trim();
  const refuse = (why) => ({ ok: false, query: null, refused: why, prompt_version: VV_ASK_PROMPT_VERSION });
  if (!m) return refuse("No model is configured for questions.");
  if (!client) return refuse("The question service is not available.");
  let res;
  try {
    res = await client.messages.create({ model: m, max_tokens: 600, temperature: 0, system: VV_ASK_SYSTEM, messages: buildAskMessages({ question }) });
  } catch (e) {
    log(`[vv-ask] model error: ${e?.message || e}`);
    return refuse("The question could not be read just now.");
  }
  let parsed;
  try { parsed = JSON.parse(textOf(res)); } catch { log("[vv-ask] not JSON"); return refuse("That could not be turned into a rule over the columns."); }
  const ok = AskQuery.safeParse(parsed);
  if (!ok.success) {
    log(`[vv-ask] schema: ${ok.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return refuse("That could not be turned into a rule over the columns.");
  }
  if (ok.data.refused) return refuse(ok.data.refused);
  if (!ok.data.filters.length && !ok.data.sort && !ok.data.columns && !ok.data.aggregate) return refuse("That question does not change the view; ask for a filter, a sort, columns, or a count.");
  return { ok: true, query: ok.data, refused: null, prompt_version: VV_ASK_PROMPT_VERSION };
}
