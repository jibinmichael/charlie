// scheduler.mjs — the SCHEDULED engine entrypoint (no manual trigger).
//
//   node scheduler.mjs
//
// Runs unattended. For EVERY active user, in one run:
//   1) match the shared scanned job pool against their dossier  (Batch API, Haiku 4.5)
//   2) pick their single top above-bar role not already emailed
//   3) compose (Sonnet 4.6) + render the one inline email
//   4) email it to them (Resend, idempotent), record the find
//
// Per-step models: Haiku for the high-volume match (match-batch.mjs), Sonnet for
// compose (composer.mjs). The one-off dossier build from a resume uses Opus 4.8
// (dossier-build.mjs) and is NOT part of this run.
//
// Job pool: reads JOBS_FILE (default jobs.json), which the scanner writes. In prod the
// cron runs the scanner first:  node scan-jobs.mjs && node scheduler.mjs
//
// Cost-safety: caps + the $ ceiling live in match-batch.mjs. Env knobs:
//   EMAIL_DRY_RUN=1   run the full pipeline but skip the actual Resend send
//   ONLY_EMAIL=x      process just that one active user (targeted reruns / tests)

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import { emailsWithSignal, loadEnv, listActiveCandidates, getFindIds, getEmailedRoleSignatures, countEmailedSince, upsertFind, setFindStatus, isSuppressed, suppressionReasons, getResume, loadKpiHistory, saveKpiHistory, chaseReplyTo, STALE_NEW_HOURS } from "./charlie-store.mjs";
import { unreachableCohort, unreachableDetail, routingAddress } from "./lib/unreachable-cohort.mjs"; // who we serve but cannot reach
import { computeMatchKpis, computeRetrievalRankKpis, mergeKpiHistory, formatKpiLine } from "./stats.mjs"; // per-run measurement counters
import { sendGuarded } from "./lib/send-guard.mjs"; // the one send door (suppression + idempotency + send)
import { runMatchBatch } from "./match-batch.mjs";
import { ResendSendPayload } from "./lib/schemas/resend-send.mjs"; // boundary validation for the direct send
import { pingHeartbeat } from "./lib/heartbeat.mjs"; // best-effort cron heartbeat (never fails the job)
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)
import { decisionRecord } from "./lib/decision-record.mjs"; // why THIS role, for THIS person, recorded
import { postSendAudit } from "./send-audit.mjs"; // post-send self-audit: flag a hard-constraint miss (never auto-corrects)
import { composeEmailFields, lookupCompany } from "./composer.mjs";
import { renderEmail, readoutStatus, referralStatus } from "./render-email.mjs";
import { computeCoverage, coverageCacheStats } from "./fit-coverage.mjs";
import { screenForComposer } from "./lib/fit-screen.mjs"; // the read the composer must not argue with
import { pairwiseReorder, pairwiseMode } from "./lib/pairwise.mjs"; // rank the shortlist by comparison, not by a collapsed score
import { preSendGuard, repeatDecision } from "./presend-guard.mjs";
import { freshnessMode, freshnessReorder } from "./freshness.mjs"; // freshness in the send decision
import { newMessageId } from "./threading.mjs";
import { unsubUrlFor, cleanSubject, renderOutOfMarket } from "./email-kit.mjs";
import { verifyGrounding, shouldHold } from "./grounding-verify.mjs";
import { citeOrDrop, groundingMode, groundingDecision, hasFitContent } from "./grounding-enforce.mjs"; // cite-or-drop at send
import { skillUnlock } from "./market-weave.mjs";
import { homeRegion, referralRegionAllowed } from "./quality-gate.mjs";
// THE FIT ENGINE'S ONLY TOUCH POINT ON A REAL SEND. Off by default; see lib/fit-authority.mjs.
import { fitVeto } from "./lib/fit-veto.mjs";
import { fitAuthorityBanner } from "./lib/fit-authority.mjs";
// ONE grounded question from the matcher's own uncertainty. Pure, deterministic, no model call.
import { askFor } from "./lib/role-ask.mjs";
import { roleAskFor, roleAskMode } from "./lib/role-ask-flag.mjs";
import { computePay, computeMomentum } from "./role-intel.mjs";
import { resolveInlineReferral } from "./referral-inline.mjs";
import { edgeHit, RARE_FIND_LABEL, rareFindSubject } from "./lib/edge-match.mjs"; // Edge Engine (dark)

const here = dirname(fileURLToPath(import.meta.url));
const MATCHER_PATH = join(here, "matcher.md");
const JOBS_PATH = process.env.JOBS_FILE || join(here, "jobs.json");
// Reply-as-signal. Dark until REPLY_SIGNAL=on — adds the "just hit reply" footer line and a
// signed chase+<token>@ Reply-To so a reply logs a `chasing` signal against the exact role.
const REPLY_SIGNAL = process.env.REPLY_SIGNAL === "on";

const log = (...a) => console.error("[scheduler]", ...a);

function loadJobs() {
  if (!existsSync(JOBS_PATH)) return [];
  try {
    const j = JSON.parse(readFileSync(JOBS_PATH, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch (e) {
    log(`could not read jobs (${JOBS_PATH}): ${e.message}`);
    return [];
  }
}

async function main() {
  loadEnv();
  initSentry({ name: "scheduler" });
  const startedAt = Date.now();

  const matcherPrompt = readFileSync(MATCHER_PATH, "utf8");
  const jobs = loadJobs();
  if (!jobs.length) {
    log(`no jobs in ${JOBS_PATH} (run the scanner first). Nothing to do.`);
    return;
  }

  // Who has already told us they want Pro. Read ONCE per run, never per render: the send loop renders
  // for every user, and a per-email query would be hundreds of round trips for a boolean that cannot
  // change mid-run. Fails OPEN to an empty set, so an unreadable signals table shows the block to
  // everyone (the pre-existing behaviour) rather than silently deleting a section for all of them.
  const proAskedSet = await emailsWithSignal("pro_interest");
  if (proAskedSet.size) log(`pro: ${proAskedSet.size} already asked — hiding that block for them`);

  let candidates = await listActiveCandidates();
  if (process.env.ONLY_EMAIL) {
    const only = process.env.ONLY_EMAIL.trim().toLowerCase();
    candidates = candidates.filter((c) => c.email === only);
    log(`ONLY_EMAIL=${only} -> ${candidates.length} user(s)`);
  }
  // EVERY ACTIVE CANDIDATE IS IN THE SEND POOL; there is no allowlist. The rules that protect people
  // all still run, below and downstream:
  //
  //   suppressed / bounced / complained  -> dropped in the pre-batch suppression filter, next block
  //   paused / unsubscribed              -> never returned by listActiveCandidates at all
  //   outside India + US                 -> the out-of-market note, not a role
  //   dossier too thin to judge fit      -> quality-gate's data-sufficiency drop, per role
  //
  // lib/role-cohort.mjs is still used by operator scripts that scope themselves to a named list on
  // purpose; it is not a gate on the daily send.
  // Cost + deliverability: drop suppressed recipients (hard bounce / spam complaint / unsubscribed)
  // BEFORE scoring, not after. A suppressed address is blocked at the send door regardless (the
  // backstop isSuppressed check below), so scoring it only burns model spend on an email that can
  // never go out. We check the SAME address the send path uses (email_config.notify || email) so the
  // pre-filter drops exactly the post-check's set. Fail-open: isSuppressed swallows store errors →
  // false, so a transient miss never blocks.
  //
  // BUT SAY WHO. Dropping them here also removes them from the coverage denominator below, so
  // `silent_no_send` can never fire for them: a person whose forwarding address hard-bounced would get
  // nothing, forever, while the run reports success. A count is not an alarm, so name every one of
  // them, in the log AND to Sentry, on every run.
  const beforeSuppress = candidates.length;
  const reasons = await suppressionReasons(candidates.map((c) => routingAddress(c)));
  if (reasons === null) {
    // Could not check. That is NOT all-clear — say so, then fall through to the per-address
    // isSuppressed drop below, which fails open exactly as it always did (a transient store error must
    // never block a legitimate send). What we refuse to do is stay quiet about not knowing.
    log(`⚠ REACHABILITY UNKNOWN: the suppression read failed, so this run cannot tell whether any of the ${beforeSuppress} candidate(s) is unreachable`);
    captureError(new Error(`reachability check failed: suppression read errored for ${beforeSuppress} candidate(s)`), { service: "scheduler", kind: "reachability_unknown", active: beforeSuppress });
  } else {
    const unreachable = unreachableCohort({ candidates, suppressed: reasons });
    if (unreachable.length) {
      log(`⚠ UNREACHABLE: ${unreachable.length}/${beforeSuppress} candidate(s) we are actively serving cannot receive mail — ${unreachableDetail(unreachable)}`);
      captureError(new Error(`unreachable: ${unreachable.length} active cohort member(s) cannot receive mail — ${unreachableDetail(unreachable)}`), { service: "scheduler", kind: "unreachable_cohort", count: unreachable.length, active: beforeSuppress });
    }
  }
  const suppressedFlags = await Promise.all(candidates.map((c) => isSuppressed(routingAddress(c))));
  candidates = candidates.filter((_, i) => !suppressedFlags[i]);
  const droppedSuppressed = beforeSuppress - candidates.length;
  if (droppedSuppressed) log(`pre-batch suppression: dropped ${droppedSuppressed}/${beforeSuppress} suppressed candidate(s) (bounce/complaint/unsub) before scoring; ${candidates.length} remain`);
  // ONE PATH FOR EVERYONE. There is no onboarding grace and no second serving track: the list this
  // loop scores is exactly active, minus suppressed, minus out-of-market. Age is not a filter. A
  // person who signed up an hour before the run is scored with everyone else, and the ordinary gates
  // (fit, geography, liveness, cadence) decide whether they hear anything. cohort-fence.test.mjs
  // fails if a second serving track comes back.
  //
  // Out-of-market: Charlie serves India + US only. A candidate whose GROUNDED home is outside BOTH
  // markets (homeRegion === "other" — a POSITIVE foreign signal: a stated foreign place or home
  // currency; an unknown still defaults to india, so no India/US user is ever misflagged) is dropped
  // HERE, before scoring, so we never spend a match on a role they can't take. Removing them from
  // `candidates` also keeps them OUT of the coverage denominator below — they are handled (one honest
  // note), not silent. Each is sent that note once, further down, after the Resend client exists.
  const beforeOOM = candidates.length;
  const outOfMarket = [];
  candidates = candidates.filter((c) => {
    if (homeRegion(c.dossier) === "other") { outOfMarket.push(c); return false; }
    return true;
  });
  if (outOfMarket.length) log(`out-of-market: held ${outOfMarket.length}/${beforeOOM} candidate(s) outside India+US (honest note, no roles); ${candidates.length} remain`);

  // Resend client — created here because BOTH the out-of-market note (just below) and the role loop
  // (further down) need it. dryRun when Resend is unconfigured or EMAIL_DRY_RUN=1: pipeline runs, no send.
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.CHARLIE_FROM;
  const dryRun = process.env.EMAIL_DRY_RUN === "1" || !resendKey || !from;
  if (dryRun) log(`email: DRY RUN (${!resendKey || !from ? "Resend not configured" : "EMAIL_DRY_RUN=1"}) — pipeline runs, no send`);
  const resend = resendKey ? new Resend(resendKey) : null;

  // The one honest note to each out-of-market person: "I only cover India and the US right now." Never
  // silence, never a foreign role. sendGuarded dedupes on (email, "out-of-market", "v1"), so it is sent
  // EXACTLY once ever; a reply with a corrected location flips homeRegion back naturally. Per-record
  // isolation: one failure never aborts the run, and this never blocks the daily role flow.
  for (const c of outOfMarket) {
    const to = c.email_config?.notify || c.email;
    const place = typeof c.dossier?.preferences?.home_place === "string" ? c.dossier.preferences.home_place : "";
    if (dryRun) { log(`${c.email}: DRY RUN — would send out-of-market note (place: ${place || "?"})`); continue; }
    try {
      const msg = renderOutOfMarket({ email: c.email, name: c.dossier?.name || "", place });
      const payload = { from, to, subject: msg.subject, html: msg.html, text: msg.text, headers: { "List-Unsubscribe": `<${unsubUrlFor(c.email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
      const check = ResendSendPayload.safeParse(payload);
      if (!check.success) { log(`${c.email}: out-of-market note malformed — skip (${check.error.issues.map((i) => i.path.join(".")).slice(0, 3).join(", ")})`); continue; }
      const r = await sendGuarded({ resend, email: c.email, template: "out-of-market", dedupeKey: "v1", payload, to, idempotencyKey: `out-of-market/${c.email}`, log });
      log(`${c.email}: out-of-market note ${r.status} (place: ${place || "?"}) -> ${to}`);
    } catch (e) {
      log(`${c.email}: out-of-market note FAILED ${e.message} (retry next run)`);
      captureError(e, { service: "scheduler", kind: "out_of_market_send_failed", email: c.email });
    }
  }

  if (!candidates.length) {
    log("no active users to process. Nothing to do.");
    return;
  }
  log(`run start: ${candidates.length} active user(s) x ${jobs.length} jobs`);

  const users = candidates.map((c) => ({
    email: c.email,
    email_config: c.email_config || {},
    dossier: c.dossier, // structured, for the per-user pre-filter (role family, remote, seniority…)
    dossierText: JSON.stringify(c.dossier, null, 2),
  }));

  // 1) batch match (Haiku + caching + caps). One batch for the whole run.
  const { byEmail, cost: matchCost, batchId, syntaxDrops, semanticSkips, constrained: matchConstrained, deferred: matchDeferred } = await runMatchBatch({ matcherPrompt, users, jobs, log });

  // NOTHING WAS SCORED. runMatchBatch returns `deferred: true` when a batch is still running — either
  // a batch parked by an earlier run that has not ended yet, or one that outlived this run's poll
  // deadline. In both cases `byEmail` is EMPTY, on purpose: the batch is parked and the next run
  // collects it.
  //
  // Returning here means no user is judged, so no user can be "below the bar", no coverage alarm can
  // fire, and no KPI row can claim a 0% match rate for a batch that simply has not finished. It is
  // Sentry-loud because a run that scores nobody IS a real event — and deliberately does NOT ping the
  // match_send heartbeat, so a batch that never lands eventually goes quiet to the external monitor
  // instead of reporting health.
  if (matchDeferred) {
    log(`[match] batch ${batchId || "?"} has not finished — NOTHING WAS SCORED this run. No one was judged, so no one is "below the bar". The batch is parked; the next run collects it.`);
    captureError(new Error(`match batch ${batchId || "?"} deferred — 0 of ${users.length} user(s) scored this run; the parked batch is collected by the next run`), { service: "scheduler", kind: "match_deferred", batchId: batchId || null, users: users.length });
    return;
  }

  // 2-4) per user: pick top NEW above-bar role, compose, email.

  // Stage-1 requirement lists are a pure function of the POSTING, so one cache per run is shared by
  // every user who sees the same role. Empty and unused when FIT_SEND_MODE=off.
  const fitCache = new Map();
  log(fitAuthorityBanner());
  log(`[role-ask] mode=${roleAskMode()}`);
  let emailed = 0;
  let skipped = 0;
  let failed = 0;
  let composeCalls = 0;
  let digested = 0; // users who got >=1 role saved for the weekly digest today
  let silentNoSend = 0; // active users who got NOTHING today (no role, no digest) — the invariant breach
  const silentUsers = []; // their emails, for the coverage alarm
  let groundingHeld = 0; // sends held back by the grounding verifier (moat: uncited claim caught)
  let groundingDropped = 0; // individual claims removed by cite-or-drop (drop mode only)
  // Why the fit chart did or did not render, per send. `hidden:cov_thin` alone cannot separate a
  // sparse profile, a vague posting and an errored Sonnet call, which have opposite fixes, so the
  // reason is counted here.
  const readoutCensus = {};
  let coverageErrors = 0;
  // WHY EACH PERSON GOT WHAT THEY GOT — one row per user per run, from a closed set. "Nothing above
  // the bar", "every candidate held" and "never reached the walk" all look like silence afterwards and
  // have opposite fixes; `silentNoSend` counts the breach, this says WHAT it was.
  //
  // NO GAP BY CONSTRUCTION: `outcome` starts at "unrecorded" and is tallied in a `finally`, so every
  // path out of the loop body is counted — including a `continue` added by a future edit that forgets
  // to set it, and including a throw. An unlabelled exit shows up as `unrecorded` rather than
  // silently vanishing from the total.
  const outcomes = {};
  const tally = (k) => { outcomes[k] = (outcomes[k] || 0) + 1; };

  for (const u of users) {
    // The find we are actively sending, hoisted so the catch below can record the failure ON THAT ROW.
    // Left at 'new' it reads as a delivered send forever (see the catch).
    let sendFindId = null;
    let outcome = "unrecorded";
    try {
      const scored = byEmail.get(u.email) || [];
      const above = scored.filter((j) => j.passed_bar);
      if (!above.length) {
        skipped++;
        silentNoSend++; // got nothing today: no role cleared the bar (the biggest silent bucket)
        silentUsers.push(u.email);
        log(`${u.email}: nothing above the bar`);
        outcome = "no_role_above_bar";
        continue;
      }
      // Cadence cap: ONE role email/day for everyone, TWO/day for confirmed Club members. The engine
      // runs once a day (13:00 UTC), so this is the per-day backstop (and enforces the Club 2/day perk);
      // count today's (UTC) emailed roles and stop at the cap.
      const dayStartUTC = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
      const dailyCap = u.email_config?.vip_confirmed_at ? 2 : 1;
      const sentToday = await countEmailedSince(u.email, dayStartUTC).catch(() => 0);
      if (sentToday >= dailyCap) {
        skipped++;
        log(`${u.email}: daily cap reached (${sentToday}/${dailyCap}${u.email_config?.vip_confirmed_at ? " club" : ""}) — skip`);
        outcome = "cadence_capped";
        continue;
      }
      const handled = await getFindIds(u.email);
      // Full dedup fingerprint (apply_url identity + roleKey + core + company recency) across
      // everything already emailed/queued — the authoritative no-repeat check lives in preSendGuard.
      const signatures = await getEmailedRoleSignatures(u.email);
      // Candidate roles: above the bar, this exact id not yet handled, and not a repeat by ANY vector
      // (a retitled repost with a new id is the exact production leak — repeatDecision catches it).
      const candidates = above.filter((j) => !handled.has(`${u.email}:${j.id}`) && !repeatDecision(j, signatures));
      if (!candidates.length) {
        skipped++;
        log(`${u.email}: top roles already emailed`);
        outcome = "all_candidates_already_sent";
        continue;
      }

      // Respect the do-not-send list (bounces/complaints) before spending on compose.
      const to = u.email_config?.notify || u.email;
      if (await isSuppressed(to)) {
        skipped++;
        log(`${u.email}: recipient ${to} is suppressed (bounce/complaint) — skipping`);
        outcome = "recipient_suppressed";
        continue;
      }

      // Quality Gate: walk candidates best-first and send the FIRST that is live + location-reachable
      // + clears the fit floor. Roles that fit the profile but miss on location or the fit floor are
      // recorded for the weekly digest (status 'digest'); dead/closed postings are dropped.
      // computeCoverage runs only for live+reachable roles.
      const GATE_SCAN = Number(process.env.GATE_SCAN || 6);
      // Matcher rank = the score-sorted position (candidates arrive score-sorted from match-batch).
      // Stamp it BEFORE any reorder so `slot` always records the MATCHER's rank, not the walk order.
      // Freshness in the SEND decision: every candidate here already cleared the bar, so preferring the
      // freshest among them surfaces fresher roles without lowering fit. Shadow-first (FRESHNESS_MODE):
      // logs the would-be reorder, changes nothing, until enforce.
      candidates.forEach((c, idx) => { c._matcherRank = idx + 1; });
      let walk = candidates;

      // ORDER OF THE TWO RE-RANKERS. They compose, cheapest first:
      //   1. freshness reorders the whole candidate list (pure CPU on data already in hand).
      //   2. pairwise then reorders the top GATE_SCAN of THAT list. pairwiseReorder returns
      //      [...reordered head, ...untouched tail], so it composes rather than replaces.
      // Running pairwise first and then freshness over the ORIGINAL array would discard the pairwise
      // result while still paying for it.
      //
      // Pairwise order is the less proven of the two; if click-per-send drops, it is the first thing
      // to turn off (PAIRWISE_RANK=off).
      if (freshnessMode() === "enforce") {
        walk = freshnessReorder(walk);
      } else if (freshnessMode() === "shadow") {
        const blended = freshnessReorder(walk);
        if (blended[0] && walk[0] && blended[0].id !== walk[0].id) {
          log(`[freshness shadow] ${u.email}: WOULD prefer ${blended[0].company} — ${blended[0].title} (fresher) over score-top ${walk[0].company} — ${walk[0].title}`);
        }
      }
      // Order the shortlist by "which of these two", not by a score that cannot rank: most above-bar
      // roles carry an IDENTICAL score, so the walk order would otherwise be drawn from a near-total
      // tie. Pairwise comparison over the top GATE_SCAN gives a real order in ~O(n log n) small calls.
      // Every candidate here still goes through the FULL gate unchanged; this only decides which of
      // the acceptable ones is offered first. Fails open to the incoming order on any error.
      if (pairwiseMode() !== "off") {
        const before = walk;
        const pr = await pairwiseReorder(walk, u.dossier, { limit: GATE_SCAN, log });
        if (pairwiseMode() === "on") {
          walk = pr.order;
          if (pr.changed) log(`[pairwise] ${u.email}: reordered top ${GATE_SCAN} in ${pr.comparisons} comparison(s) — now leading with ${pr.order[0]?.company} — ${pr.order[0]?.title}`);
        } else if (pr.changed) {
          log(`[pairwise shadow] ${u.email}: WOULD lead with ${pr.order[0]?.company} — ${pr.order[0]?.title} instead of ${before[0]?.company} — ${before[0]?.title} (${pr.comparisons} comparisons)`);
        }
      }
      let job = null;
      let cov = null;
      const fitRecords = new Map(); // jobId -> the engine's decision record, persisted with the find
      let sentSlot = null; // the sent role's matcher rank (stamped above, walk-order-independent)
      let sendRule = null; // the machine-readable gate name that said SEND (see the _decision record)
      const digestPicks = [];
      // Every role this walk actually judged, in the order it judged them. A sent role's record has to
      // be able to say what it was chosen OVER, not just that it passed: "why this role for this
      // person" is a comparative claim.
      const considered = [];
      for (const cand of walk.slice(0, GATE_SCAN)) {
        const g = await preSendGuard({
          job: cand,
          dossier: u.dossier,
          matcherScore: cand.match?.score,
          signatures,
          getCov: () => computeCoverage({ dossier: u.dossier, jobDescription: cand.description, jobTitle: cand.title }).catch((e) => ({ thin: true, reason: "error", error: e?.message })), // never an anonymous thin (see fit-coverage.mjs)
        });
        considered.push({ company: cand.company ?? null, title: cand.title ?? null, slot: cand._matcherRank ?? null, retrieval_rank: typeof cand._retrievalRank === "number" ? cand._retrievalRank : null, outcome: g.decision, rule: g.rule ?? null });
        if (g.decision === "send") {
          // THE FIT ENGINE VETO. Runs ONLY on a role the gate has already approved, and can only turn
          // that send into a hold — never a hold into a send (lib/fit-veto.mjs). With FIT_SEND_MODE=off
          // (the default) this is a single function call that returns immediately: no model call, no
          // cost, and the branch below behaves exactly as it did before this existed.
          const fv = await fitVeto({ email: u.email, dossier: u.dossier, job: cand, cache: fitCache, log });
          if (fv.record) fitRecords.set(cand.id, fv.record);
          if (fv.veto) {
            considered[considered.length - 1].outcome = "drop";
            considered[considered.length - 1].rule = "fit_engine_veto";
            log(`${u.email}: FIT VETO ${cand.company} — ${cand.title}`);
            continue;
          }
          job = cand; cov = g.cov; sentSlot = cand._matcherRank; sendRule = g.rule ?? null; log(`${u.email}: gate SEND ${cand.company} — ${cand.title} (${g.reason})`); break;
        }
        // KEEP g.cov. It was computed to make THIS decision; carrying it costs nothing and lets the
        // market-gap insight reuse it instead of re-scoring the same roles on a second model pass.
        if (g.decision === "digest") { digestPicks.push({ cand, rule: g.rule, reason: g.reason, slot: cand._matcherRank, cov: g.cov ?? null }); log(`${u.email}: gate DIGEST ${cand.company} — ${cand.title} [${g.rule}] (${g.reason})`); }
        else log(`${u.email}: gate DROP ${cand.company} — ${cand.title} (${g.reason})`);
      }
      // Record near-misses for the weekly digest (status 'digest' → marked handled so they're never
      // re-gated, and the digest email reads them). Best-effort; a store miss doesn't block.
      // A DRY RUN writes 'dry_run' instead: a preview must not queue mail the weekly digest would then
      // actually send, and must not poison repeatDecision (see the send-candidate write below).
      for (const d of digestPicks) {
        // `_cov` mirrors the SENT path (see the send-candidate write below), so a near-miss carries the
        // same coverage record as a hit. Additive only: no gate decision, no send, and no existing field
        // changes, so a reader that ignores _cov behaves exactly as before.
        await upsertFind({ email: u.email, jobId: d.cand.id, job: (({ match: _m, passed_bar: _p, ...r }) => r)(d.cand), match: d.cand.match, composed: { digest_rule: d.rule, digest_reason: d.reason, _cov: d.cov ?? null }, status: dryRun ? "dry_run" : "digest", slot: d.slot }).catch(() => {});
      }
      if (!job) {
        skipped++;
        if (digestPicks.length > 0) digested++; // got a weekly-digest near-miss
        else { silentNoSend++; silentUsers.push(u.email); } // nothing at all today — invariant at risk
        log(`${u.email}: no role passed the quality gate today (${digestPicks.length} saved for the digest)`);
        outcome = digestPicks.length > 0 ? "walk_all_held_to_digest" : "walk_all_dropped";
        continue;
      }

      const { match, passed_bar, ...rawJob } = job;
      // THE ONE QUESTION. Derived from `match`, which the line above has just unpacked: no model call,
      // no I/O. `off` skips it entirely; `shadow` computes and persists without rendering; `on` renders.
      //
      // THE DESTRUCTURE MUST STAY ABOVE THIS CALL: `askFor(match)` above it reads `match` in its
      // temporal dead zone and throws for every user the moment ROLE_ASK is anything but `off` (the
      // ternary hides it while the flag is off). role-ask.test.mjs asserts this ordering mechanically.
      const askMode = roleAskFor(u.email);
      const ask = askMode === "off" ? null : askFor(match);
      if (ask) log(`[role-ask] ${u.email}: ${askMode} · from ${ask.source} · "${ask.span.slice(0, 70)}"`);
      const companyInsight = await lookupCompany(rawJob.company, { jobHint: rawJob.title });
      // Edge Engine: decide rare-find BEFORE composing so the composer is given the edge and
      // writes the grounded opening line (edge_frame). Deterministic gate in code; grounded copy in the
      // prompt. Off / no edge -> no edge block, edge_frame stays null, email is exactly as before.
      const isRareFind = await edgeHit(u.dossier, rawJob); // model-verified + fail-closed
      let fields = await composeEmailFields(u.dossierText, JSON.stringify(rawJob, null, 2), { match, companyInsight, edge: isRareFind ? u.dossier.edge : null, screen: screenForComposer(cov) });
      composeCalls++;
      const unsubUrl = unsubUrlFor(u.email);
      // tailored resume + cover letter ride along with the role (best-effort; [] if it fails)
      const resumeText = await getResume(u.email).catch(() => null);

      // Explainable fit Readout: the grounded coverage the Quality Gate already computed for THIS
      // role (met / partly / not-shown + composite + lane + one move) is reused here — no second
      // Sonnet pass. thin JD/profile → { thin:true } and the email falls back to the composer's prose.
      if (!cov) cov = { thin: true };

      // honesty gate: re-check the composed claims about the person against their source. When the
      // Readout is live its asserted strengths + move are claims about the person too, so they ride
      // through the SAME grounding verifier.
      const covClaims = cov && !cov.thin
        ? { fit_reason: cov.reason, fit_move: cov.topMove, fit_met: (cov.coverage || []).filter((r) => r.status === "met").map((r) => `${r.req}: ${r.evidence || ""}`) }
        : {};
      const verdictGrounding = await verifyGrounding({
        sourceText: `${u.dossierText}\n\nRESUME:\n${resumeText || ""}`,
        // edge_frame (the rare-find opening) is a claim about the person -> same send-time grounding
        // check, but only the one that will actually render (isRareFind), never an over-produced/unshown one.
        // lede is included because render-email.mjs shows it under the "Why you" label when why_you is
        // absent or pruned — so it is a claim about the person and must clear the same bar.
        artifactText: JSON.stringify({ why_you: fields.why_you, lede: fields.lede, resume_tips: fields.resume_tips, facts: fields.facts, edge_frame: isRareFind ? fields.edge_frame : null, ...covClaims }),
      });
      if (verdictGrounding.violations?.length) {
        log(`[verify] ${u.email}: ${verdictGrounding.severity} — ${verdictGrounding.violations.slice(0, 4).map((x) => `"${x.claim}" (${x.issue})`).join(" | ")}`);
      }
      // Uncertainty is ALWAYS a hold — a verifier that errored/timed out is not a clean bill (fail-closed).
      if (verdictGrounding.errored) {
        skipped++;
        groundingHeld++;
        log(`${u.email}: HELD — grounding verifier could not confirm (errored: ${verdictGrounding.reason || "no reason given"}); find left for review`);
        outcome = "grounding_held";
        continue;
      }
      // Cite-or-drop: the verifier NAMED specific ungrounded claims → remove exactly those.
      const mode = groundingMode();
      const pruned = verdictGrounding.violations?.length ? citeOrDrop(fields, cov, verdictGrounding.violations) : null;

      // The decision is a pure function (grounding-enforce.mjs) so it can be tested without a send.
      // Ordering is the point: the HOLD is evaluated FIRST and in every mode, so no mode can ship a
      // high-severity or unverifiable claim.
      const decision = groundingDecision(verdictGrounding, pruned, mode, shouldHold);

      if (decision === "hold") {
        skipped++;
        groundingHeld++;
        // Name the flagged claims. A daily send that silently vanishes is undiagnosable otherwise,
        // and the verifier is non-deterministic on borderline artifacts (same role, different roll).
        const named = (verdictGrounding.violations || []).map((v) => (typeof v === "string" ? v : v.claim || JSON.stringify(v))).slice(0, 3).join(" || ") || "none named";
        const why = pruned && pruned.dropped.length === 0 ? "flagged a claim cite-or-drop could not localize" : `severity=${verdictGrounding.severity}`;
        log(`${u.email}: HELD by grounding verifier — not sent, find left for review. ${why} | flagged: ${named}`);
        outcome = "grounding_held";
        continue;
      }

      if (decision === "prune") {
        // Enforce: remove exactly the flagged claims and send the grounded remainder.
        fields = pruned.fields;
        cov = pruned.cov;
        groundingDropped += pruned.dropped.length;
        log(`${u.email}: cite-or-drop removed ${pruned.dropped.length} ungrounded claim(s): ${pruned.dropped.join(" | ")}`);
        if (pruned.allFitDropped) {
          // Nothing grounded left to say about the fit. HOLD — never substitute a neutral line just
          // to have something to send. The find stays 'new', so the role is still a candidate
          // tomorrow when the posting or the profile may support a real reason.
          skipped++;
          groundingHeld++;
          log(`${u.email}: ALL fit claims dropped → HELD, not sent (silence beats a reason-less email)`);
          captureError(new Error(`grounding: all fit claims dropped for ${u.email} (${rawJob.company})`), { service: "scheduler", kind: "grounding_all_dropped", email: u.email, jobId: rawJob.id });
          outcome = "grounding_held";
          continue;
        }
      } else if (pruned) {
        // "send" with claims still flagged — only reachable via the shadow/hold opt-outs. Loud, because
        // this state ships ungrounded claims while looking healthy.
        log(`${u.email}: ⚠ [grounding ${mode}] SENDING with ${pruned.dropped.length} flagged claim(s) NOT removed: ${pruned.dropped.join(" | ")}`);
      }

      // Nothing is attached except a drafted intro when a referral resolves.
      const attachments = [];
      // Grounded market weave: of this role's real gaps, which skill shows up in the most of the
      // roles this user matches? A literal count over `above` (their above-bar cluster). null when
      // thin, so nothing is forced. See market-weave.mjs.
      const weave = skillUnlock({ cov, cluster: above });
      if (weave) log(`${u.email}: weave — ${weave.skill} in ${weave.n}/${weave.total} matched roles`);
      // Label badge: "Fresh pick" when the posting is genuinely new (posted within the fresh window,
      // ~one scan cycle), otherwise "Today's pick". Both are above-bar sends; the badge just tells the
      // reader whether this one just landed. FRESH_PICK_HOURS is env-tunable.
      const FRESH_PICK_HOURS = Number(process.env.FRESH_PICK_HOURS || 12);
      const postedMs = Date.parse(rawJob.posted_at || "");
      // Edge Engine (dark): a role in the space where the person's grounded rare combo wins earns
      // the "Rare find" badge over Fresh pick / Best match. `isRareFind` was computed above (before compose).
      const label = isRareFind ? RARE_FIND_LABEL : (postedMs && Date.now() - postedMs <= FRESH_PICK_HOURS * 3600e3 ? "Fresh pick" : "Today's pick");
      // US-only enrichment (grounded, fail-open): pay-vs-market (posting range + BLS anchor) and
      // hiring momentum (open reqs on their own ATS). Computed only for US candidates; India-based
      // candidates never see these blocks (homeRegion gate). Never blocks a send.
      const region = homeRegion(u.dossier);
      const pay = region === "us" ? await computePay(rawJob).catch(() => null) : null;
      const momentum = region === "us" ? await computeMomentum(rawJob.company, jobs).catch(() => null) : null;
      // Region-gated inline referral (REFERRAL_REGIONS; fail-closed at verified + high-confidence +
      // in-region + LinkedIn): the "One person to ask" box + the drafted intro message rides along as
      // an attachment. Best-effort; never blocks the send.
      let referral = null;
      if (referralRegionAllowed(region)) {
        const rr = await resolveInlineReferral({ email: u.email, dossier: u.dossier, company: rawJob.company, jobUrl: rawJob.apply_url || rawJob.url, roleTitle: rawJob.title, location: rawJob.location, region, owner: !!process.env.OWNER_EMAIL && u.email === process.env.OWNER_EMAIL }).catch(() => null);
        if (rr) { referral = rr.referral; if (rr.introAttachment) attachments.push(rr.introAttachment); }
      }
      // The LAST word on fit content, on every path (not only when the verifier flagged something).
      // The cite-or-drop fallback above lives inside the prune branch, so a composer that simply
      // returns why_you: null with nothing flagged skips it; then, if the posting is also too thin to
      // score, the renderer would fall back to the generic LEDE under the heading "Why you" — an
      // email that says nothing about the person.
      const fitShown = readoutStatus(cov, rawJob.description) === "shown";
      if (!hasFitContent(fields, { readoutShown: fitShown })) {
        skipped++;
        groundingHeld++;
        log(`${u.email}: no fit content (readout hidden + no why_you) → HELD, not sent`);
        captureError(new Error(`no fit content for ${u.email} (${rawJob.company})`), { service: "scheduler", kind: "no_fit_content", email: u.email, jobId: rawJob.id });
        outcome = "grounding_held";
        continue;
      }
      const html = renderEmail({ askLine: askMode === "on" && ask ? ask.question : null, fields, match, cov, weave, label, applyUrl: rawJob.apply_url, via: rawJob.via, viaUrl: rawJob.via_url, unsubUrl, email: u.email, findId: `${u.email}:${rawJob.id}`, jobDescription: rawJob.description, jobLocation: rawJob.location, region, pay, momentum, postedAt: rawJob.posted_at, referral, edgeFrame: isRareFind ? (fields.edge_frame || null) : null, proAsked: proAskedSet.has(String(u.email || "").toLowerCase()), rawCompensation: rawJob.compensation, employmentType: rawJob.employment_type });
      // Email-trust telemetry: record why the two gated sections did/didn't render (same inputs as the
      // renderer). The cov `reason` rides along, because "hidden:cov_thin" alone cannot tell a sparse
      // profile from a vague posting from an errored call, and those have opposite fixes.
      const fitStatus = readoutStatus(cov, rawJob.description);
      readoutCensus[cov?.thin ? `${fitStatus}:${cov.reason || "unspecified"}` : fitStatus] = (readoutCensus[cov?.thin ? `${fitStatus}:${cov.reason || "unspecified"}` : fitStatus] || 0) + 1;
      if (cov?.reason === "error") {
        // OUR failure, invisible in the email, and capable of reaching 100% during an API incident while
        // every send still reports success. Not a warning in a log that rolls away: an alarm.
        coverageErrors++;
        captureError(new Error(`fit coverage errored for ${u.email} (${rawJob.company}) — the email ships without its fit chart: ${cov.error || "no message"}`), { service: "scheduler", kind: "coverage_error", email: u.email, jobId: rawJob.id });
      }
      console.error(`[email-trust] ${u.email}: fit=${fitStatus}${cov?.thin && cov.reason ? `(${cov.reason})` : ""} referral=${referralStatus(region, referral)}`);

      // Record the find BEFORE sending (status 'new' = handled → dedup; on send it flips to 'emailed').
      //
      // A DRY RUN records it as 'dry_run', which getEmailedRoleSignatures does not read. A preview
      // written as 'new' would make repeatDecision answer "already sent this posting" forever, so a
      // preview would permanently burn the very role it was showing.
      //
      // `_cov` PERSISTS THE FIT CHART'S DATA. It is the most expensive thing this run produces (a
      // Sonnet call); stored here it costs $0 extra and a few KB, and any later re-render of this find
      // keeps the chart instead of falling back to prose. Namespaced with an underscore so it cannot be
      // mistaken for a composer field by anything that reads `composed`.
      // The sent role's own justification, alongside the composed email. Additive: `_cov` and every
      // composer field are untouched, so anything reading `composed` today behaves exactly as before.
      const sendDecision = decisionRecord({
        rule: sendRule, job: rawJob, match, cov, slot: sentSlot, considered,
        rankedBy: [freshnessMode() === "enforce" && "freshness", pairwiseMode() === "on" && "pairwise"].filter(Boolean),
      });
      const findId = await upsertFind({ email: u.email, jobId: rawJob.id, job: rawJob, match, composed: { ...fields, _cov: cov ?? null, _decision: sendDecision, _fit: fitRecords.get(rawJob.id) ?? null, _ask: ask ? { ...ask, mode: askMode } : null }, status: dryRun ? "dry_run" : "new", slot: sentSlot });
      if (!dryRun) sendFindId = findId; // the catch below owns this row until the send resolves it
      const subject = cleanSubject(
        isRareFind
          ? rareFindSubject({ roleTitle: fields.role_title || rawJob.title, company: fields.company || rawJob.company })
          : fields.subject || `Found one worth your time: ${fields.role_title || rawJob.title} at ${fields.company || rawJob.company}`,
      );
      const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);

      if (dryRun) {
        emailed++;
        log(`${u.email}: DRY RUN — would email "${subject}" (${kb} KB, ${attachments.length} attachment(s)) to ${to}; find ${findId} saved 'dry_run' (does not block a later real send)`);
        outcome = "emailed_dry_run";
        continue;
      }

      // Idempotency key: a given find is never double-sent even if the run retries.
      // Standalone: a unique Message-ID + no References, so each daily role is its own thread (distinct
      // role subjects already keep them apart; this guarantees Gmail never folds them together).
      // Reply signal: route a "still chasing this one" reply to the signed chase+<token>@ address so it
      // logs against the exact role (dark until REPLY_SIGNAL=on; omitted when the token can't be built).
      const chaseTo = REPLY_SIGNAL ? chaseReplyTo({ email: u.email, jobId: rawJob.id, from }) : null;
      const payload = { from, to, subject, html, headers: { "Message-ID": newMessageId("role"), "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, ...(chaseTo ? { replyTo: chaseTo } : {}), ...(attachments.length ? { attachments } : {}) };
      // Boundary: refuse a structurally broken send (empty from/to/subject/html) before it reaches
      // Resend. Throwing here is fail-closed: the find stays 'new' and retries next run.
      const check = ResendSendPayload.safeParse(payload);
      if (!check.success) {
        throw new Error(`refusing malformed send (find ${findId}): ${check.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`);
      }
      // The ONE send door: suppression + sent_emails idempotency + the physical send.
      const sent = await sendGuarded({ resend, email: u.email, template: "role", dedupeKey: findId, payload, to, idempotencyKey: `find-alert/${findId}`, log });
      // A failure throws to the catch below, which flips this row to 'send_failed' — a status the
      // repeat guard does NOT read, so the role is offered again next run. Left 'new', it would cost
      // the person that role permanently.
      if (sent.status === "failed") throw new Error(typeof sent.error === "string" ? sent.error : JSON.stringify(sent.error));
      if (sent.status === "suppressed") { skipped++; outcome = "recipient_suppressed"; continue; } // do-not-send; nothing to record
      // sent OR duplicate (already sent in a prior run) -> the find is emailed; never re-send it.
      await setFindStatus(u.email, findId, "emailed");
      if (sent.status === "duplicate") { log(`${u.email}: role ${findId} already sent (idempotency) — marked emailed`); outcome = "emailed"; continue; }
      emailed++;
      outcome = "emailed";
      log(`${u.email}: emailed ${match?.score ?? "?"} · ${rawJob.company} · ${rawJob.title} -> ${to} (resend ${sent.id || "?"})`);
      // Post-send self-audit (best-effort, never throws, never auto-corrects): flag a hard-constraint miss
      // to a human. Runs AFTER the send so it cannot affect it.
      await postSendAudit({ dossier: u.dossier, role: rawJob, email: u.email, surface: "daily-role", log, capture: captureError });
    } catch (e) {
      failed++;
      outcome = "error";
      // Record the failure ON THE ROW. 'new' is an in-flight marker that getEmailedRoleSignatures reads
      // as a prior send, so a row left 'new' answers "already sent this posting" forever and the person
      // never gets that role. 'send_failed' is outside the signature status set, so the role comes back
      // into play on the next run — and the watchdog counts it as `stuck`, so the failure stays loud.
      // Best-effort: if this write also fails the STALE_NEW_HOURS expiry in charlie-store.mjs is the
      // backstop, which is also what covers a crash that never reaches this catch at all.
      let recorded = "";
      if (sendFindId) {
        recorded = await setFindStatus(u.email, sendFindId, "send_failed").then(
          () => ` (find ${sendFindId} marked 'send_failed' — the role is offered again next run)`,
          (err) => ` (could not mark find ${sendFindId}: ${err.message}; it expires from the repeat guard in ${STALE_NEW_HOURS}h)`,
        );
      }
      log(`${u.email}: FAILED ${e.message}${recorded}`);
      captureError(e, { service: "scheduler", kind: "send_failed" });
    } finally {
      // THE TALLY LIVES IN `finally`, NOT AT EACH EXIT. A `continue` inside the try runs this on its
      // way out, and so does a throw the catch above handles. That is the whole point: the count can
      // never disagree with `users.length`, and an exit somebody adds later without labelling it lands
      // in `unrecorded` instead of quietly disappearing. `outcome` is per-iteration, declared at the
      // top of the loop body, so no value can leak from one user to the next.
      tally(outcome);
      if (outcome === "unrecorded") log(`${u.email}: OUTCOME UNRECORDED — an exit path is not labelled (scheduler.mjs)`);
    }
  }

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  // The outcome census, sorted commonest-first, printed on EVERY run including dry runs, so "N people
  // got silence" is broken down by cause.
  const census = Object.entries(outcomes).sort((a, b) => b[1] - a[1]);
  const censusTotal = census.reduce((n, [, v]) => n + v, 0);
  log(`outcomes: ${census.map(([k, v]) => `${k}=${v}`).join(" ") || "none"} · total=${censusTotal}/${users.length}${censusTotal === users.length ? "" : " ⚠ TALLY DOES NOT MATCH THE USER COUNT"}`);
  log(
    `run done in ${secs}s · users=${users.length} emailed=${emailed} skipped=${skipped} failed=${failed} · ` +
      `fit chart ${Object.entries(readoutCensus).map(([k, v]) => `${k}=${v}`).join(" ") || "n/a"}${coverageErrors ? ` ⚠ ${coverageErrors} coverage ERROR(S) — those emails shipped without a fit chart` : ""} · ` +
      `match batch ${batchId || "n/a"} ~$${(matchCost || 0).toFixed(4)} + ${composeCalls} Sonnet compose call(s)`,
  );

  // Append today's KPI snapshot to the rolling history (Supabase kpi.json). This is
  // the "baseline can't decrease" seatbelt — pure observation, best-effort (a store miss logs and
  // never fails the run). Skipped in dry runs (no real send outcomes to record).
  if (!dryRun) {
    try {
      const kpi = computeMatchKpis(byEmail);
      const snapshot = {
        date: new Date().toISOString().slice(0, 10),
        users_active: users.length,
        scored: kpi.scored,
        passed_bar: kpi.passed_bar,
        match_positive_rate: kpi.match_positive_rate,
        borderline_share: kpi.borderline_share,
        // Where the above-bar roles sat in RETRIEVAL, measured live rather than replayed. This is the
        // prerequisite for ever touching K: a replay cannot separate a bad ranker from a drifting one.
        retrieval: computeRetrievalRankKpis(byEmail),
        // The precondition for MATCH_CONSTRAINED_DECODE=on, made readable: flip it once a shadow
        // batch shows syntax drops -> 0. null = no batch ran today (not "zero drops").
        decode: { constrained: matchConstrained ?? null, syntax_drops: syntaxDrops ?? null, semantic_skips: semanticSkips ?? null },
        cost_usd: { match: Number((matchCost || 0).toFixed(4)) },
        outcomes: { role_sent: emailed, digested, silent_no_send_users: silentNoSend, grounding_held: groundingHeld, grounding_dropped: groundingDropped, skipped, failed },
        // WHY each person got what they got, from the closed set in the loop above. `skipped` counts
        // the silence; this splits it, because the biggest buckets have opposite fixes.
        outcome_census: outcomes,
        // The fit chart's render rate, by REASON: sparse profile / vague posting / our own errored
        // call are otherwise indistinguishable, and only the third is a bug we can fix.
        fit_readout: readoutCensus,
        coverage_errors: coverageErrors,
        silent_no_send: silentNoSend > 0,
      };
      const history = await loadKpiHistory();
      await saveKpiHistory(mergeKpiHistory(history, snapshot));
      log(formatKpiLine(snapshot));
    } catch (e) {
      log(`KPI snapshot skipped (non-fatal): ${e.message}`);
    }
  }

  // Silent-no-send coverage sweep. The retention invariant is that no ACTIVE user is left
  // with nothing (role email, digest near-miss, or — future — an explicit no-send notice). This run
  // already knows each user's outcome, so the "sweep" is just: did anyone get nothing? If so, ALERT
  // (Sentry, so it's never silent + trends by day) and ping the coverage heartbeat's /fail endpoint.
  // Dry runs don't send, so they can't breach coverage.
  // Prompt-cache proof line. The gate walk re-sends one user's dossier up to GATE_SCAN times, and the
  // fit prompt marks that prefix cacheable — but the API declines silently when the shape is wrong, so
  // the only way to know it worked in PRODUCTION is to count it. Prints on dry runs too: that is how a
  // targeted ONLY_EMAIL rerun can prove the mechanism without sending anyone an email.
  const fc = coverageCacheStats();
  if (fc.calls) {
    log(`fit-cache: ${fc.calls} call(s) · ${fc.read} tok read · ${fc.write} tok written · ${fc.uncached} tok full-price · hit-rate ${fc.hitRate}`);
    if (fc.calls > users.length && fc.read === 0) log(`⚠ fit-cache: ${fc.calls} calls and ZERO cache reads — the stable prefix is not caching (check block order / minimum prefix)`);
  }

  if (!dryRun) {
    const covered = emailed + digested;
    log(`coverage: ${covered}/${users.length} served (${emailed} role · ${digested} digest) · ${silentNoSend} got NOTHING`);
    if (silentNoSend > 0) {
      captureError(new Error(`coverage: ${silentNoSend}/${users.length} active user(s) got nothing today (no role, no digest): ${silentUsers.slice(0, 10).join(", ")}${silentUsers.length > 10 ? " …" : ""}`), { service: "scheduler", kind: "silent_no_send", count: silentNoSend, active: users.length });
      await pingHeartbeat("coverage", { fail: true });
      log(`⚠ SILENT NO-SEND: ${silentNoSend} active user(s) got nothing today — alerted`);
    } else {
      await pingHeartbeat("coverage"); // healthy: every active user got a role or a digest
    }
  }

  // heartbeat: the match -> gate -> compose -> send batch completed cleanly.
  await pingHeartbeat("match_send");
}

main().catch(async (e) => {
  console.error("[scheduler] fatal:", e.message);
  captureError(e, { service: "scheduler", kind: "fatal" });
  await flushSentry();
  process.exit(1);
});
