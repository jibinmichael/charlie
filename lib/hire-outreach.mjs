// lib/hire-outreach.mjs — the outreach inbox: for a hand-run role mandate (sends filed under the role-intent or
// role-invite templates, keyed by the mandate), every email Charlie sent a person about that role and every email
// they sent back, as one thread per person, with who they are from talent_pool. READ ONLY: nothing here writes a
// row or sends anything.
//
// WHERE THE WORDS COME FROM. Sends are `sent_emails` rows (every one went through sendGuarded, which
// records subject and body_text); replies are `inbound_messages` rows. A send whose words were not
// recorded says so; nothing is reconstructed.
//
// WHAT IS NOT CLAIMED. Whether a reply answers the questions fully is read by a person; nothing here
// classifies a reply. So a reply after the questions is "answered, needs review", and nobody is shown as
// activated by this view.

import { ownWords } from "./own-words.mjs";

/** The mandates this inbox shows: which send opens the thread and which keyed sends follow it, and the
 *  hire_jobs row each belongs to (job_id; its client is the employer). A mandate with no job_id keeps a
 *  derived stage and is never saved; add the job_id of its hire_jobs row to have the pursuit sync save it.
 *  The keys are also the dedupe keys of the sends, so a key is never renamed once mail has gone out under it. */
export const OUTREACH_MANDATES = {
  "pd-blr": { role: "Product Designer", city: "Bengaluru", first: "role-intent", keyed: ["role-intent", "role-questions", "role-hold"] },
  spd: { role: "Senior Product Designer", city: "Bengaluru", first: "role-invite", keyed: ["role-invite"] },
  "ae-blr": { role: "Account Executive", city: "Bengaluru", first: "role-intent", keyed: ["role-intent", "role-questions", "role-hold"] },
  "j2ee-blr": { role: "Senior J2EE Developer", city: "Bengaluru", first: "role-intent", keyed: ["role-intent", "role-questions", "role-hold"] },
};

/** Personal answers are keyed per entry, not per mandate; they join a thread by recipient and date. */
const UNKEYED = ["role-reply"];

/** No reply this long after our last email marks the thread idle. */
export const IDLE_DAYS = 5;
const DAY = 86_400_000;

const KIND = {
  "role-intent": "Role outreach",
  "role-invite": "Role invite",
  "role-questions": "Role details and questions",
  "role-hold": "Status update",
  "role-reply": "Personal answer",
  // the Follow-up agent's single follow-up: sent as role-intent with dedupe key `<mandate>:followup`
  "role-followup": "Follow-up",
};

const ms = (t) => new Date(t).getTime();
const fmt = (t) => new Date(t).toISOString();
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * One thread per person who was sent the mandate's first email. Pure: rows in, threads out.
 * @param {{ mandate: string, sends: any[], inbound: any[], pool: any[], now: number }} input
 */
export function buildThreads({ mandate, sends, inbound, pool, now, cvEmails = new Set() }) {
  const M = OUTREACH_MANDATES[mandate];
  if (!M) throw new Error(`unknown mandate: ${mandate}`);
  const firsts = sends.filter((s) => s.template === M.first && s.dedupe_key === mandate);
  const byPool = new Map(pool.map((p) => [String(p.email || "").toLowerCase(), p]));
  const out = [];
  for (const first of firsts) {
    const email = String(first.email || "").toLowerCase();
    const start = ms(first.sent_at);
    const ours = sends
      .filter((s) => String(s.email || "").toLowerCase() === email)
      .filter((s) => (M.keyed.includes(s.template) && (s.dedupe_key === mandate || s.dedupe_key === `${mandate}:followup`)) || (UNKEYED.includes(s.template) && ms(s.sent_at) >= start))
      .map((s) => {
        const kind = s.dedupe_key === `${mandate}:followup` ? "role-followup" : s.template;
        return { from: "charlie", at: fmt(s.sent_at), kind, subject: str(s.subject) ?? KIND[kind] ?? kind, body: str(s.body_text), recorded: !!str(s.body_text) };
      });
    const theirs = inbound
      .filter((m) => String(m.email || "").toLowerCase() === email && ms(m.received_at) >= start)
      .map((m) => ({ from: "candidate", at: fmt(m.received_at), kind: "reply", subject: str(m.subject) ?? "Reply", body: str(ownWords(m.body, email)) ?? str(m.body), recorded: !!str(m.body), emailId: str(m.email_id) }));
    const messages = [...ours, ...theirs].sort((a, b) => ms(a.at) - ms(b.at));
    const { statuses, events } = deriveState(messages, now);
    const activity = activityState(messages, now);
    const last = messages[messages.length - 1];
    out.push({
      id: `${mandate}:${email}`,
      mandate,
      role: M.role,
      city: M.city,
      person: person(byPool.get(email), email, cvEmails.has(email)),
      statuses,
      activity,
      activated: false,
      events,
      messages: messages.map(({ kind, ...m }) => ({ ...m, label: KIND[kind] ?? null })),
      lastAt: last?.at ?? fmt(start),
      awaitingUs: last?.from === "candidate",
    });
  }
  return out.sort((a, b) => ms(b.lastAt) - ms(a.lastAt));
}

/**
 * The conversation's states and its timeline events, from the messages alone. `after` is the index
 * of the message an event follows.
 */
export function deriveState(messages, now) {
  const statuses = [];
  const events = [];
  const replies = messages.filter((m) => m.from === "candidate");
  const qIndex = messages.findIndex((m) => m.from === "charlie" && m.kind === "role-questions");
  let idleNow = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.from !== "charlie") continue;
    if (m.kind === "role-questions") events.push({ after: i, kind: "roleSent", at: m.at, text: "Role details and questions sent" });
    if (m.kind === "role-hold") events.push({ after: i, kind: "hold", at: m.at, text: "Status update sent" });
    // Idle: our email, then IDLE_DAYS with nothing from them and nothing more from us. Only the
    // email that opened the silence counts, so a run of our emails marks one idle, not several.
    const nextAny = messages[i + 1];
    const quietUntil = nextAny ? ms(nextAny.at) : now;
    if (quietUntil - ms(m.at) < IDLE_DAYS * DAY) continue;
    events.push({ after: i, kind: "idle", at: fmt(ms(m.at) + IDLE_DAYS * DAY), text: `No reply in ${IDLE_DAYS} days` });
    if (!nextAny) idleNow = true;
    // the silence broken by them: re-opened at their reply
    else if (nextAny.from === "candidate") events.push({ after: i + 1, kind: "reopened", at: nextAny.at, text: "Re-opened by their reply" });
  }
  if (!replies.length) statuses.push(idleNow ? "idle" : "waiting");
  else {
    statuses.push(events.some((e) => e.kind === "reopened") ? "reopened" : "replied");
    if (idleNow) statuses.push("idle");
  }
  if (qIndex > -1) {
    statuses.push("roleSent");
    const answer = messages.slice(qIndex + 1).find((m) => m.from === "candidate");
    if (answer) {
      statuses.push("answered");
      events.push({ after: messages.indexOf(answer), kind: "answered", at: answer.at, text: "Answered the questions, needs review" });
    }
  }
  events.sort((a, b) => a.after - b.after || ms(a.at) - ms(b.at));
  return { statuses, events };
}

/**
 * Where the person stands, from the live thread, one word:
 *   inactive  they have never replied
 *   active    they replied, and the thread is moving: their message is the last, or ours is under IDLE_DAYS old
 *   idle      they replied before, and our last email has gone IDLE_DAYS without an answer
 * Computed on every read, so it cannot drift from the emails it describes.
 */
export function activityState(messages, now) {
  if (!messages.some((m) => m.from === "candidate")) return "inactive";
  const last = messages[messages.length - 1];
  if (last.from === "candidate") return "active";
  return now - ms(last.at) >= IDLE_DAYS * DAY ? "idle" : "active";
}

/** Who the person is, from their pool row; every field null when the pool does not say. */
function person(p, email, hasCv = false) {
  const r = p || {};
  return {
    hasCv,
    // company facts came from an enrichment store that is not part of this codebase; the inbox shows none
    companyInfo: null,
    previousCompanyInfo: null,
    poolId: num(r.id),
    name: str(r.full_name) ?? email,
    email,
    phone: str(r.phone),
    linkedin: str(r.linkedin_url),
    portfolio: str(r.portfolio_url),
    city: str(r.city),
    title: str(r.current_title),
    company: str(r.current_company),
    previousTitle: str(r.previous_title),
    previousCompany: str(r.previous_company),
    totalYears: num(r.total_years),
    compCurrent: num(r.comp_current),
    compExpected: num(r.comp_expected),
    compCurrency: str(r.comp_currency),
    noticeDays: num(r.notice_days),
    noticeRaw: str(r.notice_period_raw),
    workMode: str(r.work_mode_pref),
    relocate: str(r.willing_to_relocate),
    skills: Array.isArray(r.top_skills) ? r.top_skills.filter((s) => typeof s === "string") : [],
    degree: str(r.degree),
    institution: str(r.institution),
    gradYear: num(r.grad_year),
    source: str(r.source_form),
  };
}

/**
 * Read one mandate's threads from the database. Three reads, no writes.
 * @param {any} db a Supabase client
 */
export async function loadOutreach(db, mandate, now = Date.now()) {
  const M = OUTREACH_MANDATES[mandate];
  if (!M) throw new Error(`unknown mandate: ${mandate}`);
  const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data || []; };
  const firsts = must(await db.from("sent_emails").select("email,sent_at").eq("template", M.first).eq("dedupe_key", mandate), "sent_emails first");
  const emails = [...new Set(firsts.map((r) => String(r.email).toLowerCase()))];
  if (!emails.length) return [];
  const since = firsts.map((r) => r.sent_at).sort()[0];
  const sends = must(await db.from("sent_emails").select("email,template,dedupe_key,subject,body_text,sent_at").in("email", emails).in("template", [...M.keyed, ...UNKEYED]), "sent_emails thread");
  const inbound = must(await db.from("inbound_messages").select("email,email_id,subject,body,received_at").in("email", emails).gte("received_at", since), "inbound_messages");
  const pool = must(await db.from("talent_pool").select("id,email,full_name,phone,linkedin_url,portfolio_url,city,current_title,current_company,previous_title,previous_company,total_years,comp_current,comp_expected,comp_currency,notice_days,notice_period_raw,work_mode_pref,willing_to_relocate,top_skills,degree,institution,grad_year,source_form").in("email", emails), "talent_pool");
  const cvEmails = await emailsWithCv(db, emails);
  return buildThreads({ mandate, sends, inbound, pool, now, cvEmails });
}

/** Which of these emails have a CV on file: a `resumes/<email>.txt` in Storage (lib/outreach-files.mjs readCv). One
 *  listing per address; a listing that fails reads as no CV, never as an error that blanks the inbox. */
export async function emailsWithCv(db, emails) {
  const out = new Set();
  for (const email of emails) {
    const name = `${String(email).toLowerCase()}.txt`;
    try {
      const r = await db.storage.from("resumes").list("", { limit: 1, search: name });
      if (!r.error && (r.data || []).some((f) => f?.name === name)) out.add(String(email).toLowerCase());
    } catch { /* no CV marker for this one */ }
  }
  return out;
}
