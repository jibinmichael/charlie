// sweep.mjs — the twice-daily client-board sweep. Takes new Tally applicants through to a client's
// Notion board without anybody sitting at a computer.
//
//   npm run sweep:run                      # the cron entry point
//   node --env-file=.env.local sweep.mjs --dry     # read everything, write nothing, spend nothing
//
// FOUR STEPS, IN THIS ORDER, PER MANDATE:
//   1. pool     new applicants into talent_pool                (scripts/pool-applicants.mjs, $0)
//   2. fetch    submissions + consent gate + CVs               ($0)
//   3. score    only the unscored, or whose CV arrived since          (~$0.04 each)
//   4. board    create missing rows, repair partial ones       ($0)
//
// IT RUNS ON ITS OWN SERVICE, NOT INSIDE engine:run. The daily send is an &&-chain, and a failure
// early in that chain has silently aborted the send before. Nothing about scoring a sales applicant
// should be able to stop a job seeker's email, so this is a separate entry point with its own
// schedule and its own heartbeat.
//
// EVERY STEP IS IDEMPOTENT, WHICH IS WHY IT CAN RUN UNATTENDED. Already-pooled people are skipped,
// already-scored people are not re-scored, already-created rows are repaired rather than duplicated.
// A failed run costs the next run a few extra seconds and nothing else.
//
// CRITERIA ARE NEVER DERIVED HERE. Deciding what a client's board scores people on is a human's
// call, made once, in a reviewed PR. The sweep only touches mandates already in lib/mandates.mjs —
// and it NAMES the live Tally forms that have none, so a new posting surfaces as a decision waiting
// for the operator rather than as silence.
//
// THE SUMMARY EMAIL IS THE POINT. Many pipeline faults (a wrong date assumption, a discarded CV
// format, a label that fires for everyone) are only visible to a human reading output. Running
// unattended means that reading has to happen somewhere, so the run mails what it did AND what it
// refused to do.

import "./lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Resend } from "resend";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs";
import { pingHeartbeat } from "./lib/heartbeat.mjs";
import { MANDATES, FORMS_WITHOUT_MANDATE } from "./lib/mandates.mjs";
import { TallyFormsPage } from "./lib/schemas/tally.mjs";

const run = promisify(execFile);
const DRY = process.argv.includes("--dry");
const OUT = process.env.SWEEP_WORK_DIR || "/tmp/charlie-sweep";
const started = Date.now();

const log = (m) => console.error(`[sweep] ${m}`);

/** Run one of our own scripts and return its output. Never throws: a failed step is data. */
async function step(script, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000,
      env: { ...process.env },
    });
    return { ok: true, out: `${stdout}\n${stderr}` };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}\n${e.stderr || ""}`, error: String(e.message).slice(0, 300) };
  }
}

const numAfter = (text, re) => { const m = String(text).match(re); return m ? Number(m[1]) : 0; };

async function sweepMandate(M) {
  const r = { key: M.key, board: M.board, pooled: 0, consented: 0, withheld: 0, scored: 0, failedScores: 0, created: 0, repaired: 0, cvNotUsed: [], problems: [] };

  const pool = await step("scripts/pool-applicants.mjs", ["--form", M.formId, ...(DRY ? [] : ["--apply"])]);
  if (!pool.ok) r.problems.push(`pool ingest failed: ${pool.error}`);
  r.pooled = numAfter(pool.out, /^(?:added|would add)\s+(\d+)/m);
  // The ingest refuses to run when a form's consent question has changed wording. That refusal is the
  // guard working, and it must reach a human rather than be counted as "0 new".
  if (/consent|regress|refus/i.test(pool.out) && !pool.ok) r.problems.push("pool ingest refused — check consent drift on this form");

  const fetched = await step("scripts/mandate-run.mjs", ["--mandate", M.key, "--out", OUT, ...(DRY ? ["--skip-score"] : [])]);
  r.consented = numAfter(fetched.out, /consented (\d+)/);
  r.withheld = numAfter(fetched.out, /withheld (\d+)/);
  r.scored = numAfter(fetched.out, /^scored (\d+)/m);
  r.failedScores = numAfter(fetched.out, /failed (\d+)/);
  // Named individually, never summarised away: each is a person whose row will read "Application only".
  for (const line of fetched.out.split("\n")) {
    const m = line.match(/CV NOT USED — (.*)$/);
    if (m) r.cvNotUsed.push(m[1].trim());
  }
  if (!fetched.ok && !/NOTHING WAS SCORED/.test(fetched.out)) r.problems.push(`scoring step failed: ${fetched.error}`);

  if (!DRY) {
    const board = await step("scripts/mandate-board.mjs", ["--mandate", M.key, "--in", OUT, "--sync", "--apply"]);
    if (!board.ok) r.problems.push(`board write failed: ${board.error}`);
    r.created = numAfter(board.out, /^created (\d+)/m);
    r.repaired = numAfter(board.out, /^repaired (\d+)/m);
    for (const line of board.out.split("\n")) if (/FAILED/.test(line)) r.problems.push(line.trim().slice(0, 200));
  }
  return r;
}

export function summarise(results, unmandated, { dry = DRY, elapsedMs = Date.now() - started } = {}) {
  const t = (f) => results.reduce((a, x) => a + x[f], 0);
  const problems = results.flatMap((r) => r.problems.map((p) => `${r.board}: ${p}`));
  const cvIssues = results.flatMap((r) => r.cvNotUsed.map((c) => `${r.board}: ${c}`));
  const rows = results.map((r) =>
    `<tr><td>${r.board}</td><td align=right>${r.pooled}</td><td align=right>${r.consented}</td>` +
    `<td align=right>${r.withheld}</td><td align=right>${r.scored}</td><td align=right>${r.created}</td>` +
    `<td align=right>${r.repaired}</td></tr>`).join("");

  const quiet = !t("pooled") && !t("scored") && !t("created") && !t("repaired") && !unmandated.length;
  // The subject is the only part most days get read. It says the largest true thing, in the order
  // that matters: a problem, then a decision waiting, then work done, then nothing.
  const did = [t("created") && `${t("created")} new on boards`, t("scored") && `${t("scored")} scored`,
               t("pooled") && `${t("pooled")} into the pool`, t("repaired") && `${t("repaired")} repaired`]
    .filter(Boolean).join(", ");
  const subject = problems.length
    ? `Charlie sweep: ${problems.length} thing${problems.length === 1 ? "" : "s"} needing a human`
    : unmandated.length ? `Charlie sweep: ${unmandated.length} new form(s) awaiting a decision`
    : quiet ? "Charlie sweep: nothing new"
    : `Charlie sweep: ${did}`;

  const html =
    `<p><strong>Client board sweep</strong> — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC, ` +
    `${Math.round(elapsedMs / 1000)}s${dry ? ", DRY RUN" : ""}.</p>` +
    `<table cellpadding=6 border=1 style="border-collapse:collapse;font:13px system-ui"><tr>` +
    `<th align=left>Board</th><th>Pooled</th><th>Consented</th><th>Withheld</th><th>Scored</th><th>New rows</th><th>Repaired</th></tr>${rows}</table>` +
    (t("withheld") ? `<p style="color:#666">${t("withheld")} applicant(s) did not agree to be shown to the employer and have no row. That is correct, not a gap.</p>` : "") +
    (cvIssues.length
      ? `<p><strong>CVs we could not read (${cvIssues.length})</strong> — these rows say "Application only", which a hiring team reads as <em>they sent nothing</em>:</p><ul>${cvIssues.map((c) => `<li>${c}</li>`).join("")}</ul>`
      : "") +
    (unmandated.length
      ? `<p><strong>New forms nobody has decided about (${unmandated.length})</strong> — these are published and collecting applicants, and are in neither MANDATES nor FORMS_WITHOUT_MANDATE. Nobody from them reaches a board until their criteria are reviewed:</p><ul>${unmandated.map((f) => `<li>${f}</li>`).join("")}</ul>`
      : "") +
    (problems.length
      ? `<p><strong>Needs a human (${problems.length}):</strong></p><ul>${problems.map((p) => `<li>${p}</li>`).join("")}</ul>`
      : `<p style="color:#666">No step failed and nothing was refused.</p>`) +
    `<p style="color:#888">Criteria are never derived automatically. A new mandate stays off this sweep until its criteria are approved and added to lib/mandates.mjs.</p>`;

  return { subject, html, problems: problems.length };
}

async function mail({ subject, html }) {
  const to = process.env.ALERT_EMAIL || process.env.CHARLIE_TO || process.env.OWNER_EMAIL || "";
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const key = process.env.RESEND_API_KEY;
  // AN OWNER CANARY, LIKE health-check AND watchdog — and an explicit one: sweep.mjs is named in
  // lib/send-doors.test.mjs, which fails when any new file calls resend.emails.send. It reaches one
  // mailbox we control and can never reach a candidate.
  //
  // It does NOT go through sendGuarded, on purpose. That door enforces suppression and per-key
  // idempotency, both of which are correct for a candidate and wrong here: a suppressed owner address
  // would silence the ops report that says something is broken, and a dedupe key would swallow the
  // second run of the day. An ops report that can be deduped away is not an ops report.
  if (DRY || !key) { log(`summary not sent (${DRY ? "dry run" : "no RESEND_API_KEY"}) — would mail ${to}: ${subject}`); return; }
  try {
    const { error } = await new Resend(key).emails.send({ from, to, subject, html });
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    log(`summary emailed to ${to}`);
  } catch (e) { log(`summary FAILED to send: ${e.message}`); } // a reporting failure must not fail the run
}

async function main() {
  initSentry({ name: "sweep" });
  const mandates = Object.values(MANDATES);
  log(`${mandates.length} mandate(s)${DRY ? " — DRY RUN, nothing will be written" : ""}`);

  const results = [];
  for (const M of mandates) {
    log(`— ${M.board}`);
    try {
      results.push(await sweepMandate(M));
    } catch (e) {
      // Per-record isolation: one broken mandate must never stop the others.
      captureError(e, { mandate: M.key });
      results.push({ key: M.key, board: M.board, pooled: 0, consented: 0, withheld: 0, scored: 0, failedScores: 0, created: 0, repaired: 0, cvNotUsed: [], problems: [`sweep threw: ${String(e.message).slice(0, 200)}`] });
    }
  }

  // Live forms that are in neither MANDATES nor FORMS_WITHOUT_MANDATE — i.e. genuinely new, and
  // nobody has decided what they are. Named rather than counted, because "1 form unhandled" is not
  // actionable and a form title is. Acknowledged forms stay silent so this line means something.
  let unmandated = [];
  try {
    const known = new Set([...mandates.map((m) => m.formId), ...Object.keys(FORMS_WITHOUT_MANDATE)]);
    const res = await fetch("https://api.tally.so/forms?limit=100", { headers: { Authorization: `Bearer ${process.env.TALLY_API_KEY}` } });
    // External data is validated at the boundary. A shape change at Tally must surface as a
    // logged skip, not as an empty list that reads exactly like "no new forms".
    const parsed = TallyFormsPage.safeParse(await res.json());
    if (!parsed.success) throw new Error(`Tally /forms failed validation: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    const forms = Array.isArray(parsed.data) ? parsed.data : parsed.data.items || [];
    unmandated = forms
      .filter((f) => f.status === "PUBLISHED" && !known.has(f.id) && Number(f.numberOfSubmissions || 0) > 0)
      .map((f) => `${f.name} (${f.id}, ${f.numberOfSubmissions} applicants)`);
  } catch (e) {
    log(`could not list Tally forms: ${e.message}`);
  }

  const summary = summarise(results, unmandated);
  for (const r of results) log(`${r.board}: pooled ${r.pooled}, scored ${r.scored}, new ${r.created}, repaired ${r.repaired}, problems ${r.problems.length}`);
  await mail(summary);

  // Heartbeat LAST and only on a clean pass. A run that reported problems has not done its job, and a
  // green heartbeat would tell the monitor otherwise — silence is the signal we want in that case.
  if (!summary.problems && !DRY) await pingHeartbeat("sweep");
  else if (summary.problems) log(`heartbeat NOT pinged — ${summary.problems} problem(s) need a human`);

  await flushSentry();
  log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
}

// Run only when executed directly. Without this, importing sweep.mjs — which a test must do to check
// the summary logic — would launch a real sweep against live Tally and a real client's board.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    captureError(e, { where: "sweep.main" });
    console.error(`[sweep] fatal: ${e.message}`);
    await flushSentry();
    process.exit(1);
  });
}
