// grounding-verify.mjs — the honesty gate. A second, independent pass that re-reads the
// SOURCE (a person's resume + profile) and the ARTIFACT Charlie is about to send about them,
// and flags any claim that isn't grounded: invented facts, or soft words upgraded to loud
// ones ("built" -> "led/shipped/scaled"). This is the structural backstop for the product's
// one non-negotiable: nothing about a person is invented or inflated.
//
// Contract: it NEVER throws. It returns a verdict the caller uses to decide. Default posture is
// ENFORCE (VERIFY_MODE defaults to 'enforce' in production): callers HOLD a send whose composed
// claims fail verification. If the verifier itself ERRORS or times out, that is UNCERTAINTY, not a
// clean bill — it returns { errored: true }, and in enforce mode the caller HOLDS that one role
// (skips it, tries the next candidate) rather than send something we could not verify. Set
// VERIFY_MODE=log (or =off) to fall back to log-only. Cheap model on purpose (this is a checker).
//
// An unreadable reply is retried ONCE before holding (a syntax flake must not cost a person their
// role for the day), and with VERIFY_CONSTRAINED_DECODE=on the reply is schema-valid BY
// CONSTRUCTION. The retry is unflagged; constrained decoding defaults OFF, mirroring the matcher's
// MATCH_CONSTRAINED_DECODE. Either way the retry buys a verdict, not a verdict we prefer: a readable
// "high" is never re-asked.

import Anthropic from "@anthropic-ai/sdk";
import { GROUNDING_VERIFY_SYSTEM } from "./prompts/grounding-verify.mjs"; // versioned prompt — see prompts/
import { parseGroundingVerdict, GroundingVerdictFormat } from "./lib/schemas/grounding-verdict.mjs"; // validate model output at the boundary

const MODEL = process.env.VERIFY_MODEL || "claude-haiku-4-5";

const SYSTEM = GROUNDING_VERIFY_SYSTEM;

function strip(s) {
  let t = (s || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

// Read ONE verifier reply into a verdict. Returns { verdict } on success, or { reason } when the reply
// could not be understood — the caller retries once on a reason, then HOLDS. Never throws.
function readVerdict(res) {
  const t = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let j;
  // Unparseable checker output is not a clean pass — we could not verify. Report it so the caller
  // HOLDS the send rather than treating garbled output as "all clear".
  try { j = JSON.parse(strip(t)); } catch { return { reason: "unparseable verifier output" }; }
  // Model output is external data — validate at the boundary. normalizeSeverity coerces
  // case/whitespace drift ("HIGH", "High ", "critical") instead of letting it fall through to "low",
  // and fails CLOSED (unrecognized severity + named violations → "high"), because an unverifiable
  // inflation is the one unrecoverable failure. See lib/schemas/grounding-verdict.mjs.
  const { severity, violations, malformed } = parseGroundingVerdict(j);
  if (malformed) return { reason: "verifier output failed schema" };
  return { verdict: { ok: severity !== "high", severity, violations } };
}

// How many times we ask for a verdict before giving up and holding. Constrained decoding
// (GroundingVerdictFormat) makes an unreadable reply rare, not impossible, so one retry closes the gap.
// This retries to get ANY verdict, never a FRIENDLIER one: we only re-ask when the reply could not be
// read at all, and a readable "high" is returned on the first attempt and never re-rolled. Re-rolling
// until the auditor says something you like would be gaming the moat — that is the line this respects.
// The retry is UNFLAGGED: it cannot fail closed.
const VERIFY_ATTEMPTS = 2;

// Constrained decoding, behind a flag exactly like the matcher's MATCH_CONSTRAINED_DECODE.
// Default OFF.
//
// Why a flag on a strictly-stricter change: this call is fail-closed, so if the API ever rejected the
// schema the 400 would land in `catch` → errored → shouldHold → EVERY role held → nobody gets an email,
// on an unattended run. `evals/live.mjs` proves the ON path against the real model before a flip;
// the flag makes the flip (and the rollback) a config change, not a deploy.
const constrainedDecodeOn = () => String(process.env.VERIFY_CONSTRAINED_DECODE || "").toLowerCase() === "on";

export async function verifyGrounding({ sourceText, artifactText, client } = {}) {
  if (!sourceText || !artifactText) return { ok: true, severity: "none", violations: [], skipped: true };
  try {
    const api = client || new Anthropic();
    const constrained = constrainedDecodeOn();
    const req = {
      model: MODEL,
      max_tokens: 800,
      // temperature 0 — a verifier that returns a different verdict on the same (source, artifact)
      // pair is not a guard, it is a lottery, and this is the last gate before a real inbox. The
      // whole point of citeOrDrop is that the SAME ungrounded claim is caught EVERY time; at the API
      // default (1.0) it catches a different subset per run.
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: `## TODAY\n\n${new Date().toISOString().slice(0, 10)} (use this for any date judgment; a date before today is PAST, not "future")\n\n## SOURCE\n\n${String(sourceText).slice(0, 14000)}\n\n## ARTIFACT\n\n${String(artifactText).slice(0, 6000)}` }],
      // Schema-valid BY CONSTRUCTION when on. output_config is a response-format constraint, not part
      // of the prompt, so it costs nothing and changes no prompt bytes (the request is byte-identical
      // when the flag is off). See lib/schemas/grounding-verdict.mjs.
      ...(constrained ? { output_config: { format: GroundingVerdictFormat } } : {}),
    };
    let reason = "unparseable verifier output";
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      const res = await api.messages.create(req);
      const read = readVerdict(res);
      if (read.verdict) return read.verdict;
      reason = read.reason;
      // A silent recovery is nearly as bad as a silent loss — say that the flake happened.
      if (attempt < VERIFY_ATTEMPTS) console.error(`[verify] ${reason} — retrying once (attempt ${attempt + 1}/${VERIFY_ATTEMPTS})`);
    }
    // Both attempts unreadable. We could not verify → HOLD. Never send unverified.
    console.error(`[verify] ${reason} after ${VERIFY_ATTEMPTS} attempts — holding`);
    return { ok: false, errored: true, severity: "none", violations: [], reason };
  } catch (e) {
    // The verifier errored/timed out. That is UNCERTAINTY, not a clean bill. Report it so the caller
    // decides (enforce mode → HOLD the send). We still never throw.
    console.error(`[verify] errored (${e.message})`);
    return { ok: false, errored: true, severity: "none", violations: [], reason: e.message };
  }
}

// VERIFY_MODE default is 'enforce' — the honesty gate is on in production. Set to 'log' or 'off' to
// disable holds (log-only). Any other value (including unset) is treated as enforce.
export function verifyEnforced() {
  const mode = String(process.env.VERIFY_MODE || "enforce").toLowerCase();
  return mode !== "log" && mode !== "off" && mode !== "false" && mode !== "0";
}

// Should this artifact be held (its send skipped)? In enforce mode we HOLD when:
//   - the verifier found a high-severity grounding violation (an invented/inflated claim), OR
//   - the verifier itself errored/timed out (uncertainty → we never send what we couldn't verify).
// A missing source/artifact (skipped: true) is NOT a hold: there was nothing to check, and holding
// every such role would silently suppress legit sends. Preflight separately proves Anthropic is
// reachable, so a total verifier outage aborts the whole run earlier, not one role at a time.
export function shouldHold(result) {
  if (!verifyEnforced()) return false;
  if (result?.skipped) return false;
  return result?.severity === "high" || result?.errored === true;
}
