// lib/edge-match.mjs — the Edge Engine's send-time surface signal (dark behind EDGE_ENGINE).
//
// Given a person's dossier and the role Charlie already chose to send, decide whether THIS role is a
// "rare find": a role that lands in a domain where the person's grounded rare combination (dossier.edge)
// is a differentiator. When it is, the daily/first-role email flips to the "Rare find" label + a rare-fit
// subject (scheduler.mjs / first-role.mjs).
//
// It never CHOOSES the role (that stays the matcher/scheduler's job); it only reads whether the chosen
// role sits in the edge's strong_in space. Fail-safe: no edge, a non-high-confidence edge, the flag off,
// or ANY uncertainty → not a rare find, and the email is exactly what it would otherwise be.
//
// ── WHY THIS ASKS A MODEL ─────────────────────────────────────────────────────────────────────────────
// "Rare find" is a CLAIM. Every other claim in this product is verified: the edge itself is grounded by
// edge-verify.mjs, composed claims by grounding-verify.mjs. Counting shared words cannot make it:
//
//   * splitting a domain PHRASE into words destroys the phrase. "AI-first product companies" reduces to
//     generic words that appear in a large share of all postings, and short tokens like "AI" carry the
//     meaning; frequency filtering still matches on words like "developer" or "saas".
//   * embedding cosine reads better, but no fixed threshold transfers between people.
//   * a percentile / top-N% rule would make "rare" mean "top 5% of today's batch" — a quota, the padding
//     antipattern the product rejects.
//
// So the gate is a judgement, made by a cheap model, and it fails closed. Cost: at most ONE Haiku call
// per SENT role, and only for a person who already has a high-confidence edge. The deterministic gates
// below run first and short-circuit, so a person with no edge — the overwhelming majority — costs nothing.
//
// Grounding note: it reads ONLY the already-verified `edge` and the job text, and asserts nothing new
// about the person. It cannot invent a fact; the worst it can do is decline to call something rare.

import Anthropic from "@anthropic-ai/sdk";
import { EDGE_MATCH_SYSTEM } from "../prompts/edge-match.mjs"; // versioned prompt — see prompts/
import { parseEdgeMatch } from "./schemas/edge-match.mjs"; // boundary validation, fails closed

// The email surface is dark until the flag is on. `dossier.edge` is also absent unless the build ran with
// the flag on, so this is belt-and-suspenders: an old edge on a dossier can't light up the label after the
// flag is turned back off.
const edgeEngineOn = () => String(process.env.EDGE_ENGINE || "").toLowerCase() === "on";

const EDGE_MATCH_MODEL = process.env.EDGE_MATCH_MODEL || "claude-haiku-4-5";

export const RARE_FIND_LABEL = "Rare find";

const stripFences = (t) => String(t ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

/**
 * Do the cheap, deterministic gates pass? Pure, never throws, no I/O. Exported for tests and so callers
 * can see the model is only ever consulted for a person who has already earned a verified high edge.
 */
export function edgeEligible(dossier, job) {
  if (!edgeEngineOn()) return false;
  const edge = dossier?.edge;
  if (!edge || edge.confidence !== "high") return false;
  if (!Array.isArray(edge.strong_in) || !edge.strong_in.length) return false;
  const text = `${job?.title || ""} ${job?.company || ""} ${job?.description || ""}`.trim();
  return text.length > 0;
}

/**
 * Is the chosen `job` a rare find for this person? True ONLY when the deterministic gates pass (flag on,
 * a HIGH-confidence verified edge, a job with text) AND the model affirms the role genuinely sits in one
 * of the edge's strong_in domains with both halves of the combo doing real work.
 *
 * FAILS CLOSED at every step: a model error, a timeout, an unreadable reply, or a schema mismatch is NOT
 * a rare find. Uncertainty never earns the loud claim. Never throws.
 *
 * @param {object} dossier  the person's dossier (must carry a verified high-confidence `edge`)
 * @param {object} job      the role already chosen for sending
 * @param {object} [opts]   { client } — inject an Anthropic-shaped client (tests)
 * @returns {Promise<boolean>}
 */
export async function edgeHit(dossier, job, opts = {}) {
  if (!edgeEligible(dossier, job)) return false;
  const edge = dossier.edge;
  try {
    const client = opts.client || new Anthropic();
    const payload = {
      edge: {
        combo: edge.combo,
        strong_in: edge.strong_in,
        generic_in: Array.isArray(edge.generic_in) ? edge.generic_in : [],
      },
      role: {
        title: job.title || "",
        company: job.company || "",
        // Cap the posting like every other caller does — the judgement needs the gist, not the boilerplate.
        description: String(job.description || "").slice(0, 4000),
      },
    };
    const res = await client.messages.create({
      model: EDGE_MATCH_MODEL,
      max_tokens: 200,
      system: EDGE_MATCH_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    const text = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let raw;
    try {
      raw = JSON.parse(stripFences(text));
    } catch {
      console.error(`[edge-match] unreadable verdict — NOT a rare find (fail closed)`);
      return false;
    }
    const { rareFit, reason, malformed } = parseEdgeMatch(raw);
    if (malformed) {
      console.error(`[edge-match] verdict failed schema — NOT a rare find (fail closed)`);
      return false;
    }
    console.error(`[edge-match] ${job.company || "?"} / ${job.title || "?"}: rare_fit=${rareFit}${reason ? ` — ${reason}` : ""}`);
    return rareFit;
  } catch (e) {
    // A rare find is a bonus, never load-bearing: if the judge is unavailable the email still sends, as a
    // plain (honest) "Best match". Silence the label, never the role.
    console.error(`[edge-match] errored (${e?.message || e}) — NOT a rare find (fail closed)`);
    return false;
  }
}

// The subject when a role is a rare find. Warm, plain, no em dash (cleanSubject also strips them), and it
// makes NO claim about the person beyond "your background/mix" — the honest, grounded framing. Names the
// real role + company so it still reads like a specific find, not a gimmick.
export function rareFindSubject({ roleTitle, company } = {}) {
  const role = String(roleTitle || "a role").trim();
  const co = String(company || "").trim();
  return co ? `A rare fit for your background: ${role} at ${co}` : `A rare fit for your background: ${role}`;
}
