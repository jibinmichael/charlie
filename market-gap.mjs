// market-gap.mjs — the weekly MARKET-GAP DROP: when a person's profile keeps just missing the roles
// they want, break the silence with a grounded, data-backed reason and an actionable close, instead
// of going quiet (the silence blind-spot: "found nothing" and "stopped looking" look identical).
//
//   node market-gap.mjs <email>   send one now (owner test; ignores cadence, still fail-closed)
//   node market-gap.mjs --dry      list who WOULD get a drop + the gap found, send nothing
//
// runMarketGapSweep() runs on the always-on server (setInterval), same class as the completeness
// nudge. DARK by default: nothing sends unless MARKETGAP_DROP=on. Two cohorts:
//   - never-matched  (0 emailed roles)            — always eligible when a recurring gap exists.
//   - stalled        (had roles, then went quiet) — eligible only when MARKETGAP_STALLED=on AND the
//                                                     gap PERSISTS (higher count bar) AND they've
//                                                     been quiet a while, so we never nag someone
//                                                     whose silence is just supply, not a real gap.
//
// The gap is REAL and GROUNDED: the recurring requirement the person's own near-miss roles ask for
// but their profile has not shown (fit-coverage status unknown/partial, aggregated). No invented
// odds, no shaming. Compose is warm prose only; every fact/number/source is code-rendered. The
// composed copy passes lintMessage (fail-closed to a deterministic default) before it can send, and
// the physical send goes through sendGuarded (suppression + idempotency), like every other drip.

import { Resend } from "resend";
import {
  getCandidate, listNewsletterCandidates, getFinds, getFindIds,
  setEmailConfig, mergeEmailConfig, isV2,
} from "./charlie-store.mjs";
import { computeCoverage } from "./fit-coverage.mjs";
import { aggregateGaps } from "./market-research.mjs";
import { researchGap } from "./market-research.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";
import { dripGuard, stampFor } from "./drip-guard.mjs";
import { renderMarketGap, unsubUrlFor } from "./email-kit.mjs";
import { lintMessage } from "./lib/convo-lint.mjs";
import { homeRegion } from "./quality-gate.mjs";
import { MARKET_GAP_SYSTEM } from "./prompts/market-gap.mjs";
import { MarketGapCopy } from "./lib/schemas/market-gap.mjs";
import { captureError } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)
import Anthropic from "@anthropic-ai/sdk";

const log = (...a) => console.error("[market-gap]", ...a);
const DAY = 24 * 60 * 60 * 1000;

const flagOn = (v) => String(v || "").toLowerCase() === "on";
const SCAN = Number(process.env.MARKETGAP_SCAN || 6);                       // near-misses to score
const MIN_COUNT = Number(process.env.MARKETGAP_MIN_COUNT || 2);            // recurrence bar (never-matched)
const STALLED_MIN_COUNT = Number(process.env.MARKETGAP_STALLED_MIN_COUNT || 3); // higher bar for stalled
const STALLED_QUIET_DAYS = Number(process.env.MARKETGAP_STALLED_QUIET_DAYS || 14);
const MAX_SENDS = Number(process.env.MARKETGAP_MAX || 6);                  // taper cap per person
const COMPOSE_MODEL = process.env.MARKETGAP_MODEL || "claude-sonnet-4-6";

const stripFences = (s) => String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
const textOf = (res) => (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

// The grounded aggregation for ONE candidate: score up to SCAN near-miss roles against their current
// profile, then rank the recurring unknown/partial requirements. Pure-ish (one model call per role).
// Returns { gaps, total }. total = scoreable near-misses considered (the "of N" denominator).
export async function gapsForCandidate(email, dossier) {
  const finds = await getFinds(email, { status: "digest", limit: SCAN }).catch(() => []);
  const coverages = [];
  for (const f of finds) {
    const job = f?.job || {};
    if (!job.description) continue;
    try {
      const cov = await computeCoverage({ dossier, jobDescription: job.description, jobTitle: job.title || "" });
      coverages.push(cov);
    } catch (e) { log(`${email}: coverage skip for a near-miss: ${e.message}`); }
  }
  return { gaps: aggregateGaps(coverages, { minCount: 1 }), total: coverages.filter((c) => c && !c.thin).length };
}

// Determine cohort + the recurrence bar. Deterministic; the caller has already read the finds.
//   returns { cohort:"never"|"stalled"|null, minCount }
export function cohortFor({ emailedCount, lastEmailedAt, now = Date.now() }) {
  if (emailedCount === 0) return { cohort: "never", minCount: MIN_COUNT };
  if (!flagOn(process.env.MARKETGAP_STALLED)) return { cohort: null, minCount: 0 };
  const quietMs = lastEmailedAt ? now - new Date(lastEmailedAt).getTime() : Infinity;
  if (quietMs < STALLED_QUIET_DAYS * DAY) return { cohort: null, minCount: 0 }; // still recently served
  return { cohort: "stalled", minCount: STALLED_MIN_COUNT };
}

// ENFORCE the compose prompt's hard bans (prose is not enforcement). The model
// is told to state NO number and imply NO odds/outcome; verify it on the RAW fields. The real figures
// are code-rendered separately and {{GAP}} carries no digit, so clean prose never needs a number. Any
// digit or odds/outcome word → the model copy is discarded and the grounded default is used. Exported
// for the test — this is a grounding-critical gate.
const ODDS_RE = /\b(chance|guarantee[ds]?|likely|almost|odds|you'?ll (get|land)|will (get|land)|shoo[- ]?in)\b/i;
export function modelCopyClean(copy) {
  const raw = [copy?.subject, copy?.opening, copy?.gap_framing, copy?.close_line, copy?.honest_line].filter(Boolean).join(" ");
  return !/\d/.test(raw) && !ODDS_RE.test(raw);
}

// Compose the warm connective prose (facts stay in the template). Returns validated copy or null,
// in which case the template uses its grounded hand-written defaults. Never throws.
async function composeCopy({ gap, kind, cohort }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const client = new Anthropic();
    const cohortLine = cohort === "stalled"
      ? "This person has received a few good roles from you before, but has gone quiet lately."
      : "You have not sent this person a single role yet.";
    const closeLine = kind === "pref"
      ? "pref: invite them to reply and adjust what they're after (for example pay or location)."
      : "share: invite them to reply with something that shows this (a doc, a case study, a story).";
    const user = `CONTEXT (do NOT restate any figure; the system renders the real numbers around your words):
- The recurring requirement the roles ask for that this person has not shown: ${gap}
- Emit this exactly as the literal placeholder {{GAP}} wherever you name it (never rephrase it).
- ${cohortLine}
- Close to use -> ${closeLine}

Return the JSON now.`;
    const res = await client.messages.create({ model: COMPOSE_MODEL, max_tokens: 700, system: MARKET_GAP_SYSTEM, messages: [{ role: "user", content: user }] });
    let parsed;
    try { parsed = JSON.parse(stripFences(textOf(res))); } catch { parsed = null; }
    const v = MarketGapCopy.safeParse(parsed || {});
    if (!v.success) { log(`compose failed schema (using default copy): ${v.error?.issues?.[0]?.message || "invalid"}`); return null; }
    if (!modelCopyClean(v.data)) {
      log("compose emitted a number or an odds/outcome word — using grounded default (fail-closed)");
      return null;
    }
    return v.data;
  } catch (e) { log(`compose threw (using default copy): ${e.message}`); return null; }
}

// The drop is a broadcast drip, NOT an interrogation turn, so it does not owe lintMessage's
// interro-shape rules (exactly one question, a costless exit, reflect a prior fact). It MUST still
// clear the same HONESTY blocklist (no scarcity / guilt / streaks / manipulation) and VOICE rules
// (no em dash, non-empty). Reuse lintMessage and keep only those violations. Exported for the test.
export function honestyVoiceOk({ subject = "", text = "" } = {}) {
  const { violations } = lintMessage({ subject, text });
  const blocking = violations.filter((v) => v.kind === "honesty" || v.rule === "em-dash" || v.rule === "empty");
  return { ok: blocking.length === 0, violations: blocking };
}

// Render + lint (fail-closed) + send one drop. Returns a status string.
async function sendTo(email, { candidate, cohort, gap, count, total, kind, research, force = false } = {}) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const stalled = cohort === "stalled";

  // model prose is an enhancement; on lint failure we retry with the grounded default copy, and only
  // if THAT still fails to lint do we skip (fail-closed — never ship copy that trips the voice lint).
  let copy = await composeCopy({ gap, kind, cohort });
  let m = renderMarketGap({ email, gap, count, total, kind, stalled, research, copy });
  if (!honestyVoiceOk({ subject: m.subject, text: m.text }).ok) {
    log(`${email}: composed copy failed honesty/voice lint — falling back to grounded default`);
    copy = null;
    m = renderMarketGap({ email, gap, count, total, kind, stalled, research, copy });
    if (!honestyVoiceOk({ subject: m.subject, text: m.text }).ok) { log(`${email}: default copy failed honesty/voice lint — skip (fail-closed)`); return "lint-skip"; }
  }

  const payload = {
    from, to: email, subject: m.subject, html: m.html, text: m.text,
    headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
  // dedupeKey = the gap key: a given gap is dropped AT MOST ONCE, ever. A new gap can still send.
  const dedupeKey = `gap:${gap.key}`;
  const res = await sendGuarded({ resend, email, template: "marketgap", dedupeKey, payload, idempotencyKey: `marketgap/${email}/${gap.key}`, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: gap "${gap.gap}" already dropped — skip`); return "duplicate"; }
  if (res.status === "failed") return "failed";

  // stamp AFTER a real send: the drip ledger (cooldown + global anti-stack) + our own count/last_at.
  try {
    const nowIso = new Date().toISOString();
    const prior = candidate?.email_config || {};
    await setEmailConfig(email, { ...prior, marketgap_count: (prior.marketgap_count || 0) + 1, marketgap_last_at: nowIso, ...stampFor("marketgap", nowIso) });
  } catch (e) {
    log(`${email}: sent but flag-mark failed: ${e.message}`);
    await mergeEmailConfig(email, { marketgap_count: (candidate?.email_config?.marketgap_count || 0) + 1, ...stampFor("marketgap") }).catch(() => {});
  }
  log(`${email}: dropped gap "${gap.gap}" (${count}/${total} near-misses · ${cohort} · ${kind})`);
  return "sent";
}

// Decide + (optionally) send for ONE candidate. `force` skips only the cadence gate (owner test),
// never suppression/lint/idempotency. Returns a short status for the CLI/dry-run.
export async function evaluateCandidate(c, { force = false, dry = false, now = Date.now() } = {}) {
  const email = c.email;
  const dossier = c.dossier || {};

  // cohort (cheap): read emailed finds. never-matched = 0; stalled = had some, then quiet.
  const emailedIds = await getFindIds(email).catch(() => new Set());
  let lastEmailedAt = null;
  if (emailedIds.size > 0) {
    const [last] = await getFinds(email, { status: "emailed", limit: 1 }).catch(() => []);
    lastEmailedAt = last?.created_at || null;
  }
  const { cohort, minCount } = cohortFor({ emailedCount: emailedIds.size, lastEmailedAt, now });
  if (!cohort) return "not-eligible-cohort";

  // taper cap
  if ((c.email_config?.marketgap_count || 0) >= MAX_SENDS) return "capped";

  // CHEAP cadence gate BEFORE the expensive aggregation: opt-out / global-gap / cooldown / suppression.
  if (!force) {
    const g = await dripGuard({ email, dripType: "marketgap", candidate: c, now });
    if (g.decision === "skip") return `skip:${g.reason}`;
  }

  // EXPENSIVE: score near-misses + rank the recurring gap.
  const { gaps, total } = await gapsForCandidate(email, dossier);
  const top = gaps.find((x) => x.count >= minCount) || null;
  if (!top) return "no-recurring-gap"; // supply gap, not a profile gap — leave them alone

  if (dry) { log(`WOULD DROP ${email} [${cohort}] gap="${top.gap}" ${top.count}/${total} kind=${top.kind}`); return "would-send"; }

  const region = homeRegion(dossier);
  const role = dossier?.preferences?.role || "";
  const research = await researchGap({ gap: top.gap, role, region, log }).catch(() => ({ lines: [], pay: null }));
  return sendTo(email, { candidate: c, cohort, gap: top, count: top.count, total, kind: top.kind, research, force });
}

// Server-called sweep. Best-effort, never throws. DARK unless MARKETGAP_DROP=on.
export async function runMarketGapSweep() {
  try {
    if (!flagOn(process.env.MARKETGAP_DROP)) return;      // master flag — dark by default
    if (!process.env.RESEND_API_KEY) return;
    const cands = await listNewsletterCandidates();
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out (matches the other sweeps)
      try {
        await evaluateCandidate(c, { now });
      } catch (e) {
        log(`${c.email} failed (skipped, batch continues): ${e.message}`);
        captureError(e, { service: "market-gap", kind: "candidate_failed", email: c.email });
      }
    }
  } catch (e) {
    log(`sweep skipped: ${e.message}`);
    captureError(e, { service: "market-gap", kind: "sweep_failed" });
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
  if (!arg) { console.error("usage: node market-gap.mjs <email> | --dry"); process.exit(1); }
  const email = arg.toLowerCase();
  const c = await getCandidate(email);
  if (!c) { console.error(`no candidate ${email}`); process.exit(1); }
  console.log(`market-gap ${email}: ${await evaluateCandidate({ email, dossier: c.dossier, email_config: c.email_config }, { force: true })}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[market-gap] fatal:", e.message); process.exit(1); });
