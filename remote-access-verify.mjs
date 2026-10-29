// remote-access-verify.mjs — the Tier-2 grounded remote-accessibility check. A cheap Haiku pass that
// re-reads the FULL job description and decides whether a REMOTE role is genuinely workable from the
// candidate's home region (India). It is the backstop for the ambiguous remote roles the deterministic
// Tier-1 classifier (quality-gate.remoteAccessibility) left as "unknown".
//
// Contract: it NEVER throws. It returns a verdict the caller (quality-gate.gateRole) uses to keep or DROP
// the role. Fail closed: an ambiguous role, an unreadable reply, or a verifier error all resolve
// to accessible=false — we would rather drop a role than dump one that isn't truly open to India.
//
// ONE exception to fail-closed, on purpose: if the model can't run AT ALL (no ANTHROPIC_API_KEY), we
// return { skipped:true } instead of accessible=false, so a missing key can't silently drop EVERY
// ambiguous remote role for every India user (the fail-closed-becomes-fail-to-zero class). The caller
// treats "skipped" as "no Tier-2 opinion" and falls back to the Tier-1 / reachableForRegion result.
//
// An unreadable reply is retried ONCE before failing closed (same one-retry pattern as edge-verify).

import Anthropic from "@anthropic-ai/sdk";
import { REMOTE_ACCESS_VERIFY_SYSTEM } from "./prompts/remote-access-verify.mjs"; // versioned prompt
import { parseRemoteAccessVerdict } from "./lib/schemas/remote-access-verdict.mjs"; // validate at the boundary

const MODEL = process.env.VERIFY_MODEL || "claude-haiku-4-5";
const VERIFY_ATTEMPTS = 2;
const JD_CAP = Number(process.env.REMOTE_ACCESS_JD_CAP || 6000); // enough JD to see a buried region/tz clause

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
  try { j = JSON.parse(strip(t)); } catch { return { reason: "unparseable remote-access verdict" }; }
  const v = parseRemoteAccessVerdict(j);
  if (v.malformed) return { reason: "remote-access verdict failed schema" };
  return { verdict: { accessible: v.accessible, confidence: v.confidence, reason: v.reason } };
}

/**
 * Verify whether a remote job is genuinely workable from the candidate's region. Never throws.
 * @param {{ job: object, region?: string, client?: object }} args
 * @returns {Promise<{ accessible: boolean, confidence: "high"|"medium"|"low", reason?: string, errored?: boolean, skipped?: boolean }>}
 *          accessible=false means the caller must DROP the role (fail closed). skipped=true means Tier 2
 *          could not run (no key) — the caller keeps the Tier-1 result instead of dropping.
 */
export async function verifyRemoteAccess({ job, region = "india", client } = {}) {
  if (!job || typeof job !== "object") return { accessible: false, confidence: "low", skipped: true };
  // No key and no injected client → Tier 2 cannot run. Skip (do NOT drop everything). Tests inject a client.
  if (!client && !process.env.ANTHROPIC_API_KEY) return { accessible: false, confidence: "low", skipped: true };
  try {
    const api = client || new Anthropic();
    const jd = `TITLE: ${String(job.title || "")}\nLOCATION: ${String(job.location || "")}\nCANDIDATE REGION: ${region}\n\nJOB TEXT:\n${String(job.description || "").slice(0, JD_CAP)}`;
    const req = { model: MODEL, max_tokens: 300, system: REMOTE_ACCESS_VERIFY_SYSTEM, messages: [{ role: "user", content: jd }] };
    let reason = "unparseable remote-access verdict";
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      const res = await api.messages.create(req);
      const read = readVerdict(res);
      if (read.verdict) return read.verdict;
      reason = read.reason;
    }
    // retries exhausted: uncertainty → fail closed (drop this ONE role, never a blanket zero).
    return { accessible: false, confidence: "low", errored: true, reason };
  } catch (e) {
    return { accessible: false, confidence: "low", errored: true, reason: e?.message || "verifier error" };
  }
}
