// grounding-enforce.mjs — cite-or-drop at send time: the enforcement step for grounded claims.
//
// verifyGrounding (grounding-verify.mjs) is the AUDITOR — it returns the exact ungrounded phrases
// ("violations"). This module is the ENFORCER: given those phrases, it DROPS each flagged claim
// from the composed email surfaces and hands back a pruned copy, so an uncited/inflated claim is
// removed rather than shipped. Every claim that survives is one the source supports.
//
// Why drop-and-send instead of holding the whole email: holding on any violation means the user gets
// NOTHING that day (a silent no-send). Dropping only the offending claim keeps the real role in their
// inbox, minus the ungrounded flourish. A verifier that ERRORED is still a HOLD upstream (uncertainty
// is not a clean bill); this module is only invoked when the verifier SUCCEEDED and named claims.
//
// If pruning removes ALL fit content — no readout, no why_you, no fit reason — this module reports it
// via `allFitDropped` and the caller holds the send (see hasFitContent).
//
// Pure + deterministic (no I/O, no model call) so it is fully unit-testable.

// GROUNDING_MODE: "drop" (DEFAULT — enforce cite-or-drop), "shadow" (compute + log what WOULD drop
// but send the claim anyway), or "hold" (no cite-or-drop, hold-only).
//
// An unknown value falls back to the SAFE mode, never the leaky one:
//
//   1. Shadow is not a safe default. It holds only on HIGH severity (grounding-verify.mjs
//      `shouldHold`), so a low/medium violation is neither held nor dropped — it ships.
//   2. A plausible typo (GROUNDING_MODE=enforce) must not silently reopen that gap, so unknown means
//      drop + a loud warning.
//
// This is deliberately NOT gated on an env var being present: a missing var must not be able to
// disable enforcement. The enforcing path is strictly tighter than shadow on every branch (see
// groundingDecision), so defaulting to it is safe.
let warnedUnknownMode = false;
export function groundingMode() {
  const raw = process.env.GROUNDING_MODE;
  if (raw == null || String(raw).trim() === "") return "drop";
  const m = String(raw).toLowerCase().trim();
  if (m === "drop" || m === "hold" || m === "shadow") return m;
  if (!warnedUnknownMode) {
    warnedUnknownMode = true;
    console.warn(`[grounding] unknown GROUNDING_MODE="${raw}" — falling back to "drop" (enforcing). Valid: drop | shadow | hold.`);
  }
  return "drop";
}

/**
 * The send-time grounding decision, extracted from scheduler.mjs so it is unit-testable without
 * running a send. Ordering is the whole point: the HOLD is evaluated FIRST and unconditionally, so
 * no mode — not even the shadow opt-out — can send a high-severity or unverifiable claim.
 *
 *   "hold"  — do not send this role at all (high severity, verifier errored, or violations the
 *             enforcer could not localize, which means we cannot PROVE the bad claim is gone).
 *   "prune" — remove the flagged claims and send the grounded remainder.
 *   "send"  — nothing flagged (or an explicit opt-out mode); send unchanged.
 *
 * @param {{severity?:string, errored?:boolean, skipped?:boolean, violations?:any[]}} verdict  verifyGrounding() result.
 * @param {{dropped:string[]}|null} pruned  citeOrDrop() output, or null when there was nothing to prune.
 * @param {string} mode  groundingMode().
 * @param {(v:any)=>boolean} holds  shouldHold from grounding-verify.mjs (injected to keep this module pure).
 * @returns {"hold"|"prune"|"send"}
 */
export function groundingDecision(verdict, pruned, mode, holds) {
  // A caller that forgets `holds` (or passes a non-function) must not crash or, worse, skip the gate.
  // Fail closed: no hold predicate means we cannot prove this is safe to send.
  if (typeof holds !== "function") return "hold";
  // 1. Uncertainty and high severity always win, in EVERY mode. This is the line that makes the
  //    shadow opt-out safe to keep: it can suppress pruning, never the hold.
  if (holds(verdict)) return "hold";
  if (mode === "hold" || mode === "shadow") return "send"; // explicit opt-outs: log only, don't prune
  if (!pruned) return "send"; // no violations named → nothing to remove
  // 2. The verifier named claims but the enforcer localized NONE of them (a paraphrase or a span
  //    crossing field boundaries the substring match missed). We cannot prove the ungrounded claim
  //    is gone, so fail closed rather than send an email we believe still carries it.
  if (pruned.dropped.length === 0) return "hold";
  return "prune";
}

const norm = (s) => String(s == null ? "" : s).toLowerCase();
// A field "carries a violation" if any flagged phrase appears within it (case-insensitive substring).
// Phrases are the verifier's `claim` values — exact spans lifted from the artifact — so substring is
// the right, conservative match (drop if in doubt).
function hit(text, phrases) {
  const t = norm(text);
  return t ? phrases.some((p) => p && t.includes(p)) : false;
}

/**
 * Remove every verifier-flagged claim from a composed email's person-claim surfaces.
 * @param {object} fields  composer output ({ why_you, flag, cover_letter, resume_tips[], facts[{k,v}], ... }).
 * @param {object|null} cov  fit-coverage readout ({ thin, reason, topMove, coverage[{req,status,evidence}] }).
 * @param {{claim?:string}[]} violations  verifyGrounding().violations.
 * @returns {{ fields:object, cov:object|null, dropped:string[], allFitDropped:boolean }}
 */
export function citeOrDrop(fields, cov, violations) {
  const phrases = (Array.isArray(violations) ? violations : []).map((v) => norm(v?.claim)).filter(Boolean);
  const dropped = [];
  const f = { ...(fields || {}) };
  const c = cov ? { ...cov } : cov;

  if (!phrases.length) return { fields: f, cov: c, dropped, allFitDropped: false };

  const dropProse = (key) => {
    if (f[key] && hit(f[key], phrases)) { dropped.push(`${key}: "${String(f[key]).slice(0, 60)}"`); f[key] = null; }
  };
  dropProse("why_you");
  dropProse("flag");
  // lede MUST be prunable: render-email.mjs falls back to it for the "Why you" slot and the preheader
  // when why_you is null. Without this, pruning an ungrounded why_you would render an UNVERIFIED line
  // in its place, under the literal label "Why you". It is verified alongside the rest (see
  // artifactText in scheduler.mjs / first-role.mjs), so it is a person-claim and prunes like one.
  dropProse("lede");
  // edge_frame (the rare-find opening) is a claim about the person and is verified alongside the others,
  // so it must be PRUNABLE too. Without this, a flagged frame co-occurring with any other dropped claim
  // slips past the HOLD guard (dropped.length > 0) and ships ungrounded once EDGE_ENGINE + GROUNDING_MODE=drop
  // are both on. Dropping it nulls the frame (render no-ops on empty) and counts toward the guard.
  dropProse("edge_frame");

  if (Array.isArray(f.resume_tips)) {
    f.resume_tips = f.resume_tips.filter((t) => { const bad = hit(t, phrases); if (bad) dropped.push(`resume_tip: "${String(t).slice(0, 60)}"`); return !bad; });
  }
  if (Array.isArray(f.facts)) {
    f.facts = f.facts.filter((x) => { const bad = hit(`${x?.k || ""}: ${x?.v || ""}`, phrases); if (bad) dropped.push(`fact: ${x?.k}`); return !bad; });
  }

  let readoutAlive = false;
  if (c && c.thin !== true) {
    if (c.reason && hit(c.reason, phrases)) { dropped.push(`fit_reason`); c.reason = null; }
    if (c.topMove && hit(c.topMove, phrases)) { dropped.push(`fit_move`); c.topMove = null; }
    if (Array.isArray(c.coverage)) {
      // The verifier saw met rows as "req: evidence" (see scheduler covClaims). Strip the ungrounded
      // evidence but keep the requirement row so the ramp/readout still renders honestly.
      c.coverage = c.coverage.map((r) => {
        if (r && r.status === "met" && r.evidence && hit(`${r.req}: ${r.evidence}`, phrases)) {
          dropped.push(`fit_met: ${r.req}`);
          return { ...r, evidence: "", status: "partly" };
        }
        return r;
      });
      readoutAlive = c.coverage.length > 0;
    }
  }

  // No fit content left to stand on: no live readout, no why_you, no fit reason.
  // `c.reason` only counts as fit PROSE when the readout is live. On a thin cov it is a DIAGNOSTIC
  // ("jd" = the posting was too vague to score, "dossier" = we know too little about the person —
  // fit-coverage.mjs); treating that label as surviving content would let a claim-less email ship.
  const covProse = c && c.thin !== true ? c.reason : null;
  const allFitDropped = !readoutAlive && !f.why_you && !covProse;
  return { fields: f, cov: c, dropped, allFitDropped };
}

/**
 * THE LAST WORD on "does this email actually say why this role fits?" — run on EVERY send path.
 *
 * Why this exists as its own function: the `allFitDropped` fallback above lives inside the cite-or-drop
 * branch, which only runs when the verifier NAMED a violation. A composer that simply returns
 * `why_you: null` with nothing flagged (the schema allows null — lib/schemas/match-output.mjs) skips
 * that branch entirely. Then, if the posting is also too thin to score, render-email falls back to
 * `f.why_you || f.lede` and would print the generic LEDE under the literal heading "Why you".
 *
 * The lede is deliberately NOT accepted as fit content — substituting one generic line for another
 * is the trap, not the fix.
 *
 * When there is nothing grounded to say about the fit, HOLD the send. An email whose entire reason
 * for existing is the fit must not go out without one. A role withheld today is still in the pool
 * tomorrow; an empty email in a real inbox is not recoverable. Both the cite-or-drop paths and the
 * plain path reach this one decision; neither substitutes a line.
 *
 * @param {object} fields        composer output.
 * @param {{readoutShown:boolean}} opts  whether the fit meter will actually render (readoutStatus === "shown").
 * @returns {boolean} true when the email carries real fit content and may be sent.
 */
export function hasFitContent(fields, { readoutShown } = {}) {
  if (readoutShown) return true; // the grounded meter IS the fit content
  return Boolean(String((fields || {}).why_you || "").trim());
}
