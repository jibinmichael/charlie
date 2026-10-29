// match-one.mjs — on-demand, single-user match for the hosted chat's in-session "aha".
//
// The daily engine matches everyone in a batch; this finds ONE good role for ONE person
// RIGHT NOW, so a newly-onboarded user sees a real, grounded match before they leave the
// chat. It mirrors the engine exactly to stay honest: same per-user pre-filter
// (selectForUser), same matcher.md rubric, same bar (70), same score shape — just one user,
// a handful of jobs, scored synchronously instead of in a batch. The pool comes from
// Supabase (the engine uploads it after each scan; see saveJobPool/loadJobPool).

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectForUser, tagCompanyReach } from "./select-jobs.mjs";
import { semanticRankOn, loadPoolVectors, buildPersonVec } from "./lib/semantic-rank.mjs";
import { getDossier, loadJobPool, upsertFind, getFindIds, getEmailedRoleSignatures } from "./charlie-store.mjs";
import { findStatus } from "./lib/dry-run.mjs"; // a preview must not write a status the repeat guard counts
import { gateRole } from "./quality-gate.mjs";
import { repeatDecision } from "./presend-guard.mjs";
import { computeCoverage } from "./fit-coverage.mjs";
import { buildScoringMessages } from "./prompts/match-scoring.mjs"; // versioned prompt — see prompts/
import { MatchOutput } from "./lib/schemas/match-output.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MATCHER_PATH = join(here, "matcher.md");
const MODEL = process.env.MATCH_ONE_MODEL || "claude-haiku-4-5";
const BAR = Number(process.env.MATCH_BAR || 70);
const TOP_N = Number(process.env.MATCH_ONE_TOPN || 24); // score the top pre-filtered jobs at onboarding (wide enough to land the first match)

function stripFences(s) {
  let t = (s || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

// Score ONE job for ONE candidate using the exact same system layout as match-batch.mjs.
// Shares the constrained-decoding flag with the batch path via the same shared builder.
async function scoreOne(client, matcherPrompt, dossierText, job) {
  const todayLine = `${new Date().toISOString().slice(0, 10)} (judge tenure and recency against this; a past date is not "future")`;
  const constrained = String(process.env.MATCH_CONSTRAINED_DECODE || "").toLowerCase() === "on";
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    ...buildScoringMessages({ matcherText: matcherPrompt, dossierText, job, todayLine, constrained }),
  });
  const reply = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const raw = JSON.parse(stripFences(reply));
    const parsed = MatchOutput.safeParse(raw); // validate the scoring output at the boundary
    if (parsed.success) return raw;
    console.error(`[match-one] schema reject: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { score: 0, verdict: "skip", flag: "schema-invalid score" };
  } catch {
    return { score: 0, verdict: "skip", flag: "unparseable score" };
  }
}

// Find the single best above-bar role for this user from the shared pool, right now.
// Returns { role, stats } — role is a find-shaped { ...job, match } or null (nothing clears
// the bar), and stats is the HONEST market picture (pool size, how many are in their lane,
// how many of the closest we scored, how many cleared the bar). Persists the winner as a
// find so the daily engine won't re-email it. stats is real (from selectForUser + scoring),
// never invented — it powers the "honest market" line.
export async function matchBestRole(email, { log = () => {} } = {}) {
  const empty = { role: null, stats: { pool: 0, lane: 0, scored: 0, aboveBar: 0 } };
  const dossier = await getDossier(email);
  if (!dossier) return empty;

  let pool = [];
  try { pool = await loadJobPool(); } catch (e) { log(`pool load failed: ${e.message}`); }
  if (!pool.length) { log("no shared pool yet"); return empty; }

  // Tag each company's India-reachability from the pool BEFORE selecting/gating (same as match-batch).
  // Without this, job.companyHiresIndia is undefined and the bare-"Remote" branch in reachableForRegion
  // wrongly treats US-remote roles as reachable for an India user — a geo leak on the onboarding/chat
  // surface that the daily batch doesn't have.
  tagCompanyReach(pool);

  // Semantic pre-rank (opt-in) — same as the daily engine, for ONE user. Fail-open: off,
  // no vectors, or a null person vector -> lexical ranking (unchanged). The pool vectors are
  // process-cached so this doesn't re-download the blob every chat turn.
  let semOpts = {};
  if (semanticRankOn()) {
    const jobVecs = await loadPoolVectors();
    if (jobVecs.size) {
      const personVec = await buildPersonVec(dossier);
      if (personVec) semOpts = { semantic: true, personVec, jobVecs };
    }
  }

  // Pull the whole lane (not just the few we score) so the pay-transparency rate is real.
  const LANE_LIMIT = 300;
  const { jobs: lane, stats: selStats } = selectForUser(dossier, pool, LANE_LIMIT, semOpts);
  const hasComp = (j) => (typeof j?.compensation === "string" ? j.compensation.trim().length > 0 : !!j?.compensation);
  const payDisclosed = lane.filter(hasComp).length;
  const sel = lane.slice(0, TOP_N); // score only the closest few
  const stats = { pool: selStats.in, lane: selStats.kept, laneReturned: lane.length, payDisclosed, scored: sel.length, aboveBar: 0 };
  if (!sel.length) return { role: null, stats };

  const matcherPrompt = readFileSync(MATCHER_PATH, "utf8");
  const dossierText = JSON.stringify(dossier);
  const client = new Anthropic();

  const scored = await Promise.all(
    sel.map(async (job) => {
      const match = await scoreOne(client, matcherPrompt, dossierText, job).catch(() => ({ score: 0, verdict: "skip" }));
      const score = typeof match.score === "number" ? match.score : 0;
      const passed_bar = score >= BAR && match.dealbreaker_hit !== true;
      return { ...job, match, passed_bar };
    }),
  );

  stats.aboveBar = scored.filter((j) => j.passed_bar).length;

  const handled = await getFindIds(email).catch(() => new Set());
  // Authoritative no-repeat: the SAME dedup vectors the send guard enforces (identity/roleKey/core/
  // cooloff via getEmailedRoleSignatures + repeatDecision), so match-one never even PICKS a role
  // already sent by ANY vector — including a retitled repost on the same apply_url that a
  // company::title-only filter would miss. Matches scheduler.mjs / scripts/send-india-first.mjs.
  // Defense-in-depth: first-role.mjs still wraps the winner in preSendGuard.
  //
  // FAIL CLOSED on a read error. `.catch(() => null)` would make repeatDecision a no-op (a falsy
  // signature set reads as "not a repeat"), so a transient DB error would let an already-sent role be
  // re-picked.
  // first-role.mjs re-guards the winner, but both reads hit the same Supabase, so the failures are
  // correlated and the backstop cannot be relied on. Rather surface nothing than a repeat.
  const signatures = await getEmailedRoleSignatures(email);
  // Rank ALL scored roles (not only above-bar) by score, so when nothing clears the bar we can still
  // surface the CLOSEST reachable role for a brand-new user instead of going silent on them.
  const ranked = scored
    .filter((j) => !handled.has(`${email}:${j.id}`) && !repeatDecision(j, signatures))
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));

  // Quality Gate: the in-session "aha" must show a role that is
  // LIVE, location-reachable, and clears the fit floor — never a dead link or a role the person
  // can't actually take. Walk best-first; near-misses are saved for the weekly digest.
  const GATE_SCAN = Number(process.env.GATE_SCAN || 8);
  let best = null;
  let bestCov = null;
  let bestSlot = null;   // the sent role's 1-based matcher rank (ranked is score-sorted)
  let closest = null; // highest-scored role that is LIVE + reachable + eligible but below the fit bar
  const digestPicks = [];
  for (const [i, cand] of ranked.slice(0, GATE_SCAN).entries()) {
    const { match: _m, passed_bar: _p, ...cjob } = cand;
    const g = await gateRole({
      job: cjob,
      dossier,
      matcherScore: cand.match?.score,
      getCov: () => computeCoverage({ dossier, jobDescription: cjob.description, jobTitle: cjob.title }).catch((e) => ({ thin: true, reason: "error", error: e?.message })), // never an anonymous thin: an infra error must stay distinguishable from a vague posting
    });
    if (g.outcome === "send") { best = cand; bestCov = g.cov; bestSlot = i + 1; break; }
    if (g.outcome === "digest") { digestPicks.push({ job: cjob, rule: g.rule, reason: g.reason, slot: i + 1 }); if (!closest) closest = { cand, cov: g.cov, slot: i + 1, rule: g.rule }; }
    // reachable + live + eligible but under the bar → a valid "close, not perfect" candidate.
    // Matched on the RULE, not on the prose: matching the human-facing sentence would let a rewording
    // silently empty the "closest" path.
    else if (g.outcome === "drop" && g.rule === "match-bar:below" && !closest) closest = { cand, cov: null, slot: i + 1, rule: g.rule };
  }
  // findStatus() makes these writes dry-run aware BY CONSTRUCTION (lib/dry-run.mjs). 'digest'/'new'
  // are statuses getEmailedRoleSignatures counts, so a preview that wrote them would permanently burn
  // the roles it was previewing for that person.
  for (const d of digestPicks) {
    await upsertFind({ email, jobId: d.job.id, job: d.job, match: scored.find((s) => s.id === d.job.id)?.match, composed: { digest_rule: d.rule, digest_reason: d.reason }, status: findStatus("digest"), slot: d.slot }).catch(() => {});
  }

  if (best) {
    const { match, passed_bar, ...job } = best;
    // 'new' means IN FLIGHT: first-role.mjs owns this row from here and must resolve it (it flips to
    // 'emailed' on a send and to 'unsent' on any other outcome), or the role is blocked for this person.
    try { await upsertFind({ email, jobId: job.id, job, match, status: findStatus("new"), slot: bestSlot }); } catch (e) { log(`find save skipped: ${e.message}`); }
    // `jobs` (the live pool) rides along so the caller can build the same grounded enrichment the daily
    // scheduler does — computeMomentum needs the pool to count a company's open reqs. Additive: every
    // existing caller destructures only what it needs, so returning more cannot break them.
    return { role: { ...job, match, cov: bestCov }, closest: null, stats, jobs: pool };
  }
  // Nothing cleared the bar — hand back the closest reachable role for the honest "close, but I can
  // do better once you tell me X" first touch (first-role.mjs decides whether/how to send it).
  if (closest) {
    const { match, passed_bar, ...job } = closest.cand;
    try { await upsertFind({ email, jobId: job.id, job, match, composed: { closest: true, digest_rule: closest.rule }, status: findStatus("closest"), slot: closest.slot }); } catch (e) { log(`closest find save skipped: ${e.message}`); }
    return { role: null, closest: { ...job, match, cov: closest.cov }, stats };
  }
  return { role: null, closest: null, stats };
}
