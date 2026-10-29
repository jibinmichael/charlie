// suppression-audit.mjs — ONE row per user: will this person receive anything on the next run, and
// if not, WHICH SWITCH IS OFF. READ-ONLY. It queries, it prints, it sends nothing and writes nothing.
//
//   node --env-file=.env.local scripts/suppression-audit.mjs
//   ROLE_COHORT="$(railway variables -s charlie-engine --kv | grep ^ROLE_COHORT= | cut -d= -f2-)" \
//     node --env-file=.env.local scripts/suppression-audit.mjs
//   … --json            machine-readable rows (one object per user)
//   … --silent-only     only the people who receive nothing
//   … --proposed-cohort print the ROLE_COHORT value that would serve everyone in bucket (a)
//
// A person can be silenced in several places set in different systems (a service env var, a Postgres
// column, a Postgres table, a JSON blob). This prints, per user, the first switch that stops them and
// every other switch that also would, and splits the silent into (a) silenced by config or accident
// and (b) silenced on purpose.
//
// It IMPORTS the real predicates (inRoleCohort, routingAddress, homeRegion, isV2, isOptedOut,
// isExcluded) instead of restating them, so the report cannot disagree with the code it reports on.
//
// It knows only the switches listed in § SWITCHES below. Adding a new way to silence someone means
// adding it here in the same change, or this report under-counts.
//
// The production ROLE_COHORT is a service variable, not in .env.local, and an unset ROLE_COHORT means
// NOBODY (lib/role-cohort.mjs). Running without it would report the entire user base as silenced, so
// it refuses unless the cohort is populated or --allow-empty-cohort is passed.

import { loadEnv, store, isV2 } from "../charlie-store.mjs";
import { inRoleCohort, roleCohortSize } from "../lib/role-cohort.mjs";
import { routingAddress } from "../lib/unreachable-cohort.mjs";
import { mayReplyDespiteSuppression } from "../lib/suppression-policy.mjs";
import { isOptedOut } from "../drip-guard.mjs";
import { isExcluded as excludedFromBriefing } from "../market-briefing.mjs";
import { homeRegion } from "../quality-gate.mjs";

// ── § SWITCHES — every way a user can be prevented from receiving something ──────────────────────
//
// Ordered the way the CODE applies them, so "first blocker" means the one that actually fires. Each
// entry says what it stops (role email / lifecycle mail / everything), and where it is set.
const SWITCHES = [
  {
    id: "status",
    stops: "everything automated",
    where: "candidates.status column (Postgres) — anything other than 'active'",
    setBy: "POST /unsubscribe (server/charlie-remote.ts → 'unsubscribed'); an inbound \"pause\" reply (server → 'paused'); scripts/pause-cohort.mjs --apply → 'paused'; scripts/deactivate-users.mjs --apply → 'unsubscribed'; saveDossier() default 'screening' for an unfinished draft",
    enforcedAt: "charlie-store.mjs listActiveCandidates / listNewsletterCandidates — every sweep reads through one of these",
  },
  {
    id: "suppression",
    stops: "everything, including a reply if the reason is a bounce or complaint",
    where: "suppressions table (Postgres), keyed on the ROUTING address",
    setBy: "Resend webhook on bounce/complaint (server/charlie-remote.ts); POST /unsubscribe; scripts/deactivate-users.mjs; manual insert",
    enforcedAt: "lib/send-guard.mjs — the one physical send door, so this blocks every template",
  },
  {
    id: "role_cohort",
    stops: "the role email only (daily scheduler + the day-2 first role)",
    where: "ROLE_COHORT env var, on BOTH the `charlie` and `charlie-engine` Railway services. Empty = NOBODY",
    setBy: "Railway service variables — not in the repo, not in .env.local",
    enforcedAt: "scheduler.mjs and first-role.mjs via lib/role-cohort.mjs",
  },
  {
    id: "unreachable_notify",
    stops: "everything — silently, because their OWN address looks clean",
    where: "email_config.notify points at an address that is itself in `suppressions`",
    setBy: "the user asking us to forward their mail somewhere, plus a later bounce on that forward",
    enforcedAt: "lib/unreachable-cohort.mjs (the alarm) + lib/send-guard.mjs (the block)",
  },
  {
    id: "drip_opt_out",
    stops: "every lifecycle drip (digest, nudges, market read) — NOT the role email",
    where: "email_config JSON: unsubscribed / drips_opt_out / drip_opt_out / lifecycle_opt_out / opt_out / drips",
    setBy: "no UI writes these today; they exist so a future toggle is honoured without a code change",
    enforcedAt: "drip-guard.mjs isOptedOut, called by every drip sender",
  },
  {
    id: "onboarding_grace",
    stops: "the daily role email, TEMPORARILY — by design, so the day-2 first role lands first",
    where: "ONBOARDING_GRACE_HOURS env (default 30) vs candidates.created_at",
    setBy: "env, engine service",
    enforcedAt: "scheduler.mjs — held if now - created_at < grace",
  },
  {
    id: "out_of_market",
    stops: "all roles — they get one honest note instead",
    where: "derived: homeRegion(dossier) === 'other' (a POSITIVE foreign signal)",
    setBy: "the person's own stated home place / currency, via the dossier",
    enforcedAt: "scheduler.mjs, before scoring, via quality-gate.mjs homeRegion",
  },
  {
    id: "v2_fence",
    stops: "every v1 sweep (digest, newsletter, completeness nudge)",
    where: "dossier.meta.onboarding === 'v2'",
    setBy: "markOnboardingCohort, only while ONBOARDING_V2=on",
    enforcedAt: "isV2() checks in digest.mjs, newsletter.mjs, completeness-nudge.mjs",
  },
  {
    id: "marketbrief_exclude",
    stops: "the market briefing only",
    where: "MARKETBRIEF_EXCLUDE env (comma list)",
    setBy: "Railway service variables",
    enforcedAt: "market-briefing.mjs isExcluded, checked first in every path",
  },
  {
    id: "only_email",
    stops: "EVERYONE except one address — a debugging knob left on is a whole-cohort outage",
    where: "ONLY_EMAIL env",
    setBy: "Railway service variables",
    enforcedAt: "scheduler.mjs, right after listActiveCandidates",
  },
  {
    id: "dry_run",
    stops: "every physical send, for everyone",
    where: "EMAIL_DRY_RUN=1 env",
    setBy: "Railway service variables",
    enforcedAt: "scheduler.mjs — pipeline runs, nothing goes out",
  },
];

// NOT a switch, deliberately: MATCH_BAR, the repeat guard, the daily cadence cap and the fit floor
// decide WHICH ROLE a served person gets, not WHETHER they are served. A user who is reachable and
// simply had nothing clear the bar is reported `reachable`, because the fix for them is the bar, not a
// switch. Keeping them apart stops "we chose not to mail them" hiding inside "the market was thin".

// Obvious test accounts — the same two patterns scripts/deactivate-users.mjs matches on, so a test
// address is classified the same way by both. Copied because that script defines them inside its CLI
// body; if they move to a module, import them instead.
const PLUS_TEST = /\+(ustest|test|intest|qa|dev|staging|demo|e2e|seed|sandbox)\d*@/i;
const TEST_DOMAIN = /@(example|test)\.(com|org|net|test)$/i;

/** A suppression reason that records a real, human decision rather than a config accident. */
const DELIBERATE_REASON = /^(unsubscribe|hard_bounce|bounce|complaint|admin-deactivate-test)/i;

/**
 * Evaluate one candidate against every switch. Pure: all state arrives as arguments, so the verdict
 * is reproducible and does not depend on when it ran.
 *
 * @param {object} c            candidate row (email, status, dossier, email_config, created_at)
 * @param {Map<string,string>} suppressed  address -> reason, for EVERY suppression row
 * @param {Map<string,object>} pauseSignals email -> the latest recorded pause/outcome signal
 * @param {number} now          ms epoch
 */
export function evaluateUser(c, suppressed, pauseSignals, now) {
  const email = String(c.email || "").trim().toLowerCase();
  const routing = routingAddress(c);
  const status = c.status ?? null;
  const ec = c.email_config || {};
  const blocks = [];

  // In code order. Each push is "this switch is off for this person".
  if (status !== "active") {
    blocks.push({ id: "status", detail: `candidates.status = '${status}' (only 'active' is swept)` });
  }
  const supReason = suppressed.get(routing) ?? null;
  if (supReason != null) {
    blocks.push({ id: "suppression", detail: `suppressions row on ${routing}: ${supReason}` });
  }
  if (!inRoleCohort(email)) {
    blocks.push({ id: "role_cohort", detail: `not among the ${roleCohortSize()} address(es) in ROLE_COHORT` });
  }
  // The silent one: their own address is clean, the forward is not.
  if (routing !== email && suppressed.has(routing) && !suppressed.has(email)) {
    blocks.push({ id: "unreachable_notify", detail: `mail is routed to ${routing}, which is suppressed, while ${email} itself is clean` });
  }
  if (isOptedOut(ec)) {
    blocks.push({ id: "drip_opt_out", detail: "an opt-out flag is set in email_config" });
  }
  const graceHours = Number(process.env.ONBOARDING_GRACE_HOURS || 30);
  const created = c.created_at ? new Date(c.created_at).getTime() : NaN;
  // Fail-closed age math, matching scheduler.mjs: an unparseable created_at reads as OLD, never held.
  if (graceHours > 0 && Number.isFinite(created) && now - created < graceHours * 3600_000) {
    blocks.push({ id: "onboarding_grace", detail: `signed up ${((now - created) / 3600_000).toFixed(1)}h ago, under the ${graceHours}h grace — the day-2 first role is scheduled separately` });
  }
  const region = homeRegion(c.dossier);
  if (region === "other") {
    blocks.push({ id: "out_of_market", detail: "grounded home is outside India + US — one honest note, no roles" });
  }
  if (isV2(c)) {
    blocks.push({ id: "v2_fence", detail: "dossier.meta.onboarding = 'v2' — the v1 sweeps skip them" });
  }
  if (excludedFromBriefing(email)) {
    blocks.push({ id: "marketbrief_exclude", detail: "on MARKETBRIEF_EXCLUDE — never sent the briefing" });
  }

  // What actually reaches them next run.
  const totalBlock = blocks.some((b) => b.id === "status" || b.id === "suppression" || b.id === "unreachable_notify");
  const roleBlocked = totalBlock || blocks.some((b) => ["role_cohort", "onboarding_grace", "out_of_market"].includes(b.id));
  const lifecycleBlocked = totalBlock || blocks.some((b) => ["drip_opt_out", "v2_fence"].includes(b.id));
  const receivesAnything = !roleBlocked || !lifecycleBlocked;

  // WHY they are silent, if anyone wrote it down. Absence of a reason is the finding, not a gap to
  // paper over with a guess — an unexplained silence is bucket (a) precisely because nobody decided it.
  const sig = pauseSignals.get(email) || null;
  const recordedReason =
    (supReason && supReason !== "unknown" ? supReason : null) ??
    (sig?.meta?.reason ? `signal '${sig.event}': ${sig.meta.reason}` : null) ??
    null;
  const isTestAccount = PLUS_TEST.test(email) || TEST_DOMAIN.test(email);

  // (b) on purpose — unsubscribed, bounced, a test account, or a human wrote a reason down.
  // (a) config or accident — silent with nothing recorded anywhere saying anyone chose it.
  const deliberate =
    status === "unsubscribed" ||
    isTestAccount ||
    (supReason != null && DELIBERATE_REASON.test(supReason)) ||
    Boolean(recordedReason);

  return {
    email,
    routing,
    status,
    region,
    created_at: c.created_at ?? null,
    receives_role: !roleBlocked,
    receives_lifecycle: !lifecycleBlocked,
    verdict: receivesAnything ? "RECEIVES" : "SILENT",
    blocked_by: blocks[0]?.id ?? null,
    blocked_detail: blocks[0]?.detail ?? null,
    all_blocks: blocks.map((b) => b.id),
    recorded_reason: recordedReason,
    test_account: isTestAccount,
    bucket: receivesAnything && !roleBlocked ? null : deliberate ? "b_on_purpose" : "a_config_or_accident",
    reply_still_reaches_them: supReason == null || mayReplyDespiteSuppression(supReason),
  };
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const asJson = has("--json");
  const silentOnly = has("--silent-only");

  // Fail closed on the thing most likely to make this report wrong (see the header).
  if (roleCohortSize() === 0 && !has("--allow-empty-cohort")) {
    console.error(
      "ROLE_COHORT is empty in this process, and empty means NOBODY (lib/role-cohort.mjs).\n" +
        "Running now would report every user as silenced — a confident wrong answer. It lives on Railway, not in .env.local:\n\n" +
        '  ROLE_COHORT="$(railway variables -s charlie-engine --kv | grep ^ROLE_COHORT= | cut -d= -f2-)" \\\n' +
        "    node --env-file=.env.local scripts/suppression-audit.mjs\n\n" +
        "Pass --allow-empty-cohort only if you genuinely mean 'nobody is in the cohort'.",
    );
    process.exit(2);
  }

  const s = store();
  const { data: cands, error: e1 } = await s.from("candidates").select("email, status, dossier, email_config, created_at").limit(2000);
  if (e1) throw new Error(`candidates read failed: ${e1.message}`);
  const { data: sups, error: e2 } = await s.from("suppressions").select("address, reason").limit(5000);
  if (e2) throw new Error(`suppressions read failed: ${e2.message}`);
  const { data: sigs } = await s.from("signals").select("email, event, meta, created_at").in("event", ["paused", "resumed", "outcome_reported"]).order("created_at", { ascending: true }).limit(2000);

  const suppressed = new Map((sups ?? []).map((r) => [String(r.address).trim().toLowerCase(), r.reason || "unknown"]));
  // Last write wins: a later `resumed` overrides an earlier `paused`, which is what actually happened.
  const pauseSignals = new Map();
  for (const r of sigs ?? []) pauseSignals.set(String(r.email).trim().toLowerCase(), r);

  const now = Date.now();
  const rows = (cands ?? [])
    .map((c) => evaluateUser(c, suppressed, pauseSignals, now))
    .sort((a, b) => a.verdict.localeCompare(b.verdict) || String(a.bucket).localeCompare(String(b.bucket)) || a.email.localeCompare(b.email));

  const shown = silentOnly ? rows.filter((r) => r.verdict === "SILENT" || !r.receives_role) : rows;

  if (asJson) {
    console.log(JSON.stringify({ takenAt: new Date().toISOString(), cohortSize: roleCohortSize(), switches: SWITCHES, rows: shown }, null, 2));
    return;
  }

  const pad = (v, n) => String(v ?? "").padEnd(n).slice(0, n);
  console.log(`\nSUPPRESSION AUDIT — ${new Date().toISOString()}`);
  console.log(`${rows.length} candidate(s) · ROLE_COHORT resolves to ${roleCohortSize()} address(es)\n`);
  console.log(`${pad("EMAIL", 38)} ${pad("STATUS", 13)} ${pad("ROLE", 5)} ${pad("LIFE", 5)} ${pad("FIRST BLOCKER", 20)} ${pad("BUCKET", 20)} REASON ON RECORD`);
  console.log("-".repeat(150));
  for (const r of shown) {
    console.log(
      `${pad(r.email, 38)} ${pad(r.status, 13)} ${pad(r.receives_role ? "yes" : "NO", 5)} ${pad(r.receives_lifecycle ? "yes" : "NO", 5)} ${pad(r.blocked_by ?? "-", 20)} ${pad(r.bucket ?? "-", 20)} ${r.recorded_reason ?? (r.receives_role ? "" : "— none —")}`,
    );
  }

  const served = rows.filter((r) => r.receives_role);
  const a = rows.filter((r) => r.bucket === "a_config_or_accident");
  const b = rows.filter((r) => r.bucket === "b_on_purpose");
  const byBlocker = {};
  for (const r of rows) if (!r.receives_role) byBlocker[r.blocked_by] = (byBlocker[r.blocked_by] || 0) + 1;

  console.log(`\n── summary ──`);
  console.log(`served a role next run:            ${served.length}`);
  console.log(`(a) no recorded reason:            ${a.length}`);
  console.log(`(b) on purpose:                    ${b.length}`);
  console.log(`first blocker:                     ${JSON.stringify(byBlocker)}`);

  const cohortWithoutRow = [...new Set(String(process.env.ROLE_COHORT || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))]
    .filter((addr) => !rows.some((r) => r.email === addr));
  if (cohortWithoutRow.length) console.log(`\nROLE_COHORT addresses with NO candidate row (${cohortWithoutRow.length}): ${cohortWithoutRow.join(", ")}`);

  if (has("--proposed-cohort")) {
    // Everyone already served, plus bucket (a) — never bucket (b), never an address with no row.
    const expanded = [...new Set([...served.map((r) => r.email), ...a.map((r) => r.email)])].sort();
    console.log(`\n── proposed ROLE_COHORT (${expanded.length} address(es); today ${roleCohortSize()}) ──\n${expanded.join(",")}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`[suppression-audit] fatal: ${e.message}`);
  process.exit(1);
});
