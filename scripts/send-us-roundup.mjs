// send-us-roundup.mjs — send one user a curated "a few US roles that fit you + a person to reach out
// to" email. SENDS REAL EMAIL. Matches the user against the live pool (US roles), picks the top few
// above the bar, gives each a grounded one-line read, finds a warm-intro contact for the top role,
// and sends it. US-home candidates only.
//
//   node_modules/.bin/tsx scripts/send-us-roundup.mjs <email>

import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getDossier, getCandidate, loadJobPool, upsertFind, getEmailedRoleSignatures, setFindStatus } from "../charlie-store.mjs";
import { repeatDecision } from "../presend-guard.mjs";
import { selectForUser } from "../select-jobs.mjs";
import { computeCoverage } from "../fit-coverage.mjs";
import { findReferralContact } from "../referral-find.mjs";
import { emailShell, unsubUrlFor, C, esc, SANS, HEAD_FONT } from "../email-kit.mjs";
import { buildScoringMessages } from "../prompts/match-scoring.mjs"; // versioned prompt — see prompts/

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) { console.error("usage: tsx scripts/send-us-roundup.mjs <email>"); process.exit(1); }
loadEnv();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dossier = await getDossier(email);
if (!dossier) { console.error(`no dossier for ${email}`); process.exit(1); }
// HARD GUARD: this sends US roles. It may ONLY run for a candidate whose home region is US.
// US roles sent to a candidate outside the US are roles they cannot take. Refuse.
const { homeRegion } = await import("../quality-gate.mjs");
const region = homeRegion(dossier);
if (region !== "us") {
  console.error(`REFUSED: ${email} home region is "${region}", not "us". US roundup would send unreachable roles. Aborting.`);
  process.exit(1);
}
const cand = await getCandidate(email).catch(() => null);
const to = cand?.email_config?.notify || email;
const name = dossier.name || "";
const pool = await loadJobPool();
const matcher = readFileSync(join(root, "matcher.md"), "utf8");
const client = new Anthropic();

const US = /\b(united states|u\.?s\.?a?|remote(?![- ]?india)|san francisco|new york|nyc|seattle|austin|boston|chicago|denver|los angeles|palo alto|mountain view|sunnyvale|bay area|california|texas|washington|remote us)\b/i;
const usRank = (j) => { const l = `${j.location || ""}`; if (/united states|u\.?s\.?a?|san francisco|new york|seattle|austin|boston|chicago|denver|california|texas|bay area|palo alto/i.test(l)) return 2; if (/remote/i.test(l) || j.remote === true) return 1; return 0; };

// family-match the user, then score the closest slate
const { jobs: eligible } = selectForUser(dossier, pool, 120);
const slate = eligible.filter((j) => usRank(j) > 0).slice(0, 18); // US-located or remote; regardless of the user's own geo
console.log(`pool ${pool.length} | eligible ${eligible.length} | US/remote slate ${slate.length}`);

const scored = await Promise.all(slate.map(async (job) => {
  const r = await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 600, ...buildScoringMessages({ matcherText: matcher, dossierText: JSON.stringify(dossier), job, todayLine: null }) });
  const t = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let m; try { m = JSON.parse(t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch { m = { score: 0, verdict: "skip" }; }
  return { job, match: m };
}));
const bar = Number(process.env.MATCH_BAR || 70);
const aboveBar = scored.filter((s) => (s.match?.score ?? 0) >= bar).sort((a, b) => usRank(b.job) - usRank(a.job) || (b.match?.score ?? 0) - (a.match?.score ?? 0));
// UNBREAKABLE RULE: never re-send a role this person already got (any dedup vector).
const roundupSig = await getEmailedRoleSignatures(email).catch(() => null);
const fresh = aboveBar.filter((p) => !repeatDecision(p.job, roundupSig));
if (fresh.length !== aboveBar.length) console.log(`repeat-guard: skipped ${aboveBar.length - fresh.length} already-sent role(s)`);
const picks = fresh.slice(0, 3);
if (!picks.length) { console.error("no fresh above-bar US roles (all already sent)"); process.exit(1); }
console.log("picks:", picks.map((p) => `${p.job.title} @ ${p.job.company} (${p.match.score}) ${p.job.location}`).join(" | "));

// a grounded one-line read per role (fit-coverage reason if the JD is scoreable, else the matcher verdict)
for (const p of picks) {
  const cov = await computeCoverage({ dossier, jobDescription: p.job.description, jobTitle: p.job.title }).catch(() => ({ thin: true }));
  p.line = !cov.thin && cov.reason ? cov.reason : `${p.match.verdict || "a match"} on what you're after`;
  p.cov = cov;
  await upsertFind({ email, jobId: p.job.id, job: p.job, match: p.match, status: "new" }).catch(() => {});
}

// a real person to reach out to at the top role's company
const top = picks[0];
const ref = await findReferralContact({ email, company: top.job.company, jobUrl: top.job.apply_url, roleTitle: top.job.title }).catch(() => ({ none: true }));
const contact = ref && !ref.none ? ref.contact : null;
console.log("referral:", contact ? `${contact.first || ""} ${contact.last || ""} — ${contact.position || ""}` : `none (${ref?.reason || "n/a"})`);

// ---- render (bespoke, on-brand) ----
const site = process.env.CHARLIE_SITE_URL || "https://example.com";
const introMailto = (job) => `mailto:intro@${String(process.env.CHARLIE_FROM || "charlie@mail.example.com").split("@")[1]}?subject=${encodeURIComponent(`Find me a warm intro: ${job.title}`)}&body=${encodeURIComponent(`Charlie, draft my intro for this one.\n\nref: ${email}:${job.id}`)}`;
const card = (p) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.frame};border-radius:12px;margin:0 0 12px;"><tbody><tr><td style="padding:16px 18px;">
    <div style="font-family:${HEAD_FONT};font-size:17px;font-weight:400;letter-spacing:-.01em;color:${C.ink};">${esc(p.job.title)}</div>
    <div style="font-family:${SANS};font-size:13px;color:${C.muted};margin:2px 0 0;">${esc(p.job.company)}${p.job.location ? ` &middot; ${esc(p.job.location)}` : ""}</div>
    <div style="font-family:${SANS};font-size:13.5px;line-height:1.5;color:${C.text};margin:9px 0 0;">${esc(p.line)}</div>
    <a href="${esc(p.job.apply_url || "#")}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:#ffffff;background:${C.coral};text-decoration:none;padding:8px 16px;border-radius:8px;margin:12px 0 0;">Apply &rarr;</a>
  </td></tr></tbody></table>`;

const personBlock = contact
  ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.signal_soft};border-radius:12px;margin:6px 0 4px;"><tbody><tr><td style="padding:16px 18px;">
      <div style="font-family:${SANS};font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 7px;">a person you could reach out to</div>
      <div style="font-family:${HEAD_FONT};font-size:17px;font-weight:400;color:${C.ink};">${esc(`${contact.first || ""} ${contact.last || ""}`.trim() || "someone on the team")}</div>
      <div style="font-family:${SANS};font-size:13px;color:${C.muted};margin:2px 0 0;">${esc(contact.position || "on the team")} at ${esc(top.job.company)}</div>
      <p style="font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.text};margin:10px 0 0;">A warm intro skips the pile, a real person there sees your name. ${contact.linkedin ? `Here's their <a href="${esc(contact.linkedin.startsWith("http") ? contact.linkedin : "https://" + contact.linkedin)}" style="color:${C.coral};">LinkedIn</a>. ` : ""}Want me to draft the note, grounded in your work? Tap below and I'll send it back for you to send from your own inbox.</p>
      <a href="${esc(introMailto(top.job))}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13.5px;font-weight:600;color:#ffffff;background:${C.coral};text-decoration:none;padding:10px 20px;border-radius:8px;margin:12px 0 0;">&#129309; Draft my intro</a>
    </td></tr></tbody></table>`
  : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.signal_soft};border-radius:12px;margin:6px 0 4px;"><tbody><tr><td style="padding:16px 18px;">
      <div style="font-family:${SANS};font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 7px;">want a warm intro?</div>
      <p style="font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.text};margin:0;">On any of these, I can find a real person there worth reaching out to and draft the note for you. Tap <b>&#129309; Draft my intro</b> and I'll hunt one down for ${esc(top.job.company)}.</p>
      <a href="${esc(introMailto(top.job))}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13.5px;font-weight:600;color:#ffffff;background:${C.coral};text-decoration:none;padding:10px 20px;border-radius:8px;margin:12px 0 0;">&#129309; Draft my intro</a>
    </td></tr></tbody></table>`;

const hi = name ? `${esc(name)}, ` : "";
const content =
  `<div style="font-family:${SANS};font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:0 0 10px;">a few worth your time</div>` +
  `<div style="font-family:${HEAD_FONT};font-size:23px;font-weight:400;letter-spacing:-.01em;line-height:1.25;color:${C.ink};margin:0 0 12px;">${hi}a few US roles that fit you, and a person to reach out to.</div>` +
  `<p style="font-family:${SANS};font-size:14.5px;line-height:1.6;color:${C.text};margin:0 0 20px;">You asked to see a few, wherever they are. These are the strongest US matches I've got for you right now, each read honestly against what you've shown me. And for the top one, a real person you could reach out to.</p>` +
  picks.map(card).join("") +
  personBlock +
  `<p style="font-family:${SANS};font-size:13px;line-height:1.55;color:${C.muted};margin:18px 0 0;">This is a one-off roundup because you asked. Day to day I stay quiet and send just one role, only when it truly clears your bar. Reply any time to sharpen what I look for.</p>`;

const html = emailShell({ preheader: `A few US roles that fit you${name ? `, ${name}` : ""}, and a real person to reach out to at ${top.job.company}.`, title: "A few US roles worth your time", contentHtml: content, unsubUrl: unsubUrlFor(email) });
const subject = `${name ? name + ", a" : "A"} few US roles that fit you, and a person to reach out to`;

const resend = new Resend(process.env.RESEND_API_KEY);
const { data: sent, error } = await resend.emails.send({ from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to, subject, html, headers: { "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
if (error) { console.error("SEND FAILED", error); process.exit(1); }
console.log(`SENT to ${to} | resend ${sent.id} | "${subject}"`);
// Flip every sent role to 'emailed' so the daily dedup can see them; otherwise a roundup role could be
// re-sent later as a solo email.
for (const p of picks) await setFindStatus(email, `${email}:${p.job.id}`, "emailed").catch(() => {});
console.log(`marked ${picks.length} find(s) 'emailed' for dedup integrity`);
