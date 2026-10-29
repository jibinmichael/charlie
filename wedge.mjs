// wedge.mjs — the WEDGE DRIP: the productized "you've been seen" moment. Charlie names the rare,
// GROUNDED combination in a person's background as their edge, and reframes their whole search around
// it (pure typography — the combination carries the email).
//
//   node wedge.mjs <email>   send one now (owner test; ignores cadence + age, still fail-closed)
//   node wedge.mjs --dry      list who WOULD get a wedge + their combo, send nothing
//
// runWedgeSweep() runs on the always-on server (setInterval), same class as the market-gap drop.
// DARK by default: nothing sends unless WEDGE_DRIP=on. The sweep is BOTH the backfill (existing
// completed dossiers with a high-confidence edge get it on the next run) AND the new-user path (a
// fresh completion qualifies once it's older than WEDGE_MIN_AGE_HOURS, so it never stacks on the
// welcome + first role).
//
// FAIL-CLOSED: a wedge sends ONLY when the dossier carries a high-confidence, grounded edge
// (edge-verify.mjs stamped `edge.confidence === "high"`). No genuine rare combo -> Charlie sends
// NOTHING; it never manufactures a wedge (fail closed). The combination itself is code-rendered
// verbatim by the template; the model writes only warm connective prose, which must clear the
// honesty/voice lint (fail-closed to a grounded default) before the physical send goes through
// sendGuarded (suppression + one-per-person-ever idempotency).

import { Resend } from "resend";
import { getCandidate, listNewsletterCandidates, setEmailConfig, mergeEmailConfig, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";
import { dripGuard, stampFor } from "./drip-guard.mjs";
import { renderWedge, unsubUrlFor } from "./email-kit.mjs";
import { lintMessage } from "./lib/convo-lint.mjs";
import { WEDGE_SYSTEM } from "./prompts/wedge.mjs";
import { WedgeCopy } from "./lib/schemas/wedge.mjs";
import { captureError } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)
import Anthropic from "@anthropic-ai/sdk";

const log = (...a) => console.error("[wedge]", ...a);
const HOUR = 60 * 60 * 1000;

const flagOn = (v) => String(v || "").toLowerCase() === "on";
const MIN_AGE_HOURS = Number(process.env.WEDGE_MIN_AGE_HOURS || 24); // day-2: give onboarding room
const COMPOSE_MODEL = process.env.WEDGE_MODEL || "claude-sonnet-4-6";

const stripFences = (s) => String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
const textOf = (res) => (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

// The fail-closed gate: a wedge earns the email ONLY when the dossier carries a high-confidence,
// grounded edge (the verifier's stamp). A null / medium / low edge, or an empty combo, means there is
// no genuine rare combination to name — Charlie says nothing. Pure + exported so the gate is testable.
export function wedgeEligible(dossier) {
  const e = dossier?.edge;
  return !!(e && typeof e === "object" && e.confidence === "high" && typeof e.combo === "string" && e.combo.trim().length > 0);
}
const comboOf = (dossier) => String(dossier?.edge?.combo || "").trim();

// ENFORCE the compose prompt's hard bans (prose is not enforcement). The model is told to state NO
// number and imply NO odds; verify it on the RAW fields. The one grounded fact (the combo) is
// code-rendered, so clean prose never needs a digit. Any digit or odds/outcome word -> discard the
// model copy and use the grounded default. Exported for the test — grounding-critical.
const ODDS_RE = /\b(chance|guarantee[ds]?|likely|almost|odds|you'?ll (get|land)|will (get|land)|shoo[- ]?in)\b/i;
export function modelCopyClean(copy) {
  const raw = [copy?.subject, copy?.opening, copy?.edge_line, copy?.advantage_line, copy?.honest_line, copy?.close_line].filter(Boolean).join(" ");
  return !/\d/.test(raw) && !ODDS_RE.test(raw);
}

// The wedge is a broadcast drip, not an interrogation turn, so it does not owe lintMessage's
// interro-shape rules. It MUST still clear the HONESTY blocklist (no scarcity / guilt / manipulation)
// and VOICE rules (no em dash, non-empty). Exported for the test.
export function honestyVoiceOk({ subject = "", text = "" } = {}) {
  const { violations } = lintMessage({ subject, text });
  const blocking = violations.filter((v) => v.kind === "honesty" || v.rule === "em-dash" || v.rule === "empty");
  return { ok: blocking.length === 0, violations: blocking };
}

// Compose the warm connective prose (the combination stays in the template). Returns validated copy
// or null, in which case renderWedge uses its grounded hand-written defaults. Never throws.
async function composeCopy({ combo }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const client = new Anthropic();
    const user = `CONTEXT (do NOT restate this; the system renders it as a quiet line in the email):
- The grounded rare combination in this person's background: ${combo}
- Refer to it ONLY as "that combination", "it", or "your combination". Never name its parts, never restate it.

Return the JSON now.`;
    const res = await client.messages.create({ model: COMPOSE_MODEL, max_tokens: 700, system: WEDGE_SYSTEM, messages: [{ role: "user", content: user }] });
    let parsed;
    try { parsed = JSON.parse(stripFences(textOf(res))); } catch { parsed = null; }
    const v = WedgeCopy.safeParse(parsed || {});
    if (!v.success) { log(`compose failed schema (using default copy): ${v.error?.issues?.[0]?.message || "invalid"}`); return null; }
    if (!modelCopyClean(v.data)) { log("compose emitted a number or an odds/outcome word — using grounded default (fail-closed)"); return null; }
    return v.data;
  } catch (e) { log(`compose threw (using default copy): ${e.message}`); return null; }
}

// Render + lint (fail-closed) + send one wedge. Returns a status string.
async function sendTo(email, { candidate, combo, force = false } = {}) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";

  // model prose is an enhancement; on lint failure retry with the grounded default, and only if THAT
  // still fails to lint do we skip (fail-closed — never ship copy that trips the honesty/voice lint).
  let copy = await composeCopy({ combo });
  let m = renderWedge({ email, combo, copy });
  if (!honestyVoiceOk({ subject: m.subject, text: m.text }).ok) {
    log(`${email}: composed copy failed honesty/voice lint — falling back to grounded default`);
    copy = null;
    m = renderWedge({ email, combo, copy });
    if (!honestyVoiceOk({ subject: m.subject, text: m.text }).ok) { log(`${email}: default copy failed honesty/voice lint — skip (fail-closed)`); return "lint-skip"; }
  }

  const payload = {
    from, to: email, subject: m.subject, html: m.html, text: m.text,
    headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
  // dedupeKey "v1": at most ONE wedge per person, ever.
  const res = await sendGuarded({ resend, email, template: "wedge", dedupeKey: "v1", payload, idempotencyKey: `wedge/${email}`, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: wedge already sent — skip`); return "duplicate"; }
  if (res.status === "failed") return "failed";

  // stamp AFTER a real send: the once-ever ledger + the global anti-stack (stampFor sets both).
  try {
    const nowIso = new Date().toISOString();
    const prior = candidate?.email_config || {};
    await setEmailConfig(email, { ...prior, ...stampFor("wedge", nowIso) });
  } catch (e) {
    log(`${email}: sent but flag-mark failed: ${e.message}`);
    await mergeEmailConfig(email, { ...stampFor("wedge") }).catch(() => {});
  }
  log(`${email}: sent wedge`);
  return "sent";
}

// Decide + (optionally) send for ONE candidate. `force` skips only the age + cadence gates (owner
// test), never the edge gate / suppression / lint / idempotency. Returns a short status.
export async function evaluateCandidate(c, { force = false, dry = false, now = Date.now() } = {}) {
  const email = c.email;
  const dossier = c.dossier || {};

  // edge gate first (fail closed): no high-confidence grounded edge -> say nothing.
  if (!wedgeEligible(dossier)) return "no-edge";
  const combo = comboOf(dossier);

  // once ever
  if (c.email_config?.wedge_sent_at) return "already-sent";

  if (!force) {
    // day-2: don't stack on the welcome + first role.
    const ageMs = c.created_at ? now - new Date(c.created_at).getTime() : Infinity;
    if (ageMs < MIN_AGE_HOURS * HOUR) return "too-new";
    // cheap cadence gate (opt-out / global anti-stack / cooldown / suppression).
    const g = await dripGuard({ email, dripType: "wedge", candidate: c, now });
    if (g.decision === "skip") return `skip:${g.reason}`;
  }

  if (dry) { log(`WOULD SEND ${email} combo="${combo.slice(0, 60)}"`); return "would-send"; }
  return sendTo(email, { candidate: c, combo, force });
}

// Server-called sweep. Best-effort, never throws. DARK unless WEDGE_DRIP=on.
export async function runWedgeSweep() {
  try {
    if (!flagOn(process.env.WEDGE_DRIP)) return; // master flag — dark by default
    if (!process.env.RESEND_API_KEY) return;
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out (matches the other sweeps)
      try {
        await evaluateCandidate(c, { now });
      } catch (e) {
        log(`${c.email} failed (skipped, batch continues): ${e.message}`);
        captureError(e, { service: "wedge", kind: "candidate_failed", email: c.email });
      }
    }
  } catch (e) {
    log(`sweep skipped: ${e.message}`);
    captureError(e, { service: "wedge", kind: "sweep_failed" });
  }
}

async function main() {
  const { loadEnv } = await import("./charlie-store.mjs");
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (arg === "--dry") {
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue;
      try { const r = await evaluateCandidate(c, { dry: true, now }); if (r !== "would-send") console.log(`skip       ${c.email}  (${r})`); }
      catch (e) { console.log(`error      ${c.email}  (${e.message})`); }
    }
    return;
  }
  if (!arg) { console.error("usage: node wedge.mjs <email> | --dry"); process.exit(1); }
  const email = arg.toLowerCase();
  const c = await getCandidate(email);
  if (!c) { console.error(`no candidate ${email}`); process.exit(1); }
  console.log(`wedge ${email}: ${await evaluateCandidate({ email, dossier: c.dossier, email_config: c.email_config, created_at: c.created_at }, { force: true })}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[wedge] fatal:", e.message); process.exit(1); });
