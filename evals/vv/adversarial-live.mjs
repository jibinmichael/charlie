// evals/vv/adversarial-live.mjs — run the writer and the judge against the adversarial cases with
// the REAL models. Opt-in, needs ANTHROPIC_API_KEY, VOICE_WRITER_MODEL and VOICE_JUDGE_MODEL. Sends
// nothing, writes nothing. Costs a few cents.
//
//   node --env-file=.env.local evals/vv/adversarial-live.mjs
//
// PASS means: every writer line passed lintUtterance (no verdict, no mechanism, one question, no
// promise) and kept the scripted question's substance, and the judge credited no element on the
// injection cases. Results are printed per case so a failure can be read, not guessed.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../../charlie-store.mjs";
import { writeUtterance, lintUtterance } from "../../voice/writer.mjs";
import { judgeOnce } from "../../voice/judge.mjs";
import { fallbackText } from "../../voice/fallback.mjs";
import { VerificationPlan } from "../../lib/schemas/vv-plan.mjs";

loadEnv();
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
const plan = VerificationPlan.parse(JSON.parse(fs.readFileSync("evals/vv/test-plan.json", "utf8")));
const cases = JSON.parse(fs.readFileSync("evals/vv/adversarial/cases.json", "utf8"));
const byRef = Object.fromEntries(plan.items.map((i) => [i.ref, i]));
const client = new Anthropic();

let failures = 0;
for (const c of cases) {
  const item = byRef[c.item_ref];
  const scripted = fallbackText(item, c.move, { plan });
  const w = await writeUtterance({ client, move: c.move, scriptedText: scripted, purpose: item.evidence_contract.establishes, candidateName: "Priya", exchanges: c.exchanges, log: () => {} });
  const lint = lintUtterance(w.text);
  const j = await judgeOnce({ client, item, exchanges: c.exchanges, log: () => {} });
  const present = j?.present?.length ?? 0;
  const problems = [];
  if (!lint.ok) problems.push(`writer lint: ${lint.violations.join("; ")}`);
  if (c.expect.judge_present_max != null && present > c.expect.judge_present_max) problems.push(`judge credited ${j.present.join(",")} (max ${c.expect.judge_present_max})`);
  if (c.expect.judge_present_min != null && present < c.expect.judge_present_min) problems.push(`judge credited nothing (min ${c.expect.judge_present_min})`);
  if (c.expect.judge_relevant != null && j && j.relevant !== c.expect.judge_relevant) problems.push(`judge relevant=${j.relevant}, expected ${c.expect.judge_relevant}`);
  for (const phrase of c.expect.writer_forbidden || []) if (w.text.toLowerCase().includes(phrase)) problems.push(`writer attributed something the candidate did not say: "${phrase}"`);
  console.log(`\n== ${c.name} (${c.move}) ${problems.length ? "FAIL" : "ok"}`);
  console.log(`   scripted : ${scripted}`);
  console.log(`   writer   : ${w.text}  [${w.reason}, ${w.latencyMs}ms]`);
  console.log(`   judge    : ${j ? JSON.stringify(j) : "null"}`);
  for (const p of problems) console.log(`   !! ${p}`);
  failures += problems.length ? 1 : 0;
}
console.log(`\n${cases.length - failures}/${cases.length} cases clean`);
process.exit(failures ? 1 : 0);
