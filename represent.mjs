// represent.mjs — "can I put your name in front of someone?", and the profile it completes.
//
// TWO JOBS IN ONE EMAIL, which is the only reason it earns a send:
//   1. It asks permission to represent someone to a headhunter or a startup.
//   2. The answer is the moment they will tell us the things we have never known.
//
// Actively-looking-vs-passive and notice period are the first questions a headhunter asks, and they
// are rarely known: nobody volunteers them unprompted. This ask is how Charlie learns them.
//
// ONE CONDITION COVERS EVERYTHING. Eligible = has received at least one role email, and has not been
// sent this. That is the initial blast to everyone who already has a role, AND every future signup
// automatically, the moment their first role lands. No separate backfill, no second code path.
//
// SENT ONCE, EVER. sendGuarded's idempotency on a fixed dedupe key is the real guarantee, not a flag.
//
// WHY IT IS NOT A MARKETING DRIP: Charlie sends jobs, the market read, info-gathering, confirmations
// and replies. This is info-gathering with the reason attached — the ask IS the thing it collects.
// It is not a nudge to re-engage and it never repeats.

import { Resend } from "resend";
import { listActiveCandidates, getCandidate, sentCountSince, recordSignal } from "./charlie-store.mjs";
import { renderRepresent } from "./email-kit.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";
import { createClient } from "@supabase/supabase-js";

const TEMPLATE = "represent";
const ROLE_TEMPLATES = ["role", "first-role", "first-closest", "recovered-role", "role-picks"];

/** off | dry | on. Read at call time so a deploy can change it without a code change. */
export function representMode() {
  const v = String(process.env.REPRESENT || "off").toLowerCase();
  return v === "dry" || v === "on" ? v : "off";
}

const db = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

/**
 * What Charlie still cannot answer about this person, in the order a headhunter asks it.
 *
 * PURE, and deliberately capped at three by the caller. Eight questions read as homework and get
 * nothing back; three read as a conversation.
 *
 * Every prompt is a question about a FACT, never an assessment. "Are you actively looking" is
 * answerable; "how motivated are you" is a judgement we have no business asking for.
 */
export function representMissing(dossier) {
  const p = (dossier && dossier.preferences) || {};
  const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  const out = [];
  if (!has(p.mode)) out.push({ key: "mode", label: "Are you actively looking", prompt: "or only moving for the right thing?" });
  if (!has(p.notice_period)) out.push({ key: "notice_period", label: "Your notice period", prompt: "how soon could you actually start?" });
  if (!has(p.comp_floor)) out.push({ key: "comp_floor", label: "Your pay floor", prompt: "the number below which it is not worth your time." });
  if (!has(p.dealbreakers)) out.push({ key: "dealbreakers", label: "Your dealbreakers", prompt: "anything you would turn down on principle." });
  if (!has(p.stage)) out.push({ key: "stage", label: "Company stage", prompt: "startup, growth, or established?" });
  return out;
}

/**
 * The same question for somebody in the APPLICANT pool rather than the email product.
 *
 * WHY A SECOND FUNCTION AND NOT A BRANCH. `representMissing` reads `dossier.preferences`, which an
 * applicant does not have: they filled in an application form and were enriched into `talent_pool`,
 * and nobody built them a dossier. Reading preferences off them would return "everything is
 * missing" for all of them, which is a confident wrong answer rather than a blank.
 *
 * Applicants who came through an older form often lack expected pay, notice and a portfolio link,
 * not because they refused but because the form never asked, and a profile sent to a client without
 * a portfolio can be rejected for exactly that.
 *
 * NOT CAPPED AT THREE, unlike its sibling. The cap there protects a cold ask; this one goes to people
 * mid-application who have a reason to answer, and the copy says partial is fine.
 */
export function poolMissing(row) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const out = [];
  if (!has(row?.portfolio_url)) out.push("portfolio");
  if (!has(row?.comp_expected)) out.push("pay");
  if (!has(row?.notice_days)) out.push("notice");
  return out;
}

/** Addresses that have ever been sent a role email. The eligibility gate, read once per pass. */
async function everSentARole() {
  const seen = new Set();
  try {
    const { data, error } = await db().from("sent_emails").select("email,template").in("template", ROLE_TEMPLATES).limit(5000);
    if (error) throw new Error(error.message);
    for (const r of data || []) seen.add(String(r.email || "").toLowerCase());
  } catch (e) {
    // Fail CLOSED: an unreadable ledger means we cannot tell who has had a role, and mailing someone
    // this before their first role would be asking to represent a person we have never served.
    console.error(`[represent] could not read sent_emails (${e.message}) — asking nobody this pass`);
    return null;
  }
  return seen;
}

/**
 * Offer to represent everyone who has had a role and has not been asked.
 *
 * Best-effort, per-record isolated, and every skip is silent. Returns counts for the log.
 */
export async function runRepresentSweep({ log = console.error } = {}) {
  const mode = representMode();
  if (mode === "off") return { mode, eligible: 0, sent: 0, skipped: 0 };

  const hadRole = await everSentARole();
  if (!hadRole) return { mode, eligible: 0, sent: 0, skipped: 0 };

  let people = [];
  try {
    people = await listActiveCandidates();
  } catch (e) {
    log(`[represent] could not list candidates (${e.message})`);
    return { mode, eligible: 0, sent: 0, skipped: 0 };
  }

  const resend = mode === "on" ? new Resend(process.env.RESEND_API_KEY) : null;
  // A wide window on purpose: this is a once-ever send, so "have we sent it at all" is the question.
  const since = new Date(Date.now() - 3650 * 86400000).toISOString();
  let eligible = 0;
  let sent = 0;
  let skipped = 0;

  for (const p of people) {
    try {
      const email = String(p?.email || "").toLowerCase();
      if (!email || !hadRole.has(email)) { skipped++; continue; }
      eligible++;
      if ((await sentCountSince(email, TEMPLATE, since)) > 0) { skipped++; continue; }

      const missing = representMissing(p.dossier);
      const { subject, html, text } = renderRepresent({ email, name: p.dossier?.name || "" });

      if (mode === "dry") {
        log(`[represent] DRY would ask ${email} (missing: ${missing.slice(0, 3).map((m) => m.key).join(", ") || "nothing"})`);
        sent++;
        continue;
      }
      const res = await sendGuarded({
        resend,
        email,
        template: TEMPLATE,
        dedupeKey: `${email}:represent:v1`, // once, ever
        payload: { from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to: email, subject, html, text },
      });
      if (res?.status === "sent") {
        sent++;
        // The denominator. Without it, "how many said yes" has nothing to divide by, and the whole
        // point of this send is measuring interest.
        await recordSignal({ email, event: "represent_offered", meta: { missing: missing.map((m) => m.key) } }).catch(() => {});
      } else {
        skipped++;
      }
    } catch (e) {
      skipped++;
      log(`[represent] ${p?.email} failed (${e.message}) — continuing`);
    }
  }

  log(`[represent] ${mode}: ${eligible} eligible, ${sent} asked, ${skipped} skipped`);
  return { mode, eligible, sent, skipped };
}

/** Single-person path, for the debug script. */
export async function representFor(email) {
  const c = await getCandidate(email);
  return c ? { missing: representMissing(c.dossier), name: c.dossier?.name || "" } : null;
}
