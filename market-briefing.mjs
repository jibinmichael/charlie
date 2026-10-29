// market-briefing.mjs — the "State of Your Market" briefing as an automated, once-ever lifecycle drip.
//
// This is the #2 email in the onboarding chain: right after the welcome, Charlie sends the grounded
// you-vs-market letter (market-report.mjs -> render-market-report.mjs). The first ROLE then lands on
// day-2 (scheduled), so the briefing proves Charlie has already done the digging before the first match
// arrives. The sweep is BOTH the backfill (existing completed dossiers get it on the next run) AND the
// catch-up for a new user whose immediate send failed. Two entry points:
//
//   sendMarketBriefing(email)     immediate best-effort send at dossier completion (the #2 slot)
//   runMarketBriefingSweep()      server setInterval — backfill + catch-up (cadence-gated)
//
//   node market-briefing.mjs <email>   send one now (owner test; skips cadence, still fail-closed)
//   node market-briefing.mjs --dry      list who WOULD get a briefing + their headline funnel, send nothing
//
// GROUNDING / FAIL-CLOSED: every number is COUNTED by market-report.mjs off the live pool
// + the person's stored dossier — no model call anywhere in this path. A thin dossier / empty market
// fails the eligibility gate and Charlie says NOTHING (never a hollow briefing). The physical send goes
// through lib/send-guard.mjs (suppression + one-per-person-ever idempotency), and dripGuard keeps the
// backfill from stacking on a person's other lifecycle drips.
//
// HARD EXCLUDE: a person on MARKETBRIEF_EXCLUDE is NEVER sent a briefing, even on --force, even before
// the once-ever flag is set (e.g. someone who already received one by hand). The exclude is checked
// first, in every path.

import { Resend } from "resend";
import { loadEnv, getCandidate, listNewsletterCandidates, loadJobPool, setEmailConfig, mergeEmailConfig, isV2 } from "./charlie-store.mjs";
import { buildMarketReport } from "./market-report.mjs";
import { computeCoverage } from "./fit-coverage.mjs";
import { seniorityChasm } from "./quality-gate.mjs"; // ONE definition of "aimed well above this person"
import { isThinDossier } from "./email-onboard.mjs"; // ONE definition of "we do not know this person well enough yet"
import { freshnessScore } from "./lib/freshness-score.mjs";
import { renderMarketReport } from "./render-market-report.mjs";
import { unsubUrlFor } from "./email-kit.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";
import { dripGuard, stampFor } from "./drip-guard.mjs";
import { captureError } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)

const log = (...a) => console.error("[market-briefing]", ...a);

const MIN_ADDRESSABLE = Number(process.env.MARKETBRIEF_MIN_ADDRESSABLE || 8);

// The hard NEVER-SEND list. Comma-separated addresses in MARKETBRIEF_EXCLUDE (kept out of the repo — a
// real user's address is not committed). Checked first in every path. Pure + exported for the test.
export function isExcluded(email) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) return true; // no address -> fail closed
  const raw = String(process.env.MARKETBRIEF_EXCLUDE || "");
  const set = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return set.has(addr);
}

// THE fail-closed "enough data" gate: a briefing earns the email ONLY when the person has a reachable
// market to speak about (addressable roles) AND at least one PROVEN domain the market is live on (so the
// "what you own" chart + copy trace to real evidence, never a hollow letter). Pure + exported so the
// bar is testable. A null/partial report fails closed.
//
// THE DOSSIER IS PART OF THE BAR. The welcome and the briefing are the FIRST TWO EMAILS a person ever
// gets, and can land seconds apart. renderWelcome consults isThinDossier and says "it's thinner than
// I'd like"; a confident charted read of their market right after it would contradict that.
//
// A market report is a claim about a PERSON's market, so it needs the same evidence bar every other
// claim about a person needs. The funnel/gravity checks below measure the MARKET; they cannot see that
// we barely know the reader. isThinDossier is the existing, tested predicate for exactly that judgement
// (email-onboard.mjs) — reused, never re-implemented, like seniorityChasm.
//
// FAIL CLOSED: a missing/undefined dossier is thin, so it does NOT send. Holding a briefing is
// recoverable — it is once-ever and un-stamped until a real send, so it goes out later when the person
// has told us more. Contradicting ourselves in someone's first hour is not recoverable.
export function marketBriefEligible(report, dossier) {
  if (isThinDossier(dossier)) return false;
  if (!report || !report.funnel) return false;
  if (!(Number(report.funnel.addressable) >= MIN_ADDRESSABLE)) return false;
  // TWO proven topics, not one. The topics are derived from the person's own vocabulary against their
  // live market rather than a fixed taxonomy, and a single hit is exactly what a coincidence looks like
  // (a stray word like "Secure"). Two independent hits is a read; one is an accident.
  if (!Array.isArray(report.gravity) || report.gravity.length < 2) return false;
  return true;
}

// Render + send one briefing through the ONE physical send door. Returns a short status string. Stamps
// the once-ever ledger + the global anti-stack AFTER a real send only.
async function sendTo(email, { candidate, report, force = false } = {}) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const { subject, html } = renderMarketReport(report, { email });
  const payload = {
    from, to: email, subject, html,
    headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
  // dedupeKey "v1": at most ONE briefing per person, ever (belt to the marketbrief_sent_at flag).
  const res = await sendGuarded({ resend, email, template: "market-briefing", dedupeKey: "v1", payload, idempotencyKey: `marketbrief/${email}`, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: briefing already sent — skip`); return "duplicate"; }
  if (res.status === "failed") return "failed";

  try {
    const nowIso = new Date().toISOString();
    const prior = candidate?.email_config || {};
    await setEmailConfig(email, { ...prior, ...stampFor("marketbrief", nowIso) });
  } catch (e) {
    log(`${email}: sent but flag-mark failed: ${e.message}`);
    await mergeEmailConfig(email, { ...stampFor("marketbrief") }).catch(() => {});
  }
  log(`${email}: sent briefing`);
  return "sent";
}

// Immediate best-effort send at dossier completion (the #2 onboarding slot). Fail-closed and quiet: an
// excluded address, an already-sent person, a thin dossier, or any error -> send nothing, never throw.
// Suppression + idempotency are enforced inside sendTo (sendGuarded). Returns a short status.

// The spotlight the briefing zooms in on should be the role this person can actually CLEAR, not just
// the most relevant one. Relevance alone can spotlight a role the person covers poorly while a much
// better-covered one sits unmentioned, under the words "if I could point you at one thing today".
//
// Cost, stated plainly: one coverage pass per shortlisted role, so at the
// default shortlist of 5 that is ~5 Sonnet calls, roughly $0.17, ONCE per person — the briefing is a
// once-ever email (marketbrief_sent_at). Set STANDOUT_FIT=off to keep the free relevance-only pick.
// Fails open in every direction: any error, any thin verdict, or a tie leaves the original pick.
//
// The coverage gap chart is built from THESE passes and adds no call of its own (market-report.mjs
// STANDOUT_SHORTLIST).
//
// OPT-IN. This is the only thing that scores ATS roles against a person outside the main run: it fires
// at dossier completion, ~5 Sonnet coverage passes, on every new signup, and if marketBriefEligible
// later rejects the report those passes are paid for and discarded.
//
// Off by default means a new person costs nothing to welcome, and the briefing still goes out with
// its free relevance-only pick. Set STANDOUT_FIT=on to buy the fit-ranked spotlight back, and put it
// somewhere the spend shows up in a run's cost line if you do.
const standoutFitOn = () => /^(on|1|true|yes)$/i.test(String(process.env.STANDOUT_FIT ?? "").trim());
export async function rankStandoutByFit(dossier, shortlist, log = console.error) {
  if (!standoutFitOn() || !Array.isArray(shortlist) || shortlist.length < 2) return null;
  // FIT AND FRESHNESS, blended the SAME way the daily send blends them (freshness.mjs) so there is one
  // definition of "fresh" in the product, not two. Weight FRESHNESS_WEIGHT (default 0.2): fit still
  // leads, freshness competes and decides between near-equal fits.
  //
  // Why it matters here: the best-fitting role can be days from the 45-day horizon where it drops out
  // of the pool. Spotlighting "if I could point you at one thing today" onto a role about to expire is a bad bet
  // even when the fit is the highest, because applying early IS winnability.
  const w = Math.min(1, Math.max(0, Number(process.env.FRESHNESS_WEIGHT ?? 0.2)));
  const now = Date.now();
  let best = null, bestBlend = -1, bestFit = null;
  // Every coverage result is KEPT, not just the winning one. These same passes are the substrate of
  // the coverage gap chart (lib/gap-chart.mjs) — building the chart from them is what makes it cost
  // one extra call rather than a second full set. A thin/errored posting is still recorded: the chart
  // skips it, but discarding it here would hide how often coverage is unavailable.
  const items = [];
  for (const job of shortlist) {
    const cov = await computeCoverage({ dossier, jobDescription: job?.description, jobTitle: job?.title }).catch(() => null);
    items.push({ job, cov });
    const fit = cov && !cov.thin && Number.isFinite(cov.composite) ? cov.composite : null;
    if (fit == null) continue;                                   // thin or errored -> no opinion on it
    // LEVEL, before fit. The same verdict the daily send gate drops on (quality-gate.mjs 2d), asked here
    // because the briefing never reaches that gate (market-report.mjs and this file do not import it).
    // Without it, the line "if I could point you at one thing today, this is it" would have no
    // seniority stop at all (e.g. a 2-year engineer spotlighted onto an 8-year role).
    // The job stays in `items` above: that is the gap chart's substrate (lib/gap-chart.mjs), and hiding
    // the row would silently change the chart. It is only barred from WINNING the spotlight.
    if (seniorityChasm(cov)) {
      log(`[marketbrief] spotlight skipped, aimed above this person: ${job.company} — ${job.title} (fit ${fit}/100, seniority ${Number(cov.subscores?.seniority).toFixed(2)})`);
      continue;
    }
    const blend = (1 - w) * (fit / 100) + w * freshnessScore(job, now);
    if (blend > bestBlend) { bestBlend = blend; best = job; bestFit = fit; }
  }
  // `items` travels back even when no posting was scoreable enough to move the standout: the chart is
  // built from the requirement rows, not from the winner, so "no better pick" is not "no coverage".
  if (!best) return { job: null, items };
  const ageDays = (now - Date.parse(best.posted_at || "")) / 86400e3;
  log(`[marketbrief] standout by fit+freshness: ${best.company} — ${best.title} (fit ${bestFit}/100, ${Number.isFinite(ageDays) ? ageDays.toFixed(0) + "d old" : "undated"}, across ${shortlist.length})`);
  return { job: best, items };
}

export async function sendMarketBriefing(email, { log: logFn = log } = {}) {
  const addr = String(email || "").trim().toLowerCase();
  try {
    if (isExcluded(addr)) { logFn(`${addr}: excluded — never send`); return "excluded"; }
    const c = await getCandidate(addr);
    if (!c) return "no-candidate";
    if (c.email_config?.marketbrief_sent_at) return "already-sent";
    let report;
    try { report = await buildMarketReport(addr, { candidateOverride: c, rankStandout: (sl) => rankStandoutByFit(c?.dossier, sl) }); }
    catch (e) { logFn(`${addr}: report build failed — skip (${e.message})`); return "no-report"; }
    if (!marketBriefEligible(report, c?.dossier)) return "not-eligible";
    return await sendTo(addr, { candidate: c, report });
  } catch (e) {
    logFn(`${addr}: send failed (${e.message})`);
    captureError(e, { service: "market-briefing", kind: "immediate_failed", email: addr });
    return "error";
  }
}

// Decide + (optionally) send for ONE candidate in the sweep. `force` skips only the cadence gate (owner
// test), never the exclude / eligibility / once-ever / suppression / idempotency. Returns a status.
export async function evaluateCandidate(c, { force = false, dry = false, now = Date.now(), pool } = {}) {
  const email = String(c?.email || "").trim().toLowerCase();

  if (isExcluded(email)) return "excluded";       // hard skip, first
  if (c.email_config?.marketbrief_sent_at) return "already-sent"; // once ever (cheap, before the pool read)

  let report;
  try { report = await buildMarketReport(email, { candidateOverride: c, poolOverride: pool, rankStandout: (sl) => rankStandoutByFit(c?.dossier, sl) }); }
  catch (e) { log(`${email}: report build failed — skip (${e.message})`); return "no-report"; }
  if (!marketBriefEligible(report, c?.dossier)) return "not-eligible";

  if (!force) {
    const g = await dripGuard({ email, dripType: "marketbrief", candidate: c, now });
    if (g.decision === "skip") return `skip:${g.reason}`;
  }

  if (dry) { log(`WOULD SEND ${email}  (${report.funnel.addressable} reachable · ${report.gravity.length} proven domains)`); return "would-send"; }
  return sendTo(email, { candidate: c, report, force });
}

// Server-called sweep. Best-effort, never throws. Backfill + catch-up. LIVE (no dark flag) — the exclude
// list + once-ever flag + eligibility gate are the guards; nothing sends without RESEND_API_KEY.
export async function runMarketBriefingSweep() {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const cands = await listNewsletterCandidates();
    const pool = await loadJobPool().catch(() => []); // load ONCE; reused across candidates
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out (matches the other sweeps)
      try {
        await evaluateCandidate(c, { now, pool });
      } catch (e) {
        log(`${c.email} failed (skipped, batch continues): ${e.message}`);
        captureError(e, { service: "market-briefing", kind: "candidate_failed", email: c.email });
      }
    }
  } catch (e) {
    log(`sweep skipped: ${e.message}`);
    captureError(e, { service: "market-briefing", kind: "sweep_failed" });
  }
}

async function main() {
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (arg === "--dry") {
    const cands = await listNewsletterCandidates();
    const pool = await loadJobPool().catch(() => []);
    const now = Date.now();
    for (const c of cands) {
      if (isV2(c)) continue;
      try { const r = await evaluateCandidate(c, { dry: true, now, pool }); if (r !== "would-send") console.log(`skip       ${c.email}  (${r})`); }
      catch (e) { console.log(`error      ${c.email}  (${e.message})`); }
    }
    return;
  }
  if (!arg) { console.error("usage: node market-briefing.mjs <email> | --dry"); process.exit(1); }
  const email = arg.toLowerCase();
  const c = await getCandidate(email);
  if (!c) { console.error(`no candidate ${email}`); process.exit(1); }
  console.log(`market-briefing ${email}: ${await evaluateCandidate(c, { force: true })}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[market-briefing] fatal:", e.message); process.exit(1); });
