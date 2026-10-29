// track.mjs — read a company reply a job seeker FORWARDS to track@, and classify what
// application stage it represents. Grounded: extract only what's in the email; never guess.
// Feeds rungs 2-3 of the feedback ladder (applied / heard back / interview / offer) passively,
// so Charlie learns outcomes without asking. Cheap model on purpose (this is a classifier).

import Anthropic from "@anthropic-ai/sdk";
import { TRACK_CLASSIFY_SYSTEM } from "./prompts/track-classify.mjs"; // versioned prompt — see prompts/

const MODEL = process.env.TRACK_MODEL || "claude-haiku-4-5";

const SYSTEM = TRACK_CLASSIFY_SYSTEM;

function stripFences(s) {
  let t = (s || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

export async function classifyForwardedReply(text) {
  if (!text || text.trim().length < 20) return null;
  try {
    const client = new Anthropic();
    const today = new Date().toISOString().slice(0, 10);
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content: `## TODAY\n\n${today}\n\n## FORWARDED EMAIL\n\n${String(text).slice(0, 8000)}` }],
    });
    const t = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const j = JSON.parse(stripFences(t));
    if (!j || typeof j !== "object") return null;
    const outcome = ["applied", "rejected", "interview", "offer", "other"].includes(j.outcome) ? j.outcome : "other";
    return { company: j.company || null, role_title: j.role_title || null, outcome, confidence: j.confidence || "low" };
  } catch (e) {
    console.error(`[track] classify failed: ${e.message}`);
    return null;
  }
}
