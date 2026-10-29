// lib/position.mjs — build one grounded POSITION for a person, or return nothing.
//
// Computed and stored on the dossier; not rendered in any email.
//
// THE INPUT IS THE STORED DOSSIER, NEVER THE RESUME. Every fact the builder can see has already been
// extracted, grounded and cited by dossier-build.mjs, so this step cannot introduce a new fact about
// the person. It can be wrong about emphasis; it cannot be wrong about truth. That property is the
// reason this is cheap enough to trust, and it is enforced here by what we pass in, not by asking
// the model nicely.
//
// FAIL CLOSED AT EVERY STEP. Unparseable reply -> one retry -> nothing. Verifier says no -> nothing.
// Verifier errors -> nothing. A person with no position is the normal, safe outcome; a person with a
// wrong one is the failure this whole file exists to prevent.

import Anthropic from "@anthropic-ai/sdk";
import { POSITION_BUILD_SYSTEM, buildPositionMessages } from "../prompts/position-build.mjs";
import { POSITION_VERIFY_SYSTEM, buildPositionVerifyMessages } from "../prompts/position-verify.mjs";
import { PositionBuild, PositionVerdict, StoredPosition } from "./schemas/position.mjs";

const BUILD_MODEL = process.env.POSITION_MODEL || "claude-opus-4-8";   // matches dossier-build.mjs:30
const VERIFY_MODEL = process.env.VERIFY_MODEL || "claude-haiku-4-5";   // matches edge-verify.mjs:17

const stripFences = (s) => String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
const textOf = (r) => (r?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

/** The one place the facts are assembled, so the builder and the verifier judge the SAME input. */
export function factsFor(dossier) {
  const d = dossier || {};
  const pick = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  return {
    headline: d.headline || null,
    strengths: pick(d.strengths, 8),
    proof_points: pick(d.proof_points, 12),
    case_studies: pick(d.case_studies, 4),
    employers: pick(d.employers, 6).map((e) => (typeof e === "string" ? e : e?.name || null)).filter(Boolean),
  };
}

/** Enough to say anything at all. Below this we do not spend a build call. */
export function hasEnoughToPosition(dossier) {
  const d = dossier || {};
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  return n(d.proof_points) + n(d.case_studies) >= 2 && (n(d.strengths) >= 1 || !!d.headline);
}

async function callJson({ client, model, system, messages, maxTokens, schema, log }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // NO `temperature`. Opus 4.8 rejects it outright (400: "temperature is deprecated for this
      // model"). No other caller in this repo sets it either.
      const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages });
      const parsed = schema.safeParse(JSON.parse(stripFences(textOf(res))));
      if (parsed.success) return { ok: true, value: parsed.data, usage: res.usage || null };
      log?.(`reply failed validation (attempt ${attempt}): ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 3).join("; ")}`);
    } catch (e) {
      log?.(`call/parse failed (attempt ${attempt}): ${e.message}`);
    }
  }
  return { ok: false };
}

/**
 * @returns {Promise<{position: object|null, reason: string, usage: object}>}
 *   `position` is null whenever anything is uncertain. `reason` always says why.
 */
export async function buildPosition(dossier, { client = new Anthropic(), log = () => {}, now = () => new Date().toISOString() } = {}) {
  const usage = { build: null, verify: null };
  if (!hasEnoughToPosition(dossier)) return { position: null, reason: "not enough grounded facts", usage };

  const facts = factsFor(dossier);
  const built = await callJson({
    client, model: BUILD_MODEL, system: POSITION_BUILD_SYSTEM,
    messages: buildPositionMessages(dossier), maxTokens: 700, schema: PositionBuild, log,
  });
  if (!built.ok) return { position: null, reason: "builder returned nothing usable", usage };
  usage.build = built.usage;

  const statement = String(built.value.statement || "").trim();
  // An empty statement is the prompt CHOOSING to say nothing. That is a correct answer, and it must
  // not be dressed up as a failure or retried into existence.
  if (!statement) return { position: null, reason: "builder declined: facts too thin to be specific", usage };
  if (!built.value.evidence?.length) return { position: null, reason: "statement offered with no evidence", usage };

  const verdict = await callJson({
    client, model: VERIFY_MODEL, system: POSITION_VERIFY_SYSTEM,
    messages: buildPositionVerifyMessages(built.value, facts), maxTokens: 400, schema: PositionVerdict, log,
  });
  // A verifier that cannot answer is NOT an approval. Same rule as edge-verify and the grounding
  // verifier: uncertainty drops the claim.
  if (!verdict.ok) return { position: null, reason: "verifier unreadable, dropping (fail closed)", usage };
  usage.verify = verdict.usage;
  if (!verdict.value.grounded) {
    return { position: null, reason: `verifier rejected: ${verdict.value.violations.join("; ") || verdict.value.reason}`, usage };
  }

  const candidate = { statement, evidence: built.value.evidence, model: BUILD_MODEL, at: now() };
  const stored = StoredPosition.safeParse(candidate);
  if (!stored.success) return { position: null, reason: "final shape invalid", usage };
  return { position: stored.data, reason: "grounded", usage };
}
