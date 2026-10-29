// lib/pieworks-activation.mjs — Pieworks 2call activation: the webhook intake, the email sweep, and reply handling.
//
// Pieworks pushes, once a day, people who have sat in its 2call (pending) stage for 7+ days. Charlie asks each one, once,
// whether they are still interested. A yes moves them to "interested" in Pieworks; that is the only status this ever
// sends (only the shortlist part, 2call to interested). These people belong to Pieworks, not to Charlie's pool: they
// live only in pieworks_activations, and nothing on the hiring or job-seeker side reads or writes them. It runs on its own: the webhook stores, the 30-minute sweep sends, a reply moves.
//
//   ingest(records)   the webhook batch: each record parsed, stored once per shortlist id (Pieworks re-sends a person
//                     daily while they stay in 2call; a repeat is a no-op, so nobody is emailed twice)
//   runPass()         one sweep: ask the new ones, one reminder at 48 hours, close at 96, retry a status Pieworks has
//                     not accepted, and Monday's stats email to the owner
//   onReply(...)      a reply to pieworks+<key>@: YES moves them, NO stops, anything else is asked once more, plainly
//
// MODES (PIEWORKS_ACTIVATION): off (the default) stores batches and does nothing else; shadow also logs what it would
// email and push and sends nothing; live emails and moves people.
//
// FAIL CLOSED. Nobody is emailed unless their role is in Pieworks' active roles right now (a failed roles read means
// nobody is asked this pass). Nobody is moved unless their own address replied and the reply reads as a yes
// (lib/qualify/fields.mjs readYesNo, over the reply with our quoted email, greeting and signature set aside). An
// unclear reply is never a yes. Every send goes through lib/send-guard.mjs (suppression, once only, the leak check).
// Every record is isolated: one failure is logged and the rest go on.
import { randomBytes } from "node:crypto";
import { Resend } from "resend";
import { store } from "../charlie-store.mjs";
import { sendGuarded } from "./send-guard.mjs";
import { ResendSendPayload } from "./schemas/resend-send.mjs";
import { PieworksWebhookCandidate } from "./schemas/pieworks.mjs";
import { listActiveRoles, markInterested } from "./connections/pieworks.mjs";
import { confirmCore, readYesNo } from "./qualify/fields.mjs";
import { renderPieworksAsk, renderPieworksReminder, renderPieworksClarify, renderPieworksNoted, renderPieworksStats, unsubUrlFor } from "../email-kit.mjs";

const H = 3_600_000;
export const REMIND_AFTER_HOURS = 48;
export const CLOSE_AFTER_HOURS = 96;
/** Tries at the status update before the sweep stops (a stuck one is counted in the stats as "not accepted yet"). */
export const MAX_PUSH_ATTEMPTS = 5;
/** At most this many first emails per pass, so a large first batch never goes out in one burst. */
export const ASKS_PER_PASS = 40;
/** Pieworks role statuses that still want people. Anything else (Offered, Fulfilled, Hold, Lost, ...) is not emailed. */
export const OPEN_ROLE_STATUSES = ["hot", "warm", "cold"];
export const FINAL_STAGES = ["interested", "declined", "skipped"];
const SENDER_NAME = "Pieworks x Charlie";

export function activationMode(env = process.env) {
  const v = String(env.PIEWORKS_ACTIVATION || "").trim().toLowerCase();
  return v === "live" || v === "shadow" ? v : "off";
}

/** 16 characters of [a-z0-9]: the opaque part of pieworks+<key>@. */
export function newReplyKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join("");
}

const bareAddress = (from) => String(from || "").replace(/^.*</, "").replace(/>.*$/, "").trim();

/** pieworks+<key>@<the sending domain>, or null when there is no sending domain. Pure. */
export function replyAddress(key, from = process.env.CHARLIE_FROM || "") {
  const domain = bareAddress(from).split("@")[1] || "";
  if (!key || !domain) return null;
  return `pieworks+${key}@${domain}`;
}

/** The reply key from the local parts an inbound email was addressed to, or null. Pure. */
export function replyKeyFrom(localParts = []) {
  for (const lp of localParts) {
    const m = /^pieworks\+([a-z0-9]{10,24})$/i.exec(String(lp || "").trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** yes | no | unclear, from the reply as they typed it (our quoted email, greeting and signature set aside). Pure. */
export function readReply(body, who = {}) {
  return readYesNo(confirmCore(body, who), "consent");
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const fmt = (n) => String(Math.round(n * 100) / 100);
const yrs = (n) => `${fmt(n)} year${n === 1 ? "" : "s"}`;

/** Pieworks' own test listing ("Do not upload", client Pieworks): never a role anyone is emailed about. Pure. */
export function isTestRole(r = {}) {
  return /^pieworks$/i.test(String(r.clientName || "").trim()) || /\bdo not upload\b/i.test(String(r.role || "")) || /^\s*test(ing)?\s*$/i.test(String(r.okr || ""));
}

/**
 * "22 to 30 lakh a year (CTC), of which up to 5 lakh is variable", or "" when the numbers are missing or contradict. Pure.
 * minCtc/maxCtc are TOTAL CTC in lakh, variable included (a role of 20-25 fixed plus 2-5 variable reads 22-30 with
 * variable 2-5 in activeRoles), so the band is never called "fixed".
 */
export function payLine(r = {}) {
  const lo = num(r.minCtc), hi = num(r.maxCtc), vhi = num(r.maxVariablePay);
  if (lo === null || hi === null || lo <= 0 || hi < lo) return "";
  const band = lo === hi ? `${fmt(lo)} lakh a year (CTC)` : `${fmt(lo)} to ${fmt(hi)} lakh a year (CTC)`;
  return vhi !== null && vhi > 0 && vhi <= hi ? `${band}, of which up to ${fmt(vhi)} lakh is variable` : band;
}

/** "2 to 4 years (you have 2)": their own years only when inside the band, so the email never points at a gap. Pure. */
export function yearsLine(r = {}, theirs = null) {
  const lo = num(r.minExperience), hi = num(r.maxExperience), mine = num(theirs);
  if (lo === null || hi === null || lo < 0 || hi < lo || hi <= 0) return "";
  const band = lo === 0 ? `Up to ${yrs(hi)}` : lo === hi ? yrs(lo) : `${fmt(lo)} to ${yrs(hi)}`;
  return mine !== null && mine >= lo && mine <= hi ? `${band} (you have ${fmt(mine)})` : band;
}

/**
 * The role's first responsibility, verbatim, or "". Pieworks runs its sentences together ("requirementsConduct ..."),
 * and splitting on case would cut words like JavaScript, so a first sentence that is not cleanly ended, carries markup,
 * starts with a number, or is too long or too short is left out rather than repaired. Pure.
 */
export function roleLine(okr) {
  const t = String(okr || "").trim();
  const m = /^(.+?)\.(?=\s|[A-Z]|$)/.exec(t);
  if (!m) return "";
  const first = m[1].trim();
  if (first.length < 15 || first.length > 140) return "";
  if (/[<>&;]|^\d|[a-z][A-Z][a-z]/.test(first)) return "";
  // stopped inside an abbreviation or a bracket ("tools (e.g", "Acme Pvt"): not a sentence
  if ((first.match(/\(/g) || []).length !== (first.match(/\)/g) || []).length || /\b(e\.g|i\.e|etc|vs|approx|incl|Inc|Ltd|Pvt|Co|No|Mr|Ms|Dr|St|[A-Za-z])$/.test(first)) return "";
  return `${first}.`;
}

/** Was this person referred? Pieworks' `source` ("Referral Link"); anything else reads as not referred. Pure. */
export function wasReferred(candidate = {}) {
  return /referr?al/i.test(String(candidate?.source || ""));
}

const squash = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Does this subject name this role? Both squashed to letters and digits, so "Re: Still open: Growth Lead, B2B Sales at
 * Acme" matches the role "Growth Lead – B2B Sales" (cleanSubject turns the dash into a comma). Pure.
 */
export function subjectNamesRole(subject, role) {
  const r = squash(role);
  return r.length >= 3 && squash(subject).includes(r);
}

/** The Monday (UTC date) that starts the week `ms` falls in, as the stats email's once-a-week key. Pure. */
export function weekKey(ms) {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/**
 * The owner's numbers, from every row. Pure.
 * emailed = got the first email; interested = Pieworks accepted the move (the conversion); pending = said yes, Pieworks
 * has not accepted it yet; waiting = emailed and still open; closed = never answered.
 */
export function countStats(rows = [], sinceMs = 0) {
  const t = (v) => (v ? Date.parse(v) : NaN);
  const emailed = rows.filter((r) => r.emailed_at);
  const tally = (list) => ({
    emailed: list.length,
    interested: list.filter((r) => r.stage === "interested" && r.pushed_at).length,
    pending: list.filter((r) => r.stage === "interested" && !r.pushed_at).length,
    declined: list.filter((r) => r.stage === "declined").length,
    waiting: list.filter((r) => ["emailed", "reminded", "clarified"].includes(r.stage)).length,
    closed: list.filter((r) => r.stage === "closed").length,
  });
  const all = tally(emailed);
  const week = { emailed: emailed.filter((r) => t(r.emailed_at) >= sinceMs).length, interested: rows.filter((r) => r.stage === "interested" && t(r.pushed_at) >= sinceMs).length };
  return { all, week };
}

function must({ data, error }, what) {
  if (error) throw new Error(`pieworks-activations ${what}: ${error.message}`);
  return data;
}

/** The ONLY reader and writer of pieworks_activations. Fail loud: an error throws, so a pass never acts on a state it could not read. */
export function activationStore(db = null) {
  const c = () => db || store();
  const T = "pieworks_activations";
  return {
    /** Insert new rows; a shortlist id already stored is left exactly as it is. Returns how many were new. */
    async insertNew(rows) {
      if (!rows.length) return 0;
      const data = must(await c().from(T).upsert(rows, { onConflict: "shortlist_id", ignoreDuplicates: true }).select("shortlist_id"), "insert");
      return (data || []).length;
    },
    /** Their threads that can still take a reply (not yet moved, stopped or skipped), newest first. */
    async openByEmail(email) {
      return must(await c().from(T).select("*").eq("email", String(email || "").trim().toLowerCase()).in("stage", ["emailed", "reminded", "clarified", "closed"]).order("emailed_at", { ascending: false }).limit(10), "open by email") || [];
    },
    async byReplyKey(key) { return must(await c().from(T).select("*").eq("reply_key", key).maybeSingle(), "by key"); },
    async inStage(stage, limit = 500) { return must(await c().from(T).select("*").eq("stage", stage).order("received_at", { ascending: true }).limit(limit), `stage ${stage}`) || []; },
    async unpushed() { return must(await c().from(T).select("*").eq("stage", "interested").is("pushed_at", null).lt("push_attempts", MAX_PUSH_ATTEMPTS).limit(200), "unpushed") || []; },
    async all() { return must(await c().from(T).select("stage, emailed_at, pushed_at").limit(100000), "all") || []; },
    async update(id, patch) {
      return must(await c().from(T).update({ ...patch, updated_at: new Date().toISOString() }).eq("shortlist_id", id).select("*").single(), "update");
    },
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof activationStore>} [deps.S]
 * @param {typeof sendGuarded} [deps.send]
 * @param {() => object} [deps.getResend]
 * @param {() => Promise<{roles: object[]}>} [deps.fetchRoles]   Pieworks' active roles
 * @param {(a: {requirementId: number, shortlistId: number}) => Promise<{ok: boolean, result: number, message: string|null}>} [deps.push]
 * @param {string} [deps.mode]  off | shadow | live
 * @param {string} [deps.statsTo]
 */
export function activation({ S = activationStore(), send = sendGuarded, getResend, fetchRoles = () => listActiveRoles(), push = (a) => markInterested(a), mode = activationMode(), statsTo = String(process.env.PIEWORKS_STATS_TO || "").trim(), now = () => Date.now(), log = console.error, capture = () => {} } = {}) {
  let rs = null;
  const resend = () => (getResend ? getResend() : (rs ||= new Resend(process.env.RESEND_API_KEY)));
  const iso = () => new Date(now()).toISOString();
  const roleOf = (row) => row.role || {};
  const mailArgs = (row) => ({ name: row.name, role: roleOf(row).role, company: roleOf(row).company, city: roleOf(row).city, referred: wasReferred(row.candidate), pay: roleOf(row).pay || "", years: roleOf(row).years || "", line: roleOf(row).line || "", unsubUrl: unsubUrlFor(row.email) });

  /** One email to one person, guarded. Returns the send status; throws only when nothing could be built. */
  async function deliver(row, kind, mail) {
    const fromAddr = bareAddress(process.env.CHARLIE_FROM);
    if (!fromAddr) throw new Error("CHARLIE_FROM is not set; nothing was sent");
    const replyTo = replyAddress(row.reply_key);
    if (!replyTo) throw new Error("no reply address could be made; nothing was sent");
    const unsub = unsubUrlFor(row.email);
    const payload = { from: `${SENDER_NAME} <${fromAddr}>`, to: row.email, replyTo, subject: mail.subject, html: mail.html, text: mail.text, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
    const ok = ResendSendPayload.safeParse(payload);
    if (!ok.success) throw new Error(`the ${kind} email did not match the send schema: ${ok.error.issues[0]?.path.join(".")}`);
    if (mode !== "live") { log(`[pieworks] shadow: would send ${kind} to ${row.email} (${row.shortlist_id}): ${mail.subject}`); return "shadow"; }
    const r = await send({ resend: resend(), email: row.email, template: `pieworks-${kind}`, dedupeKey: `${row.shortlist_id}:${kind}`, payload: ok.data, log });
    return r.status;
  }

  /** The webhook batch. Each record parsed; a bad one is logged by its shortlistId and skipped, never the batch. */
  async function ingest(records = [], { idempotencyKey = null } = {}) {
    const rows = [], skipped = [];
    for (const raw of records) {
      const p = PieworksWebhookCandidate.safeParse(raw);
      if (!p.success) {
        const id = raw && typeof raw === "object" ? raw.shortlistId : null;
        const issue = p.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        log(`[pieworks] webhook record ${id ?? "(no shortlistId)"} skipped: ${issue}`);
        skipped.push({ id, issue });
        continue;
      }
      const { aiScoreReason, ...candidate } = p.data;
      rows.push({ shortlist_id: p.data.shortlistId, requirement_id: p.data.requirementId, email: p.data.emailId.trim().toLowerCase(), name: p.data.name.trim(), candidate, ai_score_reason: aiScoreReason ?? null, idempotency_key: idempotencyKey });
    }
    // one shortlist id twice in one batch: the first is kept
    const unique = [...new Map(rows.map((r) => [r.shortlist_id, r])).values()];
    const stored = await S.insertNew(unique);
    return { received: records.length, stored, repeats: unique.length - stored, skipped };
  }

  /** First emails for the stored, not yet asked. Nobody is asked when the roles read fails. */
  async function askNew(out) {
    const pending = await S.inStage("received", ASKS_PER_PASS);
    if (!pending.length) return;
    let roles;
    try {
      roles = new Map(((await fetchRoles()).roles || []).map((r) => [Number(r.id), r]));
    } catch (e) {
      log(`[pieworks] active roles could not be read; nobody is asked this pass: ${e?.message || e}`);
      capture(e, { kind: "pieworks-roles" });
      out.failed++;
      return;
    }
    for (const row of pending) {
      try {
        if (mode === "shadow" && row.stage_reason === "shadow: would ask") continue;
        const r = roles.get(Number(row.requirement_id));
        if (!r) { await S.update(row.shortlist_id, { stage: "skipped", stage_reason: "the role is not in Pieworks' active roles" }); out.skipped++; continue; }
        if (isTestRole(r)) { await S.update(row.shortlist_id, { stage: "skipped", stage_reason: "Pieworks' test listing" }); out.skipped++; continue; }
        if (!OPEN_ROLE_STATUSES.includes(String(r.status || "").trim().toLowerCase())) { await S.update(row.shortlist_id, { stage: "skipped", stage_reason: `the role's status is ${r.status}` }); out.skipped++; continue; }
        const role = { role: r.role, company: r.clientName, city: String(r.location || "").replace(/\s*,\s*/g, ", ").trim(), pay: payLine(r), years: yearsLine(r, row.candidate?.experience), line: roleLine(r.okr) };
        const keyed = row.reply_key ? { ...row, role } : await S.update(row.shortlist_id, { reply_key: newReplyKey(), role });
        const status = await deliver(keyed, "ask", renderPieworksAsk(mailArgs(keyed)));
        if (status === "shadow") { await S.update(row.shortlist_id, { stage_reason: "shadow: would ask" }); continue; }
        if (status === "sent" || status === "duplicate") { await S.update(row.shortlist_id, { stage: "emailed", emailed_at: iso(), stage_reason: null }); out.asked++; continue; }
        if (status === "suppressed") { await S.update(row.shortlist_id, { stage: "skipped", stage_reason: "the address is suppressed (bounced, complained or unsubscribed)" }); out.skipped++; continue; }
        await S.update(row.shortlist_id, { stage_reason: `the ask was not sent: ${status}` });
        out.failed++;
      } catch (e) {
        log(`[pieworks] ask ${row.shortlist_id}: ${e?.message || e}`); capture(e, { kind: "pieworks-ask", id: row.shortlist_id }); out.failed++;
      }
    }
  }

  /** One reminder 48 hours after an unanswered ask; closed 48 hours after that (or after an unanswered clarify). */
  async function timers(out) {
    const t = now();
    for (const row of await S.inStage("emailed")) {
      try {
        if (row.replied_at || t - Date.parse(row.emailed_at) < REMIND_AFTER_HOURS * H) continue;
        const status = await deliver(row, "reminder", renderPieworksReminder(mailArgs(row)));
        if (status === "shadow") continue;
        if (status === "sent" || status === "duplicate") { await S.update(row.shortlist_id, { stage: "reminded", reminded_at: iso() }); out.reminded++; }
        else if (status === "suppressed") await S.update(row.shortlist_id, { stage: "closed", stage_reason: "the address is suppressed" });
        else out.failed++;
      } catch (e) { log(`[pieworks] reminder ${row.shortlist_id}: ${e?.message || e}`); capture(e, { kind: "pieworks-reminder", id: row.shortlist_id }); out.failed++; }
    }
    for (const [stage, at] of [["reminded", "reminded_at"], ["clarified", "clarified_at"]]) {
      for (const row of await S.inStage(stage)) {
        try {
          if (t - Date.parse(row[at]) < (CLOSE_AFTER_HOURS - REMIND_AFTER_HOURS) * H) continue;
          if (mode !== "live") continue;
          await S.update(row.shortlist_id, { stage: "closed", stage_reason: stage === "reminded" ? "no reply" : "no clear yes or no" });
          out.closed++;
        } catch (e) { log(`[pieworks] close ${row.shortlist_id}: ${e?.message || e}`); capture(e, { kind: "pieworks-close", id: row.shortlist_id }); out.failed++; }
      }
    }
  }

  /** Move one yes to interested in Pieworks; once it is accepted, thank them (so "I've let them know" is true). */
  async function pushOne(row, out) {
    if (mode !== "live") { log(`[pieworks] shadow: would move ${row.shortlist_id} (requirement ${row.requirement_id}) to interested`); return; }
    let res;
    try {
      res = await push({ requirementId: Number(row.requirement_id), shortlistId: Number(row.shortlist_id) });
    } catch (e) {
      res = { ok: false, result: null, message: String(e?.message || e) };
    }
    const attempts = (row.push_attempts || 0) + 1;
    if (!res.ok) {
      await S.update(row.shortlist_id, { push_attempts: attempts, push_result: { ...res, at: iso() } });
      log(`[pieworks] move ${row.shortlist_id} to interested not accepted (try ${attempts} of ${MAX_PUSH_ATTEMPTS}): ${res.result ?? ""} ${res.message ?? ""}`.trim());
      if (attempts >= MAX_PUSH_ATTEMPTS) capture(new Error(`Pieworks did not accept interested for ${row.shortlist_id} after ${attempts} tries`), { kind: "pieworks-push", id: row.shortlist_id });
      out.failed++;
      return;
    }
    const moved = await S.update(row.shortlist_id, { pushed_at: iso(), push_attempts: attempts, push_result: { ...res, at: iso() } });
    out.moved++;
    try { await deliver(moved, "noted", renderPieworksNoted(mailArgs(moved))); } catch (e) { log(`[pieworks] noted ${row.shortlist_id}: ${e?.message || e}`); }
  }

  /** Monday's count to the owner, once a week (the send guard's dedupe key is the week). */
  async function stats(out) {
    if (!statsTo || mode !== "live") return;
    const d = new Date(now());
    if (d.getUTCDay() !== 1 || d.getUTCHours() < 4) return; // Monday, from 09:30 IST
    const since = now() - 7 * 24 * H;
    const counts = countStats(await S.all(), since);
    const mail = renderPieworksStats({ ...counts, unsubUrl: unsubUrlFor(statsTo) });
    const fromAddr = bareAddress(process.env.CHARLIE_FROM);
    if (!fromAddr) throw new Error("CHARLIE_FROM is not set; no stats email");
    const payload = ResendSendPayload.parse({ from: `${SENDER_NAME} <${fromAddr}>`, to: statsTo, subject: mail.subject, html: mail.html, text: mail.text });
    const r = await send({ resend: resend(), email: statsTo, template: "pieworks-stats", dedupeKey: weekKey(now()), payload, log });
    if (r.status === "sent") out.stats = true;
  }

  /** One sweep. Off: nothing. Every step isolated; the result says what happened. */
  async function runPass() {
    const out = { mode, asked: 0, reminded: 0, closed: 0, moved: 0, skipped: 0, failed: 0, stats: false };
    if (mode === "off") return out;
    const steps = [["ask", askNew], ["timers", timers], ["push", async (o) => { for (const row of await S.unpushed()) await pushOne(row, o).catch((e) => { log(`[pieworks] push ${row.shortlist_id}: ${e?.message || e}`); capture(e, { kind: "pieworks-push", id: row.shortlist_id }); o.failed++; }); }], ["stats", stats]];
    for (const [name, step] of steps) {
      try { await step(out); } catch (e) { log(`[pieworks] ${name}: ${e?.message || e}`); capture(e, { kind: `pieworks-${name}` }); out.failed++; }
    }
    return out;
  }

  /**
   * A reply to pieworks+<key>@. Only the person's own address is read. YES: moved (and thanked once Pieworks accepts).
   * NO: stopped, nothing sent. Anything else: asked once, plainly; a second unclear reply changes nothing.
   * @returns {Promise<string>} what happened, for the log
   */
  async function onReply({ key, from, body }) {
    const row = await S.byReplyKey(key);
    if (!row) return "no such row";
    if (String(from || "").trim().toLowerCase() !== String(row.email).trim().toLowerCase()) return `ignored: from ${from}, not the person's own address`;
    if (FINAL_STAGES.includes(row.stage)) {
      await S.update(row.shortlist_id, { replied_at: iso(), reply_text: String(body || "").slice(0, 4000) });
      return `noted only: already ${row.stage}`;
    }
    const read = readReply(body, { name: row.name, phone: row.candidate?.phoneNo, email: row.email });
    const base = { replied_at: iso(), reply_text: String(body || "").slice(0, 4000), reply_read: read };
    if (read === "yes") {
      const next = await S.update(row.shortlist_id, { ...base, stage: "interested", stage_reason: null });
      const out = { moved: 0, failed: 0 };
      await pushOne(next, out);
      return out.moved ? "yes: moved to interested" : "yes: recorded; Pieworks has not accepted it yet, the sweep tries again";
    }
    if (read === "no") {
      await S.update(row.shortlist_id, { ...base, stage: "declined", stage_reason: null });
      return "no: stopped";
    }
    if (row.clarified_at) {
      await S.update(row.shortlist_id, base);
      return "unclear again: recorded, nothing sent";
    }
    const status = await deliver(row, "clarify", renderPieworksClarify(mailArgs(row)));
    await S.update(row.shortlist_id, { ...base, ...(status === "sent" || status === "duplicate" ? { stage: "clarified", clarified_at: iso() } : {}) });
    return `unclear: clarify ${status}`;
  }

  /**
   * A reply that came to the From address instead of pieworks+<key>@ (a mail app that ignores Reply-To, or a forward).
   * Theirs only when this sender has an open thread AND the subject names that thread's role; otherwise null, and the
   * mail goes on to the rest of /inbound unchanged, so such a reply is never read as a job seeker's question.
   */
  async function keyForReply({ from, subject }) {
    const rows = await S.openByEmail(from);
    const hit = rows.find((r) => r.reply_key && subjectNamesRole(subject, r.role?.role));
    return hit ? hit.reply_key : null;
  }

  return { ingest, runPass, onReply, keyForReply, countStats };
}
