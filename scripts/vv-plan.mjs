// vv-plan.mjs — parse a mandate (job description + hiring questions), generate its voice-verification
// plan, read the chain back, save, approve. NO SEND. NO CANDIDATE.
//
//   npm run voice:plan -- --jd jd.txt --questions q.txt --budget 900 --contact hr@client.com --role "Field Service Technician" [--client "Example Co"] [--json out.json]
//   npm run voice:plan -- --jd jd.txt --questions q.txt --budget 900 --contact hr@client.com --role "Field Service Technician" --save [--next-step "We will be in touch within a week."]
//   npm run voice:plan -- --approve <plan id> --by you@example.com [--override "reason the flagged question is fine"]
//
// WHAT IT IS FOR. A human argues with the plan before a candidate hears it. The first form prints
// every item with its whole chain (quote -> requirement -> why -> contract -> question -> probes ->
// expected evidence -> fallback) and the chain check's verdict, and writes nothing. --save inserts
// the mandate, its requirements and the plan as a DRAFT. --approve re-runs the chain check on what
// is in the database and, only if every link holds, writes the immutable approved version.
//
// --budget IS REQUIRED: the session length is the operator's choice and this script will not pick one.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../charlie-store.mjs";
import { parseMandate, generatePlan, approvePlan, checkChain, renderPlan } from "../voice/plan.mjs";
import { renderMatrix } from "../lib/mandate-parse.mjs";
import { saveMandate, saveRequirements, nextPlanVersion, savePlan, loadPlan, persistApproval } from "../voice/store.mjs";

loadEnv();
const flag = (n, d = "") => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] ?? d) : d; };
const has = (n) => process.argv.includes(n);

function readLines(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function generate() {
  const jdFile = flag("--jd");
  if (!jdFile) throw new Error("--jd <file> is required");
  const jd = fs.readFileSync(jdFile, "utf8");
  const questions = flag("--questions") ? readLines(flag("--questions")) : [];
  const budget = Number(flag("--budget"));
  if (!Number.isInteger(budget) || budget < 60) throw new Error("--budget <seconds> is required (an integer of at least 60). The session length is an open decision; this script does not choose it.");
  const contact = flag("--contact");
  const role = flag("--role");
  if (has("--save") && (!contact || !role)) throw new Error("--save needs --contact <email> and --role <title>");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic();
  const { matrix, dropped: mDropped } = await parseMandate({ client, jd, sourceName: jdFile });
  console.log(renderMatrix(matrix, mDropped, jdFile));
  console.log("\n" + "=".repeat(78) + "\n");

  const { plan, dropped, chain } = await generatePlan({ client, matrix, questions, sessionBudgetSeconds: budget, jdText: jd });
  console.log(renderPlan(plan, { dropped, chain }));

  const out = flag("--json");
  if (out) { fs.writeFileSync(out, JSON.stringify({ matrix, mandateDropped: mDropped, plan, dropped, chain }, null, 2)); console.error(`\nwritten to ${out}`); }

  if (has("--save")) {
    const mandate = await saveMandate({ client: flag("--client") || null, role, contact_email: contact, jd_text: jd, hr_questions: questions, next_step_text: flag("--next-step") || null, parsed: matrix, dropped: mDropped });
    const refMap = await saveRequirements(mandate.id, matrix);
    plan.mandate_id = mandate.id;
    plan.version = await nextPlanVersion(mandate.id);
    await savePlan(plan, refMap);
    console.error(`\nsaved as DRAFT: mandate ${mandate.id}, plan ${plan.id} v${plan.version}`);
    console.error(chain.ok ? `chain holds; approve with: --approve ${plan.id} --by <email>` : `chain has ${chain.failures.length} failure(s); it cannot be approved as is`);
  }
}

async function approve() {
  const planId = flag("--approve");
  const by = flag("--by");
  if (!by) throw new Error("--by <approver email> is required");
  const { plan, mandate } = await loadPlan(planId);
  const questions = Array.isArray(mandate.hr_questions) ? mandate.hr_questions : [];
  const chain = checkChain(plan, { jdText: mandate.jd_text, questions });
  console.log(renderPlan(plan, { chain }));
  if (!chain.ok) { console.error("\nnot approved: the chain does not hold (see above)."); process.exit(1); }
  const approved = await approvePlan(plan, { by, jdText: mandate.jd_text, questions, persist: persistApproval, override: flag("--override") || null });
  console.error(`\nAPPROVED plan ${approved.id} v${approved.version} by ${approved.approved_by} at ${approved.approved_at}`);
}

(has("--approve") ? approve() : generate()).catch((e) => { console.error(`[vv-plan] ${e.message}`); process.exit(1); });
