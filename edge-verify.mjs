// edge-verify.mjs — the Edge Engine's safety net. A second, independent pass that re-reads the SOURCE
// (a person's resume/profile) and the candidate EDGE the Opus dossier build produced, and decides whether
// the edge is grounded and how rare it genuinely is. This is the structural backstop for the one step in
// the build that reasons past the resume (the "where your combo wins" judgment).
//
// Contract: it NEVER throws. It returns a verdict the caller (dossier-build.mjs) uses to keep, downgrade,
// or DROP the edge. Fail closed: an ungrounded combo, an unreadable reply, or a verifier error
// all resolve to grounded=false, and the caller drops the edge entirely rather than store an unverified
// claim about a person. Cheap model on purpose (this is a checker), mirroring grounding-verify.mjs.
//
// An unreadable reply is retried ONCE before failing closed (same one-retry pattern as grounding-verify).

import Anthropic from "@anthropic-ai/sdk";
import { EDGE_VERIFY_SYSTEM } from "./prompts/edge-verify.mjs"; // versioned prompt — see prompts/
import { parseEdgeVerdict } from "./lib/schemas/edge-verdict.mjs"; // validate model output at the boundary

const MODEL = process.env.VERIFY_MODEL || "claude-haiku-4-5";

function strip(s) {
  let t = (s || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

// Read ONE verifier reply into a verdict. Returns { verdict } on success, or { reason } when the reply
// could not be understood — the caller retries once on a reason, then fails closed. Never throws.
function readVerdict(res) {
  const t = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let j;
  try { j = JSON.parse(strip(t)); } catch { return { reason: "unparseable edge-verifier output" }; }
  const { grounded, confidence, malformed } = parseEdgeVerdict(j);
  if (malformed) return { reason: "edge-verifier output failed schema" };
  return { verdict: { grounded, confidence } };
}

const VERIFY_ATTEMPTS = 2;

/**
 * Verify a candidate edge against the person's source. Never throws.
 * @returns {{ grounded: boolean, confidence: "high"|"medium"|"low", errored?: boolean, skipped?: boolean, reason?: string }}
 *          grounded=false means the caller must DROP the edge (fail closed).
 */
export async function verifyEdge({ sourceText, edge, client } = {}) {
  if (!sourceText || !edge || typeof edge !== "object") {
    return { grounded: false, confidence: "low", skipped: true };
  }
  try {
    const api = client || new Anthropic();
    const req = {
      model: MODEL,
      max_tokens: 400,
      system: EDGE_VERIFY_SYSTEM,
      messages: [{ role: "user", content: `## SOURCE\n\n${String(sourceText).slice(0, 14000)}\n\n## EDGE\n\n${JSON.stringify(edge).slice(0, 2000)}` }],
    };
    let reason = "unparseable edge-verifier output";
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      const res = await api.messages.create(req);
      const read = readVerdict(res);
      if (read.verdict) return read.verdict;
      reason = read.reason;
      if (attempt < VERIFY_ATTEMPTS) console.error(`[edge-verify] ${reason} — retrying once (attempt ${attempt + 1}/${VERIFY_ATTEMPTS})`);
    }
    // Both attempts unreadable → we could not verify → drop the edge. Never store unverified.
    console.error(`[edge-verify] ${reason} after ${VERIFY_ATTEMPTS} attempts — dropping edge`);
    return { grounded: false, confidence: "low", errored: true, reason };
  } catch (e) {
    console.error(`[edge-verify] errored (${e.message}) — dropping edge`);
    return { grounded: false, confidence: "low", errored: true, reason: e.message };
  }
}
