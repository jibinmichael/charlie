// scripts/ranker-eval.mjs — does the retrieval ranker predict which emailed roles get clicked?
//
//   node --env-file=.env.local scripts/ranker-eval.mjs
//   node --env-file=.env.local scripts/ranker-eval.mjs --days 30
//
// Charlie sorts the whole job pool down to a shortlist, scores the shortlist, and sends one role.
// This joins where each emailed role ranked (job._retrievalRank, plus the retrieval feature scores
// when recorded) with whether the person clicked apply, and prints click rate by rank band, by
// source, and per feature. A top-10 rate barely above the rest means the sort is close to random
// within its own shortlist.
//
// READ-ONLY, no model call, $0.

import { loadEnv } from "../charlie-store.mjs";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const DAYS = Number(process.argv[process.argv.indexOf("--days") + 1]) || 45;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
);

const since = new Date(Date.now() - DAYS * 86400000).toISOString();
const { data: finds } = await db.from("finds").select("email,job,match,composed,status,created_at").eq("status", "emailed").gte("created_at", since).limit(3000);
const { data: sig } = await db.from("signals").select("find_id").eq("event", "apply_click").limit(5000);
const clicked = new Set((sig || []).map((s) => s.find_id).filter(Boolean));

const rows = [];
for (const f of finds || []) {
  const j = f.job || {};
  if (typeof j._retrievalRank !== "number") continue;
  rows.push({
    click: clicked.has(`${f.email}:${j.id}`),
    rank: j._retrievalRank,
    rel: j._relScore ?? null,      // present only on finds that recorded retrieval features
    sem: j._semScore ?? null,
    blend: j._blendScore ?? null,
    score: f.match?.score ?? null,
    source: j.source || "?",
  });
}

const rate = (a) => (a.length ? (100 * a.filter((r) => r.click).length) / a.length : 0);
const clicks = rows.filter((r) => r.click).length;

console.log(`\nRANKER EVAL — last ${DAYS} days`);
console.log(`${rows.length} emailed roles with a recorded rank · ${clicks} clicked (${rate(rows).toFixed(1)}%)\n`);
if (rows.length < 20) { console.log(`too few to read. Come back after another run or two.\n`); process.exit(0); }

console.log(`retrieval rank     sent  clicked   rate`);
for (const [lo, hi, label] of [[0, 0, "#1"], [1, 3, "#2-4"], [4, 9, "#5-10"], [10, 24, "#11-25"], [25, 49, "#26-50"], [50, 9999, "#51+"]]) {
  const b = rows.filter((r) => r.rank >= lo && r.rank <= hi);
  if (!b.length) continue;
  const n = b.filter((r) => r.click).length;
  const warn = b.length < 10 ? "   (thin)" : "";
  console.log(`  ${label.padEnd(14)} ${String(b.length).padStart(5)} ${String(n).padStart(8)}  ${rate(b).toFixed(1)}%${warn}`);
}
const top = rows.filter((r) => r.rank <= 9);
const rest = rows.filter((r) => r.rank > 9);
const gap = rate(top) - rate(rest);
console.log(`\n  TOP-10 ${rate(top).toFixed(1)}%  vs  REST ${rate(rest).toFixed(1)}%   gap ${gap >= 0 ? "+" : ""}${gap.toFixed(1)} points`);
console.log(`  ${gap > 3 ? "the ranker separates" : gap > 0 ? "barely separates — close to random within its own shortlist" : "DOES NOT separate: the sort is not predicting"}`);

console.log(`\nby source            sent  clicked   rate`);
const bySrc = {};
for (const r of rows) (bySrc[r.source] ??= []).push(r);
for (const [s, a] of Object.entries(bySrc).sort((x, y) => y[1].length - x[1].length)) {
  if (a.length < 8) continue;
  console.log(`  ${s.padEnd(16)} ${String(a.length).padStart(5)} ${String(a.filter((r) => r.click).length).padStart(8)}  ${rate(a).toFixed(1)}%`);
}

// ── the part that only works once features accumulate ───────────────────────────────────────────
const withFeat = rows.filter((r) => typeof r.rel === "number");
console.log(`\nfinds carrying retrieval FEATURES: ${withFeat.length} of ${rows.length}`);
if (withFeat.length < 30) {
  console.log(`  Not enough yet; each run adds more.`);
  console.log(`  At ~30 you can ask which SIGNAL predicts a click, not just which position did.\n`);
} else {
  const mean = (a, k) => { const v = a.map((x) => x[k]).filter((n) => typeof n === "number"); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; };
  const C = withFeat.filter((r) => r.click);
  const N = withFeat.filter((r) => !r.click);
  console.log(`\n  signal        clicked   ignored     gap    (what actually separates)`);
  for (const k of ["rel", "sem", "blend", "score"]) {
    const c = mean(C, k), n = mean(N, k);
    if (c == null || n == null) continue;
    console.log(`  ${k.padEnd(12)} ${c.toFixed(3).padStart(8)} ${n.toFixed(3).padStart(9)} ${(c - n >= 0 ? "+" : "") + (c - n).toFixed(3)}`);
  }
  console.log(`\n  A signal with a real gap is one to weight up. A gap near zero is noise.\n`);
}
