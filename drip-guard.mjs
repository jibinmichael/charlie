// drip-guard.mjs — the ONE deterministic gate every lifecycle-drip sender calls before it sends.
//
// Mirrors the pre-send guard philosophy: rather send NOTHING than something we are half-confident
// about. Fail CLOSED. A drip (completeness nudge, weekly digest, and anything added later) must
// never spam, never double-send, never nudge someone who does not need it, and never reach a
// suppressed or unsubscribed address.
//
// Usage (in a sender, before the actual Resend call):
//   import { dripGuard, stampFor } from "./drip-guard.mjs";
//   const g = await dripGuard({ email, dripType: "completeness", candidate, now: Date.now() });
//   if (g.decision === "skip") { log(`${email}: skip (${g.reason})`); continue; }
//   ... send ...
//   await mergeEmailConfig(email, stampFor("completeness", new Date().toISOString()));  // AFTER a real send
//
// Everything is pure and testable EXCEPT the suppression check (the one network hit). Pass `now`
// (ms) and read all state off the `candidate` object so the cooldown / not-needed / opt-out logic
// can be unit-tested with no network. Only isSuppressed touches Supabase.

import { isSuppressed } from "./charlie-store.mjs";

const DAY = 24 * 60 * 60 * 1000;

// GLOBAL LEDGER: every successful lifecycle drip stamps this key too, and every drip consults it
// so no two drips of ANY type stack inside the global minimum gap: a newly added drip can never pile
// onto an existing one.
const GLOBAL_LAST_KEY = "last_drip_at";
const GLOBAL_GAP_ENV = "DRIP_GLOBAL_MIN_GAP_DAYS";
const GLOBAL_GAP_DEFAULT_DAYS = 2;

// A drip-type's contract, all in one place so a new drip is safe by construction:
//   lastAtKey — the email_config timestamp this type stamps after a successful send (idempotency)
//   cooldownDays — the per-type minimum interval; never two of the SAME type inside this window
//   defaultCooldownDays / envKey — env-tunable default (sensible, conservative)
// The cooldowns are deliberately generous: a skipped drip day is invisible; a drip storm is not.
const TYPES = {
  completeness: { lastAtKey: "last_gap_drip_at",      envKey: "DRIP_COOLDOWN_COMPLETENESS_DAYS", defaultCooldownDays: 7 },
  digest:       { lastAtKey: "last_digest_at",        envKey: "DRIP_COOLDOWN_DIGEST_DAYS",        defaultCooldownDays: 6 },
  checkin:      { lastAtKey: "last_checkin_at",       envKey: "DRIP_COOLDOWN_CHECKIN_DAYS",       defaultCooldownDays: 10 },
  profile:      { lastAtKey: "last_profile_nudge_at", envKey: "DRIP_COOLDOWN_PROFILE_DAYS",       defaultCooldownDays: 7 },
  // The weekly market-gap drop (market-gap.mjs). Its "not-needed" gate (no recurring gap → don't send)
  // needs per-role coverage scoring, which is expensive and non-deterministic, so it lives in the SWEEP,
  // not here — dripGuard only does the cheap cadence/opt-out/suppression gate for this type.
  marketgap:    { lastAtKey: "marketgap_last_at",     envKey: "DRIP_COOLDOWN_MARKETGAP_DAYS",     defaultCooldownDays: 7 },
  // The "State of Your Market" briefing (market-briefing.mjs) — the you-vs-market letter. Sent AT MOST
  // ONCE per person ever (its own `marketbrief_sent_at` gate + a hard MARKETBRIEF_EXCLUDE list), so this
  // cooldown is a belt on top; kept long. Its "enough data" gate (fail-closed on a thin dossier / empty
  // market) lives in the sweep, like marketgap/wedge — the guard only does cadence/opt-out/suppression.
  marketbrief:  { lastAtKey: "marketbrief_sent_at",   envKey: "DRIP_COOLDOWN_MARKETBRIEF_DAYS",   defaultCooldownDays: 30 },
  // The "game plan" email (game-plan.mjs) — the #3 onboarding beat (how I'll work for you + where I'm
  // looking + approve/modify). Sent AT MOST ONCE per person ever (its own `plan_sent_at` gate in the
  // sweep), so this cooldown is a belt on top; kept long. Its "enough data" gate (fail-closed on an
  // incomplete profile / out-of-market) lives in the sweep, like marketbrief — the guard only does the
  // cheap cadence/opt-out/suppression gate for this type.
  plan:         { lastAtKey: "plan_sent_at",           envKey: "DRIP_COOLDOWN_PLAN_DAYS",          defaultCooldownDays: 30 },
  invite:       { lastAtKey: "last_invite_at",        envKey: "DRIP_COOLDOWN_INVITE_DAYS",        defaultCooldownDays: 30 },
  // Proactive lifecycle drips — routed through the guard so they can't stack on each other or on the
  // completeness/invite drips (each keeps its own one-time flag as lastAtKey). Transactional/reward
  // emails (welcome, first-role, confirmation, the daily role, inbound replies) are NOT drips and stay
  // ungated — they're expected.
  referral:     { lastAtKey: "referral_announce_sent_at", envKey: "DRIP_COOLDOWN_REFERRAL_DAYS", defaultCooldownDays: 30 },
  thesis:       { lastAtKey: "thesis_sent_at",            envKey: "DRIP_COOLDOWN_THESIS_DAYS",   defaultCooldownDays: 30 },
  followup:     { lastAtKey: "followup_last_at",          envKey: "DRIP_COOLDOWN_FOLLOWUP_DAYS", defaultCooldownDays: 5 },
  // The wedge drip (wedge.mjs). Sent AT MOST ONCE per person ever (its own `wedge_sent_at` gate in the
  // sweep), so the cooldown is really a belt on top; kept long. Its "nothing to say" gate is upstream:
  // no high-confidence grounded edge -> the sweep never reaches the guard.
  wedge:        { lastAtKey: "wedge_sent_at",             envKey: "DRIP_COOLDOWN_WEDGE_DAYS",    defaultCooldownDays: 30 },
};

// The completeness nudge also spaces itself on its own `completeness_last_at`; and the timed nudge
// already collides against the chat gap-drip's `last_gap_drip_at`. To be belt-and-suspenders and to
// respect BOTH ledgers, completeness treats a recent value in ANY of these as "too soon". The profile
// nudge shares the same completeness ledgers (it asks the same missing-field questions), so it also
// consults them plus its own key.
const COOLDOWN_KEYS = {
  // completeness / profile / marketgap all target the same "not getting roles, could enrich" person,
  // so they consult EACH OTHER's ledgers: only one profile-enrichment drip fires per 7-day window
  // (the global 2-day gap alone is not enough to keep the richer marketgap from stacking on a nudge).
  completeness: ["last_gap_drip_at", "completeness_last_at", "marketgap_last_at"],
  digest: ["last_digest_at"],
  checkin: ["last_checkin_at"],
  profile: ["last_profile_nudge_at", "last_gap_drip_at", "completeness_last_at", "marketgap_last_at"],
  marketgap: ["marketgap_last_at", "last_gap_drip_at", "completeness_last_at", "last_profile_nudge_at"],
  marketbrief: ["marketbrief_sent_at"],
  plan: ["plan_sent_at"],
  invite: ["last_invite_at"],
  referral: ["referral_announce_sent_at"],
  thesis: ["thesis_sent_at"],
  followup: ["followup_last_at"],
  wedge: ["wedge_sent_at"],
};

function globalGapDays() {
  const v = Number(process.env[GLOBAL_GAP_ENV]);
  return Number.isFinite(v) && v > 0 ? v : GLOBAL_GAP_DEFAULT_DAYS;
}

function cooldownDaysFor(dripType) {
  const t = TYPES[dripType];
  if (!t) return null;
  const v = Number(process.env[t.envKey]);
  return Number.isFinite(v) && v > 0 ? v : t.defaultCooldownDays;
}

// The canonical missing-field logic — IDENTICAL to scripts/send-profile-nudge.mjs `missingFor` and
// what renderProfileNudge asks for. A field genuinely absent for THIS person, nothing already given.
const SENIORITY_IN_ROLE = /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|mid[- ]?level|entry|head|director|vp|chief|founding)\b/i;
export function missingFields(dossier) {
  const d = dossier || {};
  const p = d.preferences || {};
  const m = [];
  if (!p.role) m.push("role");
  if (!p.seniority && !(p.role && SENIORITY_IN_ROLE.test(p.role))) m.push("seniority");
  if (p.comp_floor == null) m.push("pay");
  if (!p.remote) m.push("location");
  if (!d.name) m.push("name");
  return m;
}

// True if the candidate has opted out of lifecycle drips. Respects a few flag spellings so a future
// opt-out toggle (or a global unsubscribe recorded in email_config) is honored without a code change.
export function isOptedOut(ec) {
  if (!ec) return false;
  return ec.unsubscribed === true
    || ec.drips_opt_out === true
    || ec.drip_opt_out === true
    || ec.lifecycle_opt_out === true
    || ec.opt_out === true
    || (typeof ec.drips === "string" && ec.drips.toLowerCase() === "off")
    || ec.drips === false;
}

// True if this person has a prior EMAILED role to check in on. dripGuard is deterministic and does no
// network, so the caller (which already reads finds) passes the signal on the candidate object under
// any of these spellings. Absent/false → nothing to nudge about → the checkin skips.
function hasPriorEmailedRole(candidate) {
  if (!candidate) return false;
  if (candidate.priorEmailedRole) return true;             // the actual last-emailed job object
  if (candidate.hasPriorRole === true) return true;        // an explicit boolean the caller computed
  return false;
}

// The stamp to persist AFTER a successful send. A sender that forgets to stamp risks a double-send,
// so this hands back the exact email_config patch to merge. `nowIso` defaults to now. Stamps BOTH the
// per-type ledger key AND the global `last_drip_at`, so every successful drip advances the global gap
// and no other drip type can stack behind it.
export function stampFor(dripType, nowIso = new Date().toISOString()) {
  const t = TYPES[dripType];
  if (!t) throw new Error(`stampFor: unknown dripType "${dripType}"`);
  return { [t.lastAtKey]: nowIso, [GLOBAL_LAST_KEY]: nowIso };
}

// The gate. Returns { decision: "send" | "skip", reason }. Fail CLOSED: any unknown type, missing
// candidate, or ambiguous state resolves to "skip".
//
//   email     — the recipient (identity)
//   dripType  — "completeness" | "digest" | "checkin" | "profile" (extensible via TYPES)
//   candidate — the candidate row ({ email_config, dossier, ... }); read-only
//   now       — ms epoch (default Date.now()), so cooldown math is testable
//   items     — for "digest": the already-built list of items about to be shown (skip if empty)
export async function dripGuard({ email, dripType, candidate, now = Date.now(), items } = {}) {
  const skip = (reason) => ({ decision: "skip", reason });

  const recipient = String(candidate?.email_config?.notify || email || "").trim().toLowerCase();
  if (!recipient) return skip("no-recipient");
  if (!TYPES[dripType]) return skip(`unknown-drip-type:${dripType}`);
  if (!candidate) return skip("no-candidate");

  const ec = candidate.email_config || {};

  // 1) opt-out / unsubscribe — honor it before anything else.
  if (isOptedOut(ec)) return skip("opted-out");

  // 2) GLOBAL LEDGER — never let ANY drip stack. If any lifecycle drip fired within the global
  //    minimum gap (regardless of type), skip. Every stampFor advances `last_drip_at`, so this is the
  //    one gate that guarantees drips can't pile up on each other.
  const gapDays = globalGapDays();
  const globalAt = ec[GLOBAL_LAST_KEY];
  if (globalAt) {
    const gt = new Date(globalAt).getTime();
    if (Number.isFinite(gt) && (now - gt) < gapDays * DAY) return skip(`global-gap:${GLOBAL_LAST_KEY}:${gapDays}d`);
  }

  // 3) cooldown / no-double-send — never the SAME type inside the per-type window. Consults every
  //    ledger key for the type (belt + suspenders), so a newly added drip can't stack on an existing.
  const cooldownDays = cooldownDaysFor(dripType);
  const windowMs = cooldownDays * DAY;
  for (const key of COOLDOWN_KEYS[dripType] || [TYPES[dripType].lastAtKey]) {
    const at = ec[key];
    if (!at) continue;
    const t = new Date(at).getTime();
    if (Number.isFinite(t) && (now - t) < windowMs) return skip(`cooldown:${key}:${cooldownDays}d`);
  }

  // 4) not-needed — the nudge is not warranted.
  if (dripType === "completeness" || dripType === "profile") {
    // Profile already complete → nothing to ask → don't nudge.
    if (missingFields(candidate.dossier).length === 0) return skip("profile-complete");
  } else if (dripType === "digest") {
    // Nothing to show → never send an empty digest. Callers pass the already-built `items`.
    if (!Array.isArray(items) || items.length === 0) return skip("no-digest-items");
  } else if (dripType === "checkin") {
    // Nothing to check in on if we've never sent this person a role. The caller detects the prior
    // role (finds status "emailed"); we accept it via candidate.priorEmailedRole / candidate.hasPriorRole.
    if (!hasPriorEmailedRole(candidate)) return skip("no-prior-role");
  }

  // 5) suppression — the one network read; check last so pure paths short-circuit before it. Never
  //    drip to a bounced / complained address. isSuppressed itself fails OPEN (returns false) only on
  //    a transient DB error, matching every other sender.
  if (await isSuppressed(recipient)) return skip("suppressed");

  return { decision: "send", reason: "ok" };
}
