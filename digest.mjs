// digest.mjs — the weekly digest of near-miss roles.
//
// The Quality Gate records near-miss roles (right profile, wrong location or below the fit floor)
// as finds with status 'digest'. Once a week this collects them per user, RE-VERIFIES each is still
// live (a near-miss from days ago may have closed), dedupes against roles already sent, caps at 5,
// and sends one honest "worth a look" email. Consumed finds flip to 'digest_sent' so next week starts
// fresh. Never sends an empty digest (no near-misses → no email).
//
//   node digest.mjs                # DRY RUN over all users
//   node digest.mjs --to <email>   # one user (real send)
//   node digest.mjs --send         # fire to everyone with near-misses
//   node digest.mjs --cron         # weekly self-gate (only acts on Sundays UTC) + send; for engine:run

import { Resend } from "resend";
import { loadEnv, listActiveCandidates, getFinds, getEmailedRoleKeys, getEmailedRoleSignatures, roleKey, setFindStatus, mergeEmailConfig, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one physical send door
import { renderWeeklyDigest, unsubUrlFor } from "./email-kit.mjs";
import { checkLiveness } from "./quality-gate.mjs";
import { selectDigestItems } from "./digest-select.mjs";
import { newMessageId } from "./threading.mjs";
import { dripGuard, stampFor } from "./drip-guard.mjs";
import { initSentry, captureError, flushSentry } from "./lib/sentry-node.mjs"; // error reporting (no-op without SENTRY_DSN)

loadEnv();
initSentry({ name: "digest" });
const argv = process.argv.slice(2);
const CRON = argv.includes("--cron");
const SEND = argv.includes("--send") || CRON;
const ONE = (() => { const i = argv.indexOf("--to"); return i >= 0 ? (argv[i + 1] || "").trim().toLowerCase() : null; })();
const CAP = Number(process.env.DIGEST_CAP || 5);

// Weekly self-gate: engine:run runs once daily (13:00 UTC), so --cron only proceeds on Sunday (UTC).
// NOTE: this gate checks day-of-week only, so if two cron runs fire on a Sunday both pass it.
if (CRON && new Date().getUTCDay() !== 0) { console.log("digest: not Sunday (UTC) — skipping weekly send"); process.exit(0); }

const resend = new Resend(process.env.RESEND_API_KEY);
const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";

function noteFor(find) {
  const r = String(find.composed?.digest_reason || "");
  const job = find.job || {};
  // Arrangement, before location. A remote-only person can be held back from a role in their OWN
  // city (send-audit.mjs), and the location note below would tell them it is "outside your
  // usual area" when it is ten minutes away. Wrong, and obviously wrong to the person reading it.
  if (/this role is not remote/i.test(r)) return `You said remote only, and this one looks office-based. Worth a look if you'd flex on that.`;
  if (/doesn't say whether it is remote/i.test(r)) return `You said remote only, and the posting doesn't say either way. Worth asking them before you spend time on it.`;
  if (/location|reachable/i.test(r)) return `Listed for ${job.location || "elsewhere"}, outside your usual area, but worth a look if you're flexible or they're open to remote.`;
  if (/clear only|of what they ask|fit/i.test(r)) return `Fits what you're after, but a few of their must-haves aren't shown in your profile yet, worth a look if you want to stretch.`;
  return r || "A fit for your profile, worth a quick look.";
}
const introFor = (job, findId) => (process.env.HUNTER_API_KEY || process.env.HUNTR_GTM_API_KEY)
  ? `mailto:intro@mail.example.com?subject=${encodeURIComponent(`Find me a warm intro: ${job.title || job.company || "this role"}`)}&body=${encodeURIComponent(`Charlie, find me a real person at ${job.company || "this company"} for this role, and draft the intro.\n\nref: ${findId}`)}`
  : null;

const cands = await listActiveCandidates({ limit: 1000 });
const targets = ONE ? cands.filter((c) => c.email.toLowerCase() === ONE) : cands;
console.log(`${SEND || ONE ? "SENDING" : "DRY RUN"} digest — ${targets.length} user(s)\n`);

let sent = 0, skipped = 0;
for (const c of targets) {
  if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
  const email = c.email;
  try { // isolate each user: one bad record must never abort the whole digest batch
  const digestFinds = await getFinds(email, { status: "digest", limit: 40 }).catch(() => []);
  if (!digestFinds.length) { skipped++; continue; }

  const emailed = await getEmailedRoleKeys(email).catch(() => new Set());
  // The four-vector repeat fingerprint (canonical identity + roleKey + core stem + company cooloff),
  // so a role already EMAILED — including a retitled repost with a fresh id — can never reach the digest.
  // excludeIds is LOAD-BEARING: getEmailedRoleSignatures reads statuses [emailed, digest, new], which
  // includes the very 'digest' finds we are about to show. Without it every item matches its OWN
  // identity, repeatDecision drops all of them, and the digest silently sends nothing forever while
  // consuming its whole queue. first-role.mjs guards against the same trap.
  const ownIds = new Set(digestFinds.map((f) => f.id));
  const sig = await getEmailedRoleSignatures(email, { excludeIds: ownIds }).catch(() => null);
  // The selection rule lives in digest-select.mjs so it is testable (this file runs on import).
  const { items, consumed } = await selectDigestItems({
    digestFinds, sig, emailedKeys: emailed, cap: CAP,
    isLive: async (job) => (await checkLiveness(job).catch(() => ({ ok: true }))).ok,
    noteFor, introFor,
  });

  const to = c.email_config?.notify || email;
  if (!items.length) {
    console.log(`- ${email}: ${digestFinds.length} near-miss(es), none live/fresh — no digest`);
    if (SEND || ONE) for (const id of consumed) await setFindStatus(email, id, "digest_sent").catch(() => {});
    skipped++; continue;
  }
  console.log(`- ${email}: ${items.length} in digest (${items.map((i) => i.company).join(", ")})`);
  if (!(SEND || ONE)) continue;

  // The one deterministic gate every drip passes: suppression, cooldown/no-double-send (>= 6 days
  // between digests), opt-out, and never-empty (items already built above). Fail closed on skip.
  const g = await dripGuard({ email, dripType: "digest", candidate: c, items });
  if (g.decision === "skip") { console.log(`    skip (${g.reason})`); skipped++; continue; }

  const m = renderWeeklyDigest({ email, name: c.dossier?.name || "", items });
  const unsub = unsubUrlFor(email);
  const dkey = `digest-${new Date().toISOString().slice(0, 10)}`; // per weekly run (digest only fires Sundays)
  // The one send door: suppression + idempotency (claim/stamp/release) + send.
  const payload = { from, to, subject: m.subject, html: m.html, text: m.text, headers: { "Message-ID": newMessageId("digest"), "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }; // standalone thread, one-click unsubscribe (RFC 8058)
  const res = await sendGuarded({ resend, email, template: "digest", dedupeKey: dkey, payload });
  if (res.status === "suppressed") { console.log(`    suppressed — skip`); skipped++; continue; }
  if (res.status === "duplicate") { console.log(`    already sent this week (idempotency) — skip`); skipped++; continue; }
  if (res.status === "failed") { console.log(`    SEND FAILED: ${typeof res.error === "string" ? res.error : JSON.stringify(res.error)}`); continue; }
  for (const id of consumed) await setFindStatus(email, id, "digest_sent").catch(() => {});
  // Mark AFTER a successful send so the guard's cooldown blocks a re-send this week (belt + suspenders
  // alongside the finds flipping to 'digest_sent'). Best-effort, spread-preserving.
  await mergeEmailConfig(email, stampFor("digest")).catch(() => {});
  console.log(`    sent → ${to} | resend ${res.id} | "${m.subject}"`);
  sent++;
  } catch (e) { console.log(`- ${email}: digest failed (skipped, batch continues): ${e.message}`); captureError(e, { service: "digest", kind: "per_user" }); }
}
console.log(`\n${SEND || ONE ? `done — ${sent} digest(s) sent, ${skipped} skipped` : "(dry run — --to <email> to test one, --send to fire, --cron for weekly)"}`);
await flushSentry(); // this cron process is about to exit — make sure any captured errors actually send
