// run-eval.mjs — grade the run against the things that have actually gone wrong, and write it down.
//
// Quality regressions (a chart calling someone's own field a gap, a gate silencing a slice of users,
// a fit score collapsing to one value, a region losing most of its roles) are measurable the day they
// start, but nothing alarms unless something computes the measurement. The watchdog checks that the
// machinery RAN; this checks whether what it produced is any good.
//
// IT NEVER CHANGES ANYTHING. No sends, no writes to a dossier, no flags flipped, no roles deleted. It
// reads, it grades, it records. That is deliberate and it is the whole safety argument: an evaluator
// that can act is a gate, and a gate that acts on a number nobody read can silence people.
// Self-healing belongs to the few operations that cannot hurt a person, and those have their own
// hand-run scripts.
//
// COST: $0. Database reads and one pool read. No model call anywhere.
//
// THE HISTORY IS THE POINT. One reading is a dashboard; the series is what lets a slow rot show up.
// Stored as a `run_eval` signal per run (free-text event + jsonb meta, no migration), so the trend
// survives deploys, unlike a log line.

import { loadEnv, loadJobPool, listActiveCandidates, getFinds, recordSignal, listRecentApplyClicks } from "./charlie-store.mjs";
import { safeToDelete } from "./lib/market-reach.mjs";
import { reachabilityVerdict } from "./quality-gate.mjs";
import { profileDepth, bandFor } from "./profile-depth.mjs";
import { storedCoverages, questionFor } from "./depth-question.mjs";
import { createClient } from "@supabase/supabase-js";

const db = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

/** Shannon entropy in bits. The honest way to ask "does this score actually discriminate?" */
export function entropyBits(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  if (!n) return 0;
  return -counts.reduce((a, c) => (c ? a + (c / n) * Math.log2(c / n) : a), 0);
}

/**
 * Grade one metric. `ok` false is a FINDING, never an action.
 * `why` must read like a sentence a tired person can act on at 2am.
 */
const grade = (name, ok, value, why) => ({ name, ok, value, why });

/** THE POOL: how much of what we store can anyone we serve actually take? */
export async function evalPool() {
  const pool = await loadJobPool();
  const jobs = Array.isArray(pool) ? pool : pool?.jobs || [];
  let india = 0, us = 0, deletable = 0;
  for (const j of jobs) {
    if (reachabilityVerdict(j, "india").reachable) india++;
    if (reachabilityVerdict(j, "us").reachable) us++;
    if (safeToDelete(j)) deletable++;
  }
  const pct = (n) => (jobs.length ? (100 * n) / jobs.length : 0);
  return {
    metrics: { roles: jobs.length, india, us, deletable, deletablePct: +pct(deletable).toFixed(1), indiaPct: +pct(india).toFixed(1) },
    findings: [
      grade("pool is stocked", jobs.length > 20000, jobs.length, "under 20k roles means the scan lost a source"),
      grade("dead weight under 40%", pct(deletable) < 40, `${pct(deletable).toFixed(1)}%`, "a large share of the pool is unreachable by anyone we serve"),
      grade("India supply has not collapsed", india > 3000, india, "India-reachable roles fell; check the geo rule before blaming the market"),
    ],
  };
}

/** THE SCORE: does the fit score still discriminate, or have above-bar roles collapsed to one value? */
export async function evalScoreIntegrity() {
  // ORDERED, deliberately. An unordered limit returns an arbitrary slice, so the same day's data can
  // give different readings minutes apart, which would make the trend unreadable. Most-recent-N is a sample that means the same thing every run.
  const { data } = await db().from("match_verdicts").select("output").order("scored_at", { ascending: false }).limit(1500);
  const scores = (data || []).map((r) => r?.output?.score).filter((n) => typeof n === "number");
  if (!scores.length) return { metrics: { scored: 0 }, findings: [grade("verdicts readable", false, 0, "no scores found — the cache may be empty or the shape changed")] };
  const h = {};
  for (const s of scores) h[s] = (h[s] || 0) + 1;
  const bits = entropyBits(Object.values(h));
  const above = scores.filter((s) => s >= 70);
  const aboveH = {};
  for (const s of above) aboveH[s] = (aboveH[s] || 0) + 1;
  const topShare = above.length ? (100 * Math.max(0, ...Object.values(aboveH))) / above.length : 0;
  return {
    metrics: { scored: scores.length, distinct: Object.keys(h).length, entropyBits: +bits.toFixed(2), aboveBar: above.length, topValueShare: +topShare.toFixed(1) },
    findings: [
      grade("the score discriminates", bits > 3.0, `${bits.toFixed(2)} bits`, "under ~3 bits the score is picking from a small lattice, not measuring"),
      grade("above-bar roles are not all tied", topShare < 80, `${topShare.toFixed(1)}% share one value`, "the daily pick is breaking a near-total tie at random"),
    ],
  };
}

/** THE PEOPLE: who was served, who went quiet, and how deep the profiles are. */
export async function evalPeople() {
  const people = await listActiveCandidates();
  const bands = {};
  let thin = 0;
  for (const p of people) {
    const d = profileDepth(p.dossier).depth;
    bands[bandFor(d)] = (bands[bandFor(d)] || 0) + 1;
    if (d < 6) thin++;
  }
  return {
    metrics: { active: people.length, bands, thinUnder6: thin },
    findings: [
      grade("most profiles are deep enough to match well", thin / Math.max(1, people.length) < 0.35, `${thin} of ${people.length} under 6 proof points`, "the sub-6 band has produced 0.00 clicks per email; they need the question, not another role"),
    ],
  };
}

/**
 * THE PEOPLE WE ARE FAILING QUIETLY.
 *
 * Someone whose best-ever score sits at the tie value has never had a role Charlie actually had an
 * opinion about, so their picks are effectively arbitrary.
 *
 * A person cannot see this. They see a role that is fine and not exciting, week after week, and they
 * conclude the product does not work. Then they go quiet, which looks identical to being busy.
 *
 * So it is counted every run. The threshold is deliberately "best EVER", not an average: someone whose
 * ceiling is the tie value has never been served, however many emails they received.
 */
export async function evalUnderserved() {
  const people = await listActiveCandidates();
  const { data: finds } = await db().from("finds").select("email,match").limit(3000);
  const { data: sig } = await db().from("signals").select("email,event").limit(3000);
  const clicked = new Set((sig || []).filter((s) => s.event === "apply_click").map((s) => s.email));
  const byUser = {};
  for (const f of finds || []) {
    const sc = f?.match?.score;
    if (typeof sc === "number") (byUser[f.email] ||= []).push(sc);
  }
  let scored = 0, underserved = 0, worst = null;
  for (const p of people) {
    const s = byUser[p.email];
    if (!s?.length) continue;
    scored++;
    const max = Math.max(...s);
    // Never a strong role AND never a click. Either alone is noise; together it is a person the
    // product has not worked for, and they will leave without telling us.
    if (max <= 78 && !clicked.has(p.email)) {
      underserved++;
      if (!worst || s.length > worst.n) worst = { n: s.length, max, head: String(p.dossier?.headline || "").slice(0, 50) };
    }
  }
  const pct = scored ? (100 * underserved) / scored : 0;
  return {
    metrics: { scored, underserved, pct: +pct.toFixed(1), worst },
    findings: [
      grade(
        "people the product is actually working for",
        pct < 30,
        `${underserved} of ${scored} underserved (${pct.toFixed(0)}%)`,
        "best-ever role at or below the bar AND never a click. They cannot see this and will go quiet rather than complain; check whether the ranking is producing any spread for them (build 4)",
      ),
    ],
  };
}

/** THE LOOPS: is the machinery that feeds later builds actually filling up? */
export async function evalLoops() {
  const people = await listActiveCandidates();
  let withCov = 0, ready = 0, sample = "";
  for (const p of people) {
    const finds = await getFinds(p.email, { status: "digest", limit: 12 }).catch(() => []);
    const covs = storedCoverages(finds);
    if (covs.length) withCov++;
    const q = questionFor(covs);
    if (q) { ready++; if (!sample) sample = `${q.gap} (${q.count}/${q.total})`; }
  }
  const clicks = await listRecentApplyClicks().catch(() => []);
  return {
    metrics: { peopleWithStoredCoverage: withCov, depthQuestionReady: ready, sampleQuestion: sample, recentApplyClicks: clicks.length },
    findings: [
      grade("coverage is being persisted", withCov > 0, withCov, "no near-miss carries coverage; the send is not saving what it computed"),
    ],
  };
}

/** Run every section, record the snapshot, print a readable report. */
export async function runEval({ log = console.log, record = true } = {}) {
  const sections = {};
  const findings = [];
  for (const [name, fn] of [["pool", evalPool], ["score", evalScoreIntegrity], ["people", evalPeople], ["served", evalUnderserved], ["loops", evalLoops]]) {
    try {
      const r = await fn();
      sections[name] = r.metrics;
      for (const f of r.findings) findings.push({ ...f, section: name });
    } catch (e) {
      sections[name] = { error: e.message };
      findings.push({ section: name, name: `${name} measurable`, ok: false, value: "error", why: e.message });
    }
  }

  const failed = findings.filter((f) => !f.ok);
  log("\n══ RUN EVAL ══");
  for (const [k, v] of Object.entries(sections)) log(`  ${k.padEnd(7)} ${JSON.stringify(v)}`);
  log("");
  for (const f of findings) log(`  ${f.ok ? "PASS" : "FLAG"}  ${f.name} — ${f.value}${f.ok ? "" : `\n         ${f.why}`}`);
  log(`\n${failed.length ? `${failed.length} FLAG(S)` : "all clear"} · nothing was changed by this evaluation\n`);

  if (record) {
    // Owner-scoped: this is a system reading, not a fact about a person.
    await recordSignal({
      email: process.env.ALERT_EMAIL || process.env.OWNER_EMAIL || "system",
      event: "run_eval",
      meta: { sections, flags: failed.map((f) => ({ name: f.name, value: String(f.value) })) },
    }).catch(() => {});
  }
  return { sections, findings, failed: failed.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadEnv();
  const r = await runEval({ record: !process.argv.includes("--dry") });
  process.exit(0); // NEVER fail the chain: an evaluator that can crash the run is worse than no evaluator
}
