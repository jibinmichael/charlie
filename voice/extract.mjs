// voice/extract.mjs — one extractor call for one plan item, validated at the boundary.
//
// Async, after the call, over the canonical vv_turns for the item only. Returns the raw validated
// output or a failure; it never throws into the batch (the pipeline isolates each item), never
// invents evidence, and never retries here (the pipeline decides how many attempts an item gets).
import { VV_EXTRACT_SYSTEM, VV_EXTRACT_PROMPT_VERSION, buildExtractMessages } from "../prompts/vv-extract.mjs";
import { ExtractOutput } from "../lib/schemas/vv-evidence.mjs";

export { VV_EXTRACT_PROMPT_VERSION };

function textOf(res) {
  return (res?.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

/**
 * @param {{client:object, model?:string, item:object, turns:Array, log?:Function}} p
 * @returns {Promise<{ok:true, output:{items:Array}, usage?:object} | {ok:false, reason:string, detail?:string}>}
 */
export async function extractItem({ client, model, item, turns, log = console.error }) {
  const m = String(model || process.env.VOICE_EXTRACTOR_MODEL || "").trim();
  if (!m) return { ok: false, reason: "no_model" };
  if (!client) return { ok: false, reason: "no_client" };
  if (!turns?.length) return { ok: true, output: { items: [] } };
  let res;
  try {
    res = await client.messages.create({ model: m, max_tokens: 6000, temperature: 0, system: VV_EXTRACT_SYSTEM, messages: buildExtractMessages({ item, turns }) });
  } catch (e) {
    log(`[vv-extract] item ${item.ref || item.id}: error ${e?.message || e}`);
    return { ok: false, reason: "error", detail: String(e?.message || e) };
  }
  let parsed;
  try { parsed = JSON.parse(textOf(res)); } catch { log(`[vv-extract] item ${item.ref || item.id}: not JSON`); return { ok: false, reason: "not_json" }; }
  const ok = ExtractOutput.safeParse(parsed);
  if (!ok.success) {
    const detail = ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    log(`[vv-extract] item ${item.ref || item.id}: schema ${detail}`);
    return { ok: false, reason: "schema", detail };
  }
  return { ok: true, output: ok.data, usage: res.usage || null };
}
