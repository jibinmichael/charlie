// freshness.test.mjs — the freshness-in-send-decision fence (run: node freshness.test.mjs).
// Deterministic: a fixed `now` and explicit posted_at dates, no clock/model/network. Proves the decay
// shape, the blend, and that the reorder surfaces a fresher role WITHOUT letting freshness override a real
// fit gap — and that it is a stable, pure reorder.
import { freshnessScore, blendedScore, freshnessReorder } from "./freshness.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };
const approx = (a, b, e = 0.02) => Math.abs(a - b) <= e;

const NOW = Date.parse("2026-07-28T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400e3).toISOString();
const job = (score, ageDays) => ({ id: `j${score}-${ageDays}`, company: `Co${score}`, title: `Role ${ageDays}d`, match: { score }, posted_at: ageDays == null ? null : daysAgo(ageDays) });

// defaults: FRESH_FULL_DAYS=2, FRESH_HORIZON_DAYS=45, FRESH_UNKNOWN=0.2, FRESHNESS_WEIGHT=0.2
delete process.env.FRESH_FULL_DAYS; delete process.env.FRESH_HORIZON_DAYS; delete process.env.FRESH_UNKNOWN; delete process.env.FRESHNESS_WEIGHT;

// ── decay shape ──────────────────────────────────────────────────────────────────────────────
ok("freshness: brand new (0d) -> 1.0", freshnessScore(job(80, 0), NOW) === 1);
ok("freshness: within full window (2d) -> 1.0", freshnessScore(job(80, 2), NOW) === 1);
ok("freshness: ~7d -> ~0.88", approx(freshnessScore(job(80, 7), NOW), 1 - 5 / 43));
ok("freshness: ~13d -> ~0.74", approx(freshnessScore(job(80, 13), NOW), 1 - 11 / 43));
ok("freshness: at horizon (45d) -> 0", freshnessScore(job(80, 45), NOW) === 0);
ok("freshness: past horizon (60d) -> 0 (clamped)", freshnessScore(job(80, 60), NOW) === 0);
ok("freshness: unknown date -> 0.2 (low but nonzero)", freshnessScore(job(80, null), NOW) === 0.2);

// ── the reorder surfaces a fresher role among comparable fits ──────────────────────────────────
{
  // score-top is 3 days older; a near-equal-fit fresher role should win the blend.
  const cands = [job(82, 20), job(80, 0)]; // [slightly higher score but 20d old, fresh 0d]
  const out = freshnessReorder(cands, NOW);
  ok("reorder: a fresh 80 beats a 20-day-old 82 (fit is comparable)", out[0].match.score === 80 && out[0].posted_at === daysAgo(0));
}

// ── but freshness must NOT override a real fit gap ─────────────────────────────────────────────
{
  const cands = [job(92, 30), job(72, 0)]; // a much better fit (92), 30d old, vs a fresh borderline 72
  const out = freshnessReorder(cands, NOW);
  ok("reorder: a fresh 72 does NOT leapfrog a much-better 92 (freshness nudges, not dominates)", out[0].match.score === 92);
}

// ── stability + purity ─────────────────────────────────────────────────────────────────────────
{
  const cands = [job(80, 5), job(80, 5)]; // identical blend -> original order preserved (stable)
  const out = freshnessReorder(cands, NOW);
  ok("reorder: equal blends keep original order (stable, no random shuffle)", out[0] === cands[0] && out[1] === cands[1]);
  const before = cands.slice();
  freshnessReorder(cands, NOW);
  ok("reorder: pure (does not mutate the input array)", cands[0] === before[0] && cands[1] === before[1]);
}

// ── blend math sanity (default weight 0.2) ───────────────────────────────────────────────────
ok("blend: fresh 80 = 0.8*0.8 + 0.2*1.0 = 0.84", approx(blendedScore(job(80, 0), NOW), 0.84));
ok("blend: 0-score unknown-date -> 0.2*0.2 = 0.04", approx(blendedScore(job(0, null), NOW), 0.04));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
