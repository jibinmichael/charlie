// run-charlie.mjs — the send step. For one user (CHARLIE_USER_EMAIL), take the
// best above-bar role not already in their finds, look up the company, compose +
// render the single inline email, record the find in Supabase, and (if Resend is
// configured) send it and mark the find emailed.
//
//   node run-charlie.mjs            compose + render + send the top new role
//   node run-charlie.mjs --sample   compose + render only, write sample-email.html
//
// Dedup lives in the `finds` table now, gated on status: a role whose find is
// already 'emailed' is handled and won't be re-emailed. A find still 'new' (e.g.
// a send that failed) is retried on the next run. The dossier comes from the
// per-user `candidates` store, not a local file.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import { composeEmailFields, lookupCompany } from "./composer.mjs";
import { renderEmail } from "./render-email.mjs";
import { unsubUrlFor } from "./email-kit.mjs";
import { loadEnv, userEmail, getDossier, getFindIds, upsertFind, setFindStatus } from "./charlie-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MATCHED_PATH = join(here, "matched-jobs.json");
const SAMPLE_PATH = join(here, "sample-email.html");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  loadEnv();
  const email = userEmail();
  const sampleOnly = process.argv.includes("--sample");

  // 1. read matched-jobs.json, keep above-the-bar, sort by score desc
  let matched;
  try {
    matched = JSON.parse(readFileSync(MATCHED_PATH, "utf8"));
    if (!Array.isArray(matched)) throw new Error("matched-jobs.json must be an array");
  } catch (err) {
    fail(`could not read matched-jobs.json: ${err.message} — run the matcher first.`);
  }

  const above = matched
    .filter((j) => j.passed_bar)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));

  // 2. dedup against this user's emailed finds (status='emailed' = handled;
  //    a 'new' find whose send failed is left out so it gets retried)
  let handled;
  try {
    handled = await getFindIds(email);
  } catch (err) {
    fail(err.message);
  }

  // 3. single top above-bar role not yet emailed for this user
  const job = above.find((j) => !handled.has(`${email}:${j.id}`));
  if (!job) {
    console.log(`nothing new above the bar for ${email} (${handled.size} already emailed)`);
    return;
  }

  // 4. dossier from the per-user store (not a local file)
  let dossier;
  try {
    dossier = await getDossier(email);
  } catch (err) {
    fail(err.message);
  }
  if (!dossier) fail(`no dossier in candidates for ${email} — onboard this address first`);
  const dossierText = JSON.stringify(dossier, null, 2);

  const { match, passed_bar, ...rawJob } = job;

  // 5. look up the company on the web (verified facts + sources, or null).
  console.log(`looking up ${job.company} on the web...`);
  const companyInsight = await lookupCompany(job.company, { jobHint: job.title });

  // 6. compose the email fields (prose + the matcher verdict + the company block).
  let fields;
  try {
    fields = await composeEmailFields(dossierText, JSON.stringify(rawJob, null, 2), { match, companyInsight });
  } catch (err) {
    if (err.raw) {
      console.error("composer did not return valid JSON. raw reply below — tune composer.md:\n");
      console.error(err.raw);
      process.exit(1);
    }
    fail(`composer failed: ${err.message}\ncheck that ANTHROPIC_API_KEY is set in .env.local`);
  }

  // 7. render the single inline email and write the local sample.
  const unsubUrl = unsubUrlFor(process.env.CHARLIE_TO || email);
  const html = renderEmail({ fields, match, applyUrl: job.apply_url, unsubUrl });
  writeFileSync(SAMPLE_PATH, html);
  const emailKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`sample written: ${SAMPLE_PATH}`);
  console.log(`email size: ${emailKb} KB (gmail clips ~102 KB)`);

  // --sample is a pure dry preview: no DB write, no send.
  if (sampleOnly) {
    console.log(`--sample: selected ${job.company} · ${job.title} (${match?.score ?? "?"}); wrote preview, no finds row, not sending.`);
    return;
  }

  // 8. record the find (status "new" = processed/handled → dedup on re-run).
  let findId;
  try {
    findId = await upsertFind({ email, jobId: job.id, job: rawJob, match, composed: fields, status: "new", slot: 1 });
    console.log(`find recorded: ${findId}`);
  } catch (err) {
    fail(err.message);
  }

  // 9. send via Resend, only if configured; mark the find emailed on success.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CHARLIE_FROM;
  const to = process.env.CHARLIE_TO;
  if (!apiKey || !from || !to) {
    console.log("Resend not configured (RESEND_API_KEY/CHARLIE_FROM/CHARLIE_TO) — find saved as 'new', not sending.");
    return;
  }

  const subject = fields.subject || `${fields.role_title || job.title} @ ${fields.company || job.company}`;
  const resend = new Resend(apiKey);
  try {
    const { data, error } = await resend.emails.send(
      { from, to, subject, html, headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
      { idempotencyKey: `find-alert/${findId}` }, // never double-send the same find on retry
    );
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    await setFindStatus(email, findId, "emailed");
    console.log(`sent: ${match?.score ?? "?"} · ${job.company} · ${job.title} → ${to}`);
    if (data?.id) console.log(`resend id: ${data.id}`);
  } catch (err) {
    // the find stays 'new', so the next run picks it up and retries the send.
    console.error(`send failed (find left as 'new', will retry next run): ${err.message}`);
    process.exit(1);
  }
}

main();
