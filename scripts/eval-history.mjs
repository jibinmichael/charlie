// scripts/eval-history.mjs — print the run-eval series (signals.event = 'run_eval') as a trend.
// READ ONLY, no writes, no sends.
//
//   node --env-file=.env.local scripts/eval-history.mjs
//
// A single reading is a snapshot; the series shows a metric drifting the wrong way over many runs.
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../charlie-store.mjs";
await loadEnv();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await db.from("signals").select("meta,created_at").eq("event", "run_eval").order("created_at", { ascending: true }).limit(60);
if (!data?.length) { console.log("no run_eval snapshots yet — the first lands after the next engine run"); process.exit(0); }

const row = (r) => {
  const s = r.meta?.sections || {};
  return {
    when: r.created_at.slice(5, 16).replace("T", " "),
    roles: s.pool?.roles ?? "?",
    dead: s.pool?.deletablePct ?? "?",
    india: s.pool?.india ?? "?",
    bits: s.score?.entropyBits ?? "?",
    tied: s.score?.topValueShare ?? "?",
    users: s.people?.active ?? "?",
    thin: s.people?.thinUnder6 ?? "?",
    cov: s.loops?.peopleWithStoredCoverage ?? "?",
    ready: s.loops?.depthQuestionReady ?? "?",
    flags: (r.meta?.flags || []).length,
  };
};
const rows = data.map(row);
console.log("when        roles   dead%  india   bits  tied%  users  thin  cov  ready  flags");
for (const r of rows) {
  console.log(
    `${r.when}  ${String(r.roles).padStart(6)} ${String(r.dead).padStart(6)} ${String(r.india).padStart(6)} ` +
    `${String(r.bits).padStart(6)} ${String(r.tied).padStart(6)} ${String(r.users).padStart(6)} ${String(r.thin).padStart(5)} ` +
    `${String(r.cov).padStart(4)} ${String(r.ready).padStart(6)} ${String(r.flags).padStart(6)}`,
  );
}
if (rows.length >= 2) {
  const a = rows[rows.length - 2], b = rows[rows.length - 1];
  const d = (k) => (typeof a[k] === "number" && typeof b[k] === "number" ? b[k] - a[k] : null);
  const moves = ["roles", "india", "bits", "tied", "users", "thin", "cov", "ready"].map((k) => [k, d(k)]).filter(([, v]) => v);
  console.log(`\nsince the previous run: ${moves.length ? moves.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ") : "no change"}`);
}
const last = data[data.length - 1];
if ((last.meta?.flags || []).length) {
  console.log("\nopen flags on the latest run:");
  for (const f of last.meta.flags) console.log(`  · ${f.name} — ${f.value}`);
}
