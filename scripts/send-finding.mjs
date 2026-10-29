// send-finding.mjs — send ONE real matched-role email to an onboarded user. SENDS REAL EMAIL.
// Exercises the full match -> preSendGuard -> compose -> verify -> render -> send path.
// Run via tsx (it imports the react-pdf template chain):
//
//   node_modules/.bin/tsx scripts/send-finding.mjs <email>
//
// The email must already have an onboarded dossier (run check-candidate first). Picks the
// best-scoring role from the live pool for that user (PICK_RANK=n picks a weaker one).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, getDossier, getCandidate, getResume, loadJobPool, getEmailedRoleSignatures } from "../charlie-store.mjs";
import { preSendGuard } from "../presend-guard.mjs";
import { sendGuarded } from "../lib/send-guard.mjs";
import { selectForUser } from "../select-jobs.mjs";
import { composeEmailFields, lookupCompany } from "../composer.mjs";
import { renderEmail } from "../render-email.mjs";
import { computeCoverage } from "../fit-coverage.mjs";
import { unsubUrlFor, cleanSubject } from "../email-kit.mjs";
// NOTE: buildEmailAttachments is deliberately NOT imported. The role email carries no tailored resume
// or cover letter; tailoring is on request only.
import { verifyGrounding } from "../grounding-verify.mjs";
import { homeRegion } from "../quality-gate.mjs";
import { computePay, computeMomentum } from "../role-intel.mjs";
import { resolveInlineReferral } from "../referral-inline.mjs";
import { buildScoringMessages } from "../prompts/match-scoring.mjs"; // versioned prompt — see prompts/

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) { console.error("usage: node_modules/.bin/tsx scripts/send-finding.mjs <email>"); process.exit(1); }

loadEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dossier = await getDossier(email);
if (!dossier) { console.error(`No dossier for ${email}. Onboard first.`); process.exit(1); }
const cand = await getCandidate(email).catch(() => null);
const to = cand?.email_config?.notify || email; // respect the preferred recipient
const resumeText = await getResume(email).catch(() => null);
const pool = await loadJobPool();
const matcher = readFileSync(join(root, "matcher.md"), "utf8");
const client = new Anthropic();

const { jobs: sel } = selectForUser(dossier, pool, 8);
const scored = await Promise.all(sel.map(async (job) => {
  const r = await client.messages.create({
    model: "claude-haiku-4-5", max_tokens: 600,
    ...buildScoringMessages({ matcherText: matcher, dossierText: JSON.stringify(dossier), job, todayLine: null }),
  });
  const t = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let m; try { m = JSON.parse(t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch { m = { score: 0, verdict: "skip" }; }
  return { job, match: m };
}));
scored.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
const rank = Math.min(Math.max(0, Number(process.env.PICK_RANK || 0)), scored.length - 1); // 0=best; higher=weaker match (stress test)
const { job: rawJob, match } = scored[rank] || scored[0];
console.log(`picked [rank ${rank}/${scored.length}]: ${rawJob.title} @ ${rawJob.company} (${match.score} ${match.verdict})`);

// The SAME preSendGuard as the real path (repeat/geo/language/liveness/fit). A non-"send" verdict
// stops the tool.
const signatures = await getEmailedRoleSignatures(email).catch(() => []);
const gate = await preSendGuard({
  job: rawJob,
  dossier,
  matcherScore: match?.score,
  signatures,
  getCov: () => computeCoverage({ dossier, jobDescription: rawJob.description, jobTitle: rawJob.title }).catch(() => ({ thin: true })),
});
if (gate.decision !== "send") {
  console.error(`GATED (${gate.decision}): ${gate.reason}. not sending. Try another role/user (or PICK_RANK).`);
  process.exit(1);
}

let companyInsight = null;
try { companyInsight = await lookupCompany(rawJob.company, { jobHint: rawJob.title }); } catch { /* skip */ }
const fields = await composeEmailFields(JSON.stringify(dossier, null, 2), JSON.stringify(rawJob, null, 2), { match, companyInsight });
const grounding = await verifyGrounding({
  sourceText: `${JSON.stringify(dossier)}\n\nRESUME:\n${resumeText || ""}`,
  artifactText: JSON.stringify({ why_you: fields.why_you, flag: fields.flag, resume_tips: fields.resume_tips, cover_letter: fields.cover_letter, facts: fields.facts }),
});
console.log(`verify: ${grounding.severity}${grounding.violations?.length ? " — " + grounding.violations.map((x) => `"${x.claim}" (${x.issue})`).join(" | ") : " (clean)"}`);
const cov = await computeCoverage({ dossier, jobDescription: rawJob.description, jobTitle: rawJob.title }).catch((e) => { console.log(`[fit] coverage skipped: ${e.message}`); return { thin: true }; });
console.log(`fit: ${cov.thin ? "thin (prose fallback)" : `${cov.composite}/100 lane=${cov.lane} conf=${cov.confidence}`}`);
const unsubUrl = unsubUrlFor(email);
// No tailored resume or cover letter is generated or attached to a role email. Only a resolved
// referral's intro message rides along, as in scheduler.mjs (guarded by role-attachments.test.mjs).
const attachments = [];
const region = homeRegion(dossier);
const pay = region === "us" ? await computePay(rawJob).catch(() => null) : null;
const momentum = region === "us" ? await computeMomentum(rawJob.company, pool).catch(() => null) : null;
let referral = null;
if (region === "us") {
  const rr = await resolveInlineReferral({ email, dossier, company: rawJob.company, jobUrl: rawJob.apply_url || rawJob.url, roleTitle: rawJob.title, location: rawJob.location, owner: email === String(process.env.OWNER_EMAIL || "").toLowerCase() }).catch(() => null);
  if (rr) { referral = rr.referral; if (rr.introAttachment) attachments.push(rr.introAttachment); }
}
console.log(`region: ${region}${region === "us" ? ` | pay: ${pay ? `$${Math.round(pay.lo/1000)}k-${Math.round(pay.hi/1000)}k${pay.bls ? ` vs BLS $${Math.round(pay.bls.median/1000)}k` : " (no BLS)"}` : "none"} | momentum: ${momentum ? `${momentum.openNow} open` : "none"}` : " (enrichment hidden)"}`);
// Same render params as scheduler.mjs. No `attached`: renderEmail has none (the slot-6 footnote derives
// from `referral`).
const html = renderEmail({ fields, match, cov, label: "Best match", applyUrl: rawJob.apply_url, via: rawJob.via, viaUrl: rawJob.via_url, unsubUrl, email, findId: `${email}:${rawJob.id}`, jobDescription: rawJob.description, region, pay, momentum, postedAt: rawJob.posted_at, referral });
const subject = cleanSubject(fields.subject || `Found one worth your time: ${fields.role_title || rawJob.title} at ${fields.company || rawJob.company}`);

const resend = new Resend(process.env.RESEND_API_KEY);
const findId = `${email}:${rawJob.id}`;
const payload = {
  from: process.env.CHARLIE_FROM || "charlie@mail.example.com",
  to, subject, html,
  headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  ...(attachments.length ? { attachments } : {}),
};
// Through the one send door: suppression + idempotency + send. If the target address is suppressed,
// use a +alias you control.
const sent = await sendGuarded({ resend, email, template: "send-finding", dedupeKey: findId, payload, to, idempotencyKey: `send-finding/${findId}`, log: console.error });
if (sent.status === "suppressed") { console.error(`${to} is on the suppression list — not sent. Use a +alias you control.`); process.exit(1); }
if (sent.status === "failed") { console.error("send error:", typeof sent.error === "string" ? sent.error : JSON.stringify(sent.error)); process.exit(1); }
console.log(`${sent.status === "duplicate" ? "ALREADY SENT (idempotency)" : "SENT"} to ${to} | "${subject}" | resend ${sent.id || "-"} | attachments: ${attachments.length}`);
