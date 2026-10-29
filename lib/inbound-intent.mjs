// lib/inbound-intent.mjs — name what an inbound message is for, and fail towards a human.
//
// THE ONE PROPERTY THAT MATTERS: nothing this module can return, and no way it can fail, results in
// a write to somebody's profile unless the model said "preference_change" with high confidence and
// the output parsed. Every other path returns an intent that routes to an acknowledgement and a
// person. A wrong write to somebody's profile (a consent grant or a disputed rejection filed as a
// preference change) is the failure this exists to prevent.
import Anthropic from "@anthropic-ai/sdk";
import { INBOUND_INTENT_SYSTEM, buildIntentMessages } from "../prompts/inbound-intent.mjs";
import { InboundIntent } from "./schemas/inbound-intent.mjs";

const MODEL = process.env.INBOUND_INTENT_MODEL || "claude-haiku-4-5-20251001";

/** @returns {Promise<{intent:string, confidence:string, why:string, quote:string, ok:boolean}>} */
export async function classifyInbound({ subject = "", body = "", log = () => {} } = {}) {
  const unsure = (why) => ({ intent: "other", confidence: "low", why, quote: "", ok: false });
  if (!String(body || "").trim()) return unsure("empty message");
  if (!process.env.ANTHROPIC_API_KEY) return unsure("no API key, so nothing was classified");
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      // temperature 0: the same message must route the same way twice. A person whose reply is
      // written into their profile on Monday and handed to a human on Tuesday is being treated by a
      // coin flip.
      model: MODEL, max_tokens: 300, temperature: 0,
      system: INBOUND_INTENT_SYSTEM, messages: buildIntentMessages({ subject, body }),
    });
    const text = (res.content || []).map((c) => c.text || "").join("").trim().replace(/^```(?:json)?|```$/g, "");
    let parsed;
    try { parsed = JSON.parse(text); } catch { return unsure("reply was not JSON"); }
    const ok = InboundIntent.safeParse(parsed);
    if (!ok.success) return unsure("reply did not match the schema");
    return { ...ok.data, ok: true };
  } catch (e) {
    log(`[intent] classify failed: ${e.message}`);
    return unsure(`classifier error: ${e.message}`);
  }
}

/**
 * May this message reach the preference writer?
 *
 * ONLY a confident preference_change. Everything else, including a low-confidence one and every
 * failure mode above, is false. The default is "do not write unless somebody was clearly asking us
 * to", never "write unless a guard caught it".
 */
export const mayWritePreferences = (r) => r?.ok === true && r.intent === "preference_change" && r.confidence === "high";
