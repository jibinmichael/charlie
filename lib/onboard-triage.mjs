// lib/onboard-triage.mjs — the cheap read that stands in front of the expensive one.
//
// One Haiku call (~$0.001) deciding whether a ~$0.50 Opus dossier build happens. See
// prompts/onboard-triage.mjs for the rubric and why "unsure" means proceed.
//
// MODE (ONBOARD_TRIAGE), and it defaults to SHADOW on purpose: a gate that can refuse a real person
// gets to be watched before it gets to act.
//   shadow  (default) — call it, LOG the verdict, build anyway. Costs ~$0.001/inbound, changes nothing.
//   enforce           — a "not_seeking" verdict skips the build.
//   off               — no call at all, $0.
//
// FAILS OPEN EVERYWHERE. No key, a timeout, a bad JSON body, an unexpected verdict — all return
// "seeker". Refusing a real job seeker is unrecoverable; they wrote once and will not write again.
// Spending fifty cents on a sales pitch is not.
import Anthropic from "@anthropic-ai/sdk";
import { ONBOARD_TRIAGE_SYSTEM, buildTriageUserContent } from "../prompts/onboard-triage.mjs";

const MODEL = process.env.TRIAGE_MODEL || "claude-haiku-4-5";
const VERDICTS = new Set(["seeker", "not_seeking", "unsure"]);

export const triageMode = () => {
  const m = String(process.env.ONBOARD_TRIAGE || "shadow").toLowerCase();
  return m === "enforce" || m === "off" ? m : "shadow";
};

const stripFences = (t) => String(t ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

/**
 * @returns {Promise<{verdict:"seeker"|"not_seeking"|"unsure", why:string, skipped?:true}>}
 */
export async function triageInbound(text, { client, log = console.error } = {}) {
  if (triageMode() === "off") return { verdict: "seeker", why: "triage off", skipped: true };
  if (!String(text || "").trim()) return { verdict: "seeker", why: "no text", skipped: true };
  try {
    const api = client || new Anthropic();
    const res = await api.messages.create({
      model: MODEL,
      max_tokens: 100,
      temperature: 0,
      system: ONBOARD_TRIAGE_SYSTEM,
      messages: [{ role: "user", content: buildTriageUserContent(text) }],
    });
    const raw = res?.content?.find((b) => b.type === "text")?.text || "";
    const obj = JSON.parse(stripFences(raw));
    if (!VERDICTS.has(obj?.verdict)) return { verdict: "seeker", why: "unreadable verdict", skipped: true };
    return { verdict: obj.verdict, why: String(obj.why || "").slice(0, 80) };
  } catch (e) {
    // An outage must never become a wall of refusals: a guard that stops guarding and starts silently
    // discarding is the failure this fallback prevents.
    log(`[triage] failed, proceeding as seeker: ${e?.message || e}`);
    return { verdict: "seeker", why: "triage error", skipped: true };
  }
}
