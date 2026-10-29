// lib/qualify/agent.mjs — the Qualify & Submit agent. One agent for every employer; each employer system is a connection
// (hire_connections). Automatic: no person approves each email or submission. A connection's mode is the
// control: off, shadow (judges and says what it would do; sends, submits and CHANGES NOTHING), live.
//
// EACH RUN, PER CONNECTION
//   1. Full pass, at most every 11 hours (so twice a day): sync the source's roles (lib/qualify/roles.mjs),
//      then for each active role with room, judge the pool and open a thread with the best fits: the verify
//      email asks consent to be put forward to this company for this role, then only what is missing.
//      Room = batch size (4) less threads in flight, never past the role's cap (16 submitted).
//   2. Timers: one reminder 48 hours after an unanswered first verify email; closed quietly 96 hours after it.
//      A follow-up (round 2) gets no reminder: closed quietly 96 hours after it.
//   3. Answered threads: read the answers, judge again, then submit, ask one follow-up, or close.
//   3b. Every detail in: ONE confirm email lists exactly what will be sent (role, city, pay, notice, contact, the CV
//      file), and only a reply that is just YES makes the thread ready (readConfirmYes: no word list can read consent
//      safely from free text). Anything else (a correction is filed) is confirmed once
//      more, then closed unsubmitted. Any reply after the YES and before submission needs a new confirm.
//   4. Ready threads: submit once, only what they confirmed, with a justification written only from cited evidence
//      of their own words.
//   5. Put-forward emails the daily limit held back are sent on a later run (the send guard's dedupe keeps it one).
//
// WHO IS NEVER WRITTEN TO OR SUBMITTED (each a separate check, before any email or model call where possible):
//   below the fit bar; not in the talent pool or consent_pool not true; suppressed, unsubscribed, paused or not
//   looking; a name that is not a name; the experience gate not ELIGIBLE; already in a thread for this role; in an
//   open thread for any role (one conversation per person at a time). Submitted only with a clear yes to THE
//   COMPANY THE EMAIL NAMED for this role (stored at send time, with the wording version, and the reply it came
//   from), a clear yes to the role's city when it was asked, every field the destination needs from their own
//   record or answers, a CV PDF they sent, expected pay inside the role's stated band (a role with no stated top
//   is recorded as such), and a justification that passed the grounding check. A reply that takes the yes back
//   stops everything, at any stage before submission. Only the person's own address can answer.
//   Every person and role is isolated: one failure is recorded and the rest go on.
import { fieldsFromRecord, questionsFor, readAnswers, mergeFields, missingFields, readYesNo, readConfirmYes, confirmCore } from "./fields.mjs";
import { QUALIFY_REMIND_HOURS, QUALIFY_CLOSE_HOURS } from "../hire-lifecycle.mjs";
import { verifyCopy } from "./copy.mjs";
import { justificationItems } from "./justification.mjs";
import { hashOf } from "./store.mjs";

const H = 3_600_000;
export const OPEN_STAGES = ["verify_sent", "reminded", "answered", "held", "confirming", "ready", "submitting"];
/** Confirm emails per thread: the first, and one more. Then it closes unsubmitted. */
export const CONFIRM_ASKS = 2;
export const FIT_RANK = { excellent: 3, strong: 2, potential: 1, insufficient: 0 };
export const CONSENT_WORDING = "qualify-verify-1";
const NOT_A_NAME = /[,0-9@]/;
/** The timings the agent runs on, named so the workspace's Setup card shows them from here (lib/agents/setup.mjs). */
export const FULL_PASS_HOURS = 11;
// the timers are the one lifecycle policy's (lib/hire-lifecycle.mjs DEFAULT_POLICY: 48 and 48 after it)
export const REMIND_AFTER_HOURS = QUALIFY_REMIND_HOURS;
export const CLOSE_AFTER_HOURS = QUALIFY_CLOSE_HOURS;
const FULL_PASS_EVERY = FULL_PASS_HOURS * H;
/**
 * Words that take a yes back, read on the person's own words only. Narrow on purpose: a
 * broad list closed people who said yes ("yes, go ahead. Please don't share my phone with recruiters"). It is not the
 * only guard: after a yes, any later reply that is not itself a clear yes holds the submission (onQualifyReply).
 */
const TAKES_IT_BACK = /\b(do\s*n[o']?t|don'?t|rather not|no longer want to|not)\s+(want to\s+)?(be\s+)?(put|putting|send|sending)\s+(me|my \w+)\s+(forward|ahead)\b|\b(do\s*n[o']?t|don'?t|no longer|not)\s+(want to\s+)?be\s+(put|sent|submitted)(\s+(forward|ahead|through))?\b|\b(do\s*n[o']?t|don'?t)\s+(submit|share)\s+(me|my (name|profile|cv|details))\b(?!\s+with)|\bwithdraw (my|me)\b|\bi'?ll pass\b|\bi'?d rather not\b|\bnot interested in (this|the) (role|job|position|opportunity)\b|\bno longer interested\b|\bchanged my mind\b|\bhold (off|on)\b|\bwait (before|until|till)\b|\bdo\s*n[o']?t (submit|send) (it |me )?yet\b/i;

/** A name typed in capitals is still greeted in sentence case; a non-name is refused. Pure. */
export function greetingName(raw) {
  const given = String(raw || "").trim();
  if (!given || given.length < 2 || NOT_A_NAME.test(given) || /^(n\/?a|none|null|unknown|test|candidate|name|\W+)$/i.test(given)) return null;
  const [first, ...rest] = given.split(/\s+/);
  return [/^[A-Z]{3,}$/.test(first) ? first.charAt(0) + first.slice(1).toLowerCase() : first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** May we write to this person at all? Pure. */
export function personAllowed({ pool, suppressed, status }) {
  if (!pool) return { ok: false, reason: "not in the talent pool" };
  if (pool.consent_pool !== true) return { ok: false, reason: "has not agreed to hear about other roles" };
  if (suppressed) return { ok: false, reason: "unsubscribed or suppressed" };
  if (status && status !== "active" && status !== "screening") return { ok: false, reason: `status is ${status}` };
  if (pool.seeking_status === "not_looking") return { ok: false, reason: "told us they are not looking" };
  return { ok: true };
}

export const gateAllows = (g) => g?.eligibility_status === "ELIGIBLE" || g?.eligibility_status === "NO_CONSTRAINTS";

/** The address inside "Name <a@b.com>", lower-cased. Pure. */
export const addressOf = (from) => String(/<([^>]+)>/.exec(String(from || ""))?.[1] || from || "").trim().toLowerCase();

/**
 * Does this reply take the yes back? Only an explicit phrase does. A reply that merely starts with "No" is an answer
 * ("No problem, I can work from there", "No. My notice is 30 days"), never a withdrawal. Pure.
 */
export const withdraws = (words) => TAKES_IT_BACK.test(String(words || ""));

/** Statuses from the send guard that will never change on a retry (lib/send-guard.mjs). */
const REFUSED = new Set(["suppressed", "leak_blocked"]);

/** The connection's settings with the defaults. Pure. */
export function settingsOf(conn) {
  const s = conn?.settings || {};
  // who fits is the pluggable scorer's call (lib/scoring/index.mjs): a person it passes is read as "strong", the bar
  return { min_fit: "strong", per_role_cap: Number.isInteger(s.per_role_cap) && s.per_role_cap > 0 ? s.per_role_cap : 16, batch_size: Number.isInteger(s.batch_size) && s.batch_size > 0 ? s.batch_size : 4, last_full_at: s.last_full_at || null };
}

/**
 * Exactly what the destination receives about the person, as the lines of the confirm email, including the note
 * written about them, so the person sees everything that is sent. The submission is held to these: submitReady refuses
 * when they no longer hash to what the person said YES to. Pure.
 */
export function confirmFacts(fields = {}, cvPath = null, justification = "") {
  const v = (k) => (fields[k]?.value == null || fields[k]?.value === "" ? null : fields[k].value);
  const cc = v("countryCode") ? (String(v("countryCode")).startsWith("+") ? v("countryCode") : `+${v("countryCode")}`) : "";
  return [
    `Name: ${v("name") ?? ""}`,
    `Email: ${v("emailId") ?? ""}`,
    `Phone: ${[cc, v("phoneNo") ?? ""].filter(Boolean).join(" ")}`,
    `LinkedIn: ${v("linkedInUrl") ?? ""}`,
    `Current company: ${v("currentCompany") ?? ""}`,
    `Based in: ${v("currentLocation") ?? ""}`,
    `Experience: ${v("experience") ?? ""} years`,
    `Current pay: ${v("currentCtcFixed") ?? ""} lakh fixed, ${v("currentCtcVariable") ?? ""} lakh variable`,
    `Expected pay: ${v("expectedCtc") ?? ""} lakh a year`,
    `Notice period: ${v("noticePeriod") ?? ""} days`,
    `CV: ${cvPath ? String(cvPath).split("/").pop() : ""}`,
    `What I will say about you: ${String(justification || "")}`,
  ];
}
/** Which confirm email this is: its number, its facts and when it went. */
const confirmId = (c) => `${c?.confirm_asks ?? 0}:${c?.confirm_hash ?? ""}:${c?.confirm_sent_at ?? ""}`;
// the CV's stored path is in the hash, not only its name: a new file under the same name is a new confirm
export const confirmHash = (facts, externalRoleId, company, cvPath = "") => hashOf({ facts, role: String(externalRoleId ?? ""), company: String(company ?? ""), cv: String(cvPath ?? "") });

/** Must-haves the evaluation could not establish: asked, never assumed. Pure. */
export const openMustHaves = (spec, evaluation) => {
  const must = new Map((spec?.criteria || []).filter((c) => c.kind === "must_have").map((c) => [c.ref, c]));
  return (evaluation?.criteria || []).filter((c) => must.has(c.ref) && c.level === "unknown").map((c) => ({ ref: c.ref, label: must.get(c.ref).label }));
};

/**
 * One run of the agent. Impure; every effect goes through deps so it can be tested without a network.
 * deps: { cstore, hire, adapters, syncRoles, ensureEvaluated, personFacts, gate, evaluate, writeJustification,
 *         send, render, cv, newReplyKey, log }
 */
export async function runQualify({ cfg, now, remaining, runId, deps }) {
  const { hire, adapters, log = () => {} } = deps;
  // every stage change this run writes is recorded as the agent's (lib/qualify/store.mjs)
  const cstore = deps.cstore.as ? deps.cstore.as({ actor_type: "agent", actor_id: "outreach", ref: runId ?? null }) : deps.cstore;
  /** Has a person passed on putting them forward (the Inbox's Pass)? Read now, at every step that writes to them. */
  const employerPassed = async (jobId, candidateId) => (await hire.decisionFor?.(jobId, candidateId))?.decision === "passed";
  // put forward only once a person approved them in the Inbox: a Strong score alone never puts anyone forward, a
  // human approval is the final decision (lib/qualify/store.mjs setApproval). No lookup, or no decision, means not
  // approved: fail closed
  const employerApproved = async (jobId, candidateId) => (await hire.decisionFor?.(jobId, candidateId))?.decision === "saved";
  const PASSED = "a person chose not to put them forward for this role";

  const unrecordedBefore = Number(cstore.eventFailures) || 0;
  const refusedBefore = Number(cstore.engineRefusals) || 0;
  const movesBefore = Number(cstore.engineMoves) || 0;
  const counts = { considered: 0, sent: 0, drafted: 0, waiting: 0, skipped: 0, failed: 0, submitted: 0 };
  const items = [];
  let budget = remaining;
  const note = (who, mandate, action, result, reason = "") => items.push({ who, mandate, action, result, reason });
  const iso = (ms = now) => new Date(ms).toISOString();

  // the run's own writes to a thread land only if no reply arrived since the run read it: same stage,
  // same replied_at. stillAt re-reads before an email goes, so a person who just wrote is never emailed on stale facts
  const runWrite = (t, patch) => cstore.updateThreadIf(t.id, t.stage, patch, { replied_at: t.replied_at ?? null });
  const stillAt = async (t) => { const cur = await cstore.threadByKey(t.reply_key); return Boolean(cur && cur.stage === t.stage && (cur.replied_at ?? null) === (t.replied_at ?? null)); };
  const conns = (await cstore.connections()).filter((c) => c.mode === "shadow" || c.mode === "live");
  if (!conns.length) note("Qualify & Submit", "", "run", "nothing to do", "every connection is off");
  const openEmails = await cstore.openEmails();

  /**
   * One email. Returns "sent" | "shadow" | "limit" | "engine"; throws when the guard refuses. `move` is the stage
   * change the email is for: when the lifecycle engine enforces, a move it refuses sends nothing.
   */
  const email = async (conn, { to, template, dedupeKey, replyKey, mail, who, move = null }) => {
    if (move && cstore.engineMode === "enforce") {
      const v = cstore.mayMove(move.t, move.to, move.patch ?? {});
      if (!v.ok) { counts.failed++; note(who, conn.key, "send", "engine refused", `${template}: ${v.reason}`); return "engine"; }
    }
    if (conn.mode !== "live") { note(who, conn.key, "send", "shadow", `would send ${template}`); return "shadow"; }
    if (budget <= 0) { counts.waiting++; note(who, conn.key, "send", "daily limit reached", template); return "limit"; }
    const r = await deps.send({ email: to, template, dedupeKey, replyKey, mail });
    if (r?.status === "sent") { budget--; counts.sent++; return "sent"; }
    if (r?.status === "duplicate") return "sent";
    if (REFUSED.has(r?.status)) { note(who, conn.key, "send", "refused", `${template}: ${r.status}`); return "refused"; }
    throw new Error(`${template} not sent: ${r?.status ?? "no status"}`);
  };

  for (const conn of conns) {
    const adapter = adapters[conn.source?.type];
    if (!adapter) { counts.failed++; note(conn.name, conn.key, "connect", "failed", `no adapter for ${conn.source?.type}`); continue; }
    const set = settingsOf(conn);
    const partner = conn.destination?.via || null;
    const live = conn.mode === "live";
    try {
      // 1. the full pass: roles in, then open threads with the best fits
      if (!set.last_full_at || now - Date.parse(set.last_full_at) >= FULL_PASS_EVERY) {
        const sync = await deps.syncRoles({ connection: conn, deps: { store: cstore, hire, listRoles: () => adapter.listRoles(conn), log } });
        note(conn.name, conn.key, "roles", "synced", `${sync.created} new, ${sync.rebriefed} updated, ${sync.paused} paused, ${sync.closed} closed, ${sync.skipped} not taken, ${sync.failed} failed${sync.held ? `; ${sync.held}` : ""}`);
        for (const role of (await cstore.roles(conn.id)).filter((r) => r.job_id)) {
          try {
            await qualifyRole(conn, role, set, partner);
          } catch (e) {
            counts.failed++; note(role.payload?.role || role.external_id, conn.key, "qualify", "failed", String(e?.message || e).slice(0, 160));
            log(`[qualify:${conn.key}] role ${role.external_id}: ${e?.message || e}`);
          }
        }
        await cstore.saveConnection(conn.key, { settings: { ...(conn.settings || {}), last_full_at: iso() } }, "agent");
      } else {
        // said, so a run that only read replies never looks like a run that did nothing
        const next = new Date(Date.parse(set.last_full_at) + FULL_PASS_EVERY).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
        note(conn.name, conn.key, "roles", "not due", `read replies only; the next search for new fits is after ${next} IST`);
      }
      // 2-5. every run; in shadow, nothing below changes a thread (it only says what it would do)
      await timers(conn, live);
      await heldWithoutQuestion(conn, live);
      await answered(conn, set, partner, live);
      // where candidates go is the destination's; a connection that names none hands off where its
      // roles came from, as Pieworks always has
      await submitReady(conn, adapters[conn.destination?.type || conn.source?.type], partner, live);
      if (live) await putForwardPending(conn, partner);
    } catch (e) {
      counts.failed++; note(conn.name, conn.key, "run", "failed", String(e?.message || e).slice(0, 160));
      log(`[qualify:${conn.key}] ${e?.message || e}`);
    }
  }
  // a change that happened but could not be recorded is said, never silent (the store keeps the count)
  const unrecorded = (Number(cstore.eventFailures) || 0) - unrecordedBefore;
  // the one lifecycle engine: its mode, and every move it refused (shadow) or stopped (enforce), said
  const refused = (Number(cstore.engineRefusals) || 0) - refusedBefore;
  const moved = (Number(cstore.engineMoves) || 0) - movesBefore;
  if (cstore.engineMode && (moved > 0 || refused > 0)) note("Qualify & Submit", "", "engine", refused > 0 ? "disagreed" : "agreed", refused > 0 ? `${refused} ${refused === 1 ? "move" : "moves"} the lifecycle engine ${cstore.engineMode === "enforce" ? "stopped" : "would refuse"} (${cstore.engineMode}): ${(cstore.engineReasons || []).slice(-3).join("; ")}` : `${moved} ${moved === 1 ? "move" : "moves"} checked by the lifecycle engine (${cstore.engineMode})`);
  if (unrecorded > 0) note("Qualify & Submit", "", "record", "not recorded", `${unrecorded} ${unrecorded === 1 ? "change" : "changes"} could not be added to the history`);
  return { counts, items, needsReview: counts.failed > 0 || unrecorded > 0 || refused > 0 };

  async function qualifyRole(conn, role, set, partner) {
    const job = (await hire.getJob(role.job_id))?.job;
    if (!job || job.lifecycle !== "active") return;
    const spec = await hire.currentSpec(job.id);
    if (!spec || spec.status !== "approved") { note(job.title, conn.key, "judge", "not judged", "its brief is not approved yet"); return; }
    const jobThreads = await cstore.threadsForJob(job.id);
    const subs = await cstore.submissionsForJob(job.id);
    const submitted = subs.filter((s) => s.status === "sent" || s.status === "duplicate").length;
    const inflight = jobThreads.filter((t) => OPEN_STAGES.includes(t.stage)).length;
    let room = Math.min(set.batch_size - inflight, set.per_role_cap - submitted - inflight);
    if (room <= 0) { note(job.title, conn.key, "judge", "not judged", `full: ${inflight} in conversation, ${submitted} put forward`); return; }
    const evals = await deps.ensureEvaluated({ job, spec });
    // Checked is everyone this run looked at for the role (judged, or turned away by the gate), not only those at the
    // bar, so a run that found no fit still shows what it did; the role's stored evaluations are never re-added
    // (that would overstate every pass)
    counts.considered += Number(evals.checked) || 0;
    const bar = FIT_RANK[set.min_fit];
    // the scorer's pass is the bar (lib/scoring/index.mjs); someone a person passed on is never written to
    const chosen = (e) => (FIT_RANK[e.fit] ?? 0) >= bar;
    const ranked = evals.filter((e) => e.decision?.decision !== "passed" && chosen(e)).sort((a, b) => (FIT_RANK[b.fit] - FIT_RANK[a.fit]) || ((a.retrieval?.distance ?? 9) - (b.retrieval?.distance ?? 9)));
    // the run's judging, said per role, so a pass that found no fit still shows what it did
    const passedN = evals.filter((e) => e.decision?.decision === "passed").length;
    note(job.title, conn.key, "judge", "judged", `${Number(evals.checked) || 0} scored this run; ${ranked.length} of ${evals.length} passed the scorer${passedN ? `; ${passedN} passed on by a person, never written to` : ""}`);
    const facts = await deps.personFacts(ranked.map((e) => String(e.person?.email || "").toLowerCase()).filter(Boolean));
    const seen = new Set(jobThreads.map((t) => t.candidate_id));
    for (const e of ranked) {
      if (room <= 0) break;
      const addr = String(e.person?.email || "").toLowerCase();
      const who = e.person?.full_name || addr || e.candidate_id;
      const skip = (reason) => { counts.skipped++; note(who, conn.key, "qualify", "not written to", reason); };
      if (!addr) { skip("no email address on record"); continue; }
      if (seen.has(e.candidate_id)) { skip("already asked about this role"); continue; }
      if (openEmails.has(addr)) { skip("already in a conversation about another role"); continue; }
      const pool = facts.pool.get(addr);
      const allowed = personAllowed({ pool, suppressed: facts.suppressed.has(addr), status: facts.status.get(addr) });
      if (!allowed.ok) { skip(allowed.reason); continue; }
      const name = greetingName(pool.full_name || e.person?.full_name);
      if (!name) { skip(`the name on the record ("${pool.full_name || ""}") is not a name`); continue; }
      const gate = await deps.gate({ job, spec, candidateId: e.candidate_id, person: e.person });
      if (!gateAllows(gate)) { skip(`experience check: ${gate?.eligibility_status || "no answer"}`); continue; }
      const fields = fieldsFromRecord(pool, e.person);
      const city = role.payload?.location || null;
      const questions = questionsFor({ fields, role: job.title, company: job.client, city, personCity: fields.currentLocation?.value || null, openMustHaves: openMustHaves(spec, e), haveCvPdf: false });
      if (conn.mode !== "live") { note(who, conn.key, "verify", "shadow", `${e.fit} fit; would ask ${questions.length} questions`); room--; continue; }
      if (budget <= 0) { counts.waiting++; note(who, conn.key, "verify", "daily limit reached", "asked on a later run"); break; }
      // the company the email names is fixed HERE, so the consent can only ever cover what the person was shown
      let thread = await cstore.openThread({ connection_id: conn.id, job_id: job.id, candidate_id: e.candidate_id, email: addr, name, stage: "verify_sent", fit: e.fit, reply_key: deps.newReplyKey(), questions, fields, external_role_id: role.external_id, verify_sent_at: iso(), consent: { state: "ASKED", company_shown: job.client, role_shown: job.title, wording_version: CONSENT_WORDING, asked_at: iso() } });
      seen.add(e.candidate_id); openEmails.add(addr); room--;
      try {
        const copy = verifyCopy(conn.sequence, { name, role: job.title, company: job.client, city: city || "", partner: partner || "" });
        for (const i of copy.issues) note(conn.name, conn.key, "copy", "default used", i);
        const mail = deps.render.verify({ name, role: job.title, company: job.client, city: city || "", partner: partner || "", questions: questions.map((q) => q.text), intro: copy.intro, closing: copy.closing, email: addr });
        const r = await email(conn, { to: addr, template: "qualify-verify", dedupeKey: `${thread.id}:verify`, replyKey: thread.reply_key, mail, who });
        if (r === "refused") { await cstore.updateThread(thread.id, { stage: "closed", close_reason: "cannot be emailed (suppressed or blocked)" }); openEmails.delete(addr); continue; }
        note(who, conn.key, "verify", "sent", `${e.fit} fit for ${job.title} at ${job.client}; ${questions.length} questions`);
      } catch (err) {
        counts.failed++;
        thread = await cstore.updateThread(thread.id, { stage: "failed", last_error: String(err?.message || err).slice(0, 300) });
        note(who, conn.key, "verify", "failed", String(err?.message || err).slice(0, 160));
      }
    }
  }

  async function timers(conn, live) {
    for (const t of await cstore.threads(conn.id, ["verify_sent", "reminded", "confirming"])) {
      // a confirm with no reply in 96 hours closes quietly; never submitted, never reminded
      if (t.stage === "confirming") {
        const sentAt = Date.parse(t.consent?.confirm_sent_at || "");
        if (!(now - sentAt >= CLOSE_AFTER_HOURS * H)) continue;
        if (!live) { note(t.name || t.email, conn.key, "close", "shadow", "would close: no YES to the confirm"); continue; }
        try { if (await runWrite(t, { stage: "closed", close_reason: "no reply to the confirm" })) note(t.name || t.email, conn.key, "close", "closed", "no reply to the confirm"); }
        catch (e) { counts.failed++; note(t.name || t.email, conn.key, "timer", "failed", String(e?.message || e).slice(0, 160)); }
        continue;
      }
      if (t.replied_at || !t.verify_sent_at) continue;
      const age = now - Date.parse(t.verify_sent_at);
      const who = t.name || t.email;
      try {
        const confirming = Boolean(t.consent?.recheck_asked);
        const remind = t.stage === "verify_sent" && (t.rounds ?? 1) === 1 && !confirming && age >= REMIND_AFTER_HOURS * H;
        const expire = age >= CLOSE_AFTER_HOURS * H && (t.stage === "reminded" || (t.rounds ?? 1) === 2 || confirming);
        if (!remind && !expire) continue;
        if (!live) { note(who, conn.key, remind ? "reminder" : "close", "shadow", remind ? "would remind" : "would close: no reply"); continue; }
        const job = (await hire.getJob(t.job_id))?.job;
        if (!job) { await runWrite(t, { stage: "failed", last_error: "the role's job no longer exists" }); note(who, conn.key, "timer", "failed", "the role's job no longer exists"); continue; }
        if (remind) {
          const mail = deps.render.reminder({ name: t.name, role: job.title, company: job.client, email: t.email });
          const r = await email(conn, { to: t.email, template: "qualify-reminder", dedupeKey: `${t.id}:reminder`, replyKey: t.reply_key, mail, who, move: { t, to: "reminded" } });
          if (r === "sent") { await runWrite(t, { stage: "reminded" }); note(who, conn.key, "reminder", "sent", "no reply in 48 hours"); }
          else if (r === "refused") await runWrite(t, { stage: "closed", close_reason: "cannot be emailed (suppressed or blocked)" });
        } else {
          if (await runWrite(t, { stage: "closed", close_reason: "no reply" })) note(who, conn.key, "close", "closed", "no reply");
        }
      } catch (e) {
        counts.failed++; note(who, conn.key, "timer", "failed", String(e?.message || e).slice(0, 160));
      }
    }
  }

  /** Close with one closing email. Nothing changes until that email is sent, so a held email is never skipped. */
  async function close(conn, t, job, reasonIn, tell, extra = {}) {
    let reason = reasonIn;
    if (!(await stillAt(t))) { note(t.name || t.email, conn.key, "close", "not closed", "a reply arrived; read on the next run"); return; }
    if (tell) {
      const mail = deps.render.closed({ name: t.name, role: job.title, company: job.client, email: t.email, ...extra });
      const r = await email(conn, { to: t.email, template: "qualify-closed", dedupeKey: `${t.id}:closed`, replyKey: t.reply_key, mail, who: t.name || t.email, move: { t, to: "closed", patch: { close_reason: reason } } });
      if (r === "limit" || r === "engine") return;
      if (r === "refused") reason = `${reason}; the closing email could not be sent (suppressed or blocked)`;
    }
    if (await runWrite(t, { stage: "closed", close_reason: reason })) note(t.name || t.email, conn.key, "close", "closed", reason);
  }

  /**
   * A check says they are not a fit (the experience gate, the fit bar, the pay band). Closing someone on fit is a
   * decision about a person, so the agent asks a person instead (the candidacy lifecycle): the thread
   * waits at `held` with a proposal in "Needs you". A person's decision is kept on the thread: `overrides.close[check]`
   * (approved) closes them here with the honest closing email; `overrides.keep[check]` (keep them) carries on past this
   * check. Before the candidacy migration is applied, today's behaviour stands: closed at once.
   * Returns true when the thread is dealt with (closed or held), false to carry on.
   */
  async function notAFit(conn, t, job, check, reason, evidence, extra = {}) {
    if (t.overrides?.keep?.[check]) { note(t.name || t.email, conn.key, "check", "kept", `${reason}; a person chose to keep them`); return false; }
    if (t.overrides?.close?.[check] || !(cstore.propose && (await cstore.candidacyReady?.()))) {
      // exactly as before: only the fit check saved the re-read before closing
      if (check === "fit") await runWrite(t, extra);
      await close(conn, t, job, reason, true);
      return true;
    }
    // the question first, then the thread parked behind it: a thread is never held without a question a person can
    // answer. If a reply lands in between, the question is withdrawn and the reply is read next run.
    const p = await cstore.propose({ thread: t, kind: "close_not_fit", check_id: check, reason, evidence });
    const held = await runWrite(t, { stage: "held", ...extra });
    if (!held) { await cstore.voidProposals(t); note(t.name || t.email, conn.key, "propose", "not asked", "a reply arrived; read on the next run"); return true; }
    // the history says a person was asked only once they really were: the thread is held behind the question
    await cstore.recordEvent?.({ type: "proposal.made", job_id: t.job_id, thread_id: t.id, candidate_id: t.candidate_id, reason, approval_id: p?.id ?? null });
    note(t.name || t.email, conn.key, "propose", "needs you", `close as not a fit? ${reason}`);
    return true;
  }

  /** A thread held for a person with no open question (it was lost or withdrawn) is never stuck: it goes back to the
   *  agent, which reads it again and asks again if it still has to. */
  async function heldWithoutQuestion(conn, live) {
    if (!live || !cstore.pendingProposals) return;
    const held = await cstore.threads(conn.id, ["held"]);
    if (!held.length) return;
    const asked = new Set((await cstore.pendingProposals()).map((p) => p.thread_id));
    // one thread at a time: a failure on one never stops the rest of the run
    for (const t of held) {
      if (asked.has(t.id)) continue;
      try {
        if (await runWrite(t, { stage: "answered" })) note(t.name || t.email, conn.key, "propose", "asked again", "held with no open question; read again");
      } catch (e) {
        counts.failed++; note(t.name || t.email, conn.key, "propose", "failed", String(e?.message || e).slice(0, 160));
      }
    }
  }

  async function answered(conn, set, partner, live) {
    for (const t of await cstore.threads(conn.id, ["answered"])) {
      const who = t.name || t.email;
      if (!live) { note(who, conn.key, "answers", "shadow", "would read their answers"); continue; }
      try {
        const job = (await hire.getJob(t.job_id))?.job;
        if (!job) { await runWrite(t, { stage: "failed", last_error: "the role's job no longer exists" }); continue; }
        if (t.consent?.state === "WITHDRAWN") { await close(conn, t, job, "took back their yes", true); continue; }
        // a reply after they were ready that was not a clear yes: ONE short question confirms the yes, then nothing
        if (t.consent?.state === "RECHECK") {
          const confirms = Number(t.consent.confirms || 0);
          if (t.consent.recheck_asked || confirms >= 2) { await close(conn, t, job, "their yes was not confirmed", true); continue; }
          const q = { id: "consent", text: `Just to confirm: may I put you forward to ${job.client} for the ${job.title} role?`, round: t.rounds ?? 1 };
          const mail = deps.render.verify({ name: t.name, role: job.title, company: job.client, city: "", partner: partner || "", questions: [q.text], intro: "Thanks for your note. Before I put you forward, one quick check:", closing: "A one word yes is enough. If it is a no, just say so.", email: t.email });
          // a fresh dedupe key per confirm, so a second confirm is really sent, never swallowed as a duplicate
          const r = await email(conn, { to: t.email, template: "qualify-verify", dedupeKey: `${t.id}:confirm:${confirms + 1}`, replyKey: t.reply_key, mail, who, move: { t, to: "verify_sent" } });
          if (r === "sent") { await runWrite(t, { stage: "verify_sent", verify_sent_at: iso(), replied_at: null, questions: [...(t.questions || []), q], consent: { ...t.consent, recheck_asked: true, confirms: confirms + 1 } }); note(who, conn.key, "confirm", "sent", "asked to confirm their yes"); }
          else if (r === "refused") await runWrite(t, { stage: "closed", close_reason: "cannot be emailed (suppressed or blocked)" });
          continue;
        }
        if (job.lifecycle !== "active") { await close(conn, t, job, "the role is no longer open", true); continue; }
        // confirmed twice without a plain YES: closed before any more model calls
        if (await employerPassed(job.id, t.candidate_id)) { await close(conn, t, job, PASSED, true); continue; }
        if (Number(t.consent?.confirm_asks || 0) >= CONFIRM_ASKS) { await close(conn, t, job, "did not reply YES to the details", true, { noYes: true }); continue; }
        const spec = await hire.currentSpec(job.id);
        const read = readAnswers(t.answers || {});
        const fields = mergeFields(t.fields || {}, read.fields);
        if (read.consent === "no") { await close(conn, t, job, "said no", true); continue; }
        if (read.workFrom === "no") { await close(conn, t, job, "will not work from the role's city", true); continue; }
        const evaluation = await deps.evaluate({ job, spec, thread: t });
        const gate = await deps.gate({ job, spec, candidateId: t.candidate_id, person: { email: t.email, total_years: fields.experience?.value ?? null } });
        if (!gateAllows(gate) && (await notAFit(conn, t, job, "gate", `experience check after their answers: ${gate?.eligibility_status || "no answer"}`, { gate: gate?.eligibility_status ?? null }, { fields }))) continue;
        if ((FIT_RANK[evaluation.fit] ?? 0) < FIT_RANK[set.min_fit] && (await notAFit(conn, t, job, "fit", `fit is ${evaluation.fit} after their answers${evaluation.reasons?.length ? ` (the scorer: ${evaluation.reasons.join("; ").slice(0, 160)})` : ""}`, { fit: evaluation.fit, score: evaluation.score ?? null }, { evaluation, fields }))) continue;
        const role = (await cstore.roles(conn.id)).find((r) => r.external_id === t.external_role_id);
        const maxCtc = role?.payload?.maxCtc;
        if (fields.expectedCtc && maxCtc != null && Number.isFinite(Number(maxCtc)) && Number(maxCtc) > 0 && fields.expectedCtc.value > Number(maxCtc)) { if (await notAFit(conn, t, job, "pay", `expects ${fields.expectedCtc.value} lakh; the role pays up to ${maxCtc}`, { expected: fields.expectedCtc.value, max: Number(maxCtc) }, { evaluation, fields })) continue; }
        const askedCity = (t.questions || []).some((q) => q.id === "workFrom");
        const missing = missingFields(fields);
        const consentOk = read.consent === "yes" && t.consent?.company_shown === job.client && Boolean(t.consent?.evidence);
        const needs = [...(consentOk ? [] : ["consent"]), ...(askedCity && read.workFrom !== "yes" ? ["workFrom"] : []), ...missing, ...(t.cv_path ? [] : ["cv"])];
        if (needs.length) {
          if ((t.rounds ?? 1) >= 2) { await close(conn, t, job, `details still missing after a follow-up: ${needs.join(", ")}`, true); continue; }
          const all = questionsFor({ fields, role: job.title, company: job.client, city: askedCity ? role?.payload?.location || null : null, personCity: null, openMustHaves: [], haveCvPdf: Boolean(t.cv_path) });
          const followUp = all.filter((q) => (q.id === "consent" ? needs.includes("consent") : q.id === "workFrom" ? needs.includes("workFrom") : true));
          const closing = needs.includes("consent") ? null : "Thank you. That is all I need before I put you forward.";
          const mail = deps.render.verify({ name: t.name, role: job.title, company: job.client, city: role?.payload?.location || "", partner: partner || "", questions: followUp.map((q) => q.text), intro: `Thanks for your reply. To put you forward to ${job.client} I still need a few things:`, closing, email: t.email });
          const r = await email(conn, { to: t.email, template: "qualify-verify", dedupeKey: `${t.id}:verify:2`, replyKey: t.reply_key, mail, who, move: { t, to: "verify_sent" } });
          if (r === "sent") { await runWrite(t, { stage: "verify_sent", rounds: 2, verify_sent_at: iso(), replied_at: null, questions: [...(t.questions || []), ...followUp.map((q) => ({ ...q, round: 2 }))], fields, evaluation }); note(who, conn.key, "follow-up", "sent", `still needed: ${needs.join(", ")}`); }
          else if (r === "refused") await runWrite(t, { stage: "closed", close_reason: "cannot be emailed (suppressed or blocked)" });
          continue;
        }
        if (!(maxCtc != null && Number(maxCtc) > 0)) note(who, conn.key, "pay", "no ceiling", "the role states no top of its pay band, so expected pay was not compared");
        // every detail in: ONE email shows exactly what will be sent; only a reply of just YES makes them ready
        const asks = Number(t.consent?.confirm_asks || 0);
        // the note about them is written BEFORE the confirm, so they see it, and it is the one that is sent. It is
        // drafted once per set of details and kept, so a held or re-sent confirm shows the same note a YES submits,
        // and no run pays for a fresh one
        const draftFor = confirmHash(confirmFacts(fields, t.cv_path), t.external_role_id, job.client, t.cv_path);
        let text = t.consent?.draft_for === draftFor ? String(t.consent?.draft_justification || "") : "";
        let consent = t.consent || {};
        if (!text) {
          const j = await deps.writeJustification({ roleTitle: job.title, firstName: String(t.name || "").split(/\s+/)[0], items: justificationItems(spec, evaluation, evaluation?.evidence || []) });
          if (!j?.ok || !String(j.text || "").trim()) { if (await runWrite(t, { stage: "failed", fields, evaluation, last_error: `no justification: ${j?.reason || "empty"}` })) { counts.failed++; note(who, conn.key, "confirm", "not sent", `no justification: ${j?.reason || "empty"}`); } continue; }
          text = String(j.text).trim();
          consent = { ...consent, draft_for: draftFor, draft_justification: text };
          if (!(await runWrite(t, { fields, evaluation, consent }))) { note(who, conn.key, "confirm", "not sent", "a reply arrived; read on the next run"); continue; }
        }
        const facts = confirmFacts(fields, t.cv_path, text);
        const hash = confirmHash(facts, t.external_role_id, job.client, t.cv_path);
        if (!(await stillAt(t))) { note(who, conn.key, "confirm", "not sent", "a reply arrived; read on the next run"); continue; }
        const mail = deps.render.confirm({ name: t.name, role: job.title, company: job.client, city: role?.payload?.location || "", partner: partner || "", facts, again: asks > 0, email: t.email });
        // the hash is in the dedupe key: a "duplicate" from the guard can only mean THESE facts were already delivered
        const r = await email(conn, { to: t.email, template: "qualify-confirm", dedupeKey: `${t.id}:confirm-details:${asks + 1}:${hash.slice(0, 12)}`, replyKey: t.reply_key, mail, who, move: { t, to: "confirming" } });
        if (r === "sent") {
          const moved = !(await runWrite(t, { stage: "confirming", fields, evaluation, consent: { ...consent, state: "CONFIRM_ASKED", confirm_hash: hash, justification: text, confirm_asks: asks + 1, confirm_sent_at: iso(), confirmed_hash: null } }));
          note(who, conn.key, "confirm", "sent", moved ? "sent, but a reply landed at the same moment; it is read on the next run" : `${evaluation.fit} fit, every detail in; asked to reply YES to the details`);
        } else if (r === "refused") await runWrite(t, { stage: "closed", close_reason: "cannot be emailed (suppressed or blocked)" });
      } catch (e) {
        counts.failed++; note(who, conn.key, "answers", "failed", String(e?.message || e).slice(0, 160));
        log(`[qualify:${conn.key}] thread ${t.id}: ${e?.message || e}`);
      }
    }
  }

  async function submitReady(conn, adapter, partner, live) {
    // a thread left mid-submission (the run stopped between claiming it and recording the answer) is never sent
    // again blind: a person checks the employer system
    if (live) for (const t of await cstore.threads(conn.id, ["submitting"])) {
      const since = Date.parse(t.consent?.submitting_at || "");
      if (Number.isFinite(since) && now - since < H) continue;
      try { await cstore.updateThreadIf(t.id, "submitting", { stage: "failed", last_error: "stopped mid-submission; check the employer system before anything else" }); counts.failed++; note(t.name || t.email, conn.key, "submit", "failed", "stopped mid-submission"); }
      catch (e) { counts.failed++; note(t.name || t.email, conn.key, "submit", "failed", String(e?.message || e).slice(0, 160)); }
    }
    const ready = await cstore.threads(conn.id, ["ready"]);
    if (!adapter) { if (ready.length) { counts.failed++; note(conn.name, conn.key, "submit", "not submitted", `no destination for ${conn.destination?.type}`); } return; }
    for (const t of ready) {
      const who = t.name || t.email;
      if (!live) { note(who, conn.key, "submit", "shadow", "would submit"); continue; }
      try {
        const job = (await hire.getJob(t.job_id))?.job;
        if (!job) { await runWrite(t, { stage: "failed", last_error: "the role's job no longer exists" }); continue; }
        if (job.lifecycle !== "active") { await close(conn, t, job, "the role is no longer open", true); continue; }
        const prior = (await cstore.submissionsForJob(t.job_id)).filter((s) => s.candidate_id === t.candidate_id);
        if (prior.some((s) => s.status === "sent" || s.status === "duplicate")) { await runWrite(t, { stage: "submitted" }); continue; }
        if (await employerPassed(job.id, t.candidate_id)) { await close(conn, t, job, PASSED, true); continue; }
        if (!(await employerApproved(job.id, t.candidate_id))) { counts.waiting++; note(who, conn.key, "submit", "waiting", "waiting for a person to approve them in the Inbox before they are put forward"); continue; }
        // the consent must be for the company the email named, granted, with the reply it came from
        if (t.consent?.state !== "GRANTED" || t.consent?.company_shown !== job.client || !t.consent?.evidence) { await runWrite(t, { stage: "failed", last_error: "no consent on record for this company" }); counts.failed++; note(who, conn.key, "submit", "not submitted", "no consent on record for this company"); continue; }
        if (!t.cv_path) { await runWrite(t, { stage: "failed", last_error: "no CV PDF on record" }); counts.failed++; continue; }
        // a reply kept while it was being submitted, never read by the agent: a person reads it first
        if ((t.answers?._after || []).some((x) => x?.unread)) { await runWrite(t, { stage: "failed", last_error: "a reply is waiting to be read before anything else" }); counts.failed++; note(who, conn.key, "submit", "not submitted", "a reply is waiting to be read"); continue; }
        // only what they said YES to: the details, the CV file, the role and the company, exactly as confirmed
        const justification = String(t.consent?.justification || "");
        if (!justification || !t.consent?.confirmed_hash || t.consent.confirmed_hash !== confirmHash(confirmFacts(t.fields, t.cv_path, justification), t.external_role_id, job.client, t.cv_path)) { await runWrite(t, { stage: "failed", last_error: "what would be sent is not what they confirmed" }); counts.failed++; note(who, conn.key, "submit", "not submitted", "what would be sent is not what they confirmed"); continue; }
        const cv = await deps.cv.get(t.cv_path);
        const candidate = adapter.toCandidate(t.fields, justification, { facts: confirmFacts(t.fields, t.cv_path, justification) });
        // claimed only while still ready: a reply that lands now (a withdrawal, a correction) wins, and nothing is sent
        const claimed = await cstore.updateThreadIf(t.id, "ready", { stage: "submitting", consent: { ...t.consent, submitting_at: iso() } }, { replied_at: t.replied_at ?? null });
        if (!claimed) { note(who, conn.key, "submit", "not submitted", "a reply changed the thread just now"); continue; }
        let res;
        try {
          res = await adapter.submit(conn, { roleId: t.external_role_id, candidate, cv, send: (o) => handoff(conn, t, job, o) });
        } catch (e) {
          const attempt = prior.length + 1;
          await cstore.recordSubmission({ connection_id: conn.id, job_id: t.job_id, candidate_id: t.candidate_id, thread_id: t.id, external_role_id: t.external_role_id, mode: "live", status: "failed", payload: candidate, payload_hash: hashOf(candidate), response: { error: String(e?.message || e).slice(0, 300) }, attempt });
          // back to ready only if the thread is exactly as the claim left it (compared by version, never by clock);
          // any reply since then stops it for a person to read
          const back = attempt >= 3 ? { stage: "failed", last_error: String(e?.message || e).slice(0, 300) } : { stage: "ready" };
          const ok = await cstore.updateThreadIf(t.id, "submitting", back, { updated_at: claimed.updated_at ?? null });
          if (!ok) await cstore.updateThreadIf(t.id, "submitting", { stage: "failed", last_error: "a reply arrived while the submission was failing; read it before anything else" });
          counts.failed++; note(who, conn.key, "submit", "failed", `attempt ${attempt}: ${String(e?.message || e).slice(0, 120)}`);
          continue;
        }
        await cstore.recordSubmission({ connection_id: conn.id, job_id: t.job_id, candidate_id: t.candidate_id, thread_id: t.id, external_role_id: t.external_role_id, mode: "live", status: res.status, payload: candidate, payload_hash: hashOf(candidate), response: res, attempt: prior.length + 1 });
        if (res.status === "sent") {
          await cstore.updateThread(t.id, { stage: "submitted" });
          counts.submitted++; note(who, conn.key, "submit", "submitted", `to ${job.client} for ${job.title}`);
          await sendPutForward(conn, t, job, partner);
        } else if (res.status === "duplicate") {
          await cstore.updateThread(t.id, { stage: "submitted", close_reason: "the employer already had them for this role" });
          note(who, conn.key, "submit", "already there", res.message || "");
        } else {
          await cstore.updateThread(t.id, { stage: "closed", close_reason: `refused by the employer system: ${res.message || res.result}` });
          note(who, conn.key, "submit", "refused", res.message || String(res.result));
        }
      } catch (e) {
        counts.failed++; note(who, conn.key, "submit", "failed", String(e?.message || e).slice(0, 160));
        log(`[qualify:${conn.key}] submit ${t.id}: ${e?.message || e}`);
      }
    }
  }

  /**
   * The pack to the hiring contact, for a destination that is an email. From "Charlie on behalf of
   * <the workspace's organisation>", through the same guarded send, once per thread. It does not
   * spend the daily budget: that limits the people Charlie writes to first, and this is the employer. Its reply address
   * is a fresh key no thread holds: the candidate's own thread key never goes to a third party, and a
   * reply to it is logged and not read (server/agents.ts qualifyInboundReply, "no such conversation").
   */
  async function handoff(conn, t, job, { to, contact, candidate, cv }) {
    const org = typeof cstore.orgName === "function" ? await cstore.orgName(conn.org_id) : null;
    const onBehalf = org && String(org).trim().toLowerCase() !== "charlie" ? String(org).trim() : "";
    const mail = deps.render.handoff({ org: onBehalf, name: candidate.name, email: to, candidateEmail: candidate.email, role: job.title, company: job.client, contact, facts: candidate.facts });
    return deps.send({ email: to, template: "qualify-handoff", dedupeKey: `${t.id}:handoff`, replyKey: deps.newReplyKey(), mail, fromName: onBehalf ? `Charlie on behalf of ${onBehalf}` : "Charlie", attachments: [{ filename: cv.filename, content: Buffer.from(cv.bytes).toString("base64") }] });
  }

  async function sendPutForward(conn, t, job, partner) {
    const mail = deps.render.putForward({ name: t.name, role: job.title, company: job.client, partner: partner || "", email: t.email });
    const r = await email(conn, { to: t.email, template: "qualify-put-forward", dedupeKey: `${t.id}:put-forward`, replyKey: t.reply_key, mail, who: t.name || t.email });
    if (r === "sent" || r === "refused") await cstore.updateThread(t.id, { fields: { ...(t.fields || {}), _put_forward_at: { value: iso(), source: r === "sent" ? "agent" : "refused" } } });
  }

  /** A put-forward email the daily limit held back goes on a later run; the guard's dedupe key keeps it to one. */
  async function putForwardPending(conn, partner) {
    for (const t of await cstore.threads(conn.id, ["submitted"])) {
      if (t.close_reason || t.fields?._put_forward_at) continue;
      try {
        const job = (await hire.getJob(t.job_id))?.job;
        if (job) await sendPutForward(conn, t, job, partner);
      } catch (e) {
        counts.failed++; note(t.name || t.email, conn.key, "put forward", "failed", String(e?.message || e).slice(0, 160));
      }
    }
  }
}

/**
 * A reply to a verify email (apply+<key>@). Only the person's own address is read. Answers are filed verbatim and
 * the CV kept; a reply that takes the yes back stops the thread at any stage before submission. The next run reads
 * the rest. deps: { cstore, fileAnswers(questions, reply) -> [{question, answer}], cv: { put(threadId, file) -> path },
 * ownWords, log }
 * @param {any} thread
 * @param {{ body?: string, from?: string, cvText?: string|null, cvFile?: { filename: string, bytes: Uint8Array }|null, ref?: string|null, now?: number, once?: boolean, seenConfirm?: any }} reply
 * @param {any} deps
 * @returns {Promise<string>} what happened, for the log
 */
export async function onQualifyReply(thread, { body = "", from = "", cvText = null, cvFile = null, ref = null, now = Date.now(), once = false, seenConfirm }, deps) {
  const { log = () => {} } = deps;
  // every stage change a reply causes is recorded as the candidate's (lib/qualify/store.mjs)
  const cstore = deps.cstore.as ? deps.cstore.as({ actor_type: "candidate", actor_id: addressOf(from) || null, ref: ref ?? null }) : deps.cstore;
  const at = new Date(now).toISOString();
  if (addressOf(from) !== String(thread.email || "").toLowerCase()) {
    log(`[qualify] a reply to ${thread.id} came from another address; not read`);
    return "ignored: not from the person it was sent to";
  }
  const words = deps.ownWords(body, from);
  // every write lands only while the thread is still where this reply found it; if a run moved it meanwhile (a
  // submission claimed it, or a timer closed it), the reply is read again against the thread as it is now
  const write = async (patch) => {
    const row = await cstore.updateThreadIf(thread.id, thread.stage, patch, thread.updated_at ? { updated_at: thread.updated_at } : {});
    if (row) return null;
    const fresh = await cstore.threadByKey(thread.reply_key);
    // re-read once; a YES counts only for the confirm this reply could have been answering
    if (fresh && !once) return onQualifyReply(fresh, { body, from, cvText, cvFile, ref, now, once: true, seenConfirm: confirmId(thread.consent) }, deps);
    // never dropped: kept with the thread, and the thread is stopped for a person to read
    if (fresh) {
      const late = [...(Array.isArray(fresh.answers?._after) ? fresh.answers._after : []), { at, words: String(words).slice(0, 4000), unread: true }].slice(-5);
      const stop = OPEN_STAGES.includes(fresh.stage) && fresh.stage !== "submitting" ? { stage: "failed", last_error: "a reply could not be read in order; read it before anything else" } : {};
      await cstore.updateThread(fresh.id, { ...stop, answers: { ...(fresh.answers || {}), _after: late } });
    }
    log(`[qualify] a reply to ${thread.id} could not be applied in order; kept for a person`);
    return "kept: could not be applied in order";
  };
  if (thread.stage === "submitted" || thread.stage === "submitting" || thread.stage === "closed" || thread.stage === "failed") {
    // nothing can be undone at the employer from here; keep the words so a person can read them. Written on this
    // version only (a failed submit can put the thread back to ready under it), so a reply to a
    // thread that went back to ready is read again as a reply to a ready thread
    const late = [...(Array.isArray(thread.answers?._after) ? thread.answers._after : []), { at, words: String(words).slice(0, 4000), unread: true }].slice(-5);
    return (await write({ answers: { ...(thread.answers || {}), _after: late }, replied_at: at })) ?? `kept after ${thread.stage}`;
  }
  // a reply while a person is deciding whether to close them: the question was asked on facts that just changed, and an
  // approval to close (not yet acted on) does not outlive their new words
  if (thread.stage === "held") await cstore.voidProposals?.(thread);
  const reread = thread.overrides?.close && Object.keys(thread.overrides.close).length ? { overrides: { ...thread.overrides, close: {} } } : {};
  const saidYes = ["REPLIED", "GRANTED", "CONFIRM_ASKED", "CONFIRM_UNCLEAR"].includes(thread.consent?.state);
  if (saidYes && withdraws(words)) {
    return (await write({ stage: "answered", replied_at: at, ...reread, consent: { ...(thread.consent || {}), state: "WITHDRAWN", withdrawn_at: at, evidence_withdrawn: ref || `reply:${at}` } })) ?? "took back their yes";
  }
  // THE FINAL YES. At the confirm, only a reply that is just YES makes them ready. After it and before submission, a
  // second plain YES or a bare "thanks" changes nothing; ANY other reply (a correction, a question, an "ok but") is
  // filed and the details are confirmed again (at most CONFIRM_ASKS in all, then closed unsubmitted).
  if (thread.stage === "confirming" || thread.stage === "ready") {
    const f = thread.fields || {};
    const whoSigns = { name: thread.name, company: f.currentCompany?.value, phone: f.phoneNo?.value, email: thread.email };
    // read from the raw body: confirmCore sets aside our quoted email itself, and sees a line typed inside it
    const yes = readConfirmYes(body, whoSigns) && (seenConfirm === undefined || seenConfirm === confirmId(thread.consent));
    const kept = [...(Array.isArray(thread.answers?._confirm) ? thread.answers._confirm : []), { at, words: String(words).slice(0, 2000) }].slice(-5);
    // a YES that brings a new CV is not a YES to the file they were shown: the new file is confirmed again
    if (thread.stage === "confirming" && yes && !cvFile?.bytes?.length) {
      return (await write({ stage: "ready", replied_at: at, answers: { ...(thread.answers || {}), _confirm: kept }, consent: { ...(thread.consent || {}), state: "GRANTED", granted_at: at, confirmed_at: at, confirmed_hash: thread.consent?.confirm_hash || null, evidence_confirmed: ref || `reply:${at}` } })) ?? "confirmed: YES";
    }
    if (thread.stage === "ready" && !cvFile?.bytes?.length && (yes || !confirmCore(body, whoSigns))) {
      return (await write({ answers: { ...(thread.answers || {}), _confirm: kept } })) ?? "kept: still confirmed";
    }
    const patch = { stage: "answered", replied_at: at, ...reread, consent: { ...(thread.consent || {}), state: "CONFIRM_UNCLEAR", confirmed_hash: null } };
    if (cvText) patch.cv_text = String(cvText).slice(0, 100000);
    if (cvFile?.bytes?.length && /\.pdf$/i.test(String(cvFile.filename || ""))) {
      try { patch.cv_path = await deps.cv.put(thread.id, cvFile); } catch (e) { log(`[qualify] cv for ${thread.id}: ${e?.message || e}`); }
    }
    // a correction is filed against every detail question, asked or not (a detail taken from their record, like
    // the phone, must be correctable too); never consent, the city or a must-have, which were answered
    // before the confirm and are not re-read from a correction
    const qs = questionsFor({ fields: {}, role: thread.consent?.role_shown || "", company: thread.consent?.company_shown || "", haveCvPdf: true }).filter((q) => q.id !== "consent" && q.id !== "workFrom" && !String(q.id).startsWith("must:"));
    let filed = [];
    if (qs.length) { try { filed = await deps.fileAnswers(qs.map((q) => q.text), words); } catch (e) { log(`[qualify] corrections for ${thread.id}: ${e?.message || e}`); } }
    const answers = { ...(thread.answers || {}), _confirm: kept };
    qs.forEach((q, i) => { if (filed[i]?.answer) answers[q.id] = filed[i].answer; });
    patch.answers = answers;
    return (await write(patch)) ?? `not a YES: details to confirm again (${qs.filter((q, i) => filed[i]?.answer).length} corrected)`;
  }
  // AFTER A YES, nothing is ever closed or submitted on a guess (wording alone cannot tell a willing person from a
  // real no). The rule: an explicit withdrawal closes
  // (above); a reply that answers our open questions and does not read as a no is filed; ANY other later reply
  // (one that reads as a no, or that answers nothing and is not a clear yes) holds the submission behind ONE short
  // "just to confirm" question. A willing person loses one line; a real no is never submitted.
  const patch = { stage: "answered", replied_at: at, ...reread };
  if (cvText) patch.cv_text = String(cvText).slice(0, 100000);
  if (cvFile?.bytes?.length && /\.pdf$/i.test(String(cvFile.filename || ""))) {
    try { patch.cv_path = await deps.cv.put(thread.id, cvFile); } catch (e) { log(`[qualify] cv for ${thread.id}: ${e?.message || e}`); }
  }
  const open = (thread.questions || []).filter((q) => (q.round ?? 1) === (thread.rounds ?? 1));
  let filed = [];
  try { filed = await deps.fileAnswers(open.map((q) => q.text), words); } catch (e) { log(`[qualify] answers for ${thread.id}: ${e?.message || e}`); }
  const answers = { ...(thread.answers || {}) };
  open.forEach((q, i) => { if (filed[i]?.answer) answers[q.id] = filed[i].answer; });
  patch.answers = answers;
  const consentFiled = filed.some((f, i) => open[i]?.id === "consent" && f?.answer);
  const filedAny = filed.some((f, i) => open[i] && f?.answer);
  const reads = readYesNo(words);
  if (thread.consent?.state === "RECHECK") {
    // the reply to a confirm question, read whole (the filer may have filed nothing, or be down): a yes confirms; a
    // no is a no; anything else is asked once more (capped at two confirms), never closed on
    if (consentFiled && readYesNo(answers.consent) === "yes" || reads === "yes") { patch.consent = { ...thread.consent, state: "REPLIED", evidence: ref || `reply:${at}`, replied_at: at, recheck_asked: false }; if (!answers.consent || readYesNo(answers.consent) !== "yes") answers.consent = String(words).slice(0, 400); }
    else if (reads === "no" || (consentFiled && readYesNo(answers.consent) === "no")) patch.consent = { ...thread.consent, state: "WITHDRAWN", withdrawn_at: at, evidence_withdrawn: ref || `reply:${at}` };
    else patch.consent = { ...thread.consent, recheck_asked: false };
  }
  else if (consentFiled) patch.consent = { ...(thread.consent || {}), state: "REPLIED", evidence: ref || `reply:${at}`, replied_at: at, recheck_asked: false };
  else if (saidYes && (reads === "no" || (reads !== "yes" && !filedAny))) patch.consent = { ...(thread.consent || {}), state: "RECHECK", recheck_at: at };
  const moved = await write(patch);
  if (moved) return moved;
  return `answered (${open.filter((q, i) => filed[i]?.answer).length} of ${open.length} answered${patch.cv_path ? ", CV kept" : ""})`;
}
