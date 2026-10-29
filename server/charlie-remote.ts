// @ts-nocheck — run via tsx (esbuild, no type-check); bridges to untyped ESM JS.
// server/charlie-remote.ts — Charlie's HOSTED email server.
//
// A long-lived Node/Express server. Email is the product and the only surface: this
// server receives the person's mail (/inbound, Svix-verified), runs email-native
// onboarding, and serves the links Charlie's emails point at (/unsubscribe, /e/<token>,
// /warm-intro). Delivery webhooks land on /webhooks/resend. The Supabase service-role
// key stays server-side only.
//
//   PORT=8787 PUBLIC_BASE_URL=https://charlie.example.com tsx server/charlie-remote.ts

import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
// @ts-ignore — plain ESM JS
import { loadEnv, emailForToken, suppressAddress, setCandidateStatus, isSuppressed, logEmailEvent, findIdForResend, findRefFromChase, loadJobPoolStats, loadJobPoolFeed, getPoolJob, getDossier, getResume, uploadResume, readEvent, recordSignal, recordInbound, getFinds, getFindIds, advanceApplication, dueTasks, completeTask, getApplications, scheduleTask, getThreadRoot, setThreadRoot, mergeEmailConfig, enterState, recordFirstContact, suppressionReason, recordSeeking, recentAsks, recentTurns, roleSendsFor, roleFindIdFromSend, getFindById } from "../charlie-store.mjs";
import { runJourneyWatchdog } from "../journey-watchdog.mjs"; // fire a due journey watchdog
import { sendGuarded } from "../lib/send-guard.mjs";           // the ONE physical send door
import { mayReplyDespiteSuppression } from "../lib/suppression-policy.mjs"; // an unsubscribe must not silence a reply
import { inboundSigOk, inboundSecretsMissing } from "../lib/inbound-auth.mjs"; // a missing signing secret must reject, never accept
import { buildId } from "../lib/build-id.mjs";                   // content hash of the running code, for /healthz
import { flagFingerprint } from "../lib/env-parity.mjs";        // hash of the config both services share, for /healthz
import { noteInboundFrom } from "../lib/inbound-rate.mjs"; // abuse brake: a flood is a bill, not just noise
import { isSecurityReport } from "../lib/security-report.mjs"; // route a vuln report to a human, never the onboarding nudge
// @ts-ignore — plain ESM JS
import { newMessageId, threadHeaders } from "../threading.mjs";
import { Resend } from "resend";
// @ts-ignore — plain ESM JS
import { extractResumeText, ALLOWED_EXT } from "./resume-extract.mjs";
// @ts-ignore — plain ESM JS
import { safeFetch } from "../safe-fetch.mjs";
// @ts-ignore — plain ESM JS
import { onboardFromEmail, applyEmailChange, nextGap, topStrength, isThinDossier, startInterrogation, continueInterrogation, substantiveBio, tooThinToBuild } from "../email-onboard.mjs";
import { getFindById, getCandidate, onboardingV2Enabled, getJoinApplicant, upsertJoinApplicant, appendJoinTranscript, recordReferralEvent, friendVariant } from "../charlie-store.mjs";
import Anthropic from "@anthropic-ai/sdk";
import { handleJoinReply, handleOwnerVerdict } from "../campaign-loop.mjs";
import { stripQuotedReply, stripQuotedLines } from "../campaign-gate.mjs";
import { recordOwnWords, isEvidenceReply, isClientStatusReply, isCheckinReply, MIN_CHARS } from "../lib/evidence-record.mjs"; // a reply about their own work lands on their own record
import { looksLikeQuestion, knownAnswer } from "../lib/inbound-question.mjs"; // a question never reaches the preference writer
import { roleInPlay } from "../lib/role-in-play.mjs";           // which role is "that"?
import { askedBefore } from "../lib/role-answer.mjs";              // and did they already ask this?
import { composeReply, transcriptFrom, isContinuation } from "../lib/compose-reply.mjs"; // one bounded turn
import { openAskFor } from "../lib/open-ask.mjs"; // nor does an answer to a question we asked
import { classifyInviteReply } from "../lib/role-invite-reply.mjs"; // yes, no, or a human reads it
import { readSeekingReply, seekingUntil } from "../lib/seeking-reply.mjs"; // still looking? got an offer?
import { classifyInbound, mayWritePreferences } from "../lib/inbound-intent.mjs"; // and nothing writes at all unless it is clearly an instruction
import { replyFor, QUOTING_INTENTS } from "../lib/reply-intent.mjs"; // one reply per situation, not one for all of them
import { lintReply } from "../lib/reply-lint.mjs";                   // the reply rule set (NOT convo-lint's — see its header)
import { renderCampaignIncomplete, renderCampaignRedirect, renderCampaignKickoff, renderCampaignMessage, renderCampaignReject, renderCampaignPass, renderCampaignCalendly, renderCampaignNearMiss, renderCampaignOwnerReview } from "../render-campaign.mjs";
import { buildRejectBoardFor } from "../campaign-board.mjs";
import { currentState, journeyOf } from "../journey.mjs"; // read the v2 journey state to route replies
import { lintMessage } from "../lib/convo-lint.mjs";        // honesty copy-lint (pre-send gate for v2 sends)
import { ResendWebhookEvent } from "../lib/schemas/resend-webhook.mjs"; // boundary validation for the delivery webhook
import { ResendSendPayload } from "../lib/schemas/resend-send.mjs"; // boundary validation for a direct send payload
import * as Sentry from "@sentry/node";
import { initSentry, captureError } from "../lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)
import { dripGuard, stampFor } from "../drip-guard.mjs";
// @ts-ignore — plain ESM JS
import { homeRegion } from "../quality-gate.mjs";
import { PRO_SUBJECT } from "../render-email.mjs"; // one definition of the Pro CTA subject
import { renderPositioning, POSITION_SUBJECT } from "../email-kit.mjs"; // the "show me how to position" answer
import { replyForUngrounded } from "../lib/ungrounded-reply.mjs"; // who gets asked again, and who gets declined
import { runCampaignStallSweep } from "../campaign-stall.mjs"; // the hiring loop's one nudge for a quiet applicant
import { renderWelcome, renderMissingResume, renderNotJobSearch, renderProInterest, renderTellMeMore, renderSecondChance, renderBuildDelayed, renderPrefsUpdated, renderConvoReply, renderAck, renderInterroTurn, renderCheckScorecard, renderCheckNeedJob, renderCheckNeedResume, renderTrackAck, renderTrackStarted, renderReferralFound, renderReferralNone, renderOutOfMarket, renderPaused, renderResumed, renderRepresent, renderRepresentAsk, renderQuestionAck, renderAskAnswerAck, renderInviteAnswer, renderIntentAnswer, renderQuestionsAnswer, renderHoldAnswer, renderSeekingNoted, renderRoleAnswer, renderClientReplyAck, renderCheckinNoted, esc, REPRESENT_SUBJECT, warmIntroPage, giftLandingPage, fitCheckPage, unsubUrlFor, unsubscribePage, unsubscribeConfirmPage, feedbackPage } from "../email-kit.mjs";
// @ts-ignore — plain ESM JS
import { buildEmailAttachments } from "../tailored-docs.mjs";
// @ts-ignore — plain ESM JS
import { findReferralContact } from "../referral-find.mjs";
// @ts-ignore — plain ESM JS
import { draftIntro } from "../referral-draft.mjs";
import { sendMarketBriefing } from "../market-briefing.mjs";
import { sendPlan, runGamePlanSweep, applyPlanReply, renderGamePlan, gamePlanOn } from "../game-plan.mjs"; // the game plan + modify loop
import { runCompletenessNudgeSweep } from "../completeness-nudge.mjs";
import { runWedgeSweep } from "../wedge.mjs";
import { runConfirmationSweep } from "../confirm-sweep.mjs";
import { runDepthSnapshotSweep } from "../profile-depth.mjs"; // the depth-per-user time series
import { runDepthQuestionSweep } from "../depth-question.mjs"; // the market read + one question
import { parsePauseCommand } from "../lib/pause-command.mjs"; // the "pause" reply command
import { representMissing, runRepresentSweep } from "../represent.mjs"; // the represent list: the ask IS the thing it collects
import { fetchJobText, runCvCheck } from "../cv-check.mjs";
import { classifyForwardedReply } from "../track.mjs";
import { voiceRouter, voiceEnabled } from "./voice.ts"; // voice verification: dark behind VOICE_VERIFICATION, every route 404 while off
// @ts-ignore — plain ESM JS
import { looksLikeCv } from "../lib/qualify/cv-file.mjs";
import { activation as pieworksActivation, replyKeyFrom as pieworksReplyKey } from "../lib/pieworks-activation.mjs"; // Pieworks 2call activation: dark unless PIEWORKS_ACTIVATION is shadow or live
import { verifyWebhookSignature as pieworksSignatureOk } from "../lib/connections/pieworks.mjs";
import { PieworksWebhookBatch } from "../lib/schemas/pieworks.mjs";
import { pingHeartbeat } from "../lib/heartbeat.mjs";
import { outreachRouter, runPursuitSync } from "./outreach.ts"; // the outreach inbox API (read only) and the pursuit sync: dark behind HIRING_WORKSPACE
import { agentsRouter, runAgentsSweep, qualifyInboundReply } from "./agents.ts"; // the agents API and schedule: dark behind HIRING_WORKSPACE
// @ts-ignore — plain ESM JS
import * as voiceStore from "../voice/store.mjs";
// @ts-ignore — plain ESM JS
import { runPipelineSweep } from "../voice/pipeline.mjs"; // the post-call pipeline sweep, flag-gated
import { securityHeaders, cors, hireOriginsOf } from "../lib/http-guards.mjs"; // security headers + CORS

loadEnv();
initSentry({ name: "charlie-server" }); // error reporting + global unhandled handlers (no-op without SENTRY_DSN)

const PORT = Number(process.env.PORT || 8787);
const VERSION = "0.9.362"; // bump on each deploy; surfaced in /healthz (with `build`, the content hash, and the shared-config `flags` hash)

// The operator's own address (OWNER_EMAIL). It receives ops alerts when ALERT_EMAIL is unset and is
// the only identity allowed on owner-gated debug routes. Unset means nobody is the owner.
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "").trim().toLowerCase();
const isOwnerEmail = (addr: string) => !!OWNER_EMAIL && String(addr || "").trim().toLowerCase() === OWNER_EMAIL;
const ALERT_TO = () => process.env.ALERT_EMAIL || OWNER_EMAIL;

// Charlie's own mail domain, read from CHARLIE_FROM (e.g. charlie@mail.example.com -> example.com).
// Inbound mail from this domain or any subdomain of it is our own and is never processed.
const OWN_ROOT_DOMAIN = (String(process.env.CHARLIE_FROM || "").match(/@([^>\s]+)/)?.[1] || "").toLowerCase().split(".").slice(-2).join(".");
const isOwnDomain = (addr: string) => {
  const dom = String(addr || "").split("@")[1]?.toLowerCase() || "";
  return !!OWN_ROOT_DOMAIN && (dom === OWN_ROOT_DOMAIN || dom.endsWith("." + OWN_ROOT_DOMAIN));
};

// The onboarding hand-off: at dossier completion, fire the "State of Your Market" briefing NOW
// (best-effort + fail-closed inside sendMarketBriefing). Roles come from the weekly run (see below).
async function briefingThenScheduleRole(email: string) {
  const c: any = await getCandidate(email).catch(() => null);
  // Out-of-market: Charlie serves India + US only. If this person's GROUNDED home is outside
  // both (homeRegion === "other" — a positive foreign signal; an unknown still defaults to india, so no
  // India/US user is ever misflagged), do NOT start the briefing -> first-role flywheel. Send the one
  // honest "I only cover India and the US" note instead (sendGuarded dedupes it to once ever, and it is
  // the SAME template + key the daily scheduler uses, so the two paths never double-send). Onboarding
  // ends in an honest answer, never a foreign role and never silence; a reply correcting the location
  // flips homeRegion back so the normal flow resumes on a later turn.
  if (c?.dossier && homeRegion(c.dossier) === "other") {
    try {
      const to = c.email_config?.notify || email;
      const place = typeof c.dossier?.preferences?.home_place === "string" ? c.dossier.preferences.home_place : "";
      const msg = renderOutOfMarket({ email, name: c.dossier?.name || "", place });
      const resend = new Resend(process.env.RESEND_API_KEY);
      const from_ = process.env.CHARLIE_FROM || "charlie@mail.example.com";
      const payload = { from: from_, to, subject: msg.subject, html: msg.html, text: msg.text, headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
      // Boundary validation, mirroring the scheduler's out-of-market send: refuse a
      // structurally broken payload before it reaches Resend. Fail-closed — skip the note, don't throw
      // into onboarding; the daily scheduler will send it on the next run if this person is still "other".
      const check = ResendSendPayload.safeParse(payload);
      if (!check.success) {
        console.error(`[out-of-market] ${email}: note malformed — skip (${check.error.issues.map((i: any) => i.path.join(".")).slice(0, 3).join(", ")})`);
      } else {
        await sendGuarded({ resend, email, template: "out-of-market", dedupeKey: "v1", to, idempotencyKey: `out-of-market/${email}`, payload });
        console.error(`[out-of-market] ${email} outside India+US (place: ${place || "?"}) — sent honest note, skipped briefing + first role`);
      }
    } catch (e: any) {
      console.error(`[out-of-market] ${email}: honest note failed ${e.message}`);
    }
    return;
  }
  // #2 briefing now, then #3 the game plan AFTER it resolves so the two land in order (briefing -> plan).
  // Both are best-effort and fail-closed inside their own senders; the plan is dark until GAME_PLAN=on
  // (sendPlan self-gates too, so the flag check here is belt-and-suspenders that also skips the await).
  sendMarketBriefing(email, { log: (msg: string) => console.error(`[market-briefing] ${msg}`) })
    .then(() => (gamePlanOn() ? sendPlan(email, { log: (msg: string) => console.error(`[game-plan] ${msg}`) }) : null))
    .catch(() => {});
  // NO SECOND SERVING TRACK. A new person is not a cohort: they are scored by the weekly run alongside
  // everybody else, and renderWelcome tells them so in plain words ("every Monday I read every live
  // posting...") instead of promising minutes.
  //
  // There is deliberately no "send a role now" path here. `sendFirstRole` runs a complete parallel copy
  // of the send pipeline (many model calls, then composer + verifier); triggered by an inbound email it
  // would be an unbounded, stranger-triggered spend.
  //
  // The briefing above still lands at completion; it is the one thing a new person gets on day one,
  // and it costs no job scoring.
}

const reqHost = (req: any) =>
  String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].split(":")[0].trim().toLowerCase();

const app = express();
// Security headers on every reply, and no banner naming the framework.
app.disable("x-powered-by");
app.use(securityHeaders());
// Capture the raw body so the Resend (Svix) webhook signature can be verified.
// The voice router (server/voice.ts) parses its own bodies: /voice/api carries a mandate file as
// base64 (up to 10 MB decoded), /voice/llm and /voice/session check their bearer or token before
// reading a byte, and /webhooks/elevenlabs needs its raw body for the signature. Every other route
// keeps the 1 MB cap.
const jsonBody = express.json({ limit: "1mb", verify: (req: any, _res, buf) => { req.rawBody = buf; } });
app.use((req, res, next) => (req.path.startsWith("/voice/") || req.path === "/webhooks/elevenlabs" ? next() : jsonBody(req, res, next)));

// CORS so the landing page can read the public /pool-* scan stats from the browser. The hiring API answers a browser
// only from the origins in HIRE_APP_ORIGINS; unset = no origin, so the browser
// refuses the call (fail closed).
app.use(cors({ hireOrigins: hireOriginsOf(process.env.HIRE_APP_ORIGINS) }));

// Two things VERSION cannot tell you, both computed once at boot.
// `build` is a content hash of the running SOURCE (lib/build-id.mjs). VERSION is bumped by hand, so
// equal versions do NOT prove equal code; `build` does, and it is the same function the engine stamps at
// the start of every cron run — which is what makes "are both services on the same code?" a question
// with an answer rather than an inference.
// `flags` is a hash of the non-secret CONFIG both services share (lib/env-parity.mjs), so watchdog.mjs
// can notice a divergence unattended — EDGE_ENGINE was `on` here and `off` on the cron for an unknown
// period, and nothing knew the two were meant to agree. Both are hashes, so this endpoint stays exactly
// as public as it already was; they say "we disagree", never which var.
const BUILD = buildId();
const FLAGS = flagFingerprint();
// Voice verification (server/voice.ts): the dashboard API under /voice/api/* behind the dashboard
// secret, plus the live-call routes. Mounted here so it sits behind the JSON + CORS middleware
// above and in front of every other route; it answers nothing while VOICE_VERIFICATION is off.
app.use(voiceRouter());
app.use(outreachRouter());
app.use(agentsRouter());

app.get("/healthz", (_req, res) => res.json({ ok: true, service: "charlie-server", version: VERSION, build: BUILD, flags: FLAGS.hash, flagVars: FLAGS.vars }));

// Public, no-auth: the live scan stats the landing shows (roles live, companies, opened
// today, closed since yesterday). Real numbers from the engine's last scan; null until the
// first scan shares them. Short cache so the landing isn't hammered.
app.get("/pool-stats", async (_req, res) => {
  try {
    const stats = await loadJobPoolStats();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(stats || null); // null = no scan has written stats yet (a real, cacheable answer)
  } catch (e: any) {
    // The read itself failed: say so (503, not cached) so monitors see it. The landing still keeps
    // its static fallback because the body carries no `roles`.
    console.error(`[pool-stats] ${e?.message || e}`);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "pool stats unavailable" });
  }
});

// Public, no-auth: the live feed the landing streams — freshest REAL roles + by-function
// counts, precomputed by the engine (tiny JSON, never the full pool).
app.get("/pool-feed", async (_req, res) => {
  try {
    const feed = await loadJobPoolFeed();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(feed || null); // null = no scan has written a feed yet
  } catch (e: any) {
    console.error(`[pool-feed] ${e?.message || e}`);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "pool feed unavailable" });
  }
});

// Verify a Resend (Svix-signed) webhook. secret = "whsec_<base64>"; signature is
// base64(HMAC-SHA256( `${id}.${timestamp}.${rawBody}`, base64decode(secret) )), sent
// in `svix-signature` as a space-separated list of "v1,<sig>". Returns true if any match.
function verifyResendSignature(req: any, secret: string = process.env.RESEND_WEBHOOK_SECRET || ""): boolean {
  if (!secret.startsWith("whsec_")) return false;
  const id = req.headers["svix-id"];
  const ts = req.headers["svix-timestamp"];
  const sigHeader = String(req.headers["svix-signature"] || "");
  if (!id || !ts || !sigHeader || !req.rawBody) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signed = `${id}.${ts}.${req.rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", key).update(signed).digest(); // raw bytes
  return sigHeader.split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    let got: Buffer;
    try { got = Buffer.from(sig, "base64"); } catch { return false; }
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// Resend delivery webhooks. On a hard bounce or spam complaint, add the recipient to
// the global suppression list so Charlie never emails it again (protects deliverability).
app.post("/webhooks/resend", async (req, res) => {
  if (!verifyResendSignature(req)) return res.status(401).json({ error: "bad signature" });
  // Boundary: validate the (signature-verified) body before acting on it. Fail-closed — an
  // unparseable body is logged + acked without suppressing anyone or logging a garbage event.
  const parsed = ResendWebhookEvent.safeParse(req.body);
  if (!parsed.success) {
    console.error(`[webhook] unparseable body (skipped): ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`);
    return res.json({ ok: true, skipped: "unparseable" });
  }
  const { type, data } = parsed.data;
  const to = data.to;
  const addrs = Array.isArray(to) ? to : to ? [to] : [];
  try {
    // Log EVERY delivery event (delivered / bounced / complained / opened / ...) to email_events,
    // one row per recipient. Fail-open (logEmailEvent never throws) so it can't 500 the webhook.
    // Attribute the event to the exact role when the send was role-level, so an open
    // (once Resend open-tracking is enabled) joins to its find. findIdForResend is fail-soft (null
    // on a non-role send or any error), keeping the webhook fail-open.
    const resendId = data.email_id ?? data.id ?? null;
    const findId = await findIdForResend(resendId);
    for (const a of addrs) {
      await logEmailEvent({ email: a, type: type || "unknown", channel: "delivery", resendId, findId, meta: data });
    }
    // Hard bounce / spam complaint -> global do-not-send (the send path checks isSuppressed).
    if (type === "email.bounced" || type === "email.complained") {
      for (const a of addrs) await suppressAddress(a, type === "email.complained" ? "complaint" : "hard_bounce");
      console.error(`[webhook] ${type}: suppressed ${addrs.join(", ")}`);
    }
    res.json({ ok: true });
  } catch (e: any) {
    console.error(`[webhook] handling failed: ${e.message}`);
    res.status(500).json({ error: "handler error" });
  }
});

// ── Pieworks 2call activation (lib/pieworks-activation.mjs) ──────────────────────────────────────
// Pieworks POSTs, once a day, a batch of people who have sat in its 2call stage for a week (its doc, section 3), signed
// with X-Pieworks-Signature over the raw body. A bad or missing signature is a 401 (Pieworks aborts on a 4xx). The batch
// is stored, each person once ever, and acked; a store failure is a 500 so Pieworks retries. Then the sweep sends.
// These people are Pieworks', not Charlie's: they are never onboarded and never enter the pool.
const pieworks = pieworksActivation({ capture: captureError });
let pieworksRunning = false;
async function runPieworksSweep() {
  if (pieworksRunning) return;
  pieworksRunning = true;
  try {
    const out = await pieworks.runPass();
    if (out.mode === "off") return;
    if (out.asked || out.reminded || out.closed || out.moved || out.skipped || out.failed || out.stats) console.error(`[pieworks] pass: ${JSON.stringify(out)}`);
    await pingHeartbeat("pieworks", { fail: out.failed > 0 });
  } finally {
    pieworksRunning = false;
  }
}
app.post("/webhooks/pieworks", async (req: any, res) => {
  if (!pieworksSignatureOk({ secret: process.env.PIEWORKS_WEBHOOK_SECRET || "", header: req.get("x-pieworks-signature"), rawBody: req.rawBody })) {
    console.error("[pieworks] webhook signature rejected (or PIEWORKS_WEBHOOK_SECRET unset)");
    return res.status(401).json({ error: "bad signature" });
  }
  const batch = PieworksWebhookBatch.safeParse(req.body);
  if (!batch.success) {
    console.error("[pieworks] webhook body is not a batch of candidates");
    return res.status(400).json({ error: "expected a JSON array of candidates" });
  }
  try {
    const out = await pieworks.ingest(batch.data, { idempotencyKey: String(req.get("idempotency-key") || "").slice(0, 200) || null });
    console.error(`[pieworks] webhook ${String(req.get("x-pieworks-event") || "").slice(0, 60)}: received ${out.received}, stored ${out.stored}, repeats ${out.repeats}, skipped ${out.skipped.length}`);
    res.json({ ok: true, stored: out.stored });
  } catch (e: any) {
    console.error(`[pieworks] webhook store failed: ${e.message}`);
    captureError(e, { kind: "pieworks-webhook" });
    return res.status(500).json({ error: "could not store the batch" });
  }
  // ask now rather than up to 30 minutes later
  runPieworksSweep().catch((e: any) => console.error(`[pieworks] sweep error: ${e.message}`));
});

// ── inbound email onboarding (start@ address) ──────────────────────────
// Resend Inbound parses the email and POSTs it here (Svix-signed). The sender's address is
// their identity (no magic link). A first email with a resume attached onboards them; a
// later reply is treated as a change to their preferences. We reply via Resend either way.
// Verify against the inbound webhook's own secret first, then fall back to the delivery
// webhook secret (in case they're shared). Each Resend webhook has its OWN signing secret,
// so INBOUND_WEBHOOK_SECRET must be set to THIS webhook's secret.
const INBOUND_SECRETS = [process.env.INBOUND_WEBHOOK_SECRET, process.env.RESEND_WEBHOOK_SECRET].filter(Boolean) as string[];

// Refuse to boot with no signing secret. /inbound REPLIES to the address in the payload, so an
// unauthenticated POST makes this server send mail to an attacker-chosen recipient on the domain
// whose deliverability is a GA blocker. A crash-loop is loud and recoverable; an open relay is
// neither. Deliberately fatal rather than degraded — see lib/inbound-auth.mjs for the full why.
if (inboundSecretsMissing(INBOUND_SECRETS)) {
  console.error("[boot] FATAL: no inbound signing secret. Set INBOUND_WEBHOOK_SECRET (this webhook's own Resend signing secret) and redeploy. Refusing to start rather than accept unverified mail.");
  process.exit(1);
}

// Maintenance aid: a small in-memory ring buffer of the last inbound events, surfaced via the
// owner-gated GET /inbound-debug. Lets us confirm at a glance what /inbound received and did
// (signature, attachment fetch, extraction, dispatch) without trawling logs. Resets on deploy.
const recentInbound: any[] = [];
function noteInbound(e: any) { recentInbound.unshift({ t: new Date().toISOString(), ...e }); if (recentInbound.length > 25) recentInbound.length = 25; }

function addrOf(v: any): string {
  // accept "Name <a@b.com>", {address}, {email}, or a raw address
  if (!v) return "";
  if (typeof v === "object") v = v.address || v.email || "";
  const m = String(v).match(/<([^>]+)>/);
  return (m ? m[1] : String(v)).trim().toLowerCase();
}

// Forwarded / HTML-only emails often ship an empty text/plain part; recover the body from HTML.
// Keeps <a href> targets so job links survive stripping.
function htmlToText(h: any): string {
  return String(h || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Best-effort sender-authentication signal from the inbound payload. On /inbound the acting identity is
// the `From` address, which is unauthenticated on its own — so we surface whatever SPF/DKIM/DMARC verdict
// the provider includes and REFUSE to act on an explicit spoof/fail (a stranger must not be able to write
// a real user's dossier by forging `From:`). Absence → "unknown": we can't distinguish, so we do NOT block
// legitimate mail on it (fail-open on absence, hard-closed on explicit fail). Pairs with DMARC enforcement
// + INBOUND_WEBHOOK_SECRET (both on the GA checklist) for a fully authoritative inbound-identity boundary.
function senderAuthSignal(d: any): { verdict: "pass" | "fail" | "unknown"; raw: string } {
  const raw = [
    d?.spf, d?.dkim, d?.dmarc, d?.spf_verdict, d?.dkim_verdict, d?.dmarc_verdict,
    d?.authentication_results, d?.["authentication-results"],
    d?.headers?.["authentication-results"], d?.headers?.["Authentication-Results"],
  ].filter(Boolean).map((x) => String(x)).join(" | ").slice(0, 240);
  const s = raw.toLowerCase();
  // Enforce ONLY on an unambiguous aligned DMARC failure (never on SPF-alone, which forwarding breaks).
  if (/dmarc[=:\s]+fail/.test(s)) return { verdict: "fail", raw };
  if (/dmarc[=:\s]+pass/.test(s)) return { verdict: "pass", raw };
  return { verdict: "unknown", raw };
}

// the local-parts an inbound email was addressed to (start@, check@, ...), shape-tolerant
function recipientLocalParts(d: any): string[] {
  const raw = d?.to ?? d?.recipient ?? d?.envelope?.to ?? d?.headers?.to ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x: any) => addrOf(x)).filter(Boolean).map((a: string) => a.split("@")[0]);
}

// Resend Inbound delivers attachment METADATA only (id + email_id); the bytes are fetched
// from the Attachments API, which needs a READ-capable key (the send key 401s on reads).
const RESEND_READ_KEY = process.env.RESEND_READ_KEY || process.env.RESEND_API_KEY || "";

async function fetchResendInboundAttachment(emailId: string, attId: string): Promise<{ buf: Buffer | null; note: string }> {
  if (!emailId || !attId) return { buf: null, note: "missing email_id/att_id" };
  if (!RESEND_READ_KEY) return { buf: null, note: "no read key (set RESEND_READ_KEY)" };
  const headers = { authorization: `Bearer ${RESEND_READ_KEY}` };
  for (const url of [
    `https://api.resend.com/emails/receiving/${emailId}/attachments`,
  ]) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) { if (r.status === 401) return { buf: null, note: "401 (key lacks read scope)" }; continue; }
      const d: any = await r.json();
      let item: any = d;
      if (Array.isArray(d?.data)) item = d.data.find((a: any) => a.id === attId) || d.data[0];
      if (item?.content && typeof item.content === "string") { try { return { buf: Buffer.from(item.content, "base64"), note: "content" }; } catch { /* try url */ } }
      const dl = item?.download_url || item?.url;
      if (dl) { const fr = await fetch(dl); if (fr.ok) return { buf: Buffer.from(await fr.arrayBuffer()), note: "download_url" }; }
      return { buf: null, note: `no bytes; keys=${Object.keys(item || {}).join(",")}` };
    } catch { /* next endpoint */ }
  }
  return { buf: null, note: "endpoints failed" };
}

// Resend Inbound webhooks carry only METADATA (from/to/subject/email_id/attachments), NOT the
// body. Fetch the full received email (text/html) from the Receiving API by email_id — same
// read-capable key as attachments. Returns null if unavailable (send-only key locally).
async function fetchResendInboundEmail(emailId: string): Promise<{ subject: string; text: string; html: string } | null> {
  if (!emailId || !RESEND_READ_KEY) return null;
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, { headers: { authorization: `Bearer ${RESEND_READ_KEY}` } });
    if (!r.ok) { console.error(`[inbound] full-email fetch ${r.status}${r.status === 401 ? " (key lacks read scope)" : ""}`); return null; }
    const d: any = await r.json();
    const e: any = d?.data || d;
    return { subject: String(e?.subject || ""), text: String(e?.text || ""), html: String(e?.html || e?.html_body || "") };
  } catch (err: any) { console.error(`[inbound] full-email fetch failed: ${err.message}`); return null; }
}

// Pull the resume attachment's bytes from whatever shape Resend sends (base64 or a URL).
async function attachmentBuffer(att: any): Promise<Buffer | null> {
  if (!att) return null;
  // base64 string under any of the common field names
  const c = att.content ?? att.contentBytes ?? att.base64 ?? att.data ?? att.Content;
  if (typeof c === "string" && c.length) { try { return Buffer.from(c, "base64"); } catch { /* try url */ } }
  // JSON-serialized Buffer ({type:"Buffer", data:[...]}) or {data:[...]}
  if (c && Array.isArray(c.data)) { try { return Buffer.from(c.data); } catch { /* try url */ } }
  // a download URL Resend hosts the attachment at — SSRF-guarded (the URL rides in on the webhook
  // payload, so treat it as attacker-influenceable; safeFetch blocks internal/metadata targets).
  const url = att.content_url || att.url || att.download_url || att.contentUrl || att.downloadUrl || att.path;
  if (url) { try { const r = await safeFetch(String(url)); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch { /* ignore */ } }
  return null;
}

// turn the changed-preference keys into a warm, human phrase for the confirmation email
//
// AN UNMAPPED KEY IS DROPPED, NEVER PRINTED. Falling back to the key itself would print a database
// column (e.g. "home_place") in a person's email; user-facing copy never exposes the mechanism.
//
// COMPLETING THE MAP IS NOT THE FIX, because `preferences` is a .passthrough() object: any key can
// appear, so the map is guaranteed to be incomplete the next time somebody adds a field, and the
// failure is silent and lands in a stranger's inbox. Dropping what we cannot say in English is the
// only version that stays correct. Saying less is always available; a leaked internal name is not
// recoverable.
function friendlyChanges(keys: string[]): string {
  const map: Record<string, string> = {
    role: "the kind of role", seniority: "your seniority", remote: "where you want to work",
    comp_floor: "your pay floor", comp_currency: "your pay currency", stage: "company stage",
    dealbreakers: "your dealbreakers", ping_bar: "what's worth reaching out for", values: "what matters to you",
    home_place: "where you're based", mode: "what you're looking for", notice_period: "your notice period",
    relocate: "whether you'd relocate", location: "where you want to work",
  };
  const parts = keys.map((k) => map[k]).filter(Boolean);
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

app.post("/inbound", async (req, res) => {
  console.error(`[inbound] POST received (${INBOUND_SECRETS.length} signing secret(s) configured)`);
  noteInbound({ stage: "received", secrets: INBOUND_SECRETS.length, host: reqHost(req) });
  const sigOk = inboundSigOk(INBOUND_SECRETS, (s) => verifyResendSignature(req, s));
  if (!sigOk) {
    console.error("[inbound] signature REJECTED — set INBOUND_WEBHOOK_SECRET to this webhook's signing secret in Resend");
    noteInbound({ stage: "sig_rejected" });
    return res.status(401).json({ error: "bad signature" });
  }
  // acknowledge fast; do the work after so the provider never times out / retries
  res.json({ ok: true });

  try {
    const d = req.body?.data || req.body || {};
    const from = addrOf(d.from || d.sender || d.envelope?.from);
    if (!from) { console.error("[inbound] no sender — ignoring"); noteInbound({ stage: "no_sender", keys: Object.keys(d || {}) }); return; }
    // Loop/auto-mail guard: the sending domain also receives, so never process mail from our
    // own domain (would loop on Charlie's own replies) or from system senders (bounces,
    // auto-responders, mailer-daemon).
    if (isOwnDomain(from) || /^(mailer-daemon|postmaster|no-?reply|noreply)@/i.test(from)) {
      console.error(`[inbound] ignoring self/system sender ${from}`);
      return;
    }
    // RATE LIMIT — before any work, and it drops SILENTLY. The expensive step runs early in this
    // handler: 80 characters of body is enough to trigger a full Opus 4.8 dossier build before
    // anything checks whether the sender is job hunting, so a flood is a bill, not just noise.
    // No reply, deliberately: answering a flood doubles the volume, and on a spoofed sender it makes
    // Charlie the one sending unsolicited mail. A dropped message is recoverable; a burnt sending
    // domain is not. Placed AFTER the self/system-sender check so our own bounces never consume
    // someone's quota, and BEFORE sender-auth so a forged flood cannot spend a real person's budget.
    const rate = noteInboundFrom(from);
    if (!rate.allowed) {
      console.error(`[inbound] RATE LIMITED ${from} — ${rate.count} in the last hour (limit ${rate.limit}), dropping silently`);
      noteInbound({ stage: "rate_limited", from, count: rate.count, limit: rate.limit });
      return;
    }
    // SECURITY (tenant integrity): refuse to act on mail that FAILED sender authentication — otherwise a
    // forged `From:` could write another person's profile. Only an explicit DMARC fail is blocked; absence
    // of a verdict is logged (so we can confirm the provider surfaces it) and allowed through.
    const auth = senderAuthSignal(d);
    if (auth.verdict === "fail") {
      console.error(`[inbound] sender auth FAIL for ${from} — refusing to act (possible spoof)`);
      noteInbound({ stage: "auth_rejected", from, auth: auth.raw });
      return;
    }
    let subject = String(d.subject || "");
    let body = String(d.text || d.plain || d.body || "").trim() || htmlToText(d.html || d.html_body || d.htmlContent || d.HtmlBody);
    // Resend's inbound webhook is metadata-only — the body lives behind the Receiving API.
    // If the webhook gave us no body, fetch the full email by email_id (needs the read key).
    if (!body && d.email_id) {
      const full = await fetchResendInboundEmail(d.email_id);
      if (full) {
        if (!subject) subject = full.subject;
        body = full.text.trim() || htmlToText(full.html);
      }
    }
    const atts = Array.isArray(d.attachments) ? d.attachments : [];
    console.error(`[inbound] from ${from} | subj "${subject.slice(0, 50)}" | ${atts.length} attachment(s)`);
    noteInbound({ stage: "parsed", from, attachments: atts.length, attNames: atts.map((a: any) => a.filename || a.name || "?"), subject: subject.slice(0, 60),
      keys: Object.keys(d || {}), webhookTextLen: String(d.text || "").length, webhookHtmlLen: String(d.html || "").length });

    // KEEP WHAT THEY WROTE, so "what did this person actually say" always has an answer. Stored here, immediately after parsing and BEFORE any
    // branch decides what kind of message it is, so a message that is routed wrongly is still on
    // file. Fail-open and unawaited-safe: recordInbound swallows its own errors, because failing to
    // answer somebody would be worse than losing the filing copy.
    recordInbound({ email: from, subject, body, emailId: String(d.email_id || ""), stage: "parsed" }).catch(() => {});

    // Tier-1 work ingestion: extract EVERY allowed attachment (not just the first). The doc named
    // like a resume/CV becomes the primary; the rest ride along as extra ARTIFACT sources for the
    // dossier. If nothing is resume-named, the longest extracted doc is promoted to primary.
    let resumeText: string | null = null;
    const extraDocs: { filename: string; text: string }[] = [];
    // CAP THE COUNT as well as the size. Each attachment costs a fetch and a full extraction, so an
    // unbounded count is an unbounded cost. Five is more than any
    // real person sends (a resume plus a portfolio or two) and turns an unbounded loop into a bounded
    // one. The extractor caps each file's BYTES separately (MAX_ATTACHMENT_BYTES).
    const MAX_ATTACHMENTS = Number(process.env.MAX_ATTACHMENTS || 5);
    if (atts.length > MAX_ATTACHMENTS) {
      console.error(`[inbound] ${from} sent ${atts.length} attachments — reading the first ${MAX_ATTACHMENTS}`);
      noteInbound({ stage: "attachments_capped", from, sent: atts.length, read: MAX_ATTACHMENTS });
    }
    // The original CV file, kept for a hiring reply whose employer needs the PDF itself (lib/qualify/agent.mjs).
    let cvPdf: { filename: string; bytes: Uint8Array; text: string } | null = null;
    for (const a of atts.slice(0, MAX_ATTACHMENTS)) {
      const ext = (String(a.filename || a.name || "").split(".").pop() || "").toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) continue;
      let buf = await attachmentBuffer(a); // inline content/url, if any
      if (!buf && a.id) {
        const fa = await fetchResendInboundAttachment(d.email_id, a.id); // Resend inbound: fetch by id
        buf = fa.buf;
        noteInbound({ stage: "att_fetch", filename: a.filename || a.name, ok: !!buf, note: fa.note });
      }
      if (!buf) continue;
      const fname = String(a.filename || a.name || "document");
      const r = await extractResumeText(buf, fname);
      noteInbound({ stage: "extract", filename: fname, ok: r.ok, chars: r.ok ? r.chars : 0 });
      if (!r.ok) continue;
      // only a PDF that reads like a CV (named as one, or with a CV's sections) can travel as their CV: a payslip
      // or an offer letter never becomes the CV an employer receives
      if (ext === "pdf" && looksLikeCv(fname, r.text) && (!cvPdf || /(^|[^a-z])(cv|resume)([^a-z]|$)/i.test(fname))) cvPdf = { filename: fname, bytes: new Uint8Array(buf), text: r.text };
      if (!resumeText && /resume|cv|curriculum/i.test(fname)) resumeText = r.text;
      else extraDocs.push({ filename: fname, text: r.text });
    }
    // No explicitly resume-named doc? Promote the longest extracted document to primary.
    if (!resumeText && extraDocs.length) {
      extraDocs.sort((x, y) => y.text.length - x.text.length);
      resumeText = extraDocs.shift()!.text;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const from_ = process.env.CHARLIE_FROM || "charlie@mail.example.com";
    const unsub = unsubUrlFor(from);
    // every reply carries the designed shell + one-click unsubscribe header
    // Every direct reply to the user threads into ONE conversation (threadKey "convo"): the first
    // send anchors the thread, later sends reference its Message-ID so the exchange reads as one chat
    // instead of scattered mail. Pass a distinct threadKey (e.g. a findId) to isolate a sub-thread.
    // Routes through sendGuarded like every other user-facing send, so a reply leaves a
    // `sent_emails` row and a webhook redelivery cannot double-reply (the dedupe key is the INBOUND
    // message id; a genuine later email carries a new one and gets its own reply).
    //
    // SUPPRESSION, but reason-aware. Replying to someone who just emailed YOU is not unsolicited
    // mail: their message is the consent. An unsubscribe means "stop sending me things", not "never
    // speak to me again", and since email is the only surface, blocking it outright would make
    // unsubscribe a ONE-WAY DOOR — a person asking to come back would meet total silence. So an
    // unsubscribe does not block an inbound reply. A hard bounce (dead mailbox) or a spam complaint
    // (they objected) still does, as does any other reason: this is a whitelist, so an unknown or
    // future suppression reason keeps blocking rather than silently opening.
    // The decision itself is a pure, exhaustively tested function (lib/suppression-policy.mjs),
    // extracted rather than inlined because a send-blocking rule buried in a closure cannot be
    // enumerated against its whole input space.
    const replyAllowed = async (addr: string) => {
      if (mayReplyDespiteSuppression(await suppressionReason(addr))) return false; // they wrote in — answer them
      return isSuppressed(addr);
    };
    const send = async (m: { subject: string; html: string; text: string }, threadKey = "convo") => {
      try {
        const root = await getThreadRoot(from, threadKey).catch(() => null);
        const messageId = newMessageId(threadKey);
        const r = await sendGuarded({
          resend, email: from, template: `inbound:${threadKey}`,
          dedupeKey: String(d.email_id || messageId),
          deps: { isSuppressed: replyAllowed },
          payload: {
            from: from_, to: from, subject: m.subject, html: m.html, text: m.text,
            headers: threadHeaders({ messageId, root, base: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }),
          },
        });
        if (r?.status !== "sent") { console.error(`[inbound] reply ${r?.status} for ${from}: "${m.subject}"`); return; }
        if (!root) await setThreadRoot(from, threadKey, messageId).catch(() => {}); // anchor on first send
        console.error(`[inbound] replied to ${from}: "${m.subject}"${root ? " (threaded)" : " (new thread)"}`);
      } catch (e: any) { console.error(`[inbound] reply failed: ${e.message}`); }
    };

    // The v2 interrogation send door. Unlike the raw `send` above, an interrogation message is
    // LLM-generated, so it must clear the honesty lint AND route through sendGuarded (suppression +
    // idempotency), fail-closed — a manipulative/careless line never reaches a real inbox, and a webhook
    // retry can't double-send. Returns { sent, lintDropped } so the caller can fall back to a clean ask.
    const sendV2 = async (m: { subject: string; html: string; text: string }, o: { state: string; batchN: number; journeyId: string }) => {
      const lint = lintMessage({ subject: m.subject, text: m.text });
      if (!lint.ok) {
        console.error(`[interro] lint DROP ${o.state}/${o.batchN} ${from}: ${lint.violations.map((v: any) => v.rule).join(", ")}`);
        return { sent: false, lintDropped: true };
      }
      const r: any = await sendGuarded({
        resend, email: from, template: `interro:${o.state}`,
        dedupeKey: `${o.journeyId}:${o.state}:${o.batchN}`,
        idempotencyKey: `interro/${o.journeyId}/${o.state}/${o.batchN}`,
        payload: { from: from_, to: from, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
        deps: { isSuppressed: replyAllowed }, // a returning unsubscriber who sends a resume must not be onboarded into silence
        log: console.error,
      }).catch((e: any) => { console.error(`[interro] sendGuarded threw: ${e.message}`); return { status: "failed" }; });
      return { sent: r.status === "sent" || r.status === "duplicate", lintDropped: false, status: r.status };
    };

    // Send ONE interrogation question, falling back to a clean deterministic ask if the generated
    // copy fails the lint (fail-closed — onboarding never ends in silence).
    const askOne = async (dossier: any, opts: { first: boolean; changedText?: string; question: string; state: string; batchN: number; journeyId: string }) => {
      const name = dossier?.name || "";
      const strength = topStrength(dossier);
      const primary = renderInterroTurn({ email: from, name, first: opts.first, changedText: opts.changedText || "", strength, question: opts.question });
      const r = await sendV2(primary, opts);
      if (!r.lintDropped) return r;
      const fbq = nextGap(dossier)?.ask || opts.question; // clean, hand-written ask
      const fb = renderInterroTurn({ email: from, name, first: opts.first, question: fbq });
      return sendV2(fb, opts);
    };

    // Finish the interrogation — reach `building` via a legal hop if needed (needs_input/parked ->
    // interrogating -> building), a light NO-WIPE finalize, then `delivered` which fires the first
    // role. The accumulated grounded facts are preserved.
    const completeInterro = async (dossier: any) => {
      try {
        const st = currentState(await getCandidate(from).catch(() => null));
        if (st === "needs_input" || st === "parked") await enterState(from, "interrogating").catch(() => {});
        await enterState(from, "building").catch((e: any) => console.error(`[interro] building: ${e.message}`));
        await enterState(from, "delivered").catch((e: any) => console.error(`[interro] delivered: ${e.message}`));
        void dossier; // finalize is a state move only — no buildDossier rebuild (would discard the transcript)
        await briefingThenScheduleRole(from); // #2 briefing now, #3 first role on day-2
      } catch (e: any) { console.error(`[interro] complete failed ${from}: ${e.message}`); }
    };
    const journeyIdFor = async () => (journeyOf(await getCandidate(from).catch(() => null)) as any)?.journey_id || "interro";

    const existing = await getDossier(from);
    noteInbound({ stage: "dispatch", from, resume: !!resumeText, existing: !!existing, bodyChars: body.length, auth: auth.verdict, authRaw: auth.raw || undefined });

    // pieworks+<key>@ = a reply to a Pieworks 2call ask (lib/pieworks-activation.mjs). Read before everything else that
    // could onboard: the person is Pieworks', and a reply here is a yes or a no to one role, never a new Charlie user.
    // A reply sent to charlie@ instead (a mail app that ignores Reply-To) is theirs too when this sender has an open
    // Pieworks thread and the subject names its role; a lookup failure leaves the mail to the rest of /inbound, as before.
    const pwKey = pieworksReplyKey(recipientLocalParts(d)) || (await pieworks.keyForReply({ from, subject }).catch((e: any) => { console.error(`[pieworks] reply lookup: ${e?.message || e}`); return null; }));
    if (pwKey) {
      const outcome = await pieworks.onReply({ key: pwKey, from, body }).catch((e: any) => { captureError(e, { kind: "pieworks-reply" }); return `failed: ${e?.message || e}`; });
      console.error(`[pieworks] reply pieworks+${pwKey}: ${outcome}`);
      noteInbound({ stage: "pieworks-reply", from });
      return;
    }

    // apply+<key>@ = a reply to a Qualify & Submit email (lib/qualify/agent.mjs). FIRST, before the referral marker,
    // join@ and onboarding: the CV attached belongs to that conversation, never to a new dossier. Dark while
    // HIRING_WORKSPACE is off.
    if (await qualifyInboundReply({ localParts: recipientLocalParts(d), from, body, cvFile: cvPdf, qualifyCvText: cvPdf?.text ?? null, ref: d.email_id || null })) {
      noteInbound({ stage: "hire-invite-reply", from });
      return;
    }

    // Bring-a-friend attribution (the friend-drip share loop): a NEW sender arriving with a
    // [fref:<token>] marker came via a friend's /g link. Record the signup against the giver + their
    // A/B variant, best-effort and fail-open — this never gates onboarding, and existing users (already
    // ours) are skipped so a stray marker in a returning user's reply can't misattribute.
    if (!existing) {
      const fref = (body.match(/\[fref:([A-Za-z0-9._-]+)\]/) || subject.match(/\[fref:([A-Za-z0-9._-]+)\]/) || [])[1] || null;
      if (fref) {
        const giver = emailForToken(fref);
        if (giver && giver.toLowerCase() !== from.toLowerCase())
          recordReferralEvent({ giverEmail: giver, variant: friendVariant(giver), kind: "signup", friendEmail: from, refCode: fref }).catch(() => {});
      }
    }

    // join@ = the ISOLATED hiring campaign brain. DARK unless
    // JOIN_CAMPAIGN=on. Placed FIRST in dispatch so a campaign mail can never fall into onboarding. The
    // model NEVER decides a verdict — only the owner's typed advance/reject moves anyone (campaign-loop.mjs,
    // proven by campaign-loop.test.mjs). Every candidate send is convo-lint'd + routed through sendGuarded;
    // every read fails closed. The whole flow is the tested orchestration; this block only wires deps.
    const joinLocal = String(process.env.JOIN_INBOUND || "join@mail.example.com").split("@")[0].toLowerCase();
    if (process.env.JOIN_CAMPAIGN === "on" && recipientLocalParts(d).some((lp) => lp.toLowerCase() === joinLocal)) {
      const joinFrom = `Charlie <${process.env.JOIN_INBOUND || "join@mail.example.com"}>`;
      const ownerEmail = String(process.env.JOIN_OWNER_EMAIL || "").toLowerCase();
      const calendlyUrl = String(process.env.JOIN_CALENDLY || "");
      const isOwner = (addr: string) => !!ownerEmail && String(addr).toLowerCase() === ownerEmail;

      const askModel = async (system: string, user: string): Promise<string> => {
        const client = new Anthropic();
        const res: any = await client.messages.create({
          model: process.env.JOIN_MODEL || "claude-sonnet-4-6",
          max_tokens: 1400, system,
          messages: [{ role: "user", content: String(user).slice(0, 24000) }],
        });
        return (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      };
      const lintOk = (msg: string) => lintMessage({ subject: "", text: String(msg || ""), conversational: false }).ok;

      const renderByKind = (kind: string, toEmail: string, args: any = {}) => {
        switch (kind) {
          case "redirect": return renderCampaignRedirect({ email: toEmail });
          case "incomplete": return renderCampaignIncomplete({ email: toEmail });
          case "kickoff": return renderCampaignKickoff({ email: toEmail, opener: args.opener });
          case "message": return renderCampaignMessage({ email: toEmail, message: args.message });
          case "reject": return renderCampaignReject({ email: toEmail, board: args.board });
          case "pass": return renderCampaignPass({ email: toEmail });
          case "calendly": return renderCampaignCalendly({ email: toEmail, calendlyUrl });
          case "nearmiss": return renderCampaignNearMiss({ email: toEmail, reason: args.reason });
          default: return null;
        }
      };
      // send to an APPLICANT (may differ from the inbound sender, e.g. an owner-verdict fires a send to the
      // candidate). convo-lint every message; guarded + threaded; dedupe on the triggering inbound id.
      const sendCandidate = async (toEmail: string, kind: string, args: any = {}) => {
        const m: any = renderByKind(kind, toEmail, args);
        if (!m) return;
        const lint = lintMessage({ subject: m.subject, text: m.text, conversational: false }); // campaign copy is reviewed; only the universal honesty/voice gate applies (not the one-question structure)
        if (!lint.ok) { console.error(`[join] lint DROP ${kind} ${toEmail}: ${lint.violations.map((v: any) => v.rule).join(",")}`); return; }
        const threadKey = "join";
        const root = await getThreadRoot(toEmail, threadKey).catch(() => null);
        const messageId = newMessageId(threadKey);
        const u = unsubUrlFor(toEmail);
        const r: any = await sendGuarded({
          resend, email: toEmail, template: `join:${kind}`,
          dedupeKey: `join:${kind}:${toEmail}:${d.email_id || messageId}`,
          idempotencyKey: `join/${kind}/${toEmail}/${d.email_id || messageId}`,
          deps: { isSuppressed: replyAllowed }, // a candidate in a live conversation is not silenced by an old unsubscribe (still blocks bounce/complaint)
          payload: { from: joinFrom, to: toEmail, subject: m.subject, html: m.html, text: m.text, headers: threadHeaders({ messageId, root, base: { "List-Unsubscribe": `<${u}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }) },
          log: console.error,
        }).catch((e: any) => { console.error(`[join] send ${kind} threw: ${e.message}`); return { status: "failed" }; });
        if (r?.status === "sent" && !root) await setThreadRoot(toEmail, threadKey, messageId).catch(() => {});
        console.error(`[join] ${kind} -> ${toEmail}: ${r?.status}`);
      };
      // hand the answers + a FACTUAL summary to the human. The reply-subject carries the applicant email so
      // the owner can just reply advance/reject. Nothing about the candidate is decided here.
      const notifyOwner = async (applicantEmail: string, phase: string, extra: any = {}) => {
        if (!ownerEmail) { console.error("[join] JOIN_OWNER_EMAIL unset — cannot request a verdict; holding"); return; }
        const app: any = await getJoinApplicant(applicantEmail).catch(() => null);
        const m: any = renderCampaignOwnerReview({ ownerEmail, applicantEmail, phase, transcript: app?.transcript || [], summary: extra.summary || app?.scores || null });
        const threadKey = `joinowner:${applicantEmail}`;
        const root = await getThreadRoot(ownerEmail, threadKey).catch(() => null);
        const messageId = newMessageId(threadKey);
        const r: any = await sendGuarded({
          resend, email: ownerEmail, template: `joinowner:${phase}`,
          dedupeKey: `joinowner:${phase}:${applicantEmail}:${d.email_id || messageId}`,
          deps: { isSuppressed: replyAllowed }, // the owner must always receive a verdict request (still blocks bounce/complaint)
          payload: { from: joinFrom, to: ownerEmail, subject: m.subject, html: m.html, text: m.text, headers: threadHeaders({ messageId, root, base: {} }) },
          log: console.error,
        }).catch((e: any) => { console.error(`[join] owner notify threw: ${e.message}`); return { status: "failed" }; });
        if (r?.status === "sent" && !root) await setThreadRoot(ownerEmail, threadKey, messageId).catch(() => {});
        console.error(`[join] owner review (${phase}) for ${applicantEmail}: ${r?.status}`);
      };
      const orderGateFacts = async (email: string) => {
        const cand: any = await getCandidate(email).catch(() => null);
        let hasDeliveredMatch = false;
        try { const ids: any = await getFindIds(email); hasDeliveredMatch = !!ids && (ids.size ?? ids.length ?? 0) > 0; } catch { /* fail closed */ }
        return { hasCandidate: !!cand, hasDeliveredMatch };
      };
      const buildRejectBoard = async (email: string) => {
        const rt = await getResume(email).catch(() => null);
        return buildRejectBoardFor({ resumeText: rt, askModel, log: console.error });
      };

      const deps: any = {
        getJoinApplicant, upsertJoinApplicant, appendJoinTranscript,
        orderGateFacts, askModel, lintOk, sendCandidate, notifyOwner, buildRejectBoard,
        isOwner, maxTurns: Number(process.env.JOIN_LOOP_MAX_TURNS) || 6, log: console.error,
      };

      // strip the quoted original so the transcript stores only the sender's OWN words (not Charlie's
      // quoted question tail), and the verdict/answer reads clean.
      const cleanBody = stripQuotedReply(body) || body;
      try {
        if (isOwner(from)) {
          // the owner replies to the review; resolve the applicant from the (Re:) subject that carried it.
          const targetFromSubject = (subject.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || [])[0]?.toLowerCase() || null;
          const out: any = await handleOwnerVerdict({ from, text: cleanBody, targetFrom: targetFromSubject }, deps);
          noteInbound({ stage: "join_owner", from, action: out?.action });
          console.error(`[join] owner action: ${out?.action}`);
        } else {
          const out: any = await handleJoinReply({ from, text: cleanBody }, deps);
          noteInbound({ stage: "join_reply", from, action: out?.action });
          console.error(`[join] applicant action: ${out?.action}`);
        }
      } catch (e: any) { console.error(`[join] handler failed for ${from}: ${e.message}`); Sentry.captureException(e); }
      return;
    }

    // intro@ = the email-native warm-intro finder. A "Find me a warm intro" button in a role
    // email opens a prefilled mail here (subject "Find me a warm intro: <role>", body carries
    // "ref: <findId>"). Charlie finds a real person, drafts the intro, and replies with a "Send
    // intro" button that opens the user's own mail app to that person, plus the tailored resume
    // attached (mailto can't attach a file, so the user drags it in). Fully in email, no browser.
    if (recipientLocalParts(d).some((lp) => /^intro/.test(lp)) || /find me a warm intro/i.test(subject)) {
      const ref = (body.match(/ref:\s*(\S+:\S+)/) || [])[1] || null;
      // The intro request carries the RIGHT company + role (so we never guess from the wrong find):
      // subject "Find me a warm intro: <role>", body "...at <company> I can reach out...".
      const hintRole = (subject.match(/find me a warm intro:\s*(.+)$/i)?.[1] || "").split(/\s+@\s+/)[0].trim();
      const hintCompany = (body.match(/\bat\s+(.+?)\s+I can reach out/i)?.[1] || "").trim();
      noteInbound({ stage: "intro", from, ref, company: hintCompany });
      const data: any = await computeReferral(from, ref, hintCompany, hintRole).catch((e: any) => { console.error(`[intro] ${e.message}`); return { none: true }; });
      if (!data || data.none || !data.contact) { await send(renderReferralNone({ email: from, company: data?.company || hintCompany || "" })); return; }
      // attach the tailored resume for this role so the user drags it straight into the intro
      let attachments: any[] = [];
      try {
        const finds: any[] = await getFinds(from, { limit: 50 });
        const job = (finds.find((f) => f.id === ref) || {}).job || null; // exact match only — no finds[0]
        if (job) {
          const rt = resumeText || (await getResume(from).catch(() => null));
          const all: any[] = await buildEmailAttachments(rt, existing, job).catch(() => []);
          attachments = (all || []).filter((a: any) => /resume/i.test(a.filename || ""));
        }
      } catch (e: any) { console.error(`[intro] attach skipped: ${e.message}`); }
      const m = renderReferralFound({ email: from, contact: data.contact, company: data.company, roleTitle: data.roleTitle, mailtoUrl: data.mailto, gmailUrl: data.gmail, hasResume: attachments.length > 0 });
      try {
        const r = await sendGuarded({
          resend, email: from, template: "inbound:intro", dedupeKey: String(d.email_id || `${data.company}:${data.roleTitle}`),
          deps: { isSuppressed: replyAllowed },
          payload: {
            from: from_, to: from, subject: m.subject, html: m.html, text: m.text,
            ...(attachments.length ? { attachments } : {}),
            headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          },
        });
        console.error(`[inbound] intro ${r?.status} for ${from} (contact:${data.contact?.email}, att:${attachments.length})`);
      } catch (e: any) { console.error(`[intro] reply failed: ${e.message}`); }
      return;
    }

    // ── a pool member answering what their own work actually was ────────────────────────────────
    //
    // The reply is filed onto the person's own record, so what they sent describes them. It is
    // NON-TERMINAL: the person still
    // falls through to an ordinary human reply, because somebody who just wrote 2,000 words about
    // their work deserves an answer, not a receipt.
    //
    // It cannot break the handler. A filing failure is logged and the reply continues — the words are
    // still in inbound_messages and the reconciliation (scripts/evidence-reconcile.mjs) will find
    // anything that slipped.
    if (isEvidenceReply(subject)) {
      try {
        const r = await recordOwnWords({ email: from, subject, body, receivedAt: new Date().toISOString() });
        console.error(`[evidence] ${r.ok ? (r.key ? `filed ${r.chars} chars as "${r.key}"` : r.reason) : `NOT FILED (${r.reason})`} for ${from}`);
        noteInbound({ stage: "evidence", from, filed: Boolean(r.ok && r.key), chars: r.chars || 0 });
      } catch (e: any) { console.error(`[evidence] filing threw, reply continues: ${e.message}`); }
    }

    // ── [ask:<token>] — a candidate answering the one question their application left blank ─────
    //
    // The decision-ask email carries a signed marker in its subject, so a plain Reply brings it back
    // through the ONE door rather than needing a second inbound address. Same shape as gift-a-role's
    // [fref:] marker.
    //
    // WHAT THIS DOES AND DOES NOT DO. It files their words onto their own row on the client board,
    // verbatim, under the date. It does NOT move their score. A reply changes the evidence, and a
    // score is recomputed by a deliberate run that records what it saw — letting inbound mail move a
    // number on a paying client's board would mean a stranger could push somebody up it.
    //
    // IT FAILS CLOSED ON IDENTITY. The token is HMAC-signed and carries the address it was sent to;
    // if the person replying is not that address, the reply is logged and NOT filed, because the
    // board must never attribute one person's words to another.
    const askTok = (subject.match(/\[ask:([A-Za-z0-9._-]+)\]/) || body.match(/\[ask:([A-Za-z0-9._-]+)\]/) || [])[1] || null;
    const askPay: any = askTok ? readEvent(askTok) : null;
    if (askPay && askPay.b && askPay.e) {
      const intended = String(askPay.e).toLowerCase();
      if (intended !== from) {
        console.error(`[ask] NOT FILED: token was issued to ${intended} but the reply came from ${from}`);
      } else {
        try {
          const { fileCandidateReply } = await import("../lib/notion.mjs");
          const r: any = await fileCandidateReply(String(askPay.b), {
            email: from, name: existing?.name || "", asked: String(askPay.a || ""),
            reply: body, receivedAt: new Date().toISOString().slice(0, 10),
          });
          console.error(`[ask] ${r.ok ? (r.duplicate ? "already filed" : "filed") : `NOT FILED (${r.reason})`} for ${from}`);
          noteInbound({ stage: "ask", from, filed: !!r.ok, duplicate: !!r.duplicate });
        } catch (e: any) { console.error(`[ask] filing failed: ${e.message}`); }
      }
      // Fall through: they still get an ordinary human reply, because an answer deserves an answer.
    }

    // There is no prepare@ route: Charlie does not write CVs on demand. A prepare@ mail falls through
    // to the ordinary reply path and is answered like any other note, never silently dropped.
    // buildEmailAttachments is still used by intro@ (above) for the tailored RESUME in a warm intro.

    // check@ = the email-native honest read on a CV against ONE job (no full onboarding).
    // Needs a job (pasted or a link) and a resume (attached, or stored for an existing user).
    if (recipientLocalParts(d).some((lp) => /^check/.test(lp))) {
      let rt = resumeText;
      if (!rt && existing) rt = await getResume(from).catch(() => null);
      // gift-a-role: a [fref:<token>] (signEvent({e:giver, j:jobId})) means a friend is checking a role
      // that was gifted to them. Resolve the role from the pool (no pasted JD needed) + attribute the
      // fit-check to the giver + that role, best-effort/fail-open. Falls back to pasted/linked text.
      let jobText = "";
      const fref = (body.match(/\[fref:([A-Za-z0-9._-]+)\]/) || subject.match(/\[fref:([A-Za-z0-9._-]+)\]/) || [])[1] || null;
      const fp: any = fref ? readEvent(fref) : null;
      if (fp && fp.e && fp.j) {
        try { const job: any = await getPoolJob(fp.j); if (job) jobText = [job.title, job.company, job.location].filter(Boolean).join(" · ") + "\n\n" + String(job.description || job.job_summary || ""); } catch { /* fall through to pasted */ }
        recordReferralEvent({ giverEmail: fp.e, kind: "role_check", friendEmail: from, refCode: fref, jobId: String(fp.j) }).catch(() => {});
      }
      if (!jobText) jobText = (await fetchJobText(`${subject}\n\n${body}`)).text;
      noteInbound({ stage: "check", from, hasResume: !!rt, jobChars: jobText.length, gifted: !!fp });
      if (!jobText || jobText.length < 120) { await send(renderCheckNeedJob({ email: from })); return; }
      if (!rt) { await send(renderCheckNeedResume({ email: from })); return; }
      const result = await runCvCheck(rt, jobText).catch((e: any) => { console.error(`[check] ${e.message}`); return null; });
      if (!result) { await send(renderCheckNeedJob({ email: from })); return; }
      await send(renderCheckScorecard({ email: from, result }));
      return;
    }

    // track@ = the passive application tracker. Forward a company reply here; Charlie classifies
    // the stage (applied / rejected / interview / offer), logs it as a signal (rungs 2-3 of the
    // feedback ladder), matches it to the role it sent if it can, and acknowledges warmly.
    if (recipientLocalParts(d).some((lp) => /^track/.test(lp))) {
      // "Track this application" button: a self-initiated start (subject "Tracking: ..." or a
      // "ref: <email>:<jobId>" token in the body), not a forwarded company reply. Log it as
      // applied and prime them to forward future replies here.
      const trackRef = (body.match(/ref:\s*(\S+:\S+)/) || [])[1] || null;
      const isTrackingSubject = /^\s*(re:|fwd:)?\s*tracking:/i.test(subject);
      if (isTrackingSubject || trackRef) {
        // only trust the subject for the role when it's actually a "Tracking: <role>" subject
        const role = isTrackingSubject ? (subject.replace(/^\s*(re:|fwd:)?\s*tracking:\s*/i, "").trim() || null) : null;
        const jobId = trackRef && trackRef.includes(":") ? trackRef.slice(trackRef.indexOf(":") + 1) : null;
        await recordSignal({ email: from, findId: trackRef, jobId, event: "applied", meta: { role, source: "track-button" } }).catch(() => {});
        await advanceApplication({ email: from, findId: trackRef, role, stage: "applied", meta: { source: "user_tracked" } }).catch(() => {}); // temporal spine: remember it (evidence = they tapped track)
        noteInbound({ stage: "track", from, outcome: "tracking_started" });
        await send(renderTrackStarted({ email: from, role }));
        return;
      }
      const cls = await classifyForwardedReply(`${subject}\n\n${body}`).catch(() => null);
      noteInbound({ stage: "track", from, outcome: cls?.outcome, company: cls?.company, confidence: cls?.confidence });
      // Low confidence = we don't actually know what happened. Don't persist a stage or arm a
      // proactive nudge on a guess (that's how the nudge reads vague). Ask for the real email.
      if (!cls || cls.outcome === "other" || cls.confidence === "low") { await send(renderTrackAck({ email: from, outcome: "other" })); return; }
      let findId: string | null = null, jobId: string | null = null;
      try {
        const finds: any[] = await getFinds(from, { limit: 30 });
        const needle = (cls.company || "").toLowerCase().slice(0, 12);
        const hit = needle ? finds.find((f) => (f.job?.company || "").toLowerCase().includes(needle)) : null;
        if (hit) { findId = hit.id || (hit.job?.id ? `${from}:${hit.job.id}` : null); jobId = hit.job?.id || null; }
      } catch { /* company-level log is fine */ }
      const event = ({ applied: "applied", rejected: "rejected", interview: "interview", offer: "offer" } as any)[cls.outcome] || "heard_back";
      await recordSignal({ email: from, findId, jobId, event, meta: { company: cls.company || null, role: cls.role_title || null, source: "forward" } }).catch(() => {});
      // temporal spine: persist where this application now stands, so Charlie remembers it over time
      await advanceApplication({ email: from, findId, company: cls.company, role: cls.role_title, stage: event, meta: { source: "forward", confidence: cls.confidence, subject: subject.slice(0, 120) } }).catch(() => {});
      // arm a follow-up nudge only when we're CONFIDENT they applied (high confidence), so we never
      // nudge on a maybe. Fires a week out, and only if it's still quiet then.
      await send(renderTrackAck({ email: from, outcome: cls.outcome, company: cls.company, role: cls.role_title }));
      return;
    }

    // chase@ = reply-as-signal. The role email's Reply-To is chase+<signed find token>@...,
    // so "still chasing this one? just hit reply" lands here carrying the EXACT role. Log a `chasing`
    // signal (tier: committed).
    // If the token is missing or tampered, still record the intent with a null find_id + log it for
    // manual review (never drop a real signal). Fires only when a chase address was minted (REPLY_SIGNAL).
    //
    // IT DOES NOT RETURN. Returning here would swallow every reply to the role email, the most-sent
    // email Charlie has, and discard whatever the person wrote ("remote only from now on"). Recording a
    // signal is not a reason to stop reading someone's words: the signal is logged and the message
    // continues to the ordinary reply path, so a stated preference is applied and the person is
    // answered. Fenced by affordance-guards.test.mjs, which also
    // fences the de-quoting this fallthrough made necessary (see the applyEmailChange call below).
    if (recipientLocalParts(d).some((lp) => /^chase\+/i.test(lp))) {
      const lp = recipientLocalParts(d).find((x) => /^chase\+/i.test(x)) || "";
      const ref = findRefFromChase(lp);
      await recordSignal({ email: ref?.email || from, findId: ref?.findId ?? null, jobId: ref?.jobId ?? null, event: "chasing", meta: { source: "reply", resolved: !!ref } }).catch(() => {});
      noteInbound({ stage: "chase", from, resolved: !!ref, findId: ref?.findId || null });
      if (!ref) console.error(`[chase] unresolved chasing reply from ${from} — logged with null find_id for manual review`);
    }

    // ── an answer to "has anyone been in touch?" ────────────────────────────────────────────────
    //
    // TERMINAL, and it must be. An open ask otherwise gets renderAskAnswerAck, which tells the reader
    // their background is going to the hiring side "without your name on it". These people's names ARE
    // on a named client's board. Answering a status question with that sentence would be a second
    // wrong reply sent on top of the first.
    //
    // IT FORWARDS TO A HUMAN, because the whole reason for asking is that nobody can see this from the
    // outside. "They called me on Tuesday" is the only route that information has into the building,
    // and an ack that files it and tells no one would waste the answer.
    if (isCheckinReply(subject)) {
      try {
        const r = await recordOwnWords({ email: from, subject, body, receivedAt: new Date().toISOString() });
        console.error(`[checkin] record: ${r.ok ? (r.key ? `filed ${r.chars} chars` : r.reason) : `NOT FILED (${r.reason})`} for ${from}`);
      } catch (e: any) { console.error(`[checkin] filing threw, reply continues: ${e.message}`); }

      await sendMailTo(ALERT_TO(), {
        subject: `Pipeline answer from ${from}: ${subject}`,
        html: `<pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
        text: ownWords.slice(0, 6000),
      }).catch(() => {});

      noteInbound({ stage: "checkin", from });
      await send(renderCheckinNoted({ email: from, name: existing?.dossier?.name || existing?.name || "" }));
      return;
    }

    // ── a reply to a client-status mail ─────────────────────────────────────────────────────────
    //
    // TERMINAL ON PURPOSE, which is the opposite of the evidence branch above. Somebody who wrote
    // 2,000 words about their work deserves a human reply, so that branch falls through. These people
    // must NOT: they applied to one role through a form and are not enrolled in the matching product,
    // so the ordinary fall-through — renderAck — offers to change their PAY FLOOR and promises to
    // email them a role "the moment one's worth your time". Both describe a relationship they do not
    // have, in reply to something they took trouble over.
    //
    // That single fact is why `replyTo` on 191 of these mails pointed at a human mailbox instead, and
    // the cost of THAT was never counted: /inbound never saw the replies, so nothing filed them. Zero
    // client-status replies existed in inbound_messages while applicants were writing back. The fix is
    // this branch, not the routing — with it, `replyTo` goes back to Charlie and the loop closes.
    //
    // IT REPORTS WHERE THE WORDS ACTUALLY WENT. `filed` is what happened, never what was intended:
    // the client's page, their own record, or nothing (a "thanks!" below the floor). The ack says only
    // what is true of each, because an ack claiming "it is on your file" when it is not is this
    // month's recurring defect exactly — a step stops working and keeps reporting success.
    //
    // NOTHING HERE MAY THROW PAST THE ACK. A Notion outage must cost the stronger sentence, not the
    // reply: the person still gets answered, and the words are still in inbound_messages for
    // scripts/evidence-reconcile.mjs to find.
    if (isClientStatusReply(subject)) {
      let filed: "board" | "record" | "none" = "none";
      try {
        const r = await recordOwnWords({ email: from, subject, body, receivedAt: new Date().toISOString() });
        if (r.ok) filed = "record";
        console.error(`[client-status] record: ${r.ok ? (r.key ? `filed ${r.chars} chars` : r.reason) : `NOT FILED (${r.reason})`} for ${from}`);
      } catch (e: any) { console.error(`[client-status] record filing threw: ${e.message}`); }

      try {
        const { ownWords } = await import("../lib/own-words.mjs");
        const own = ownWords(body, from);
        // Same floor as the record. A two-word thanks does not belong on a paying client's board.
        if (own.length >= MIN_CHARS) {
          const { CLIENT_BOARDS } = await import("../lib/mandates.mjs");
          const { fileCandidateReply } = await import("../lib/notion.mjs");
          for (const b of CLIENT_BOARDS) {
            // Per-board isolation: one unreadable board must not cost them the others.
            try {
              const f: any = await fileCandidateReply(b.databaseId, {
                email: from, name: existing?.name || "", asked: "", reply: own,
                receivedAt: new Date().toISOString().slice(0, 10),
              });
              if (f?.ok) { filed = "board"; console.error(`[client-status] board ${b.key}: ${f.duplicate ? "already filed" : "filed"} for ${from}`); }
            } catch (e: any) { console.error(`[client-status] board ${b.key} failed: ${e.message}`); }
          }
        }
      } catch (e: any) { console.error(`[client-status] board filing threw: ${e.message}`); }

      noteInbound({ stage: "client-status", from, filed });
      await send(renderClientReplyAck({ email: from, name: existing?.name || "", filed }));
      return;
    }

    // There is no "reply status" route: Charlie is not a dashboard — it reads the market and sends one
    // role. A "status" reply falls through to the ordinary reply path and is answered there.
    // getApplications is still imported: the follow-up nudge sweep below reads it.

    // The onboarding build FAILED for a NEW person who DID send a resume (a model/infra outage such as
    // exhausted API credit, or a resume we can't ground yet). Replying "send me your resume" would
    // blame them for our outage and leave them in no store at all. Instead: record them, KEEP the resume, tell them
    // honestly it'll take a moment, and queue a retry (onboard_retry in runTaskSweep) that re-grounds
    // from the saved resume once the outage clears. Only after the retry keeps failing do we ask them
    // to resend. A failure becomes recoverable, not a silent loss.
    const onboardBuildFailed = async () => {
      await recordFirstContact(from).catch(() => {});
      if (resumeText) await uploadResume(from, resumeText).catch(() => {}); // keep it so the retry needs no user action
      await scheduleTask({ email: from, kind: "onboard_retry", runAt: Date.now() + 10 * 60_000, payload: { attempt: 1, subject, body } }).catch(() => {});
      noteInbound({ stage: "onboard", from, outcome: "queued_retry" });
      await send(renderBuildDelayed({ email: from }));
    };

    // A SECURITY / vulnerability report is not a sign-up. Without this, a stranger with no resume
    // falls into the onboarding branch below and is told "send me your resume" — the exact wrong
    // reply to a researcher doing responsible disclosure. Detect it deterministically (no model),
    // forward the full report to a human (ALERT_EMAIL), and STOP: NO auto-reply (a canned bot reply
    // to a security contact reads worse than a human one — the owner replies personally) and NO
    // onboarding side effects (no first-contact row, no build). Gated to the exact mis-onboarded
    // population (new sender, no resume) so existing users' mail is untouched. The forward routes
    // through sendGuarded so a webhook replay cannot double-forward (dedupe on the inbound
    // email_id) and the owner address's suppression is still honoured.
    // PRO INTEREST — someone clicked "I'm interested" on the role email's Pro block. Matched on the
    // SAME exported subject string the button prefills (PRO_SUBJECT, render-email.mjs), never a copy
    // that could drift. Recorded as a signal and answered with a short note that sells nothing: the
    // block promises "nothing to pay, nothing to sign up for", and this is where that stays true.
    //
    // Placed BEFORE the onboarding/reply routing on purpose. Without it, "Yes, I'd use this. The one
    // I want most: cover letter" reaches applyEmailChange and gets written into their preferences as
    // a stated wish about ROLES — a real fact about the person, invented from a button click.
    // "I'M INTERESTED" on the represent offer.
    //
    // Before the generic routing, like every other button reply. Without it "Yes, put me on it"
    // reaches applyEmailChange and a model reads it as a statement about the kind of ROLE they want —
    // a preference invented out of a button we asked them to press.
    //
    // The answer is not a thank-you. It is the two or three facts Charlie still cannot answer for
    // them, chosen from their OWN record, in the order a headhunter asks. Three at most: eight
    // questions read as homework and get nothing back.
    if (new RegExp(`^\\s*(re:|fwd:)?\\s*${REPRESENT_SUBJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(subject)) {
      const missing = representMissing(existing?.dossier);
      await recordSignal({ email: from, event: "represent_interest", meta: { missing: missing.map((m: any) => m.key) } }).catch(() => {});
      console.error(`[represent] interest from ${from} — missing: ${missing.map((m: any) => m.key).join(", ") || "nothing"}`);
      noteInbound({ stage: "represent_interest", from, missing: missing.length });
      await send(renderRepresentAsk({ email: from, name: existing?.dossier?.name || "", missing }));
      return;
    }

    // PAUSE / RESTART — the only control a person has that is not permanent.
    //
    // Before every other reply branch, because these are the shortest messages a person sends and the
    // generic path would read "pause" as a preference to fold into their profile.
    //
    // STRICT ON PURPOSE (lib/pause-command.mjs): the message must be essentially JUST the command.
    // Failing to spot a real "pause" costs one more email and they can say it again; wrongly spotting
    // one silences somebody mid-conversation who may never learn why the roles stopped.
    {
      const cmd = parsePauseCommand(stripQuotedLines(body || "") || body);
      if (cmd && existing) {
        if (cmd.kind === "pause") {
          await setCandidateStatus(from, "paused");
          if (cmd.days) {
            // A timed pause un-pauses itself. Without this, "pause 2 weeks" is an indefinite pause
            // with a promise attached, and the promise is the part people remember.
            await scheduleTask({ email: from, kind: "unpause", runAt: Date.now() + cmd.days * 86400000, payload: { days: cmd.days } }).catch(() => {});
          }
          await recordSignal({ email: from, event: "paused", meta: { days: cmd.days } }).catch(() => {});
          noteInbound({ stage: "pause", from, days: cmd.days });
          await send(renderPaused({ email: from, name: existing?.dossier?.name || "", days: cmd.days }));
          return;
        }
        // RESUME. Deliberately does NOT un-suppress: a person who unsubscribed opted out of mail
        // entirely, and reversing that on a one-word reply would re-subscribe someone the sending
        // domain has already recorded as opted out. Pause and unsubscribe are different doors.
        //
        // WHICH MEANS AN UNSUBSCRIBED PERSON MUST NOT BE TOLD "back on". Flipping them to active while
        // suppression still blocks every send is a promise Charlie cannot keep, and they would never
        // learn why nothing arrived. They need
        // the re-opt-in flow, which is a deliberate consent step, so say nothing here and let the
        // ordinary path handle it.
        if (await isSuppressed(from)) {
          noteInbound({ stage: "resume", from, outcome: "suppressed-no-op" });
          console.error(`[pause] ${from} asked to restart but is suppressed — needs re-opt-in, not a status flip`);
          return;
        }
        await setCandidateStatus(from, "active");
        await recordSignal({ email: from, event: "resumed", meta: {} }).catch(() => {});
        noteInbound({ stage: "resume", from });
        const stats: any = await loadJobPoolStats().catch(() => null);
        await send(renderResumed({ email: from, name: existing?.dossier?.name || "", poolSize: stats?.roles ?? null }));
        return;
      }
    }

    // DEPTH ANSWER — the reply to "About your last few roles" (depth-question.mjs).
    //
    // Before the generic routing, same reason as the two blocks below it. This one matters MORE: the
    // answer is literally about a skill ("yes, ran it in production for two years"), so the generic
    // path would read it as a preference edit and write a claim about the person from a sentence we
    // prompted. The whole point of asking rather than assuming would be undone at the last step.
    //
    // Stored verbatim and NOT parsed into the dossier here. Folding a claimed skill into a person's
    // grounded record is a writeback decision with its own verifier (applyEmailChange's tiered,
    // grounded path), and doing it from a raw reply would put an unverified claim in the record that
    // the send-time verifier then treats as truth.
    // ROLE-QUESTION REPLY — the answer to the one grounded question in a role email
    // (lib/role-ask.mjs). Placed here for the SAME reason as the depth-question block below it: the
    // answer is about a skill ("yes, ran on-call for two years"), and the generic path would read it
    // as a preference edit and write a claim about the person from a sentence we prompted.
    //
    // Recorded verbatim and NOT parsed into the dossier here, then FALLS THROUGH deliberately so
    // applyEmailChange's tiered, grounded writeback still runs and can fold it in properly. The signal
    // is the measurement; the writeback is the grounding, and each does only its own job.
    if (/^\s*(re:|fwd:)?\s*(this .+ (role|looks like)|found one worth|a .+ role worth)/i.test(subject)) {
      const answer = stripQuotedLines(body || "").trim().slice(0, 600) || stripQuotedReply(body || "").slice(0, 600);
      if (answer) {
        await recordSignal({ email: from, event: "role_question_answered", meta: { answer, subject } }).catch(() => {});
        console.error(`[role-ask] answer from ${from}: ${answer.replace(/\s+/g, " ").slice(0, 90)}`);
        noteInbound({ stage: "role_answer", from, chars: answer.length });
      }
      // fall through to the grounded writeback below
    }

    if (/^\s*(re:|fwd:)?\s*about your last few roles/i.test(subject)) {
      const answer = stripQuotedLines(body || "").trim().slice(0, 600) || stripQuotedReply(body || "").slice(0, 600);
      await recordSignal({ email: from, event: "depth_question_answered", meta: { answer, subject } }).catch(() => {});
      console.error(`[depth-q] answer from ${from}: ${answer.replace(/\s+/g, " ").slice(0, 90)}`);
      noteInbound({ stage: "depth_answer", from, chars: answer.length });
      // Fall THROUGH deliberately: the answer is also a real fact about them, so the ordinary grounded
      // writeback still runs and can fold it in properly. The signal above is the measurement; the
      // writeback below is the grounding, and each does only its own job.
    }

    // OUTCOME REPLY — the answer to "Did the <company> role end with you?" (outcome-probe.mjs).
    //
    // Placed BEFORE the generic reply routing for the same reason the Pro block is: without it, "no,
    // never heard back" reaches applyEmailChange and a model reads it as a statement about what this
    // person WANTS. An answer about one employer would become a preference in their profile, invented
    // from a question we asked: an upgraded claim created by our own follow-up.
    //
    // Matched on the subject Charlie itself sent. The reply is recorded verbatim and NOT interpreted
    // here: turning "they went with someone internal" into a structured outcome is a later, separate
    // judgement, and storing the raw words keeps that honest.
    if (/^\s*(re:|fwd:)?\s*did the .+ role end with you\?/i.test(subject)) {
      const answer = stripQuotedLines(body || "").trim().slice(0, 600) || stripQuotedReply(body || "").slice(0, 600);
      await recordSignal({ email: from, event: "outcome_reported", meta: { answer, subject } }).catch(() => {});
      console.error(`[outcome] reply from ${from}: ${answer.replace(/\s+/g, " ").slice(0, 90)}`);
      noteInbound({ stage: "outcome_reply", from, chars: answer.length });
      // No auto-reply. They answered a question we asked; thanking them by machine would be noise, and
      // a wrong or eager reply here is worse than silence.
      return;
    }

    if (new RegExp(`^\\s*(re:|fwd:)?\\s*${PRO_SUBJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(subject)) {
      const wanted = stripQuotedReply(body || "").slice(0, 400);
      await recordSignal({ email: from, event: "pro_interest", meta: { wanted, subject } }).catch(() => {});
      console.error(`[pro] interest from ${from}: ${wanted.replace(/\s+/g, " ").slice(0, 90)}`);
      noteInbound({ stage: "pro_interest", from, chars: wanted.length });
      await send(renderProInterest({ email: from, name: existing?.dossier?.name || "" }));
      return;
    }
    if (!existing && !resumeText && isSecurityReport(subject, body)) {
      const owner = process.env.ALERT_EMAIL || process.env.CHARLIE_TO || OWNER_EMAIL;
      noteInbound({ stage: "security", from, subject: subject.slice(0, 80), auth: auth.verdict });
      const escH = (t: any) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const fwdText = `Security report received at start@ (NOT auto-replied; reply to the sender yourself).\n\n`
        + `From: ${from}\nSender auth: ${auth.verdict}${auth.raw ? ` (${auth.raw})` : ""}\nSubject: ${subject}\n\n${body}`;
      const fwdHtml = `<p><strong>Security report received at start@</strong> (not auto-replied; reply to the sender yourself).</p>`
        + `<p><strong>From:</strong> ${escH(from)}<br><strong>Sender auth:</strong> ${escH(auth.verdict)}<br><strong>Subject:</strong> ${escH(subject)}</p>`
        + `<hr><pre style="white-space:pre-wrap;font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${escH(body)}</pre>`;
      try {
        const r = await sendGuarded({
          resend, email: from, to: owner, template: "security-forward",
          dedupeKey: String(d.email_id || subject || from),
          idempotencyKey: `security-forward/${d.email_id || from}`,
          deps: { isSuppressed: replyAllowed }, // an owner alert must survive an unsubscribe (a hard bounce/complaint still blocks)
          payload: { from: from_, to: owner, replyTo: from, subject: `[security] report from ${from}`.slice(0, 180), html: fwdHtml, text: fwdText },
        });
        console.error(`[inbound] security report from ${from} forwarded to ${owner}: ${r?.status}`);
      } catch (e: any) { console.error(`[inbound] security forward failed: ${e.message}`); }
      return;
    }

    // First reply, no resume attached. Resume is OPTIONAL: if the person wrote a real bio, ground the
    // profile from THEIR OWN WORDS (promote it to the grounding source and fall through to the same
    // grounded, fail-closed build path below — v2 interrogation or v1 build; their words are CLAIM-tier,
    // nothing invented). Only when the body is too thin to ground anything do we ask (renderMissingResume,
    // which now invites a resume OR a few lines) — so "no resume needed" is never a broken promise. The
    // security-report gate above already ran, so a report's prose can never be mis-onboarded here.
    // Record the contact BEFORE the ask reply: a person with no candidates row exists in no store at all,
    // so without this a real person who wrote in, got answered, would leave no trace to count or follow up.
    if (!existing && !resumeText) {
      const bio = substantiveBio(body);
      // ASK BEFORE BUILDING. They wrote real words, but not enough to build a profile on and then speak
      // about their market with confidence. Ask ONE thing and wait. No dossier, no candidate row, no
      // market read — nothing that would have Charlie sounding certain about someone he has not met.
      // A day-3 follow-up is scheduled on the existing task sweep so this cannot become silence.
      if (bio && tooThinToBuild(bio)) {
        await recordFirstContact(from).catch(() => {});
        noteInbound({ stage: "ask_first", from, bioChars: bio.length });
        console.error(`[ask-first] ${from}: ${bio.length} chars, asking for one specific instead of building`);
        await scheduleTask({ email: from, kind: "ask_first_nudge", runAt: Date.now() + 3 * 24 * 60 * 60 * 1000, payload: { chars: bio.length } }).catch(() => {});
        await send(renderTellMeMore({ email: from }));
        return;
      }
      if (bio) {
        resumeText = bio;
        noteInbound({ stage: "bio_onboard", from, bioChars: bio.length });
        console.error(`[inbound] onboarding from bio (${bio.length} chars, no resume attached): ${from}`);
        // fall through to the v2/v1 onboarding build below (resumeText now holds their bio)
      } else {
        const isNew = await recordFirstContact(from);
        console.error(`[inbound] first contact ${isNew ? "recorded" : "already waiting"}: ${from}`);
        await send(renderMissingResume({ email: from }));
        return;
      }
    }
    // v2 cohort only, gated by ONBOARDING_V2: a NEW person begins the interrogation loop instead
    // of the one-shot below — ground from the resume, walk the journey into `interrogating`, and ask the
    // FIRST grounded question. NO first role fires yet (delivery comes after the loop completes). v1 is
    // byte-identical: this whole block is skipped unless the flag is on. Fails closed like v1 on a bad resume.
    if (resumeText && !existing && onboardingV2Enabled()) {
      let started: { dossier: any; question: string } | null = null;
      try {
        started = await startInterrogation(from, resumeText, `${subject}\n\n${body}`, extraDocs);
      } catch (e: any) {
        console.error(`[interro] start failed for ${from}: ${e.message}`);
        noteInbound({ stage: "interro_start", from, outcome: "build_failed", error: String(e?.message || e) });
      }
      if (!started?.dossier) { await onboardBuildFailed(); return; }
      const dossier = started.dossier;
      // Walk null -> received -> ack -> interrogating. The received/ack watchdogs go stale the instant
      // state moves on and no-op by the unchanged-guard (by design); a crash mid-walk is
      // still self-healing (the received watchdog auto-advances). enterState needs the row saved above.
      await enterState(from, "received").catch((e: any) => console.error(`[interro] received: ${e.message}`));
      await enterState(from, "ack").catch(() => {});
      await enterState(from, "interrogating").catch((e: any) => console.error(`[interro] interrogating: ${e.message}`));
      noteInbound({ stage: "interro_start", from, outcome: "asked", hasQ: !!started.question });
      if (started.question) {
        await askOne(dossier, { first: true, question: started.question, state: "interrogating", batchN: 1, journeyId: await journeyIdFor() });
      } else {
        // Already-complete profile at signup (nothing to ask) — skip straight to the payoff.
        await completeInterro(dossier);
      }
      return;
    }
    // Resume in hand for a NEW person: build the grounded profile, confirm what to expect, then fire
    // the first matched role now so "within minutes" is real (best-effort, never blocks).
    // GUARD (data-loss + tenant integrity): only a NEW user (no existing profile) is built from a
    // fresh resume. For an EXISTING user, a full rebuild would DISCARD everything added since (proofs,
    // strengths, headline, work history from later replies) — and, on a spoofed `From`, would let a
    // stranger overwrite a real user's grounded profile. Existing users route to the additive path
    // below (their re-sent resume is refreshed in storage for tailoring, never used to wipe the dossier).
    if (resumeText && !existing) {
      // G3 — ONBOARDING ACKNOWLEDGED-OR-TOLD: onboarding must NEVER end in silence. onboardFromEmail
      // throws for two DIFFERENT reasons, and they get opposite treatment:
      //   `code:"ungrounded"` — the build worked and found nothing to ground (not a job search).
      //      Retrying cannot help, so: no candidate row, no retry, the honest ask. See the catch below.
      //   anything else       — the build FAILED (model/infra outage, unreadable resume). Route to
      //      onboardBuildFailed (record + keep resume + honest "give me a few minutes" + queued retry).
      // Either way we catch here rather than dropping into the outer catch, which sends nothing.
      let dossier: any = null;
      let ungrounded = false;
      try {
        dossier = await onboardFromEmail(from, resumeText, `${subject}\n\n${body}`, extraDocs);
      } catch (e: any) {
        // NOT A JOB SEARCH: the build grounded nothing, so there is no person here to
        // serve. This is NOT a build failure — retrying spends three more Opus builds and grounds
        // nothing again — so it must not reach onboardBuildFailed. No candidate row is written, which
        // is what keeps them out of the daily role and every drip. They stay in first
        // contact and get the honest ask, so a real person whose resume simply didn't extract still
        // has a way in (onboarding never ends in silence).
        ungrounded = e?.code === "ungrounded";
        console.error(`[inbound] onboarding ${ungrounded ? "grounded NOTHING (not a job search)" : "build failed"} for ${from}: ${e.message}`);
        noteInbound({ stage: "onboard", from, outcome: ungrounded ? "ungrounded" : "build_failed", error: String(e?.message || e) });
      }
      if (ungrounded) {
        // THREE different people land here and they need different replies. The decision is in
        // lib/ungrounded-reply.mjs, pure and unit-tested, because this is the branch that decides
        // whether a human hears "tell me more" or "this is not the right address".
        //
        // Branching on the attachment alone is wrong: "no attachment" is true of spam and equally true
        // of somebody who wrote what they want instead of where they worked, and a real person must
        // never be told on FIRST contact that they have the wrong address.
        //
        // `recordFirstContact` RETURNS whether this address was new; that return is the whole signal. Fail-safe on error: assume first contact, i.e. ask rather than
        // decline, because the cost of asking a spammer once is nothing.
        const isFirstContact = await recordFirstContact(from).catch(() => true);
        const reply = replyForUngrounded({ triedToSendADoc: atts.length > 0, isFirstContact });
        // LEAVE A TRACE. A decline writes no candidate row and no task, and the host keeps only the
        // current container's logs. Any path that tells a human "I cannot help you" has to be countable.
        await recordSignal({ email: from, event: "onboard_ungrounded", meta: { reply, first_contact: isFirstContact, attachments: atts.length, chars: String(body || "").length } }).catch(() => {});
        console.error(`[inbound] ungrounded ${from}: reply=${reply} first_contact=${isFirstContact} atts=${atts.length}`);
        noteInbound({ stage: "ungrounded", from, outcome: reply });
        if (reply === "missing_resume") await send(renderMissingResume({ email: from }));
        else if (reply === "tell_me_more") await send(renderTellMeMore({ email: from }));
        else await send(renderNotJobSearch({ email: from }));
        return;
      }
      if (!dossier) { await onboardBuildFailed(); return; }
      const name = dossier?.name || "";
      // G6 — THIN-DOSSIER HONESTY: pass thin=true when the built profile is genuinely sparse (no
      // verifiable proof points, or no role/region to aim at) so the welcome asks for a bit more
      // rather than overpromising sharp matches. Deterministic (isThinDossier), never guessed.
      const thin = isThinDossier(dossier);
      // The welcome opens the conversation: grounded strength + ONE next question (highest-leverage gap).
      const gap = nextGap(dossier);
      await send(renderWelcome({ email: from, name, thin, ask: gap?.ask || "", strength: topStrength(dossier) }));
      if (gap) await mergeEmailConfig(from, { last_gap_drip_at: new Date().toISOString() }).catch(() => {}); // collision-guard vs the timed nudge
      await briefingThenScheduleRole(from); // #2 briefing now, #3 first role on day-2
      return;
    }
    // v2 cohort only: an existing v2 user mid-interrogation continues the loop — fold the answer
    // in (grounded writeback), then either ask the next grounded question (flipping interrogating<->
    // needs_input to reset the nudge timer) or complete into the first role. v1 users never match
    // this guard (no meta.onboarding, no journey), so they fall through to the byte-identical path below.
    const st = currentState(existing);
    if ((existing as any)?.meta?.onboarding === "v2" && (st === "interrogating" || st === "needs_input" || (st === "parked" && (existing as any)?.meta?.interro?.active))) {
      if (resumeText) await uploadResume(from, resumeText).catch(() => {}); // refresh stored copy, never rebuild
      const res = await continueInterrogation(from, `${subject}\n\n${body}`).catch((e: any) => { console.error(`[interro] continue failed ${from}: ${e.message}`); return null; });
      if (!res) { await send(renderAck({ email: from })); return; } // never silent
      noteInbound({ stage: "interro_reply", from, done: res.done, from_state: st });
      if (res.done) {
        await completeInterro(res.dossier);
      } else if (res.question) {
        const to = st === "interrogating" ? "needs_input" : "interrogating"; // flip resets the 60h timer (parked -> interrogating)
        await enterState(from, to).catch((e: any) => console.error(`[interro] flip ${to}: ${e.message}`));
        const batchN = Number(res.dossier?.meta?.interro?.batches) || 1;
        await askOne(res.dossier, { first: false, changedText: res.changed.length ? friendlyChanges(res.changed) : "", question: res.question, state: to, batchN, journeyId: await journeyIdFor() });
      } else {
        await completeInterro(res.dossier); // no question but not done — complete safely (never loop/dead-end)
      }
      return;
    }
    // Existing user (with or without a new resume): fold the note into their profile (prefs + grounded
    // background), then advance the conversation one turn — ack what changed and ask the ONE next gap.
    // But only while it still makes sense: once a role has cleared their bar, Charlie stops asking
    // (delivery replaces asking), and it never asks more than the one thing.
    // If they attached a fresh resume, refresh the STORED copy (used for tailoring) — but never rebuild
    // the dossier from it: additive only, so nothing they've added since is silently discarded.
    if (resumeText) await uploadResume(from, resumeText).catch(() => {});

    // Part 4 — the game-plan modify loop. Self-gates on plan_sent_at (a non-plan user falls straight
    // through). A stated change routes ONLY through the safe search-parameter writeback
    // (applyPlanReply -> applyPrefsOnly), never the correction path, then re-sends the updated plan. A
    // reply that is neither an affirmation nor a parameter change returns "not-applicable", so we fall
    // through to the generic path below where a new fact/correction is handled as before.
    const planOutcome = await applyPlanReply(from, `${subject}\n\n${body}`).catch((e: any) => { console.error(`[game-plan] reply failed ${from}: ${e.message}`); return null; });
    if (planOutcome?.kind === "acknowledged") {
      // A bare "ok"/"yes". Charlie already has everything it needs and the day-2 role is scheduled, so
      // it acknowledges SILENTLY and gets on with the work rather than mailing back a content-free
      // confirmation. Returning here is also what keeps a stray affirmation out of applyEmailChange.
      noteInbound({ stage: "plan_reply", from, outcome: "acknowledged" });
      return;
    }
    if (planOutcome?.kind === "modified") {
      noteInbound({ stage: "plan_reply", from, outcome: "modified", changed: planOutcome.changed });
      await send(renderGamePlan({ email: from, name: planOutcome.name, positioning: "", params: planOutcome.params, note: "I adjusted where I'm looking." }));
      return;
    }

    // DE-QUOTE BEFORE THE WRITEBACK (never ground a claim about a person in someone else's text). applyEmailChange feeds its input to BOTH
    // extractPrefs and ingestUrls, and `material` (their words + fetched pages) is the corpus
    // writebackIsGrounded checks a conversation-tier proof against. A Gmail reply quotes the entire
    // email being answered — and since the chase branch above falls through, that quote is
    // routinely a ROLE EMAIL: the job's location, level, pay, company and its apply URL. Left raw,
    // the quoted JOB's location or pay could be read as the PERSON's stated preference, and the
    // crawled JD could ground a claim about them. Both are contamination of the person's record.
    // stripQuotedLines, NOT stripQuotedReply: the latter truncates at the first quote marker, so a
    // bottom-posted "actually make it remote only" collapses to the attribution line — non-empty, so
    // a `|| body` fallback never fires and the real instruction is lost. This drops quoted lines
    // wherever they sit and keeps the person's own words above OR below them.
    const ownWords = stripQuotedLines(body) || body;

    // AN ANSWER TO OUR OWN QUESTION IS NOT A PREFERENCE STATEMENT EITHER (lib/open-ask.mjs).
    //
    // This runs BEFORE the question guard, because a reply to something we asked is an answer whether
    // or not it is phrased as a question, and it must not reach applyEmailChange in either case.
    //
    // An ask sent by a hand-run script is recorded (open asks), so the handler knows which conversation
    // a reply belongs to rather than treating an answer as a preference edit.
    //
    // It is deliberately blunt: inside the window, ANY inbound from somebody with an open ask goes to
    // a human. That will sometimes forward a message that did not need forwarding, which costs one
    // person one read. The other error costs a stranger's trust.
    try {
      const ask = await openAskFor(from, { recentAsks });
      if (ask.open) {
        // ── an answer to "would you like me to put you forward? reply yes or no" ─────────────────
        //
        // TERMINAL, AND IT HAS TO BE. The generic ack below tells the reader "I am taking the shape
        // of your background to the hiring side... I will come back to you with what I hear". The
        // invitation told them the opposite: "no is the right answer and it costs you nothing", and
        // "if I do not hear back, nothing happens". Sending that ack to somebody who declined would
        // answer a person who did exactly what was asked by telling them it cost them the thing they
        // just refused. client-checkin needed its own branch for the same reason; a registry entry
        // without one is half the change, and the half that shows up in a stranger's inbox.
        //
        // THE CLASSIFIER DECIDES THE COPY, NOT THE OUTCOME. yes / no / unclear only chooses which
        // three sentences they read. Nobody is put in front of a client by this handler: that is a
        // person reading the forward below and acting on it.
        // ── an answer to the role mailer: are you still looking, and do you have an offer ────────
        //
        // TERMINAL, for the same reason every other ask is. The generic ack tells the reader their
        // background is going to the hiring side, which is not what they were asked and not what
        // they answered.
        //
        // ONE MESSAGE CARRIES SEVERAL FACTS. "Open, and I have an offer, but this one is too junior"
        // is three, and readSeekingReply returns a set rather than a label so none is thrown away.
        // A `stop` beats an `open` in the same message: the one error this must never make is to
        // keep mailing somebody who asked us not to.
        //
        // WRITES ONLY WHAT THEY SAID. recordSeeking leaves every unmentioned field alone, because a
        // blank means "not asked or not answered" and must never harden into "no".
        if (ask.template === "role-match") {
          const r = readSeekingReply(body, from);
          const today = new Date().toISOString().slice(0, 10);
          await recordSeeking({
            email: from, open: r.open, stop: r.stop,
            offerText: r.offer ? r.excerpt : "",
            until: r.open ? seekingUntil(today) : null,
          }).catch(() => {});
          console.error(`[role-match] ${from} -> ${r.signals.join("+") || "nothing recognised"}`);
          noteInbound({ stage: "role_match_reply", from, signals: r.signals.join("+") || "none" });
          // A person sees every reply. The wrong-role reason is the only feedback we get on matching
          // quality, and an offer is time-sensitive to the point of being useless a week later.
          await sendMailTo(ALERT_TO(), {
            subject: `Role mailer: ${r.signals.join(" + ") || "unclear"} from ${from}`,
            html: `<p><b>${esc(r.signals.join(" + ") || "nothing recognised")}</b></p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
            text: `${r.signals.join(" + ") || "nothing recognised"}\n\n${ownWords.slice(0, 6000)}`,
          }).catch(() => {});
          await send(renderSeekingNoted({ email: from, name: existing?.dossier?.name || "", open: r.open, stop: r.stop, offer: r.offer, unclear: r.needsHuman }));
          return;
        }

        if (ask.template === "role-invite") {
          const verdict = classifyInviteReply(body, from);
          console.error(`[role-invite] ${from} answered ${verdict.answer}: ${verdict.excerpt.slice(0, 80)}`);
          noteInbound({ stage: "role_invite_answer", from, answer: verdict.answer });
          // The whole point of asking was to learn something nobody can see from the outside, so a
          // human sees every answer, including the ones the classifier read confidently.
          await sendMailTo(ALERT_TO(), {
            subject: `Role invite: ${verdict.answer.toUpperCase()} from ${from}`,
            html: `<p>Classified <b>${esc(verdict.answer)}</b>. Their words:</p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
            text: `Classified ${verdict.answer}.\n\n${ownWords.slice(0, 6000)}`,
          }).catch(() => {});
          await send(renderInviteAnswer({ email: from, name: existing?.dossier?.name || existing?.name || "", answer: verdict.answer }));
          return;
        }

        // ── an answer to the role-intent mail: looking, interested, may I take the next step ──────
        //
        // TERMINAL, for the same reason as the two above. NOTHING IS CLASSIFIED: three questions get
        // mixed answers, and filing "yes, but not five days on site" as a yes would be consent the
        // person never gave. One acknowledgement that is true of every answer, and a person reads
        // their words. Nobody is put in front of a client by this handler.
        if (ask.template === "role-intent") {
          console.error(`[role-intent] ${from} answered`);
          noteInbound({ stage: "role_intent_answer", from });
          await sendMailTo(ALERT_TO(), {
            subject: `Role intent: answer from ${from}`,
            html: `<p>Asked ${esc(ask.asked_at || "recently")}. Their words:</p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
            text: `Asked ${ask.asked_at || "recently"}.\n\n${ownWords.slice(0, 6000)}`,
          }).catch(() => {});
          await send(renderIntentAnswer({ email: from, name: existing?.dossier?.name || existing?.name || "" }));
          return;
        }

        // ── answers to the questions that followed a yes: deal size, targets, who they sold to ────
        //
        // TERMINAL, like every ask. THEIR WORDS ARE FILED ON THEIR OWN RECORD FIRST, through the one
        // writer (lib/evidence-record.mjs), because these answers are the evidence a submission
        // stands on and a reply that is only forwarded lives in one inbox. Filing cannot break the
        // handler: a failure is logged, the forward and the acknowledgement still happen, and the
        // words are in inbound_messages either way.
        //
        // IT DECIDES NOTHING. Whether somebody is put forward is a person's call after reading this.
        if (ask.template === "role-questions") {
          let filed = "not filed";
          try {
            const r: any = await recordOwnWords({ email: from, subject, body, receivedAt: new Date().toISOString() });
            filed = r.ok ? (r.key ? `filed ${r.chars} chars` : String(r.reason)) : `not filed (${r.reason})`;
          } catch (e: any) { filed = `filing threw: ${e.message}`; }
          console.error(`[role-questions] ${from} answered — ${filed}`);
          noteInbound({ stage: "role_questions_answer", from, filed });
          await sendMailTo(ALERT_TO(), {
            subject: `Role questions: answers from ${from}`,
            html: `<p>Asked ${esc(ask.asked_at || "recently")}. On their record: ${esc(filed)}. Their words:</p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
            text: `Asked ${ask.asked_at || "recently"}. On their record: ${filed}.\n\n${ownWords.slice(0, 6000)}`,
          }).catch(() => {});
          await send(renderQuestionsAnswer({ email: from, name: existing?.dossier?.name || existing?.name || "" }));
          return;
        }

        // ── a reply to "where this stands": usually thanks, sometimes a question. A person reads it. ──
        if (ask.template === "role-hold") {
          console.error(`[role-hold] ${from} wrote back`);
          noteInbound({ stage: "role_hold_reply", from });
          await sendMailTo(ALERT_TO(), {
            subject: `Role hold: reply from ${from}`,
            html: `<p>Told ${esc(ask.asked_at || "recently")} that we are holding. Their words:</p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
            text: `Told ${ask.asked_at || "recently"} that we are holding.\n\n${ownWords.slice(0, 6000)}`,
          }).catch(() => {});
          await send(renderHoldAnswer({ email: from, name: existing?.dossier?.name || existing?.name || "" }));
          return;
        }

        noteInbound({ stage: "ask_answer", from, template: ask.template || "unknown", why: ask.reason });
        console.error(`[inbound] ${from} is answering ${ask.template || "an ask"} (${ask.reason}) — no preference write`);
        await send(renderAskAnswerAck({ email: from, name: existing?.dossier?.name || "" }));
        // The answer itself is the whole point of having asked, so a person must actually see it.
        await sendMailTo(ALERT_TO(), {
          subject: `Answer from ${from} (${ask.template || "ask"})`,
          html: `<p>Asked ${ask.asked_at || "recently"} via <b>${esc(ask.template || "?")}</b></p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
          text: `Asked ${ask.asked_at || "recently"} via ${ask.template || "?"}\n\n${ownWords.slice(0, 6000)}`,
        }).catch(() => {});
        return;
      }
    } catch (e: any) {
      // Fail closed: if we cannot tell whether an ask is open, do not run the preference writer.
      console.error(`[inbound] open-ask check failed for ${from}: ${e.message} — handing to a human`);
      await sendMailTo(ALERT_TO(), {
        subject: `Inbound from ${from} (could not check for an open ask)`,
        html: `<pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
        text: ownWords.slice(0, 6000),
      }).catch(() => {});
      return;
    }

    // A QUESTION IS NOT A PREFERENCE STATEMENT (lib/inbound-question.mjs).
    //
    // Everything below this point feeds applyEmailChange, which reads a message as "change what you
    // are looking for" and answers by confirming what it changed. That is right for "actually make it
    // remote only" and badly wrong for "is it applied?": a question would get a confirmation of a
    // preference change, and worse, be fed to a writer that puts facts INTO the person's profile, so
    // asking could change what Charlie believes about them.
    //
    // So a question never reaches the writer. It is answered if the answer is the same for everybody
    // and depends on no fact about them, and otherwise handed to a person, out loud.
    /**
     * ONE CONVERSATIONAL TURN: what they said, in the light of what we said, answered from the record.
     *
     * Entered for a question, and for a short acceptance or refusal of something we just offered,
     * because "yes" is a turn in a conversation and carries no meaning on its own. Everything else is
     * untouched and still routes exactly where it did before.
     *
     * EVERY EXIT IS THE FALLBACK. No role, no fact, an out-of-bounds request, a rejected reply,
     * a repeat, or any error: all return null and the caller runs the human fallback that was always
     * there. This can make Charlie quieter than it could have been. It cannot make it wrong.
     */
    const conversationalTurn = async (addr: string, words: string, subj: string) => {
      try {
        const turns = await recentTurns(addr, 6);
        // turns[0] is the message being handled: recordInbound filed it above.
        const priors = turns.slice(1).map((t: any) => String(t?.body || ""));
        // ASKED TWICE MEANS OUR ANSWER DID NOT LAND. Repeating it is the machine-like thing to do.
        if (askedBefore(words, priors)) { console.error(`[inbound] ${addr} asked this before — handing to a person`); return null; }

        const sends = await roleSendsFor(addr, 25);
        const rp = await roleInPlay(addr, { roleSends: async () => sends, findIdFromSend: roleFindIdFromSend, findById: getFindById });
        if (!rp) return null;

        const t = await composeReply({
          message: words, job: rp.job,
          transcript: transcriptFrom({ inbound: turns, sends }),
          log: (m: string) => console.error(m),
        });
        if (t.kind === "none") {
          // Silence towards them, never towards a human: the same bargain lib/reply-intent.mjs makes
          // for `courtesy`. A misread "never mind" must not become a message nobody ever sees.
          console.error(`[inbound] nothing needed for ${addr} (${t.why})`);
          await sendMailTo(ALERT_TO(), {
            subject: `No reply needed for ${addr}`,
            html: `<pre style="white-space:pre-wrap">${esc(words).slice(0, 4000)}</pre>`,
            text: words.slice(0, 4000),
          }).catch(() => {});
          return { kind: "none", reply: null, why: t.why };
        }
        if (!t.reply) { console.error(`[inbound] cannot answer ${addr} (${t.why}) — handing to a person`); return null; }
        console.error(`[inbound] composed for ${addr}: ${t.why}`);
        return t;
      } catch (e: any) {
        console.error(`[inbound] conversational turn failed for ${addr}: ${e.message} — handing to a person`);
        return null;
      }
    };

    // A short acceptance or refusal of something we just offered. "Yes" is a turn in the conversation
    // Charlie started; classifying it fresh is what made it answer an offer with a settings menu.
    if (!looksLikeQuestion(ownWords).isQuestion && isContinuation(ownWords)) {
      const cont = await conversationalTurn(from, ownWords, subject);
      if (cont?.kind === "none") return;
      if (cont?.reply) {
        noteInbound({ stage: "continuation", from });
        console.error(`[inbound] continued with ${from}: ${cont.reply}`);
        await send(renderRoleAnswer({ email: from, text: cont.reply, replySubject: subject }));
        await sendMailTo(ALERT_TO(), {
          subject: `Continued with ${from}`,
          html: `<p><b>${esc(cont.reply)}</b></p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 4000)}</pre>`,
          text: `${cont.reply}\n\n---\n${ownWords.slice(0, 4000)}`,
        }).catch(() => {});
        return;
      }
      // no role, no offer to continue, or refused: fall through to everything that ran before.
    }

    const q = looksLikeQuestion(ownWords);
    if (q.isQuestion) {
      const known = knownAnswer(ownWords);

      // ── answer it from the record, if the record can answer it ──────────────────────────────────
      //
      // Before handing a question to a human, see whether the role they are already discussing
      // answers it (e.g. "Can I apply?" once we know which role "that" is). Nothing here can invent one: answerAboutRole reads stored fields and returns null when a
      // field is absent, and null falls straight through to the fallback below, unchanged.
      //
      // ASKED TWICE MEANS OUR ANSWER FAILED. If this is a repeat of something they already sent, the
      // first reply did not land, and sending the same sentences again is exactly what "I already
      // told you that" sounds like from their side. A repeat goes to a person.
      //
      // FAIL SOFT, IN ONE DIRECTION ONLY. Any error in here logs and falls through to the human
      // fallback. It can make Charlie quieter than it could have been; it can never make it wrong.
      const turn = !known ? await conversationalTurn(from, ownWords, subject) : null;
      if (turn?.kind === "none") return; // nothing needed; conversationalTurn already told a person
      const roleAnswer = turn?.reply ? { text: turn.reply, kind: turn.kind } : null;
      if (roleAnswer) {
        noteInbound({ stage: "role_answer", from, kind: roleAnswer.kind });
        console.error(`[inbound] answered ${from} (${roleAnswer.kind}): ${roleAnswer.text}`);
        await send(renderRoleAnswer({ email: from, text: roleAnswer.text, replySubject: subject }));
        // A person still sees it. An answer built from a field is still an answer we have never had a
        // human read, and the two questions this cannot yet answer are the ones worth noticing.
        await sendMailTo(ALERT_TO(), {
          subject: `Answered ${from} from the record (${roleAnswer.kind})`,
          html: `<p><b>${esc(roleAnswer.text)}</b></p><pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 4000)}</pre>`,
          text: `${roleAnswer.text}\n\n---\n${ownWords.slice(0, 4000)}`,
        }).catch(() => {});
        return;
      }

      noteInbound({ stage: "question", from, why: q.why, known: known || "none" });
      console.error(`[inbound] question from ${from} (${q.why}) — not writing preferences${known ? `, answering "${known}"` : ", handing to a human"}`);
      await send(renderQuestionAck({ email: from, name: existing?.dossier?.name || "", answer: known || "", applyUrl: process.env.QUESTION_APPLY_URL || "" }));
      if (!known) {
        // Tell the owner, because "a person will answer this" is a promise and nothing else keeps it.
        await sendMailTo(ALERT_TO(), {
          subject: `Question from ${from}`,
          html: `<pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 4000)}</pre>`,
          text: ownWords.slice(0, 4000),
        }).catch(() => {});
      }
      return;
    }

    // THE DEFAULT IS NOT A WRITE.
    //
    // applyEmailChange reads any message as an instruction to rewrite what this person is looking
    // for. As a default that is wrong: "Please share my profile with Lumora" is a consent grant, and
    // "You've misread my CV, I ran a plant for eight years before this" is a
    // dispute; neither is a preference change.
    //
    // So the message is named first, and only a confident instruction may write. Everything else,
    // including every way the classifier can fail, goes to a person. `mayWritePreferences` is the
    // whole inversion in one predicate.
    const intent = await classifyInbound({ subject, body: ownWords, log: console.error });
    noteInbound({ stage: "intent", from, intent: intent.intent, confidence: intent.confidence });
    console.error(`[inbound] ${from}: ${intent.intent} (${intent.confidence}) ${intent.why}`);

    if (!mayWritePreferences(intent)) {
      // A consent grant and a dispute are the two the owner must see the same day: one is permission
      // the business waits on, the other is us being wrong about somebody to their face.
      //
      // ONE REPLY PER SITUATION (lib/reply-intent.mjs): a consent grant, a factual dispute, a status
      // update, an answer to Charlie's own question and a newsletter each get their own reply, and a
      // thank-you gets silence, rather than one fixed acknowledgement for all of them.
      //
      // FLAG READ AT CALL TIME, never frozen at import, like every other flag here. OFF falls back to
      // the single generic acknowledgement.
      const chosen = process.env.REPLY_INTENT === "on"
        ? replyFor(intent, { email: from, name: existing?.dossier?.name || "" })
        : null;
      const urgent = chosen ? chosen.urgent : (intent.intent === "consent_grant" || intent.intent === "dispute");
      let handOff = ""; // why a person needs to answer this one personally, if they do

      if (!chosen) {
        await send(renderAck({ email: from })); // flag off: unchanged
      } else if (chosen.silent) {
        // A thank-you needs no email. The owner is still told below, so silence is only ever silence
        // towards the user and a misclassified message can never vanish.
        console.error(`[inbound] ${from}: ${intent.intent} — no reply sent, by design`);
        noteInbound({ stage: "reply_silent", from, intent: intent.intent });
      } else {
        // FAIL CLOSED, and NOT back to the form letter. A reply that trips the lint is not sent at
        // all: falling back to renderAck would reintroduce the exact template this replaces, in
        // precisely the cases nobody predicted. The person is not left in silence either, because
        // the alert below is escalated and a human answers them.
        const lint = lintReply({
          subject: chosen.message.subject, text: chosen.message.text, html: chosen.message.html,
          quote: QUOTING_INTENTS.includes(intent.intent) ? intent.quote : "",
        });
        if (lint.ok) {
          await send(chosen.message);
        } else {
          handOff = `reply-lint dropped it: ${lint.violations.map((v: any) => v.rule).join(", ")}`;
          console.error(`[inbound] reply-lint DROP ${intent.intent} ${from}: ${handOff}`);
          noteInbound({ stage: "reply_lint_drop", from, intent: intent.intent, rules: lint.violations.map((v: any) => v.rule) });
        }
      }

      const act = urgent || !!handOff;
      await sendMailTo(ALERT_TO(), {
        subject: `${act ? "[ACT] " : ""}${intent.intent} from ${from}`,
        html: `<p><b>${esc(intent.intent)}</b> (${esc(intent.confidence)}) ${esc(intent.why)}</p>${handOff ? `<p><b>NOBODY REPLIED TO THIS PERSON.</b> ${esc(handOff)}</p>` : ""}<pre style="white-space:pre-wrap">${esc(ownWords).slice(0, 6000)}</pre>`,
        text: `${intent.intent} (${intent.confidence}) ${intent.why}\n${handOff ? `\nNOBODY REPLIED TO THIS PERSON. ${handOff}\n` : ""}\n${ownWords.slice(0, 6000)}`,
      }).catch(() => {});
      return;
    }

    const r = await applyEmailChange(from, `${subject}\n\n${ownWords}`);
    const emailedYet = (await getFindIds(from).catch(() => new Set())).size > 0;
    const gap = !emailedYet ? nextGap(r?.dossier) : null;
    if (r && (r.changed.length || gap)) {
      await send(renderConvoReply({ email: from, changedText: r.changed.length ? friendlyChanges(r.changed) : "", strength: gap ? topStrength(r.dossier) : "", ask: gap?.ask || "" }));
      if (gap) await mergeEmailConfig(from, { last_gap_drip_at: new Date().toISOString() }).catch(() => {});
    } else {
      await send(renderAck({ email: from }));
    }
  } catch (e: any) {
    console.error(`[inbound] handler error: ${e.message}`);
    noteInbound({ stage: "error", error: String(e?.message || e) });
  }
});

// One-click unsubscribe. The signed token IS the identity (same HMAC as connection tokens).
// GET = the footer link a person clicks (returns a branded page). POST = RFC 8058 one-click,
// which Gmail/Apple fire from the List-Unsubscribe header. Both (1) add the address to the global
// suppression list so no future send goes out, AND (2) flip the candidate to status='unsubscribed'
// so they also drop out of the daily scan+match pool (listActiveCandidates is active-only) — not
// just unsent but unscanned. Both writes are best-effort; neither may break the response.
// GET does NOT unsubscribe: mail-security scanners fetch every link in an email, so a GET that
// suppressed on load would silently opt out engaged people the moment a scanner touched their
// welcome email. GET shows a one-tap confirm whose button POSTs; the POST
// below is the only place that actually suppresses. Gmail's RFC 8058 one-click already POSTs here.
app.get("/unsubscribe", async (req, res) => {
  const token = String(req.query.t || "");
  let email = "";
  try { email = await emailForToken(token); } catch { /* invalid/expired */ }
  if (!email) return res.status(400).type("html").send(unsubscribePage("This link looks invalid or expired.", false));
  res.type("html").send(unsubscribeConfirmPage(token));
});
app.post("/unsubscribe", async (req, res) => {
  let email = "";
  try { email = await emailForToken(String(req.query.t || req.body?.t || "")); } catch { /* invalid */ }
  if (email) {
    try { await suppressAddress(email, "unsubscribe"); } catch (e: any) { console.error(`[unsubscribe] suppress failed: ${e.message}`); }
    try { await setCandidateStatus(email, "unsubscribed"); } catch (e: any) { console.error(`[unsubscribe] status flip failed: ${e.message}`); }
  }
  // Gmail's one-click POST wants a bare 200; a human tapping the confirm button (a browser form
  // submit) wants the confirmation page. Distinguish by whether the client accepts HTML.
  if (req.accepts("html")) return res.type("html").send(unsubscribePage(email ? `Charlie won't email ${email} anymore.` : "This link looks invalid or expired.", Boolean(email)));
  res.status(200).end();
});

// The one-time Gmail filter (tag-only): users import this in Gmail Settings -> Filters -> Import
// filters. Google runs the rules, so this needs ZERO API access to their inbox. It
// (1) labels every Charlie email under "Charlie" and keeps it out of spam, and (2) auto-sorts
// each email into a stage sub-label by matching a hidden anchor Charlie stamps in every send
// (charlieroles / charlieapplied / charlieinterviews / charlieoffers / charlieintros), and stars
// interviews + offers. Result: the whole search groups itself in the sidebar, one glance, no app.
// Pair with Gmail's Multiple Inboxes (label:Charlie/Interviews etc.) for a dashboard-in-Gmail.
const FILTER_ENTRY = (title: string, matchName: string, matchVal: string, label: string, extra = "") =>
  `  <entry>
    <category term="filter"></category>
    <title>${title}</title>
    <content></content>
    <apps:property name="${matchName}" value="${matchVal}"/>
    <apps:property name="label" value="${label}"/>
    ${extra}
  </entry>`;
const GMAIL_FILTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006">
  <title>Charlie mail filters</title>
${FILTER_ENTRY("Charlie", "from", (String(process.env.CHARLIE_FROM || "charlie@mail.example.com").match(/[^<\s]+@[^>\s]+/) || ["charlie@mail.example.com"])[0], "Charlie", '<apps:property name="shouldNeverSpam" value="true"/>')}
${FILTER_ENTRY("Charlie/Roles", "hasTheWord", "charlieroles", "Charlie/Roles")}
${FILTER_ENTRY("Charlie/Applied", "hasTheWord", "charlieapplied", "Charlie/Applied")}
${FILTER_ENTRY("Charlie/Interviews", "hasTheWord", "charlieinterviews", "Charlie/Interviews", '<apps:property name="shouldStar" value="true"/>')}
${FILTER_ENTRY("Charlie/Offers", "hasTheWord", "charlieoffers", "Charlie/Offers", '<apps:property name="shouldStar" value="true"/>')}
${FILTER_ENTRY("Charlie/Intros", "hasTheWord", "charlieintros", "Charlie/Intros")}
</feed>`;
app.get("/gmail-filter.xml", (_req, res) => {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="charlie-gmail-filter.xml"');
  res.send(GMAIL_FILTER_XML);
});

// One-click feedback + tracked apply. The signed token carries { e, f(findId), v(event), u? }.
// Logs the signal (best-effort), then: apply_click 302s to the real posting; worth/not show a
// tiny thank-you page. The HMAC signature means links can't be forged for another user.
// Warm-intro finder (v2): find a contact for the role, draft the grounded intro, and return
// the DATA the /warm-intro page renders (contact + LinkedIn + a native mailto and a Gmail
// compose link). No email is sent, the user sends from their own inbox. Never throws.
async function computeReferral(email: string, findId: string | null, hintCompany = "", hintRole = "") {
  const owner = isOwnerEmail(email); // may use the stub for dry runs
  let job: any = null;
  try {
    const finds: any[] = await getFinds(email, { limit: 50 });
    job = (finds.find((f) => f.id === findId) || {}).job || null; // EXACT ref match only — never finds[0]
  } catch (e: any) { console.error(`[referral] finds read: ${e.message}`); }
  // Prefer the matched find; otherwise the company/role from the REQUEST itself (the role the
  // user actually asked about). Never borrow a different role's company — that was the mismatch bug.
  const company = job?.company || hintCompany || "";
  const roleTitle = job?.title || hintRole || "";
  const jobUrl = job?.apply_url || job?.url || "";
  if (!company) return { none: true, reason: "no_company" }; // can't find a person without a real company

  // Warm intros are US-only (Huntr coverage + our fail-closed bar). Gate on the candidate's region
  // BEFORE spending a lookup; the account owner may bypass for dry-run testing.
  let dossier: any = {};
  try { dossier = (await getDossier(email)) || {}; } catch { /* thin note is fine */ }
  if (!owner && homeRegion(dossier) !== "us") return { none: true, reason: "region", company };

  const location = job?.location || "";
  const r = await findReferralContact({ email, company, jobUrl, roleTitle, location, owner }).catch((e: any) => {
    console.error(`[referral] find: ${e.message}`); return { none: true, reason: "error" };
  });
  if (!r || r.none || !r.contact) return { none: true, reason: r?.reason || "none", company };

  const draft = await draftIntro({ dossier, roleTitle, company: r.company || company, contact: r.contact });

  const enc = encodeURIComponent;
  const to = r.contact.email;
  // mailto: keep the address literal (encoded @ trips some mail apps); encode only subject/body.
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(draft.subject)}&body=${enc(draft.body)}`;
  const mailto = `mailto:${to}?subject=${enc(draft.subject)}&body=${enc(draft.body)}`;

  recordSignal({ email, findId, event: "referral_suggested", meta: { contact: r.contact, company: r.company || company } }).catch(() => {});
  return { none: false, company: r.company || company, roleTitle, contact: r.contact, subject: draft.subject, body: draft.body, mailto, gmail };
}

// The warm-intro page (mobile-first). Serves a static shell; its JS calls /find below.
app.get("/warm-intro/:token", (req, res) => {
  const p: any = readEvent(String(req.params.token || ""));
  if (!p || !p.e) return res.status(400).type("html").send(feedbackPage("This link looks invalid or expired.", false));
  res.type("html").send(warmIntroPage());
});

// GET /g/<token> — the bring-a-friend referral link (the friend-drip loop). <token> is the giver's
// signed code (signToken(giver)). Log the click best-effort (fail-open: a missing table still lets the
// redirect through), then serve the gift landing page, which hands off to start@ with the ref marker.
// Email is Charlie's only door; this page never signs anyone up — the friend sends the mail themselves.
app.get("/g/:token", async (req, res) => {
  const token = String(req.params.token || "");
  const giver = emailForToken(token);
  if (!giver) return res.status(400).type("html").send(feedbackPage("This link looks invalid or expired.", false));
  recordReferralEvent({ giverEmail: giver, variant: friendVariant(giver), kind: "click", refCode: token }).catch(() => {});
  // resolve the giver's grounded name so the page reads "<Name> gave you Charlie" (their own recommendation,
  // not Charlie self-promoting). Best-effort: any miss falls back to "A friend" in giftLandingPage.
  let giverName = "";
  try { const c: any = await getCandidate(giver); giverName = String(c?.dossier?.name || c?.name || ""); } catch { /* warm generic fallback */ }
  res.type("html").send(giftLandingPage({ token, giverName }));
});

// GET /j/<token> — the gift-a-role fit-check link (the "see your fit" loop). <token> = signEvent({e:giver,
// j:jobId}). Resolve the giver's name + the role from the pool, log the click (best-effort, fail-open),
// then serve the fit-check page, which hands off to check@. Email stays the only door; nobody signs up here.
app.get("/j/:token", async (req, res) => {
  const token = String(req.params.token || "");
  const p: any = readEvent(token);
  if (!p || !p.e || !p.j) return res.status(400).type("html").send(feedbackPage("This link looks invalid or expired.", false));
  let giverName = "";
  try { const c: any = await getCandidate(p.e); giverName = String(c?.dossier?.name || c?.name || ""); } catch { /* generic fallback */ }
  let role: any = {};
  try { const job: any = await getPoolJob(p.j); if (job) role = { title: job.title, company: job.company, location: job.location }; } catch { /* role stays minimal */ }
  recordReferralEvent({ giverEmail: p.e, kind: "role_click", refCode: token, jobId: String(p.j) }).catch(() => {});
  res.type("html").send(fitCheckPage({ token, giverName, role }));
});

// The JSON the page fetches on open: the lookup + drafted intro. Quota is spent only here
// (on a real open), and findReferralContact caches per company so refreshes are free.
app.get("/warm-intro/:token/find", async (req, res) => {
  const p: any = readEvent(String(req.params.token || ""));
  if (!p || !p.e) return res.status(400).json({ none: true, reason: "invalid" });
  const findId: string | null = p.f || null;
  const jobId = findId && findId.startsWith(`${p.e}:`) ? findId.slice(p.e.length + 1) : null;
  recordSignal({ email: p.e, findId, jobId, event: "referral_click", meta: {} }).catch(() => {});
  try {
    const data = await computeReferral(p.e, findId);
    res.json(data);
  } catch (e: any) {
    console.error(`[referral] find endpoint: ${e.message}`);
    res.json({ none: true, reason: "error" });
  }
});

app.get("/e/:token", async (req, res) => {
  const p: any = readEvent(String(req.params.token || ""));
  if (!p || !p.e || !p.v) return res.status(400).type("html").send(feedbackPage("This link looks invalid or expired.", false));
  const findId: string | null = p.f || null;
  const jobId = findId && findId.startsWith(`${p.e}:`) ? findId.slice(p.e.length + 1) : null;
  // Older emails may still carry a /e referral link — send them to the new warm-intro page.
  if (p.v === "referral") return res.redirect(302, `/warm-intro/${req.params.token}`);
  await recordSignal({ email: p.e, findId, jobId, event: p.v, meta: {} }).catch(() => {});
  // apply_click and share_* carry a destination (u): record the click, then send them on to the real
  // target (the ATS apply page, or the WhatsApp/LinkedIn/mailto share action).
  if (p.u && (p.v === "apply_click" || String(p.v).startsWith("share_"))) return res.redirect(302, String(p.u));

  // "Show me how to position for this role" — the one click that answers itself by email. The click
  // is already recorded above, which is the measurement; this sends the answer.
  //
  // $0 AND NO MODEL. Everything sent was computed for the role email and stored on the find, so a
  // click cannot cost money or fail on an API incident. It reroutes into email rather than rendering
  // the advice on a web page: email is the product's one surface.
  //
  // FAILS SOFT, NEVER LOUD. If the find is missing or the send fails, the person still gets a page
  // that tells them the truth. A thrown 500 on a link in a real inbox is worse than a plain sentence.
  // The send itself lives in sendPositioning(), BELOW sendMailTo — deliberately outside the region
  // first-contact.test.mjs slices as "the inbound handler". That test counts the guarded sends in the
  // slice and requires each to carry the reply-policy suppression override, which is right for an
  // inbound REPLY and wrong here: this is a click-triggered send, and a suppressed address must never
  // receive it. Moving the call out keeps that guard exact rather than loosening it.
  if (p.v === "position_ask") return sendPositioning(res, String(p.e), findId, jobId);
  const msg = p.v === "worth"
    ? "I'll send you more like that."
    : p.v === "not"
      ? "I'll steer away from those."
      : "Noted, thank you.";
  res.type("html").send(feedbackPage(msg, true));
});

// Debug: recent inbound events (owner-gated). Lets us see exactly what /inbound received
// without relying on log tailing. token = a Charlie HMAC token for the owner email.
app.get("/inbound-debug", async (req, res) => {
  let who: string | null = null;
  try { who = await emailForToken(String(req.query.token || "")); } catch { /* 401 */ }
  if (!who || !isOwnerEmail(who)) return res.status(401).json({ error: "unauthorized" });
  res.json({ count: recentInbound.length, secretsConfigured: INBOUND_SECRETS.length, events: recentInbound });
});

// The temporal-spine task sweep: process durable timers that are due, dispatch by kind, mark
// done. Handlers are added as timer-based features land (followup / interview_ics / standings /
// pause_resume / snooze). Idle+ready until something schedules a task. Best-effort; never throws.
// Send one email to a recipient from a sweep handler. Skips suppressed. Best-effort.
async function sendMailTo(to: string, m: { subject: string; html: string; text: string }) {
  if (!to) return; // no recipient configured (e.g. ALERT_EMAIL and OWNER_EMAIL both unset)
  try {
    if (await isSuppressed(to)) return;
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.CHARLIE_FROM || "charlie@mail.example.com",
      to, subject: m.subject, html: m.html, text: m.text,
      headers: { "List-Unsubscribe": `<${unsubUrlFor(to)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  } catch (e: any) { console.error(`[task] send failed: ${e.message}`); }
}

/**
 * Answer "show me how to position for this role", by email.
 *
 * $0 AND NO MODEL CALL. Everything sent was already computed for the role email and stored on the
 * find (`topMove` + `resume_tips`), so tapping the link cannot cost money, cannot be slow, and cannot
 * fail during an API incident.
 *
 * SUPPRESSION IS NOT OVERRIDDEN, on purpose. sendGuarded's default check applies: a bounced or
 * complained address never receives this. The reply-policy exception exists for answering someone who
 * wrote to us, and a link click is not a letter.
 *
 * Idempotent per role via the dedupe key, so five taps send one email. Fails SOFT: a missing find or
 * a failed send still returns a page that tells the person the truth, because a 500 on a link in a
 * real inbox is worse than a plain sentence.
 */
async function sendPositioning(res: any, email: string, findId: string | null, jobId: string | null) {
  try {
    // getFindById is SCOPED to the address inside the signed token, so a forged id cannot read
    // another person's find. The token is the identity; the scope is the enforcement.
    const find: any = findId ? await getFindById(email, findId) : null;
    const composed: any = find?.composed || {};
    const cov: any = composed._cov || {};
    const { subject, html, text } = renderPositioning({
      email,
      name: (await getCandidate(email))?.dossier?.name || "",
      role: composed.role_title || find?.job?.title || "",
      company: composed.company || find?.job?.company || "",
      lead: cov.topMove || "",
      tips: Array.isArray(composed.resume_tips) ? composed.resume_tips : [],
    });
    const sent = await sendGuarded({
      resend,
      email,
      template: "positioning",
      dedupeKey: `${email}:position:${jobId || "unknown"}`,
      payload: { from: process.env.CHARLIE_FROM!, to: email, subject, html, text },
    });
    return res.type("html").send(feedbackPage(
      sent?.status === "sent" ? "On its way to your inbox." : "You already have that one, check your inbox.",
      true,
    ));
  } catch (e: any) {
    console.error(`[position-ask] ${email} failed: ${e?.message}`);
    Sentry.captureException(e);
    return res.type("html").send(feedbackPage("I could not pull that up. Reply to any of my emails and I will send it.", false));
  }
}

async function runTaskSweep() {
  try {
    const tasks: any[] = await dueTasks({ limit: 50 });
    for (const t of tasks) {
      try {
        switch (t.kind) {
          // ASK-FIRST FOLLOW-UP, three days on. Fires ONLY if they still have no profile — the moment
          // they reply with specifics, onboarding builds one and this says nothing. One nudge, then it
          // stops forever: they already answered once by writing in, and a third chase is a drip
          // wearing a helpful hat (which is why the friend-drip and VIP invite were deleted).
          // A timed pause expiring. Only ever moves paused -> active, so it can never resurrect
          // someone who unsubscribed or was paused for another reason in the meantime.
          case "unpause": {
            const cand: any = await getCandidate(t.email).catch(() => null);
            if (!cand || cand.status !== "paused") break;   // they already came back, or left entirely
            if (await isSuppressed(t.email)) break;
            await setCandidateStatus(t.email, "active");
            await recordSignal({ email: t.email, event: "resumed", meta: { auto: true } }).catch(() => {});
            const stats: any = await loadJobPoolStats().catch(() => null);
            // sendGuarded, not sendMailTo: this is an AUTOMATED user-facing send, so it needs
            // the suppression + sent_emails idempotency door. Without it a webhook replay or a retried
            // sweep could mail the same person "back on" twice.
            const m = renderResumed({ email: t.email, name: cand?.dossier?.name || "", poolSize: stats?.roles ?? null });
            await sendGuarded({
              resend,
              email: t.email,
              template: "resumed",
              dedupeKey: `${t.email}:unpause:${t.id ?? t.run_at ?? ""}`,
              payload: { from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to: t.email, subject: m.subject, html: m.html, text: m.text },
            });
            console.error(`[pause] auto-resumed ${t.email}`);
            break;
          }
          case "ask_first_nudge": {
            const cand: any = await getCandidate(t.email).catch(() => null);
            if (cand?.dossier) break;                 // they replied and got built — say nothing
            if (await isSuppressed(t.email)) break;   // bounced or unsubscribed
            await sendMailTo(t.email, renderSecondChance({ email: t.email }));
            console.error(`[ask-first] day-3 nudge sent to ${t.email}`);
            break;
          }
          case "onb_watchdog":
          case "interro_nudge":
          case "hunt_heartbeat": {
            // Durable journey watchdogs. All three route to one handler; the state's policy
            // (advance / nudge_then_park / pulse / park) decides what happens, and it fires only if
            // the journey is unchanged since scheduling. Sends go through sendGuarded. v2-only: no
            // journey exists until ONBOARDING_V2 is on and the interrogation loop drives it.
            const resend = new Resend(process.env.RESEND_API_KEY);
            const r = await runJourneyWatchdog({
              task: t,
              deps: { getCandidate, enterState, scheduleTask, sendGuarded, resend, log: console.error },
            });
            if (r?.action && r.action !== "stale" && r.action !== "none") {
              console.error(`[task] journey ${t.kind}: ${r.action} (${t.email})`);
            }
            break;
          }
          case "onboard_retry": {
            // Safety net: an onboarding build that failed (model/infra outage) is
            // retried from the resume we saved, so a transient outage never costs us a real signup.
            // Idempotent + capped: skip if they onboarded another way, give up after MAX attempts and
            // (only then) ask for a readable resume, since by now it is genuinely unreadable, not us.
            const MAX = 3;
            const { attempt = 1, subject = "", body = "" } = t.payload || {};
            if (await getDossier(t.email).catch(() => null)) break; // already onboarded (e.g. they resent) — done
            const rt = await getResume(t.email).catch(() => null);
            if (!rt) break; // nothing to retry with
            let dossier: any = null;
            let ungrounded = false;
            try { dossier = await onboardFromEmail(t.email, rt, `${subject}\n\n${body}`, []); }
            catch (e: any) {
              // A build that grounded NOTHING will ground nothing on attempt 2 and 3 as well — the
              // input is the problem, not an outage. Stop retrying immediately and take the give-up
              // branch below, so junk never costs three Opus builds.
              ungrounded = e?.code === "ungrounded";
              console.error(`[onboard_retry] ${t.email} attempt ${attempt} ${ungrounded ? "grounded NOTHING — not retrying" : "failed"}: ${e.message}`);
            }
            const resend = new Resend(process.env.RESEND_API_KEY);
            const from_ = process.env.CHARLIE_FROM || "charlie@mail.example.com";
            const guarded = (dedupeKey: string, m: { subject: string; html: string; text: string }) => sendGuarded({
              resend, email: t.email, template: "inbound:convo", dedupeKey,
              payload: { from: from_, to: t.email, subject: m.subject, html: m.html, text: m.text,
                headers: { "List-Unsubscribe": `<${unsubUrlFor(t.email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
            });
            if (dossier) {
              const gap = nextGap(dossier);
              await guarded(`onboard-retry:${t.email}`, renderWelcome({ email: t.email, name: dossier?.name || "", thin: isThinDossier(dossier), ask: gap?.ask || "", strength: topStrength(dossier) }));
              await briefingThenScheduleRole(t.email); // #2 briefing now, #3 first role on day-2
              console.error(`[onboard_retry] recovered ${t.email} on attempt ${attempt}`);
            } else if (!ungrounded && attempt < MAX) {
              await scheduleTask({ email: t.email, kind: "onboard_retry", runAt: Date.now() + 30 * 60_000, payload: { attempt: attempt + 1, subject, body } });
            } else {
              await guarded(`onboard-retry-giveup:${t.email}`, renderMissingResume({ email: t.email })); // retries exhausted (or nothing to ground) — now the honest ask is correct
              console.error(`[onboard_retry] gave up on ${t.email} after ${attempt} attempt(s)${ungrounded ? " (grounded nothing)" : ""}`);
            }
            break;
          }
          case "first_role": {
            // Nothing queues this kind (see briefingThenScheduleRole); roles come from the weekly run.
            // This case only drains any legacy rows: it completes each one without sending. Without
            // it the `default` branch would log "no handler", which reads like a bug.
            console.error(`[first-role] RETIRED — draining stale task ${t.id} for ${t.email} without sending (one weekly run serves everyone now)`);
            break;
          }
          default:
            console.error(`[task] no handler yet for kind "${t.kind}" (task ${t.id})`);
        }
        await completeTask(t.id, "done");
      } catch (e: any) {
        console.error(`[task] ${t.kind} failed (${e.message})`);
        await completeTask(t.id, "done").catch(() => {}); // don't reprocess a poison task forever
      }
    }
  } catch (e: any) { console.error(`[task] sweep skipped: ${e.message}`); }
}

// Report any error thrown out of a route handler to Sentry (after all routes; no-op without SENTRY_DSN).
Sentry.setupExpressErrorHandler(app);

const httpServer = app.listen(PORT, () => {
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  console.error(`charlie server listening on :${PORT}`);
  console.error(`inbound: ${base}/inbound   ·   the one door is start@ (email is the product)`);
  // There is no referral-find nudge drip; the inline "one person who might refer you" box rides on
  // the role email when a real contact resolves.
  // Completeness nudge: users getting no roles (thin input) nudged at 7/14/30 days, max 3, then
  // stop; stops the moment a role clears their bar. Best-effort; day-scale, so a slow interval.
  setInterval(() => { runCompletenessNudgeSweep().catch((e: any) => console.error(`[completeness-nudge] sweep error: ${e.message}`)); }, 30 * 60 * 1000);
  // ── NO SWEEP SCORES THE JOB POOL ──────────────────────────────────────────────────────────────
  // Job scoring happens only in the weekly run, where its spend shows in the run's own cost line. No
  // timer here scores ATS roles against a person between runs: the market-gap drop and the
  // market-briefing backfill both call model-priced coverage per person, so they are not on an
  // interval. Both features still work when called directly.
  //
  // The wedge sweep runs here: it reasons about the person from their stored dossier and never
  // touches the job pool. It does spend model calls on a timer.
  setInterval(() => { runWedgeSweep().catch((e: any) => console.error(`[wedge] sweep error: ${e.message}`)); }, 6 * 60 * 60 * 1000);
  // Outcome probe: when a role someone clicked apply on comes off its board, ask the one
  // question that has an answer at that moment. DARK unless OUTCOME_PROBE is set; `dry` logs and sends
  // nothing. Deliberately slow: a closure detected six hours late is still a closure, and this must
  // never compete with the send path. It reads the seen-store the engine's scan writes.
  // Depth snapshot: one grounded-depth reading per active user, so the change over time can be
  // measured; that needs history, which only accumulates if something writes it down. Signals only:
  // it never emails anyone and never touches a dossier, so its worst failure is a missing data point. Daily, and DARK unless DEPTH_SNAPSHOT is set.
  setInterval(() => { runDepthSnapshotSweep().catch((e: any) => console.error(`[depth] sweep error: ${e.message}`)); }, 24 * 60 * 60 * 1000);
  // The depth question: a grounded read on their market, then ONE thing to answer.
  // $0 in model spend by construction — it reads the coverage the send already paid for and
  // SKIPS anyone whose rows predate that rather than recomputing. DARK unless DEPTH_QUESTION is set.
  setInterval(() => { runDepthQuestionSweep().catch((e: any) => console.error(`[depth-q] sweep error: ${e.message}`)); }, 12 * 60 * 60 * 1000);
  // THE HIRING LOOP'S ONE NUDGE for an applicant who went quiet after the challenge question
  // (renderCampaignStall). Hourly is fine: the dedupe key is `stall:<email>`
  // with no date, so a person can be nudged exactly ONCE no matter how often this fires, and the
  // sweep never touches stage/turns/verdict -- the verdict stays 100% human. Inert unless
  // JOIN_CAMPAIGN=on.
  setInterval(() => { runCampaignStallSweep().catch((e: any) => console.error(`[campaign-stall] sweep error: ${e.message}`)); }, 60 * 60 * 1000);
  // The represent offer: once ever, to anyone who has had a role. That single condition is both the
  // initial blast and every future signup, the moment their first role lands — no backfill path.
  // DARK unless REPRESENT is set.
  setInterval(() => { runRepresentSweep().catch((e: any) => console.error(`[represent] sweep error: ${e.message}`)); }, 6 * 60 * 60 * 1000);
  // sendMarketBriefing is called directly at dossier completion (no backfill sweep; see above).
  setInterval(() => { runGamePlanSweep().catch((e: any) => console.error(`[game-plan] sweep error: ${e.message}`)); }, 6 * 60 * 60 * 1000); // part 4: backfill + catch-up (dark until GAME_PLAN=on)
  // VIP confirmation: an invited person who has now FINISHED their dossier gets the one-time "you're
  // in" card. Idempotent via email_config.vip_confirmed_at. Closes the invite → complete → welcome loop.
  setInterval(() => { runConfirmationSweep().catch((e: any) => console.error(`[confirm] sweep error: ${e.message}`)); }, 30 * 60 * 1000);
  // There is no bring-a-friend or club-invite drip: Charlie sends roles, the market read, the things
  // that gather what a match needs, and replies to what a person wrote. /g/<token> + friend_referrals
  // exist for gift-a-role. drip-removal.test.mjs fails if a referral/invite drip is added.
  // Temporal spine: process due durable timers (follow-ups, interview invites, standings, ...).
  setInterval(() => { runTaskSweep().catch((e: any) => console.error(`[task] sweep error: ${e.message}`)); }, 5 * 60 * 1000);
  // Pieworks 2call activation (lib/pieworks-activation.mjs): asks, the one reminder, closing, retrying a status Pieworks
  // has not accepted, and Monday's stats email. Every 30 minutes; a no-op unless PIEWORKS_ACTIVATION is shadow or live.
  setInterval(() => { runPieworksSweep().catch((e: any) => console.error(`[pieworks] sweep error: ${e.message}`)); }, 30 * 60 * 1000);
  // The saved candidate lifecycle, kept in step with the outreach emails (lib/hire-pursuit-sync.mjs). Every 15 minutes; a no-op unless HIRING_WORKSPACE is on.
  setInterval(() => { runPursuitSync().catch((e: any) => console.error(`[pursuit-sync] sweep error: ${e.message}`)); }, 15 * 60 * 1000);
  // The agents (lib/agents/*): each built agent on its schedule, with quiet hours and a daily limit. Every 15 minutes; a no-op unless HIRING_WORKSPACE is on.
  setInterval(() => { runAgentsSweep().catch((e: any) => console.error(`[agents] sweep error: ${e.message}`)); }, 15 * 60 * 1000);
  // Voice verification: every session whose transcript has landed becomes a report. The webhook
  // kicks the pipeline immediately; this sweep catches what a restart or a failed kick left behind.
  // No-op while VOICE_VERIFICATION is off. Model spend per session is capped (VOICE_MAX_PIPELINE_COST_USD).
  setInterval(() => {
    if (!voiceEnabled()) return;
    runPipelineSweep({ store: voiceStore, client: new Anthropic() }).catch((e: any) => console.error(`[voice-pipeline] sweep error: ${e.message}`));
  }, 10 * 60 * 1000);
});

export { app, httpServer };
