// game-plan.mjs — the "game plan" onboarding beat + the modify reply loop.
//
// After the welcome (#1) and the "State of Your Market" briefing (#2), Charlie sends the PLAN (#3): here's
// how I'll work for you, and exactly where I'm looking. Then it hands the person the wheel — reply with
// changes and Charlie adjusts, any time. The first ROLE lands on day-2 regardless (onboarding must
// never end in silence).
//
// It does NOT ask for an approval: the day-2 role is already scheduled, so an approval ask would imply
// a contingency that does not exist.
//
// Two entry points, mirroring market-briefing.mjs:
//   sendPlan(email)          immediate best-effort send after the briefing (the #3 slot)
//   runGamePlanSweep()       server setInterval — backfill (a completed profile that missed it) + catch-up
// And the reply side:
//   applyPlanReply(email, body)   bare "ok" -> acknowledge silently; a stated change -> SAFE pref writeback
//
//   node game-plan.mjs <email>   send one now (owner test/preview; skips cadence, still fail-closed)
//   node game-plan.mjs --dry     list who WOULD get a plan, send nothing
//
// DARK BY DEFAULT: the automatic sends (immediate + sweep) fire only when GAME_PLAN=on. The CLI preview
// works regardless, so an operator can check a real render before flipping it on. The reply loop is naturally
// dormant until a plan has been sent (it self-gates on plan_sent_at), so no separate flag is needed there.
//
// GROUNDING / FAIL-CLOSED: every line traces to the person's OWN stored profile — no model
// call anywhere in the send path. The positioning is a verbatim strength; "where I'm looking" is the
// search parameters they stated. An incomplete profile (missing role/level/pay/location/name) or a home
// outside India + US fails the eligibility gate and Charlie says NOTHING (never a hollow or guessed plan).
// The physical send goes through lib/send-guard.mjs (suppression + one-per-person-ever idempotency), the
// payload is Zod-validated at the boundary, and dripGuard keeps it from stacking on other drips.
//
// The MODIFY loop rides ONLY on applyPrefsOnly (email-onboard.mjs) — the honest, deterministic search-
// parameter writeback. It NEVER touches applyEmailChange's correction path, so Charlie can never tell a
// person "I updated that" while only appending a note-to-self. A reply that is neither an
// approval nor a stated parameter change returns "not-applicable" so the caller falls through to the
// existing reply path unchanged (a new fact/correction is handled there, not here).

import { Resend } from "resend";
import { loadEnv, getCandidate, listNewsletterCandidates, mergeEmailConfig, setEmailConfig, isV2 } from "./charlie-store.mjs";
import { renderGamePlan } from "./render-plan.mjs";
import { unsubUrlFor } from "./email-kit.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";
import { dripGuard, stampFor, missingFields } from "./drip-guard.mjs";
import { homeRegion } from "./quality-gate.mjs";
import { topStrength, applyPrefsOnly } from "./email-onboard.mjs";
import { stripQuotedReply } from "./campaign-gate.mjs";
import { ResendSendPayload } from "./lib/schemas/resend-send.mjs";
import { captureError } from "./lib/sentry-node.mjs";

const log = (...a) => console.error("[game-plan]", ...a);

export const gamePlanOn = () => String(process.env.GAME_PLAN || "").toLowerCase() === "on";

// ── grounded derivation (pure, no model, reads only the dossier) ──────────────────────────────────
function firstName(full) {
  return String(full || "").trim().split(/\s+/)[0] || "";
}

// Indian comp the way people say it: 80L, 1 Cr. Local copy (render-market-report's is private).
function inr(n) {
  if (n >= 10000000) return `${(n / 10000000).toFixed(n % 10000000 ? 2 : 0).replace(/\.00$/, "")} Cr`;
  return `${Math.round(n / 100000)}L`;
}
// Format the pay floor with the person's OWN stated currency. Grounding: never assert a currency they did
// not give (an unknown currency drops the floor rather than guess ₹/$), and never render a wrong-magnitude
// number (a sub-lakh rupee floor or a sub-$1k USD floor is almost always a mis-parse) — drop it instead.
function formatFloor(n, ccy) {
  const f = Number(n);
  if (!Number.isFinite(f)) return "";
  if (ccy === "USD") return f >= 1000 ? `$${Math.round(f / 1000)}K` : "";
  if (ccy === "INR") return f >= 100000 ? `₹${inr(f)}` : "";
  return ""; // unknown currency: do not assert a symbol, do not render an ambiguous bare number
}

// The "where I'm looking" parameters, grounded and pre-formatted. Only fields the person actually stated
// are returned — an absent parameter is never guessed or padded. Pure + exported for the test.
export function planParams(dossier) {
  const p = (dossier && dossier.preferences) || {};
  const out = {};
  if (p.role) out.roles = String(p.role).trim();
  if (p.seniority) out.level = String(p.seniority).trim();
  const loc = p.remote || p.location;
  if (loc) out.location = String(loc).trim();
  const pay = formatFloor(p.comp_floor, p.comp_currency);
  if (pay) out.pay = pay;
  const avoid = (Array.isArray(p.dealbreakers) ? p.dealbreakers : []).map((s) => String(s).trim()).filter(Boolean);
  if (avoid.length) out.avoid = avoid.join(", ");
  return out;
}

// One grounded positioning sentence: a verbatim proven strength (topStrength prefers a VERIFIED proof), or
// the extracted headline, or "" if we genuinely have nothing to point to. Never a manufactured claim.
export function planPositioning(dossier) {
  const s = topStrength(dossier); // verbatim, verified-first, "" if nothing
  const raw = s || (typeof dossier?.headline === "string" ? dossier.headline.trim() : "");
  if (!raw) return "";
  return /[.!?]$/.test(raw) ? raw : `${raw}.`;
}

// THE fail-closed eligibility gate. A plan earns the email ONLY when we know enough to STATE one: every
// search parameter is present (role, level, pay, location, name — missingFields === []) AND the person's
// grounded home is inside Charlie's two markets. An unknown region defaults to India (never "other"), so
// no India/US user is misflagged; only a positive foreign signal fails the gate. Pure + exported.
export function planEligible(dossier) {
  if (!dossier || typeof dossier !== "object") return false;
  if (missingFields(dossier).length) return false;   // can't state "where I'm looking" with a hole in it
  if (homeRegion(dossier) === "other") return false;  // out-of-market: the honest note handles them, not a plan
  return true;
}

// Did the person, in their OWN words, send a bare affirmation? The plan does not ASK for one, but
// this guard is load-bearing: it is what stops a one-word "ok" / "yes"
// from reaching applyPrefsOnly, where a stray token could be misread as a stated preference. A match
// means "acknowledge silently and carry on" — no email, no writeback.
// Conservative + quote-safe: read only the FIRST non-empty line of the DE-QUOTED reply (so a quoted
// line in the plan email itself can never trigger it), and require a short, standalone affirmation.
// Anything longer is treated as a change, not a yes.
const APPROVE_RE = /^(y|yes|yep|yeah|yup|approve|approved|ok|okay|sure|sounds good|looks good|looks right|go|go ahead|let'?s go|let'?s do it|do it|proceed|perfect|great|confirmed|agreed)$/i;
export function planSaysApprove(body) {
  const top = stripQuotedReply(String(body || "")) || String(body || "");
  const first = top.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  if (!first || first.length > 40) return false; // a real change reply, not a bare approval
  const norm = first.replace(/[\s.!,👍✅]+$/u, "").trim(); // drop trailing punctuation / a thumbs-up
  return APPROVE_RE.test(norm);
}

// ── send ──────────────────────────────────────────────────────────────────────────────────────────
async function sendTo(email, { candidate, dossier, force = false } = {}) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const name = firstName(dossier?.name);
  const { subject, html, text } = renderGamePlan({ name, positioning: planPositioning(dossier), params: planParams(dossier), email });
  const payload = {
    from, to: email, subject, html, text,
    headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
  // Boundary validation: refuse a structurally broken payload before Resend. Fail-closed.
  const check = ResendSendPayload.safeParse(payload);
  if (!check.success) { log(`${email}: plan payload malformed — skip (${check.error.issues.map((i) => i.path.join(".")).slice(0, 3).join(", ")})`); return "malformed"; }

  // dedupeKey "v1": at most ONE plan per person, ever (belt to the plan_sent_at flag).
  const res = await sendGuarded({ resend, email, template: "game-plan", dedupeKey: "v1", payload, idempotencyKey: `plan/${email}`, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: plan already sent — skip`); return "duplicate"; }
  if (res.status === "failed") return "failed";

  try {
    const nowIso = new Date().toISOString();
    const prior = candidate?.email_config || {};
    await setEmailConfig(email, { ...prior, ...stampFor("plan", nowIso) });
  } catch (e) {
    log(`${email}: sent but flag-mark failed: ${e.message}`);
    await mergeEmailConfig(email, { ...stampFor("plan") }).catch(() => {});
  }
  log(`${email}: sent plan`);
  return "sent";
}

// Immediate best-effort send after the briefing (the #3 onboarding slot). Fail-closed and quiet: dark
// flag off, already-sent, ineligible profile, out-of-market, or any error -> send nothing, never throw.
// Suppression + idempotency are enforced inside sendTo (sendGuarded). Returns a short status.
export async function sendPlan(email, { log: logFn = log, force = false } = {}) {
  const addr = String(email || "").trim().toLowerCase();
  try {
    if (!force && !gamePlanOn()) return "dark";
    const c = await getCandidate(addr);
    if (!c) return "no-candidate";
    if (c.email_config?.plan_sent_at) return "already-sent";
    if (!planEligible(c.dossier)) return "not-eligible";
    return await sendTo(addr, { candidate: c, dossier: c.dossier, force });
  } catch (e) {
    logFn(`${addr}: send failed (${e.message})`);
    captureError(e, { service: "game-plan", kind: "immediate_failed", email: addr });
    return "error";
  }
}

// Decide + (optionally) send for ONE candidate in the sweep. `force` skips only the cadence gate (owner
// test), never the dark flag / eligibility / once-ever / suppression / idempotency. Returns a status.
export async function evaluateCandidate(c, { force = false, dry = false, now = Date.now() } = {}) {
  const email = String(c?.email || "").trim().toLowerCase();
  if (!force && !gamePlanOn()) return "dark";
  if (c.email_config?.plan_sent_at) return "already-sent"; // once ever (cheap, before anything else)
  if (!planEligible(c.dossier)) return "not-eligible";

  if (!force) {
    const g = await dripGuard({ email, dripType: "plan", candidate: c, now });
    if (g.decision === "skip") return `skip:${g.reason}`;
  }
  if (dry) { const pr = planParams(c.dossier); log(`WOULD SEND ${email}  (${Object.keys(pr).join(", ") || "no params"})`); return "would-send"; }
  return sendTo(email, { candidate: c, dossier: c.dossier, force });
}

// Server-called sweep. Best-effort, never throws. Backfill (a completed profile that never got the plan)
// + catch-up (a new user whose immediate send failed). Dark until GAME_PLAN=on (the per-candidate gate).
export async function runGamePlanSweep() {
  try {
    if (!process.env.RESEND_API_KEY) return;
    if (!gamePlanOn()) return; // dark: no work until the flag is flipped on
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out (matches the other sweeps)
      try {
        await evaluateCandidate(c, { now });
      } catch (e) {
        log(`${c.email} failed (skipped, batch continues): ${e.message}`);
        captureError(e, { service: "game-plan", kind: "candidate_failed", email: c.email });
      }
    }
  } catch (e) {
    log(`sweep skipped: ${e.message}`);
    captureError(e, { service: "game-plan", kind: "sweep_failed" });
  }
}

// ── the modify reply loop ───────────────────────────────────────────────────────────────────────────
// Self-gating: returns { kind: "not-applicable" } unless this person actually received a plan (plan_sent_at
// set), so the caller can safely try it on every existing-user reply and fall through when it doesn't fire.
//   acknowledged -> a bare "ok"/"yes". Charlie says NOTHING and just carries on (the day-2 role is
//                   already scheduled). The caller returns without sending. No writeback: the whole
//                   point of this branch is to keep a stray affirmation out of applyPrefsOnly.
//   modified  -> SAFE search-param writeback only (applyPrefsOnly), returns { changed, params, name }
//   not-applicable -> not a plan recipient, OR a reply that is neither an affirmation nor a stated change
export async function applyPlanReply(email, bodyText) {
  const addr = String(email || "").trim().toLowerCase();
  const c = await getCandidate(addr).catch(() => null);
  if (!c?.email_config?.plan_sent_at) return { kind: "not-applicable" };

  // Silent acknowledgement: no stamp and no "Great, I'm on it" confirmation, which would carry no
  // information the person has not just read.
  if (planSaysApprove(bodyText)) return { kind: "acknowledged" };

  const r = await applyPrefsOnly(addr, bodyText).catch(() => null);
  if (r && Array.isArray(r.changed) && r.changed.length) {
    return { kind: "modified", changed: r.changed, name: firstName(r.dossier?.name), params: planParams(r.dossier), dossier: r.dossier };
  }
  return { kind: "not-applicable" }; // neither an affirmation nor a param change -> let the generic path handle it
}

// Renders reused by the server so the reply copy lives with the template, not inline.
export { renderGamePlan };

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (arg === "--dry") {
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue;
      try { const r = await evaluateCandidate(c, { dry: true, force: true, now }); if (r !== "would-send") console.log(`skip       ${c.email}  (${r})`); }
      catch (e) { console.log(`error      ${c.email}  (${e.message})`); }
    }
    return;
  }
  if (!arg) { console.error("usage: node game-plan.mjs <email> | --dry"); process.exit(1); }
  const email = arg.toLowerCase();
  const c = await getCandidate(email);
  if (!c) { console.error(`no candidate ${email}`); process.exit(1); }
  console.log(`game-plan ${email}: ${await evaluateCandidate(c, { force: true })}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[game-plan] fatal:", e.message); process.exit(1); });
