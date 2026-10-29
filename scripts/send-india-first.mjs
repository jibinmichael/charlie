// send-india-first.mjs — find ONE genuine, above-bar role for each candidate, INDIA FIRST, and email
// it with the explainable fit readout. SENDS REAL EMAIL with --to or --send. Mirrors the daily send
// path (select -> score -> compose -> verify -> render -> send) with India-first ordering: it scores
// India-located roles first, then remote, then the rest, and takes the best role that clears the bar
// (70). It NEVER sends a sub-bar role: a candidate with nothing above the bar is reported and
// skipped, not sent a filler.
//
//   node scripts/send-india-first.mjs                # DRY RUN over all candidates
//   node scripts/send-india-first.mjs --to <email>   # one candidate (real send)
//   node scripts/send-india-first.mjs --send         # fire to everyone with a genuine match
//
// Excludes already-emailed roles (dedup) and suppressed recipients.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { loadEnv, loadJobPool, getResume, isSuppressed, upsertFind, getEmailedRoleSignatures, roleKey, getFinds, mergeEmailConfig, readAll } from "../charlie-store.mjs";
import { dripGuard, stampFor } from "../drip-guard.mjs";
import { selectForUser } from "../select-jobs.mjs";
import { composeEmailFields, lookupCompany } from "../composer.mjs";
import { renderEmail } from "../render-email.mjs";
import { renderCheckInNudge, unsubUrlFor } from "../email-kit.mjs";
import { computeCoverage } from "../fit-coverage.mjs";
import { homeRegion } from "../quality-gate.mjs"; // region gate for the US-only slots (ROLE_EMAIL_SPEC)
import { preSendGuard, repeatDecision } from "../presend-guard.mjs";
// NOTE: buildEmailAttachments is deliberately NOT imported. The role email carries no tailored resume
// or cover letter; tailoring is on request only.
import { verifyGrounding, shouldHold } from "../grounding-verify.mjs";
import { buildScoringMessages } from "../prompts/match-scoring.mjs"; // versioned prompt — see prompts/

loadEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const ONE = (() => { const i = argv.indexOf("--to"); return i >= 0 ? (argv[i + 1] || "").trim().toLowerCase() : null; })();
const BAR = Number(process.env.MATCH_BAR || 70);
const TOPN = 20; // score up to this many per tier (wide enough to surface distinct above-bar roles)

const INDIA = /\b(india|bengaluru|bangalore|mumbai|delhi|new delhi|hyderabad|pune|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad|remote[- ]?india)\b/i;
const isIndia = (j) => INDIA.test(`${j.location || ""} ${j.region || ""}`);
const isRemote = (j) => j.remote === true || /remote/i.test(j.location || "");
// A role tied to a specific non-India country/city is NOT truly available to an India-based person,
// even if it says "remote" (e.g. "United States (Remote)" = US-only). For India-preference candidates
// we drop these so "India first" never quietly hands them a role they can't actually take.
const FOREIGN = /\b(united states|u\.?s\.?a?|americas|north america|san francisco|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|london|united kingdom|canada|toronto|vancouver|singapore|dubai|u\.?a\.?e|australia|sydney|melbourne|germany|berlin|munich|france|paris|amsterdam|netherlands|ireland|dublin|spain|madrid|poland|warsaw|brazil|mexico|emea|latam)\b/i;
const isForeign = (j) => { const l = `${j.location || ""}`; return FOREIGN.test(l) && !INDIA.test(l); };
const wantsIndia = (d) => /india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|gurgaon|gurugram|noida|kolkata/i.test(d?.preferences?.remote || "") || d?.preferences?.comp_currency === "INR";

/** @type {import("@supabase/supabase-js").SupabaseClient<import("../lib/database.types").Database>} */
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const matcher = readFileSync(join(root, "matcher.md"), "utf8");
const client = new Anthropic();
const resend = new Resend(process.env.RESEND_API_KEY);
const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
const site = process.env.CHARLIE_SITE_URL || "https://example.com";
const pool = await loadJobPool();
const BOARDS = JSON.parse(readFileSync(join(root, "watchlist.json"), "utf8")).length;
const rk = (j) => roleKey(j?.company, j?.title); // UNBREAKABLE dedup key: company+title (matches getEmailedRoleKeys)
console.log(`pool: ${pool.length} jobs | ${pool.filter(isIndia).length} India-located | ${BOARDS} boards\n`);

async function score(dossier, job) {
  const r = await client.messages.create({
    model: "claude-haiku-4-5", max_tokens: 600,
    ...buildScoringMessages({ matcherText: matcher, dossierText: JSON.stringify(dossier), job, todayLine: new Date().toISOString().slice(0, 10) }),
  });
  const t = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch { return { score: 0, verdict: "skip" }; }
}

// best above-bar role from a tier (scores up to TOPN, returns the top scorer if it clears BAR)
async function bestOf(dossier, jobs) {
  if (!jobs.length) return null;
  const scored = [];
  for (const job of jobs.slice(0, TOPN)) scored.push({ job, match: await score(dossier, job) });
  scored.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
  const top = scored[0];
  return top && (top.match?.score ?? 0) >= BAR ? top : null;
}

// pick India-first, then remote, then rest. Two passes: pass 1 excludes roles already handed to
// another candidate this run (so people get DISTINCT roles); pass 2 relaxes that, so no one is
// skipped merely because their best role went to someone earlier.
async function pickFor(dossier, tiers, used) {
  for (const [name, jobs] of tiers) { const p = await bestOf(dossier, jobs.filter((j) => !used.has(rk(j)))); if (p) return { pick: p, tier: name }; }
  for (const [name, jobs] of tiers) { const p = await bestOf(dossier, jobs); if (p) return { pick: p, tier: name }; }
  return null;
}

const cands = await readAll("candidates", "email,dossier,email_config,status");
const MINE = new Set([String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean));
// real candidates first (they get first pick of the best roles); the owner's own addresses last.
const targets = (ONE ? cands.filter((c) => c.email.toLowerCase() === ONE) : cands)
  .sort((a, b) => (MINE.has(a.email.toLowerCase()) ? 1 : 0) - (MINE.has(b.email.toLowerCase()) ? 1 : 0));
console.log(`${SEND || ONE ? "SENDING" : "DRY RUN"} — ${targets.length} candidate(s)\n`);

const used = new Set(); // roles handed out this run, for cross-candidate variety
for (const c of targets) {
  const email = c.email; const dossier = c.dossier || {};
  const to = c.email_config?.notify || email;
  const { jobs: eligible } = selectForUser(dossier, pool, 80);
  const sig = await getEmailedRoleSignatures(email).catch(() => null); // full dedup fingerprint — never resend
  const fresh = eligible.filter((j) => !repeatDecision(j, sig));
  // India-preference candidates: keep India roles + genuinely-global remote, but drop roles pinned
  // to a foreign country (a US-only "remote" role isn't available to someone in India).
  const wi = wantsIndia(dossier);
  const ok = (j) => !(wi && isForeign(j));
  const india = fresh.filter(isIndia);
  const remote = fresh.filter((j) => !isIndia(j) && isRemote(j) && ok(j));
  const other = fresh.filter((j) => !isIndia(j) && !isRemote(j) && ok(j));

  const got = await pickFor(dossier, [["india", india], ["remote", remote], ["other", other]], used);
  if (!got) {
    // No FRESH above-bar role. The unbreakable rule forbids resending — so if they've been sent a
    // role before, the only matches are repeats: check in (name their last role, "did you apply?")
    // instead of resending. If they've never had a role, there's nothing to check in on — skip.
    const prior = await getFinds(email, { status: "emailed", limit: 1 }).catch(() => []);
    const last = prior[0]?.job;
    if (!last) { console.log(`- ${email}: no fresh above-bar role, no prior role — SKIP`); continue; }
    console.log(`- ${email}: no NEW match → CHECK-IN nudge (still: ${last.company} — ${last.title})`);
    if (!(SEND || ONE)) continue;
    // The one deterministic drip gate: opt-out, global min-gap (no drip stacks), per-type cooldown,
    // already-satisfied (there IS a prior role — passed in), then suppression. Fail closed on skip.
    const g = await dripGuard({ email, dripType: "checkin", candidate: { ...c, priorEmailedRole: last }, now: Date.now() });
    if (g.decision === "skip") { console.log(`    skip (${g.reason})`); continue; }
    const m = renderCheckInNudge({ email, name: dossier.name || "", company: last.company || "", role: last.title || "", boards: BOARDS });
    const { data: sent, error } = await resend.emails.send({ from, to, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    if (error) { console.log(`    SEND FAILED: ${error.message || JSON.stringify(error)}`); continue; }
    // Stamp AFTER a real send so the cooldown + global ledger block a re-nudge. Best-effort.
    await mergeEmailConfig(email, stampFor("checkin", new Date().toISOString())).catch(() => {});
    console.log(`    check-in sent → ${to} | resend ${sent.id}`);
    continue;
  }
  const { pick, tier } = got;
  used.add(rk(pick.job));

  const { job: rawJob, match } = pick;
  // Quality Gate: even the India-first pick must be live, reachable, and clear the fit floor. A
  // near-miss is recorded for the digest and skipped here (the durable digest send is the scheduler).
  const gate = await preSendGuard({ job: rawJob, dossier, matcherScore: match?.score, signatures: sig, getCov: () => computeCoverage({ dossier, jobDescription: rawJob.description, jobTitle: rawJob.title }).catch(() => ({ thin: true })) });
  console.log(`- ${email}: [${tier}] ${rawJob.title} @ ${rawJob.company} (${match.score} ${match.verdict}) ${rawJob.location || "remote"} → gate ${gate.decision.toUpperCase()}`);
  if (gate.decision !== "send") {
    console.log(`    ${gate.reason}`);
    if ((SEND || ONE) && gate.decision === "digest") await upsertFind({ email, jobId: rawJob.id, job: rawJob, match, composed: { digest_reason: gate.reason }, status: "digest" }).catch(() => {});
    continue;
  }
  if (!(SEND || ONE)) continue;
  if (await isSuppressed(to)) { console.log(`    suppressed — skip`); continue; }

  const resumeText = await getResume(email).catch(() => null);
  let companyInsight = null; try { companyInsight = await lookupCompany(rawJob.company, { jobHint: rawJob.title }); } catch {}
  const fields = await composeEmailFields(JSON.stringify(dossier, null, 2), JSON.stringify(rawJob, null, 2), { match, companyInsight });
  const cov = gate.cov || { thin: true };
  const grounding = await verifyGrounding({
    sourceText: `${JSON.stringify(dossier)}\n\nRESUME:\n${resumeText || ""}`,
    artifactText: JSON.stringify({ why_you: fields.why_you, flag: fields.flag, resume_tips: fields.resume_tips, cover_letter: fields.cover_letter, facts: fields.facts, ...(cov && !cov.thin ? { fit_reason: cov.reason, fit_move: cov.topMove } : {}) }),
  });
  // Name the reason. A hold that logs only THAT it held is unreproducible: the verifier is a model
  // call and is not deterministic on borderline artifacts. Print the severity or the errored path,
  // plus the flagged claims.
  if (shouldHold(grounding)) {
    const why = grounding.errored ? `verifier errored (${grounding.reason || "no reason"}) — uncertainty holds` : `severity=${JSON.stringify(grounding.severity)}`;
    console.log(`    HELD by grounding verifier — skip. ${why}`);
    for (const v of grounding.violations || []) console.log(`      flagged: ${typeof v === "string" ? v : `${v.claim || "(no claim)"} — ${v.issue || v.why || ""}`}`);
    continue;
  }
  // No tailored resume or cover letter is attached to a role email; "How to position you" (slot 6) is
  // the payload, and tailoring is on request only (the prepare@ path in server/charlie-remote.ts).
  // Start empty, exactly like scheduler.mjs, so a test send matches what real users get.
  // Guarded by role-attachments.test.mjs. Do NOT reintroduce buildEmailAttachments here.
  const attachments = [];
  // Param parity with the daily scheduler: renderEmail defaults every optional param to null, so a
  // forgotten param silently renders NOTHING instead of erroring (guarded by render-params.test.mjs).
  // No `attached`: renderEmail has none (the slot-6 footnote derives from `referral`).
  // pay/momentum/referral are US-only and this path is India-first, so they stay out.
  const html = renderEmail({
    fields, match, cov, label: "Best match", applyUrl: rawJob.apply_url, via: rawJob.via, viaUrl: rawJob.via_url,
    unsubUrl: `${site}/unsubscribe?e=${encodeURIComponent(email)}`, email, findId: `${email}:${rawJob.id}`,
    jobDescription: rawJob.description, region: homeRegion(dossier), postedAt: rawJob.posted_at,
  });
  const subject = fields.subject || `Found one worth your time: ${fields.role_title || rawJob.title} at ${fields.company || rawJob.company}`;
  await upsertFind({ email, jobId: rawJob.id, job: rawJob, match, composed: fields, status: "new" });
  const { data: sent, error } = await resend.emails.send({ from, to, subject, html, text: fields.plaintext || undefined, attachments, headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  if (error) { console.log(`    SEND FAILED: ${error.message || JSON.stringify(error)}`); continue; }
  await s.from("finds").update({ status: "emailed" }).eq("id", `${email}:${rawJob.id}`).then(() => {}, () => {});
  console.log(`    sent → ${to} | resend ${sent.id} | fit ${cov.thin ? "thin" : cov.composite + "/100 " + cov.lane} | "${subject}"`);
}
console.log(`\n${SEND || ONE ? "done" : "(dry run — --to <email> to test one, --send to fire)"}`);
