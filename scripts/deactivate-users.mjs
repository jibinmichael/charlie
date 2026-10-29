// deactivate-users.mjs — take dead or test accounts out of the scanned and emailed pool, reversibly.
//
// The engine, the matcher and the watchdogs only touch candidates with status='active'
// (listActiveCandidates, watchdog.mjs), so retiring an account means flipping its status, not
// deleting the row: finds has a FK to candidates and deletion is irreversible (forget_me is the only
// delete path).
//
// For each matched account: status -> 'unsubscribed' AND the address goes on the suppressions
// (do-not-send) list, so even a bug cannot scan or email it. --reactivate undoes both.
//
// Dry run by DEFAULT: prints every match and its reason, changes nothing. The owner inbox
// (OWNER_EMAIL) is never matched. Nothing is written without --apply.
//
//   node scripts/deactivate-users.mjs --list                # show EVERY candidate (email/status/created), change nothing
//   node scripts/deactivate-users.mjs                       # DRY RUN: show test-pattern matches
//   node scripts/deactivate-users.mjs a@b.com c@d.com       # DRY RUN: pattern matches + these exact emails
//   node scripts/deactivate-users.mjs --apply               # actually deactivate + suppress the matches
//   node scripts/deactivate-users.mjs --reactivate a@b.com  # UNDO: status active + un-suppress
//   node scripts/deactivate-users.mjs --owner x@y.com       # extend the protected owner set
//
// Exit code is non-zero on any per-record error so it can gate a script.

import { loadEnv, store, setCandidateStatus, suppressAddress, unsuppressAddress, readAll } from "../charlie-store.mjs";

loadEnv();
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const APPLY = has("--apply");
const REACTIVATE = has("--reactivate");
const LIST = has("--list");
const DEACTIVATED_STATUS = "unsubscribed";

// The owner's inbox (OWNER_EMAIL) is never matched and never touched. Protect further addresses
// with --owner.
const OWNER = new Set([String(process.env.OWNER_EMAIL || "").toLowerCase()].filter(Boolean));
if (val("--owner")) OWNER.add(String(val("--owner")).trim().toLowerCase());

// Explicit emails passed as bare args (not flags, not the value of a flag) are ALWAYS targeted —
// this is your manual "these specific dead accounts" list, on top of the pattern.
const FLAG_VALUES = new Set([val("--owner")].filter(Boolean));
const explicit = argv
  .filter((a) => !a.startsWith("--") && !FLAG_VALUES.has(a))
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

// TEST-ALIAS PATTERNS — obvious test accounts only. Eyeball these; the dry-run shows every match.
//  (a) plus-alias test tags:  foo+ustest2@example.com, foo+test@…, foo+qa1@…
//  (b) throwaway test domains: someone@example.com, x@test.test
const PLUS_TEST = /\+(ustest|test|intest|qa|dev|staging|demo|e2e|seed|sandbox)\d*@/i;
const TEST_DOMAIN = /@(example|test)\.(com|org|net|test)$/i;

function classify(email) {
  const e = String(email || "").trim().toLowerCase();
  if (OWNER.has(e)) return { hit: false, reason: "OWNER — protected" };
  if (explicit.includes(e)) return { hit: true, reason: "explicit (passed on the command line)" };
  if (PLUS_TEST.test(e)) return { hit: true, reason: `test +alias (${e.match(PLUS_TEST)[1]})` };
  if (TEST_DOMAIN.test(e)) return { hit: true, reason: "test domain" };
  return { hit: false, reason: "" };
}

// ── reactivate (undo) ─────────────────────────────────────────────────────────
if (REACTIVATE) {
  const emails = explicit;
  if (!emails.length) { console.error("--reactivate needs one or more emails: node scripts/deactivate-users.mjs --reactivate a@b.com"); process.exit(2); }
  let ok = 0, fail = 0;
  for (const e of emails) {
    if (OWNER.has(e)) { console.log(`skip ${e} (owner)`); continue; }
    try {
      await setCandidateStatus(e, "active");
      await unsuppressAddress(e);
      console.log(`reactivated ${e} — status='active', suppression cleared`);
      ok++;
    } catch (err) { console.error(`FAILED ${e}: ${err.message}`); fail++; }
  }
  console.log(`\ndone: ${ok} reactivated, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

// ── read the pool ───────────────────────────────────────────────────────────
const cands = await readAll("candidates", "email,status,created_at");
const error = null;
if (error) { console.error(`candidates read failed: ${error.message}`); process.exit(2); }

// ── --list: show everyone so you can copy exact emails (read-only) ─────────────
if (LIST) {
  const rows = [...(cands || [])].sort((a, b) => String(a.email).localeCompare(String(b.email)));
  console.log(`\n${rows.length} candidates (read-only, nothing changed):\n`);
  for (const c of rows) {
    const tag = OWNER.has(String(c.email).toLowerCase()) ? "  <- OWNER (protected)" : (classify(c.email).hit ? `  <- would match: ${classify(c.email).reason}` : "");
    console.log(`  ${String(c.email).padEnd(40)} status=${String(c.status || "?").padEnd(12)} ${String(c.created_at || "").slice(0, 10)}${tag}`);
  }
  console.log(`\nPick the ones to move, then: node scripts/deactivate-users.mjs <email> <email> …  (dry run), then add --apply.`);
  process.exit(0);
}

const matched = [];
const kept = [];
for (const c of cands || []) {
  const { hit, reason } = classify(c.email);
  (hit ? matched : kept).push({ ...c, reason });
}

console.log(`\npool: ${cands.length} candidates · ${matched.length} matched for deactivation · ${kept.length} kept\n`);

if (!matched.length) {
  console.log("no test/dead accounts matched. (pass exact emails as args to target specific ones.)");
  process.exit(0);
}

console.log("WILL DEACTIVATE + SUPPRESS:");
for (const m of matched) {
  const already = m.status === DEACTIVATED_STATUS ? "  [already unsubscribed]" : "";
  console.log(`  ${m.email.padEnd(38)} status=${(m.status || "?").padEnd(12)} ${m.reason}${already}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing changed. Re-run with --apply to deactivate + suppress the ${matched.length} above.`);
  console.log("Undo any time:  node scripts/deactivate-users.mjs --reactivate <email>");
  process.exit(0);
}

// ── apply ─────────────────────────────────────────────────────────────────────
console.log(`\n--apply: deactivating + suppressing ${matched.length} account(s)...\n`);
let ok = 0, fail = 0;
for (const m of matched) {
  if (OWNER.has(m.email)) { console.log(`skip ${m.email} (owner)`); continue; } // defense in depth
  try {
    await setCandidateStatus(m.email, DEACTIVATED_STATUS); // out of the scan + email pool
    await suppressAddress(m.email, "admin-deactivate-test"); // hard do-not-send
    console.log(`deactivated ${m.email} — status='${DEACTIVATED_STATUS}' + suppressed`);
    ok++;
  } catch (err) { console.error(`FAILED ${m.email}: ${err.message}`); fail++; } // isolate each record
}
console.log(`\ndone: ${ok} deactivated, ${fail} failed. Undo: node scripts/deactivate-users.mjs --reactivate <email>`);
process.exit(fail ? 1 : 0);
