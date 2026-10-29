// send-one-role.mjs — send ONE specific, hand-picked role to ONE person, through the real path.
// SENDS REAL EMAIL with --send.
//
//   node_modules/.bin/tsx scripts/send-one-role.mjs <email> <jobId>          # DRY RUN
//   node_modules/.bin/tsx scripts/send-one-role.mjs <email> <jobId> --send   # actually send
//
// send-finding.mjs picks among the top roles the pre-filter returns. When the role a person should
// get sits deeper than that, or outside the MAX_JOBS_PER_USER cap entirely, this sends it by id.
//
// It does NOT bypass anything: the role still goes
// through preSendGuard (repeat / geo / language / liveness / fit) and sendGuarded (suppression +
// idempotency), so a role that should not reach someone still will not. The only thing overridden is
// WHICH role is considered, and that choice is a human's.
import { loadEnv, getCandidate, loadJobPool } from "../charlie-store.mjs";
import { tagCompanyReach } from "../select-jobs.mjs";
import { computeCoverage } from "../fit-coverage.mjs";
import { composeEmailFields } from "../composer.mjs";
import { renderEmail } from "../render-email.mjs";
import { preSendGuard } from "../presend-guard.mjs";
import { sendGuarded } from "../lib/send-guard.mjs";
import { unsubUrlFor, cleanSubject } from "../email-kit.mjs";
import { homeRegion } from "../quality-gate.mjs";
import { Resend } from "resend";

await loadEnv();
const [email, jobId] = process.argv.slice(2);
const SEND = process.argv.includes("--send");
if (!email || !jobId) { console.error("usage: send-one-role.mjs <email> <jobId> [--send]"); process.exit(1); }

const c = await getCandidate(email);
if (!c?.dossier) { console.error(`no dossier for ${email}`); process.exit(1); }
const pool = await loadJobPool();
const jobs = Array.isArray(pool) ? pool : pool?.jobs || [];
tagCompanyReach(jobs);                       // the per-company reach signal the gate reads
const job = jobs.find((j) => j.id === jobId);
if (!job) { console.error(`job ${jobId} is not in the pool — refusing to send a role that may be closed`); process.exit(1); }

const region = homeRegion(c.dossier);
console.error(`\n${job.company} — ${job.title}\n  ${JSON.stringify(job.location)}  region=${region}\n`);

const cov = await computeCoverage({ dossier: c.dossier, jobDescription: job.description || "", jobTitle: job.title || "" });
console.error(`  fit ${cov?.composite}/100  level=${cov?.seniorityLevel}  thin=${cov?.thin}`);

// The SAME choke point the daily send uses. Nothing here is skipped.
const gate = await preSendGuard({ job, dossier: c.dossier, matcherScore: 78, email, getCov: async () => cov });
// preSendGuard returns { decision, rule, reason, cov } — NOT { outcome } like gateRole.
console.error(`  guard: ${gate.decision} (${gate.rule}) — ${gate.reason}`);
if (gate.decision !== "send") { console.error("\nNOT SENDING: the guard said no. That is the guard working, not a bug.\n"); process.exit(0); }

const fields = await composeEmailFields(JSON.stringify(c.dossier, null, 2), `${job.title}\n${job.company}\n${job.location || ""}\n\n${job.description || ""}`);
const html = renderEmail({
  fields, cov, label: "Today's pick", applyUrl: job.apply_url, via: job.via, viaUrl: job.via_url,
  unsubUrl: unsubUrlFor(email), email, findId: `${email}:${job.id}`,
  jobDescription: job.description, jobLocation: job.location, region, postedAt: job.posted_at,
});
const subject = cleanSubject(fields.subject || `${job.title} at ${job.company}`);
console.error(`\n  subject: ${subject}\n  ${html.length} bytes`);
if (!SEND) { console.error("\nDRY RUN — nothing sent. Re-run with --send.\n"); process.exit(0); }

const res = await sendGuarded({
  resend: new Resend(process.env.RESEND_API_KEY),
  email, template: "role", dedupeKey: `${email}:${job.id}`,
  payload: { from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to: email, subject, html },
});
console.error(`\nSENT: ${JSON.stringify(res)}\n`);
