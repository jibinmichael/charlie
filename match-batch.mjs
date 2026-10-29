// match-batch.mjs — the high-volume match/classify step, via the Message Batches API.
//
// Instead of one synchronous Sonnet call per job, we submit
// ALL (user x job) match requests as ONE async batch on Haiku 4.5:
//   - Haiku 4.5: a cheap, fast model that is right-sized for a scoring/classification
//     task (vs Sonnet for the compose step, Opus for the one-off dossier build).
//   - Batch API: -50% on input + output vs synchronous.
//   - Prompt caching: the shared matcher prompt and the per-user dossier are sent as
//     cache_control system blocks, so matching many jobs against one dossier reads the
//     cached prefix (0.1x) instead of re-billing it each call. NOTE: Haiku's minimum
//     cacheable prefix is large (~4k tokens), so caching only bites when the matcher
//     prompt + dossier clear that floor; below it, it's a harmless no-op and the win
//     comes from Haiku + batch alone.
//
// Cost-safety: hard caps on jobs/user, users/run, and total batch size, plus an
// estimated-cost ceiling that ABORTS before submitting. Every cap and the estimate
// are logged — nothing is silently truncated.

import Anthropic from "@anthropic-ai/sdk";
import { selectForUser, tagCompanyReach, personBlob } from "./select-jobs.mjs";
import { blindDossierText } from "./lib/blind-dossier.mjs"; // the scorer never sees the name
import { semanticRankOn, loadPoolVectors } from "./lib/semantic-rank.mjs";
import { embedTexts } from "./lib/voyage.mjs";
import { buildScoringMessages } from "./prompts/match-scoring.mjs"; // versioned prompt — see prompts/
import { MatchOutput } from "./lib/schemas/match-output.mjs";
import { Dossier } from "./lib/schemas/dossier.mjs"; // boundary validation for the dossier matching consumes
import { captureError } from "./lib/sentry-node.mjs"; // report serious errors (no-op without SENTRY_DSN)
import { loadPendingBatch, savePendingBatch, clearPendingBatch, getVerdicts, putVerdicts, pruneVerdicts } from "./charlie-store.mjs"; // park a slow batch, collect it next run; + the verdict cache (incremental matching)
import { matchCacheKey, cacheableVerdict } from "./lib/match-cache-key.mjs";
import { pregateCensus, pregateMode } from "./lib/eligibility-pregate.mjs"; // shadow census: what a free gate would have rejected before we paid

const MATCH_MODEL = "claude-haiku-4-5"; // cheap, fast classifier for scoring
const MAX_TOKENS = 1000;

// Constrained decoding. When on, each request carries output_config.format (MatchOutputFormat) so the
// model's JSON is schema-valid by construction and the "unparseable score" syntax-drop class goes to
// zero. Default OFF; flip to "on" after a shadow batch confirms syntax drops fell without a rise in
// semantic skips.
const constrainedDecodeOn = () => String(process.env.MATCH_CONSTRAINED_DECODE || "").toLowerCase() === "on";

// Cost: whether the BATCH path attaches cache_control to the matcher + dossier system prefix. On the
// Batch API the concurrent requests never warm the shared prefix before each other, so cache_control
// likely bills a 1.25x cache-WRITE for a cache nothing reads (see the usage log + cost comment below).
// Default: cache attached. Set MATCH_BATCH_CACHE=off
// (or 0/false/no) to drop it, after one run's log confirms cache_read≈0 / cache_write>0. match-one.mjs
// is unaffected — its sequential per-dossier reuse genuinely warms the prefix, so its caching stays on.
const batchCacheOn = () => !/^(off|0|false|no)$/i.test(String(process.env.MATCH_BATCH_CACHE ?? "").trim());
// Incremental matching: reuse verdicts scored on a PRIOR run for pairs whose inputs are unchanged (the
// bulk of the pool, which is the same roles day to day). DARK by default — needs the match_verdicts
// table migrated AND MATCH_CACHE=on. TTL re-scores a verdict after N days so the
// date line (deliberately absent from the key) can't drift tenure/recency judgments.
const matchCacheOn = () => /^(on|1|true|yes)$/i.test(String(process.env.MATCH_CACHE ?? "").trim());
const matchCacheTtlDays = () => { const n = Number(process.env.MATCH_CACHE_TTL_DAYS); return Number.isFinite(n) && n > 0 ? n : 7; };

// Haiku 4.5 BATCH prices (per the pricing docs, 50% of standard $1/$5): $0.50/$2.50 per MTok.
const PRICE_IN_PER_MTOK = 0.5;
const PRICE_OUT_PER_MTOK = 2.5;
const ASSUMED_OUT_TOKENS = 350; // a score JSON is small; used only for the pre-submit guard

const approxTokens = (s) => Math.ceil((s?.length || 0) / 4); // rough chars -> tokens
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function stripFences(text) {
  let t = (text ?? "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

export const DEFAULT_CAPS = {
  barScore: Number(process.env.MATCH_BAR || 70),
  // Paired with the relevance pre-rank in select-jobs.mjs. The pre-rank puts a person's most-relevant
  // roles first so the cap keeps the best, not the freshest; 300 is the safety margin for
  // cross-functional users, whose best role can be lexically distant from their stated target and thus
  // demoted a little by the deterministic ranker. The extra scoring stays inside MAX_RUN_COST_USD.
  maxJobsPerUser: Number(process.env.MAX_JOBS_PER_USER || 300),
  maxUsers: Number(process.env.MAX_USERS_PER_RUN || 500),
  maxBatchRequests: Number(process.env.MAX_BATCH_REQUESTS || 5000),
  // Sizing: estIn per pair is matcher (~750) + FULL blinded dossier (~1700) + job (~800) ≈ 3250
  // tokens, so a 300-pair user costs ~$0.75 uncached at Haiku-batch prices. 80 is a runaway backstop,
  // not a budget: estCost counts cache MISSES only, and the worst case is a cold cache after a
  // matcher.md or cache-key change. Keep the default in step with .env.example so a service with the
  // var UNSET cannot run a different ceiling from one that sets it.
  maxRunCostUsd: Number(process.env.MAX_RUN_COST_USD || 80),
  pollMs: Number(process.env.BATCH_POLL_MS || 5000),
  // How long to wait for the Message Batches API before giving up: 4h.
  //
  // Anthropic documents the Batch API as "most batches complete within 1 hour; maximum 24 hours", so a
  // slow batch is NORMAL, not a fault, and a deadline below the typical completion time abandons healthy
  // batches. 4h clears that norm with room to spare while still finishing long before the next daily
  // run. A batch that outlives it is parked and collected on the next run (see pendingBatchAction), so
  // a slow batch delays the send rather than cancelling it.
  pollTimeoutMs: Number(process.env.BATCH_TIMEOUT_MS || 4 * 60 * 60 * 1000),
};

/**
 * What to do with a batch parked by an earlier run. Pure so the policy is testable without the API.
 *   "collect" — it finished; read its results instead of paying for a new batch.
 *   "wait"    — still running and young enough that the next run can still collect it; leave it parked.
 *   "discard" — ended badly, or older than the Batch API's documented 24h ceiling, so it will never
 *               produce results. Clear it and run a fresh batch.
 * @param {{createdAt?:string}|null} pending
 * @param {{processing_status?:string}|null} status  batches.retrieve() result, or null if it failed.
 * @param {number} nowMs
 */
export function pendingBatchAction(pending, status, nowMs = Date.now()) {
  if (!pending || !pending.batchId) return "discard";
  if (!status) return "discard"; // can't confirm it exists (deleted/expired/unreachable) — don't block the day on it
  if (status.processing_status === "ended") return "collect";
  // Only a genuinely in-flight batch is worth waiting for. Anthropic documents processing_status as
  // in_progress | canceling | ended, but ANY other value (canceled, expired, or something added
  // later) is treated as terminal-without-results: waiting on it would park the slot forever and
  // starve every future run. Fail forward — discard and run a fresh batch.
  if (status.processing_status !== "in_progress" && status.processing_status !== "canceling") return "discard";
  const age = nowMs - Date.parse(pending.createdAt || "");
  // Anthropic documents a 24h maximum. Past that (or with an unparseable timestamp) it is never
  // finishing. 26h leaves a small margin.
  if (!Number.isFinite(age) || age > 26 * 60 * 60 * 1000) return "discard";
  return "wait";
}

// How close a run may get to a ceiling before it is worth saying so out loud. 0.8 = warn once four
// fifths of the budget is spoken for, which at typical user growth is roughly a day of notice. Not an
// env var on purpose:
// a threshold you can tune is a threshold that gets tuned to silence.
const CEILING_WARN_AT = 0.8;

/**
 * Which run ceilings this batch is approaching. Pure, so the policy is testable without the API — same
 * reason pendingBatchAction above is pure.
 *
 * Returns [] when there is nothing to say. It NEVER decides whether to abort: the hard caps still own
 * that. This only converts "the run died at 02:30 with no warning" into "the run told you yesterday".
 *
 * @param {{requestCount:number, estCost:number, caps:{maxBatchRequests:number,maxRunCostUsd:number}, at?:number}} a
 * @returns {string[]} human-readable warnings, empty when clear
 */
export function capacityWarnings({ requestCount, estCost, caps, at = CEILING_WARN_AT }) {
  const out = [];
  const reqCap = Number(caps?.maxBatchRequests);
  const costCap = Number(caps?.maxRunCostUsd);
  // A missing or nonsensical cap means we cannot judge headroom. Say nothing rather than emit a bogus
  // percentage — a false ceiling alarm trains the reader to ignore the real one.
  if (Number.isFinite(reqCap) && reqCap > 0 && Number.isFinite(requestCount) && requestCount > reqCap * at) {
    out.push(`${requestCount} requests is ${Math.round((requestCount / reqCap) * 100)}% of MAX_BATCH_REQUESTS=${reqCap}`);
  }
  if (Number.isFinite(costCap) && costCap > 0 && Number.isFinite(estCost) && estCost > costCap * at) {
    out.push(`estimated $${estCost.toFixed(2)} is ${Math.round((estCost / costCap) * 100)}% of MAX_RUN_COST_USD=$${costCap}`);
  }
  return out;
}

// users: [{ email, dossierText }]. jobs: [{ id, ... }].
// Returns { byEmail: Map<email, scored[]>, cost, requestCount, batchId }.
export async function runMatchBatch({ matcherPrompt, users, jobs, caps = {}, log = console.error }) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const client = new Anthropic();

  // ── Resume a batch parked by an earlier run ────────────────────────────────────────────────
  // A slow batch is parked and collected here, so the send is DELAYED by a run rather than cancelled,
  // and we never pay twice for scoring we already bought.
  const pending = await loadPendingBatch();
  if (pending) {
    let status = null;
    try { status = await client.messages.batches.retrieve(pending.batchId); } catch (e) { log(`[match] parked batch ${pending.batchId} unreadable: ${e.message}`); }
    const action = pendingBatchAction(pending, status);
    if (action === "collect") {
      // Rebuild the exact index arrays the custom_ids address (`u{i}_j{j}`) from the parked mapping.
      // Jobs are re-hydrated from TODAY's pool by id: a role that has since left the pool is skipped,
      // which is correct — we would not want to send a role that is no longer live anyway.
      const jobById = new Map(jobs.map((j) => [j.id, j]));
      const rUsers = [];
      const rJobs = [];
      let missing = 0;
      for (const e of pending.map) {
        const m = /^u(\d+)_j(\d+)$/.exec(e.custom_id || "");
        if (!m) continue;
        const ui = Number(m[1]);
        const ji = Number(m[2]);
        rUsers[ui] = { email: e.email };
        rJobs[ui] = rJobs[ui] || [];
        const job = jobById.get(e.jobId);
        if (!job) { missing++; continue; }
        rJobs[ui][ji] = job;
      }
      const useUsers = rUsers.filter(Boolean);
      log(`[match] collecting PARKED batch ${pending.batchId} from ${pending.createdAt} — ${useUsers.length} user(s)${missing ? `, ${missing} role(s) no longer in the pool (skipped)` : ""}. No new batch this run.`);
      const collected = await collectBatchResults({ client, batchId: pending.batchId, useUsers: rUsers, perUserJobs: rJobs, c, constrained: constrainedDecodeOn(), cache: batchCacheOn(), log });
      // Persist what we just collected, exactly as the normal path does. These verdicts were paid for
      // on the run that submitted them; without this the NEXT run re-scores every one of the same
      // pairs at full price.
      await writeResumedVerdicts(collected.byEmail, pending.map, log);
      await clearPendingBatch();
      return { ...collected, requestCount: pending.map.length, batchId: pending.batchId, resumed: true };
    }
    if (action === "wait") {
      log(`[match] parked batch ${pending.batchId} still ${status?.processing_status || "unknown"} — leaving it parked; not starting a second batch this run.`);
      return { byEmail: new Map(), cost: 0, requestCount: 0, batchId: pending.batchId, deferred: true };
    }
    log(`[match] discarding parked batch ${pending.batchId} (${status?.processing_status || "unreadable"}, created ${pending.createdAt}) — running a fresh batch.`);
    captureError(new Error(`parked match batch ${pending.batchId} discarded without results`), { service: "match-batch", kind: "batch_discarded", batchId: pending.batchId });
    await clearPendingBatch();
  }

  // Apply caps with explicit logging — never silently truncate.
  let useUsers = users;
  if (useUsers.length > c.maxUsers) {
    log(`[match] capping users ${useUsers.length} -> ${c.maxUsers} (MAX_USERS_PER_RUN); ${useUsers.length - c.maxUsers} deferred to next run`);
    useUsers = useUsers.slice(0, c.maxUsers);
  }

  // ── BLIND SCORING. The scorer judges the work; it is never told the person's name. ─────────────
  //
  // Holding the dossier and the role constant at temperature 0 and changing ONLY the name can move the
  // score by tens of points. A swing on a field that says nothing about whether somebody can do a job
  // is luck, and luck does not belong in a scoring path.
  //
  // `scoringText` replaces `dossierText` EVERYWHERE the scorer or its cache touches, and nowhere
  // else. The composer still gets the full dossier, so the email still opens with the person's name:
  // the name is needed to speak to a person and never to judge one.
  //
  // The cache key hashes the scoring text, so any change to what is blinded invalidates every cached
  // verdict once and the next run pays full price.
  for (const u of useUsers) u.scoringText = blindDossierText(u.dossierText);
  // Per-user pre-filter (Stage 1C): select each person's most RELEVANT jobs before the
  // per-user cap, so their matcher slots hold relevant roles (their role family, location,
  // seniority, dealbreakers) instead of an arbitrary global slice. Deterministic, no model.
  // Company-context: tag every job with whether its company hires in India, so the bare-"Remote"
  // reachability check can trust a global-remote label only from companies that actually hire there.
  const indiaCoCount = tagCompanyReach(jobs);
  log(`[match] company-context: ${indiaCoCount} companies with an India footprint (bare-Remote trusted only for those)`);

  // Semantic pre-rank (Phase B, opt-in via VOYAGE_SEMANTIC=on). Load job vectors ONCE + embed every
  // person's grounded blob in ONE batch here (async), then pass the precomputed vectors into the pure
  // selectForUser. FAIL-OPEN: disabled, no vectors, or a null person vector -> opts stays empty -> the
  // pre-filter uses lexical ranking, per user.
  const semantic = semanticRankOn();
  const jobVecs = semantic ? await loadPoolVectors() : null;
  let personVecs = null;
  if (semantic && jobVecs && jobVecs.size) {
    const blobs = useUsers.map((u) => personBlob(u.dossier || safeParse(u.dossierText) || {}));
    personVecs = await embedTexts(blobs, { inputType: "query" }); // aligned to useUsers; each vec|null
    log(`[match] semantic rank ON: ${jobVecs.size} job vectors, ${personVecs ? personVecs.filter(Boolean).length : 0}/${useUsers.length} person vectors`);
  } else if (semantic) {
    log(`[match] semantic rank requested but no job vectors available yet — using lexical`);
  }

  // Shadow pre-gate census accumulator. Reset per run; reported once below.
  const pregateTotals = { scored: 0, eliminable: 0, byRule: {} };
  const perUserJobs = useUsers.map((u, ui) => {
    const dossier = u.dossier || safeParse(u.dossierText) || {};
    // Boundary: a structurally broken dossier must not feed matching. Log + skip this user (no jobs
    // matched this run) rather than score against garbage. Fail-closed.
    const dossierCheck = Dossier.safeParse(dossier);
    if (!dossierCheck.success) {
      log(`[match] ${u.email}: SKIP — invalid dossier: ${dossierCheck.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`);
      return [];
    }
    const opts = semantic && personVecs && personVecs[ui] && jobVecs && jobVecs.size
      ? { semantic: true, personVec: personVecs[ui], jobVecs }
      : {};
    const { jobs: sel, stats } = selectForUser(dossier, jobs, c.maxJobsPerUser, opts);
    // SHADOW ONLY. Count how many of the roles we are about to PAY to score a free,
    // deterministic gate would have rejected anyway. It filters nothing — `sel` is returned
    // untouched — and lib/eligibility-pregate.mjs has no enforce mode, so this cannot become a
    // behaviour change by a config edit alone.
    if (pregateMode() !== "off") {
      try {
        const census = pregateCensus(sel, dossier);
        if (census.eliminable) {
          pregateTotals.scored += census.scored;
          pregateTotals.eliminable += census.eliminable;
          for (const [rule, n] of Object.entries(census.byRule)) pregateTotals.byRule[rule] = (pregateTotals.byRule[rule] || 0) + n;
          log(`[pregate shadow] ${u.email}: ${census.eliminable}/${census.scored} of the roles about to be scored would be rejected by a free gate — ${Object.entries(census.byRule).map(([r, n]) => `${r}=${n}`).join(" ")}`);
        }
      } catch (e) { log(`[pregate shadow] census skipped (non-fatal): ${e.message}`); }
    }
    log(`[match] ${u.email}: pre-filter ${stats.in} -> ${stats.kept} relevant [${stats.region}, ${stats.unreachable} geo-dropped, ${stats.ineligible} work-auth-dropped]${stats.semantic ? " semantic" : ""} -> ${stats.taken} matched (families: ${stats.families.join(",") || "any"})`);
    return sel;
  });

  // Emitted HERE, before any early return. A 100% verdict-cache-hit run returns before the request
  // builder, so a summary placed further down would never print on the cheapest runs.
  if (pregateMode() !== "off" && pregateTotals.eliminable) {
    const perPairUsd = (3253 * PRICE_IN_PER_MTOK + ASSUMED_OUT_TOKENS * PRICE_OUT_PER_MTOK) / 1e6; // measured tokens per pair
    log(`[pregate shadow] RUN TOTAL: ${pregateTotals.eliminable}/${pregateTotals.scored} retrieved pairs (${((100 * pregateTotals.eliminable) / (pregateTotals.scored || 1)).toFixed(1)}%) would be rejected by a free deterministic gate · ~$${(pregateTotals.eliminable * perPairUsd).toFixed(2)} at full price · ${Object.entries(pregateTotals.byRule).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(" ")}`);
  }

  // Build batch requests. custom_id encodes user+job indices (a-zA-Z0-9_-, <=64).
  const requests = [];
  let estIn = 0;
  let estOut = 0;
  const constrained = constrainedDecodeOn();
  if (constrained) log("[match] constrained decoding ON (output_config.format = MatchOutputFormat)");
  const cache = batchCacheOn();
  log(`[match] batch prompt cache: ${cache ? "ON (cache_control attached — today's default)" : "OFF (MATCH_BATCH_CACHE=off — no cache_control on the batch prefix)"}`);
  const today = new Date().toISOString().slice(0, 10); // so scoring judges tenure/recency correctly
  const todayLine = `${today} (a past date is not "future")`;
  // Incremental matching: reuse verdicts scored on a prior run for pairs whose inputs are unchanged.
  // This is where the daily match cost actually lives: most of the pool is the same roles day to day.
  const useCache = matchCacheOn();
  const cachedHits = []; // { ui, ji, match } — reused verdicts, merged into byEmail after the batch
  let verdicts = new Map();
  let keyGrid = null; // keyGrid[ui][ji] = cache_key (computed once; reused on read AND write-back)
  if (useCache) {
    keyGrid = useUsers.map((u, ui) => perUserJobs[ui].map((job) =>
      matchCacheKey({ model: MATCH_MODEL, maxTokens: MAX_TOKENS, matcherText: matcherPrompt, dossierText: u.scoringText, job, constrained })));
    try {
      verdicts = await getVerdicts(keyGrid.flat(), matchCacheTtlDays());
    } catch (e) {
      // Fail-open: a cache read error must never block matching. Score everything, exactly as before.
      log(`[match] verdict cache read failed (${e.message}) — scoring all pairs (fail-open)`);
      verdicts = new Map();
    }
  }

  for (let ui = 0; ui < useUsers.length; ui++) {
    const u = useUsers[ui];
    const userJobs = perUserJobs[ui];
    for (let ji = 0; ji < userJobs.length; ji++) {
      if (useCache) {
        const hit = verdicts.get(keyGrid[ui][ji]);
        // Defensive: a cached row must still be a real verdict AND valid under the CURRENT schema, else
        // it re-scores (a schema evolution or a stored skip never serves a stale/wrong result).
        if (hit && cacheableVerdict(hit) && MatchOutput.safeParse(hit).success) {
          cachedHits.push({ ui, ji, match: hit });
          continue; // reuse — do not re-score this pair
        }
      }
      // system: [matcher prefix, per-user dossier prefix] (both cache-controlled) + the job as the user turn.
      // With constrained=true this also carries output_config.format (schema-valid-by-construction reply).
      const scoring = buildScoringMessages({ matcherText: matcherPrompt, dossierText: u.scoringText, job: userJobs[ji], todayLine, constrained, cache });
      // temperature 0 — the matcher GRADES a person against a role; it is not writing copy. At the
      // API default (1.0) the same (person, job) pair can score either side of MATCH_BAR on two runs,
      // which makes the verdict cache store a coin flip and makes "why did this role appear today and
      // not yesterday" unanswerable. Deterministic scoring is also what makes the cache honest: a
      // cached verdict is only reusable if re-scoring would have produced the same number.
      requests.push({ custom_id: `u${ui}_j${ji}`, params: { model: MATCH_MODEL, max_tokens: MAX_TOKENS, temperature: 0, ...scoring } });
      estIn += approxTokens(matcherPrompt) + approxTokens(u.scoringText) + approxTokens(scoring.messages[0].content);
      estOut += ASSUMED_OUT_TOKENS;
    }
  }
  if (useCache) log(`[match] verdict cache: ${cachedHits.length}/${cachedHits.length + requests.length} reused, ${requests.length} to score (TTL ${matchCacheTtlDays()}d)`);

  if (requests.length === 0) {
    if (!useCache || cachedHits.length === 0) {
      log("[match] no requests to run");
      // Drop counts are NULL, not 0, on every path where no batch ran. "no batch was submitted" and
      // "a batch ran and produced zero syntax drops" are different facts, and only the second one is
      // evidence for flipping MATCH_CONSTRAINED_DECODE=on. Reporting 0 here would manufacture that
      // evidence out of a quiet day.
      return { byEmail: new Map(useUsers.map((u) => [u.email, []])), cost: 0, requestCount: 0, batchId: null, syntaxDrops: null, semanticSkips: null, scored: 0, errored: 0, constrained: constrainedDecodeOn() };
    }
    // Every pair was a fresh cache hit — no batch, no cost. Assemble byEmail from the reused verdicts.
    const byEmail = new Map(useUsers.map((u) => [u.email, []]));
    mergeCachedHits(byEmail, cachedHits, useUsers, perUserJobs, c);
    log(`[match] 100% verdict-cache hit — ${cachedHits.length} reused, no batch submitted, $0.00`);
    return { byEmail, cost: 0, requestCount: 0, batchId: null, syntaxDrops: null, semanticSkips: null, scored: 0, errored: 0, constrained: constrainedDecodeOn() };
  }

  // Estimated-cost guard (uncached worst case — caching only makes it cheaper).
  const estCost = (estIn / 1e6) * PRICE_IN_PER_MTOK + (estOut / 1e6) * PRICE_OUT_PER_MTOK;
  log(`[match] ${requests.length} requests (${useUsers.length} users, per-user pre-filtered) on ${MATCH_MODEL} (batch) · est ~${estIn} in + ~${estOut} out tok · est ~$${estCost.toFixed(4)} (uncached worst case)`);

  // EARLY WARNING — fires BEFORE either ceiling aborts the run.
  //
  // Both ceilings below are correct. The point of the warning is notice: an abort costs that day's
  // entire role send, and run cost grows quickly with users. Headroom is also fragile: a single
  // matcher.md edit invalidates every cached verdict at once (the rubric is in the cache key), so one
  // prompt change can put the next run straight back to full price.
  //
  // This only observes — it never lowers a ceiling, never skips work, and never suppresses an abort.
  for (const w of capacityWarnings({ requestCount: requests.length, estCost, caps: c })) {
    log(`[match] ⚠ APPROACHING CEILING: ${w}`);
    captureError(new Error(`[match] approaching run ceiling: ${w}`), { service: "match-batch", kind: "ceiling_warning" });
  }

  // Hard cap on total batch size.
  if (requests.length > c.maxBatchRequests) {
    throw new Error(`[match] ABORT: ${requests.length} requests exceed MAX_BATCH_REQUESTS=${c.maxBatchRequests}. Lower counts or raise the cap deliberately.`);
  }
  if (estCost > c.maxRunCostUsd) {
    throw new Error(`[match] ABORT: estimated $${estCost.toFixed(2)} exceeds MAX_RUN_COST_USD=$${c.maxRunCostUsd}. Lower caps or raise the ceiling deliberately.`);
  }

  // Submit, then PARK the batch id + the custom_id -> (email, jobId) mapping BEFORE polling. The
  // mapping is what makes a resume possible at all: custom_id is `u{i}_j{j}`, indices into THIS run's
  // arrays, which are meaningless on a later run. Parked first so a crash mid-poll is still resumable.
  const batch = await client.messages.batches.create({ requests });
  try {
    await savePendingBatch({
      batchId: batch.id,
      createdAt: new Date().toISOString(),
      map: requests.map((r) => {
        const m = /^u(\d+)_j(\d+)$/.exec(r.custom_id);
        const ui = Number(m[1]);
        const ji = Number(m[2]);
        // PARK THE CACHE KEY TOO. Without it a resumed batch can never be written back to the verdict
        // cache: matchCacheKey needs the blinded dossier text, and the resume path rebuilds users from
        // this map alone (`{ email }`, no dossier). Recomputing the key on the far side would also be
        // WRONG if the dossier changed between park and collect — it would file a verdict under a key
        // describing inputs that were never scored. The key computed at submit time is the only one
        // that describes what the model actually saw, so it travels with the request.
        // null when MATCH_CACHE is off (no keyGrid). A parked payload without `cache_key` simply writes
        // nothing on resume.
        return { custom_id: r.custom_id, email: useUsers[ui].email, jobId: perUserJobs[ui][ji].id, cache_key: keyGrid?.[ui]?.[ji] ?? null };
      }),
    });
  } catch (e) {
    // Parking is an optimization, not a correctness requirement — a failure here costs a re-run at
    // worst, so it must never take down a batch we've already paid for.
    log(`[match] could not park batch ${batch.id} for resume (non-fatal): ${e.message}`);
  }

  log(`[match] batch ${batch.id} submitted; polling every ${c.pollMs}ms...`);
  const deadline = Date.now() + c.pollTimeoutMs;
  let status = batch;
  while (status.processing_status !== "ended") {
    if (Date.now() > deadline) {
      // NOT fatal. scheduler.mjs sits inside engine:run's `&&` chain, so throwing here would abort the
      // digest and newsletter too. The batch is parked, so the next run collects it: a slow batch
      // DELAYS the send instead of cancelling the day. Returning an empty byEmail is safe (scheduler does `byEmail.get(e) || []`)
      // and lands in the silent-no-send coverage alarm, which is the correct signal.
      log(`[match] batch ${batch.id} still running after ${c.pollTimeoutMs}ms — parked; the NEXT run will collect it. No role emails this run.`);
      captureError(new Error(`match batch ${batch.id} exceeded ${c.pollTimeoutMs}ms — deferred to the next run`), { service: "match-batch", kind: "batch_deferred", batchId: batch.id });
      return { byEmail: new Map(), cost: 0, requestCount: requests.length, batchId: batch.id, deferred: true };
    }
    await sleep(c.pollMs);
    status = await client.messages.batches.retrieve(batch.id);
  }
  log(`[match] batch ${batch.id} ended: ${JSON.stringify(status.request_counts)}`);
  await clearPendingBatch(); // collected in this same run — nothing to resume

  const collected = await collectBatchResults({ client, batchId: batch.id, useUsers, perUserJobs, c, constrained, cache, log });

  if (useCache) {
    // Persist the freshly-scored verdicts (skip/error rows are dropped by cacheableVerdict) so the next
    // run reuses them, THEN merge in the pairs we reused this run. Writes happen before the merge so we
    // never re-write the hits (already in the table). All steps fail-open — the cache can't break a send.
    await writeFreshVerdicts(collected.byEmail, useUsers, matcherPrompt, constrained, log);
    mergeCachedHits(collected.byEmail, cachedHits, useUsers, perUserJobs, c);
    try { await pruneVerdicts(); } catch (e) { log(`[match] verdict cache prune failed (non-fatal): ${e.message}`); }
  }

  return { ...collected, requestCount: requests.length, batchId: batch.id };
}

// Merge reused verdicts into byEmail with the SAME shape collectBatchResults produces ({...job, match,
// passed_bar}), recomputing passed_bar against the CURRENT bar — the score is cached, the bar is not, so
// a MATCH_BAR change takes effect immediately without invalidating a single cached verdict.
function mergeCachedHits(byEmail, cachedHits, useUsers, perUserJobs, c) {
  for (const { ui, ji, match } of cachedHits) {
    const u = useUsers[ui];
    const job = perUserJobs[ui]?.[ji];
    if (!u || !job) continue;
    const score = typeof match.score === "number" ? match.score : 0;
    const passed_bar = score >= c.barScore && match.dealbreaker_hit !== true;
    byEmail.get(u.email)?.push({ ...job, _retrievalRank: ji, match, passed_bar });
  }
  for (const arr of byEmail.values()) arr.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
}

// Store the just-scored verdicts so the next run reuses them. Keys are recomputed from the same inputs
// as the read side (matchCacheKey ignores the match/passed_bar fields the scored job carries, so the
// write key equals the read key — proven in lib/match-cache-key.test.mjs). Only real verdicts are
// stored; skip/error rows fail cacheableVerdict and re-score next run.
/**
 * Cache the verdicts of a RESUMED batch, using the keys parked with the requests.
 *
 * The normal path recomputes matchCacheKey from the live dossier; this path cannot — it rebuilt its
 * users from the parked map, which carries an email and a job id and no dossier. So the key is the
 * one that was computed at submit time and parked beside the request. That is not a workaround, it is
 * the more correct source: it describes the inputs the model actually scored, even if the person's
 * dossier has changed since.
 *
 * Fails soft in every direction — a parked payload without a `cache_key` writes nothing, an
 * un-cacheable verdict (error placeholder) is skipped, and a write failure logs rather than throws.
 * The worst case is the old behaviour: re-scoring next run.
 */
async function writeResumedVerdicts(byEmail, parkedMap, log) {
  const keyOf = new Map();
  for (const e of Array.isArray(parkedMap) ? parkedMap : []) {
    if (e?.cache_key && e.email && e.jobId) keyOf.set(`${e.email}::${e.jobId}`, e.cache_key);
  }
  if (!keyOf.size) return; // MATCH_CACHE was off when it was parked, or the payload carries no keys
  const rows = [];
  for (const [email, arr] of byEmail) {
    for (const scored of arr) {
      if (!cacheableVerdict(scored.match)) continue;
      const cache_key = keyOf.get(`${email}::${scored.id}`);
      if (!cache_key) continue;
      rows.push({ cache_key, email, output: scored.match });
    }
  }
  if (!rows.length) return;
  try {
    const n = await putVerdicts(rows);
    log(`[match] verdict cache: stored ${n} resumed verdict(s) — the next run reuses them instead of re-scoring`);
  } catch (e) {
    log(`[match] resumed verdict cache write failed (non-fatal): ${e.message}`);
  }
}

async function writeFreshVerdicts(byEmail, useUsers, matcherPrompt, constrained, log) {
  const dossierByEmail = new Map(useUsers.map((u) => [u.email, u.scoringText ?? u.dossierText]));
  const rows = [];
  for (const [email, arr] of byEmail) {
    const dossierText = dossierByEmail.get(email);
    for (const scored of arr) {
      if (!cacheableVerdict(scored.match)) continue;
      rows.push({
        cache_key: matchCacheKey({ model: MATCH_MODEL, maxTokens: MAX_TOKENS, matcherText: matcherPrompt, dossierText, job: scored, constrained }),
        email,
        output: scored.match,
      });
    }
  }
  try {
    const n = await putVerdicts(rows);
    log(`[match] verdict cache: stored ${n} fresh verdict(s)`);
  } catch (e) {
    log(`[match] verdict cache write failed (non-fatal): ${e.message}`);
  }
}

// Read a finished batch's results and map each entry back to its user + job. Extracted because there
// are TWO callers: the normal same-run path, and the resume path that collects a batch parked by
// an earlier run. Identical logic either way — a resumed batch must be scored exactly like a fresh one.
async function collectBatchResults({ client, batchId, useUsers, perUserJobs, c, constrained, cache, log }) {
  // `useUsers` may be SPARSE on the resume path: it is rebuilt from the parked custom_ids (`u{i}_j{j}`),
  // and a user whose every pair was served from the verdict cache contributed NO request to the batch,
  // so their index is a hole. The holes must stay (the indices address this batch's custom_ids), but
  // `.map()` preserves them and `new Map()` rejects an undefined entry, so the constructor must filter
  // holes out. The loop below skips holes too (`if (!u || !job) continue`).
  const byEmail = new Map(useUsers.filter(Boolean).map((u) => [u.email, []]));
  let usageIn = 0;
  let usageCacheRead = 0;
  let usageCacheCreate = 0;
  let usageOut = 0;
  let ok = 0;
  let errored = 0;
  let syntaxDrops = 0;   // JSON that didn't parse (should be 0 with constrained decoding)
  let semanticSkips = 0; // schema-valid JSON that failed MatchOutput.safeParse (still caught, constrained or not)
  for await (const entry of await client.messages.batches.results(batchId)) {
    const m = /^u(\d+)_j(\d+)$/.exec(entry.custom_id);
    if (!m) continue;
    const u = useUsers[Number(m[1])];
    // The job's index in THIS user's `selectForUser` output IS its retrieval rank — the position the
    // hard filters + family gate + semantic/lexical blend put it at, before the model saw anything.
    // Stamped here so a verdict can be read against the rank that produced it. See `_retrievalRank`.
    const rank = Number(m[2]);
    const job = perUserJobs[Number(m[1])]?.[rank];
    if (!u || !job) continue;
    if (entry.result?.type !== "succeeded") {
      errored++;
      byEmail.get(u.email).push({ ...job, _retrievalRank: rank, match: { score: 0, verdict: "skip", flag: `score failed: ${entry.result?.type}` }, passed_bar: false });
      continue;
    }
    const msg = entry.result.message;
    const usage = msg.usage || {};
    usageIn += usage.input_tokens || 0;
    usageOut += usage.output_tokens || 0;
    usageCacheRead += usage.cache_read_input_tokens || 0;
    usageCacheCreate += usage.cache_creation_input_tokens || 0;
    const reply = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let match;
    try {
      const raw = JSON.parse(stripFences(reply));
      const parsed = MatchOutput.safeParse(raw); // validate the scoring output at the boundary
      if (parsed.success) {
        match = raw;
      } else {
        // SEMANTIC skip: parsed as JSON but violated the shape/values (e.g. hallucinated score).
        // Constrained decoding does NOT prevent this — it's exactly what safeParse must still catch.
        semanticSkips++;
        const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        console.error(`[match] schema reject ${entry.custom_id}: ${detail}`);
        captureError(new Error(`match schema reject: ${detail}`), { service: "match-batch", kind: "schema_reject", customId: entry.custom_id });
        match = { score: 0, verdict: "skip", flag: "schema-invalid score" }; // log + skip this record, never crash
      }
    } catch {
      // SYNTAX drop: the reply wasn't valid JSON at all. This is the class constrained decoding kills — with
      // constrained decoding on it should be 0. Log the record id so a shadow batch is auditable.
      syntaxDrops++;
      console.error(`[match] unparseable score ${entry.custom_id} (JSON.parse failed)`);
      match = { score: 0, verdict: "skip", flag: "unparseable score" };
    }
    const score = typeof match.score === "number" ? match.score : 0;
    const passed_bar = score >= c.barScore && match.dealbreaker_hit !== true;
    byEmail.get(u.email).push({ ...job, _retrievalRank: rank, match, passed_bar });
    ok++;
  }

  // Actual cost from real usage: cache reads bill at 0.1x, 5-minute cache WRITES at 1.25x, the base
  // input price. cache_write>0 with cache_read=0 means we are PAYING to warm a cache nothing reads
  // (the Batch API runs requests concurrently, so the prefix never warms before its siblings run) —
  // a dead-weight cost that argues for dropping cache_control here or warming the prefix first.
  const cost =
    (usageIn / 1e6) * PRICE_IN_PER_MTOK +
    (usageCacheRead / 1e6) * PRICE_IN_PER_MTOK * 0.1 +
    (usageCacheCreate / 1e6) * PRICE_IN_PER_MTOK * 1.25 +
    (usageOut / 1e6) * PRICE_OUT_PER_MTOK;
  log(`[match] results: ${ok} ok, ${errored} errored · drops: ${syntaxDrops} syntax + ${semanticSkips} semantic (constrained=${constrained ? "on" : "off"}) · tokens in=${usageIn} cache_read=${usageCacheRead} cache_write=${usageCacheCreate} out=${usageOut} · actual match cost ~$${cost.toFixed(4)}`);
  // Cost verify: with the batch cache ON, cache_write>0 while cache_read≈0
  // is the dead-weight penalty — we PAID 1.25x to warm a prefix nothing read. Surface it explicitly so
  // the decision to flip MATCH_BATCH_CACHE=off rests on a real run's numbers, not the estimate.
  if (cache && usageCacheCreate > 0 && usageCacheRead === 0) {
    log(`[match] ⚠ batch cache PENALTY confirmed: cache_write=${usageCacheCreate} tok billed at 1.25x but cache_read=0 (nothing read it). Set MATCH_BATCH_CACHE=off to drop it — identical prompt, lower bill.`);
  } else if (cache && usageCacheRead > 0) {
    log(`[match] batch cache is paying off: cache_read=${usageCacheRead} tok read at 0.1x (write=${usageCacheCreate}) — keep MATCH_BATCH_CACHE on.`);
  }

  for (const arr of byEmail.values()) arr.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
  // Return the drop counts, do not only log them. "A shadow batch shows syntax drops -> 0" is the
  // PRECONDITION for flipping MATCH_CONSTRAINED_DECODE=on, and log lines age out before anyone reads
  // them. `constrained` rides along so a
  // reading of the count is never ambiguous about which mode produced it.
  return { byEmail, cost, syntaxDrops, semanticSkips, scored: ok, errored, constrained };
}
