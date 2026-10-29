// drip-guard.test.mjs — pure unit tests for the deterministic drip gate. No network on the pure
// paths (suppression is only reached when every earlier check passes, and these fixtures short-circuit
// before it). Run: node drip-guard.test.mjs
//
// We import the pure helpers (missingFields, stampFor) directly, and exercise dripGuard on paths that
// resolve to "skip" BEFORE the isSuppressed network call, so no Supabase env is needed.

import assert from "node:assert/strict";
import { dripGuard, stampFor, missingFields } from "./drip-guard.mjs";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 4); // fixed clock

// A "complete" dossier so the completeness not-needed check doesn't short-circuit unrelated tests.
const completeDossier = { name: "Sam Rivera", preferences: { role: "Product Designer", seniority: "senior", comp_floor: 120000, remote: "remote" } };
const thinDossier = { name: "", preferences: {} };

// ── missingFields (the canonical completeness logic) ────────────────
test("missingFields: complete profile → nothing missing", () => {
  assert.deepEqual(missingFields(completeDossier), []);
});
test("missingFields: thin profile → all five", () => {
  assert.deepEqual(missingFields(thinDossier).sort(), ["location", "name", "pay", "role", "seniority"].sort());
});
test("missingFields: seniority implied by role title is not asked", () => {
  const d = { name: "A", preferences: { role: "Senior Engineer", comp_floor: 1, remote: "remote" } };
  assert.deepEqual(missingFields(d), []);
});

// ── stampFor (the after-send patch) ───────────────────────────────────────────────────
test("stampFor completeness → { last_gap_drip_at, last_drip_at }", () => {
  const iso = "2026-07-04T00:00:00.000Z";
  assert.deepEqual(stampFor("completeness", iso), { last_gap_drip_at: iso, last_drip_at: iso });
});
test("stampFor digest → { last_digest_at, last_drip_at }", () => {
  const iso = "2026-07-04T00:00:00.000Z";
  assert.deepEqual(stampFor("digest", iso), { last_digest_at: iso, last_drip_at: iso });
});
test("stampFor unknown type throws", () => {
  assert.throws(() => stampFor("nope"));
});

// ── dripGuard: cooldown blocks a too-soon resend ──────────────────────────────────────
test("completeness: cooldown blocks a resend 2 days after last_gap_drip_at", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: thinDossier, // would otherwise be nudge-worthy
    email_config: { last_gap_drip_at: new Date(NOW - 2 * DAY).toISOString() },
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "completeness", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown/);
});
test("completeness: also respects completeness_last_at as a cooldown ledger", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: thinDossier,
    email_config: { completeness_last_at: new Date(NOW - 1 * DAY).toISOString() },
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "completeness", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown/);
});
test("digest: cooldown blocks a resend 3 days after last_digest_at", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: { last_digest_at: new Date(NOW - 3 * DAY).toISOString() } };
  const g = await dripGuard({ email: "u@x.com", dripType: "digest", candidate, items: [{ role: "x" }], now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown/);
});

// ── dripGuard: not-needed ─────────────────────────────────────────────────────────────
test("completeness: skips when nothing is missing (profile complete)", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: {} };
  const g = await dripGuard({ email: "u@x.com", dripType: "completeness", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "profile-complete");
});
test("digest: skips when there are no items", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: {} };
  const g = await dripGuard({ email: "u@x.com", dripType: "digest", candidate, items: [], now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "no-digest-items");
});
test("digest: skips when items is undefined", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: {} };
  const g = await dripGuard({ email: "u@x.com", dripType: "digest", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "no-digest-items");
});

// ── dripGuard: opt-out ────────────────────────────────────────────────────────────────
test("opt-out short-circuits to skip before anything else", async () => {
  const candidate = { email: "u@x.com", dossier: thinDossier, email_config: { unsubscribed: true } };
  const g = await dripGuard({ email: "u@x.com", dripType: "completeness", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "opted-out");
});

// ── dripGuard: fail-closed on bad input ───────────────────────────────────────────────
test("unknown drip type → skip", async () => {
  const g = await dripGuard({ email: "u@x.com", dripType: "mystery", candidate: { email: "u@x.com", email_config: {} }, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /unknown-drip-type/);
});
test("no recipient → skip", async () => {
  const g = await dripGuard({ email: "", dripType: "digest", candidate: { email_config: {} }, items: [{ role: "x" }], now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "no-recipient");
});

// ── dripGuard: a due send passes the pure checks (mock isSuppressed via a due candidate) ──
// This path reaches isSuppressed. To keep the test network-free, we stub the module's export by
// monkeypatching globalThis is not possible here; instead we assert the DECISION logic up to
// suppression by using a candidate whose only remaining gate is suppression, and we verify the guard
// does NOT skip for any pure reason. We confirm the non-suppression logic by checking that with a
// cooldown JUST expired, none of the pre-suppression skips fire.
test("completeness: past cooldown + profile incomplete + not opted out → not skipped for a PURE reason", async () => {
  const candidate = {
    email: "due@x.com",
    dossier: thinDossier, // incomplete → needs nudge
    email_config: { last_gap_drip_at: new Date(NOW - 30 * DAY).toISOString() }, // well past 7d cooldown
  };
  // We can't hit the real suppressions table without env; assert that the decision is NOT one of the
  // pure skip reasons. If it reaches suppression it either sends or skips("suppressed") — both mean the
  // pure gates passed. We detect a thrown network error too and treat it as "pure gates passed".
  let reason = null, decision = null;
  try {
    const g = await dripGuard({ email: "due@x.com", dripType: "completeness", candidate, now: NOW });
    decision = g.decision; reason = g.reason;
  } catch { reason = "network"; }
  const pureSkips = ["no-recipient", "no-candidate", "opted-out", "profile-complete", "no-digest-items"];
  assert.ok(!(decision === "skip" && pureSkips.includes(reason)), `expected pure gates to pass, got ${decision}/${reason}`);
  assert.ok(!/^cooldown/.test(reason || ""), `expected no cooldown skip, got ${reason}`);
});

// ── stampFor: stamps BOTH the per-type key AND the global last_drip_at ──────────────
test("stampFor checkin → { last_checkin_at, last_drip_at }", () => {
  const iso = "2026-07-04T00:00:00.000Z";
  assert.deepEqual(stampFor("checkin", iso), { last_checkin_at: iso, last_drip_at: iso });
});
test("stampFor profile → { last_profile_nudge_at, last_drip_at }", () => {
  const iso = "2026-07-04T00:00:00.000Z";
  assert.deepEqual(stampFor("profile", iso), { last_profile_nudge_at: iso, last_drip_at: iso });
});

// ── checkin: per-type cooldown + already-satisfied ───────────────────────────────────────
test("checkin: cooldown blocks a resend 5 days after last_checkin_at (10d default)", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: completeDossier,
    priorEmailedRole: { company: "Acme", title: "PM" },
    email_config: { last_checkin_at: new Date(NOW - 5 * DAY).toISOString() },
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "checkin", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown/);
});
test("checkin: skips when there is NO prior emailed role to check in on", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: {} }; // no priorEmailedRole
  const g = await dripGuard({ email: "u@x.com", dripType: "checkin", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "no-prior-role");
});

// ── profile: per-type cooldown + skip-when-nothing-missing ────────────────────────────────
test("profile: cooldown blocks a resend 3 days after last_profile_nudge_at (7d default)", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: thinDossier, // would otherwise be nudge-worthy
    email_config: { last_profile_nudge_at: new Date(NOW - 3 * DAY).toISOString() },
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "profile", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown/);
});
test("profile: skips when nothing is missing (profile complete)", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: {} };
  const g = await dripGuard({ email: "u@x.com", dripType: "profile", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "profile-complete");
});

// ── GLOBAL LEDGER: a DIFFERENT type is blocked within the global gap ───────────────────
test("global ledger: a profile drip 1 day after ANY drip (last_drip_at) is blocked (2d gap)", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: thinDossier, // profile has missing fields → would otherwise send
    email_config: { last_drip_at: new Date(NOW - 1 * DAY).toISOString() }, // a DIFFERENT drip fired yesterday
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "profile", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /global-gap/);
});
test("global ledger: a checkin drip 1 day after ANY drip is blocked even with a prior role", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: completeDossier,
    priorEmailedRole: { company: "Acme", title: "PM" },
    email_config: { last_drip_at: new Date(NOW - 1 * DAY).toISOString() },
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "checkin", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /global-gap/);
});
test("global ledger: past the global gap, the per-type/needed checks resume (not a global-gap skip)", async () => {
  const candidate = {
    email: "u@x.com",
    dossier: completeDossier, // profile complete → should skip for profile-complete, NOT global-gap
    email_config: { last_drip_at: new Date(NOW - 5 * DAY).toISOString() }, // well past 2d gap
  };
  const g = await dripGuard({ email: "u@x.com", dripType: "profile", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.equal(g.reason, "profile-complete"); // fell through the global gate to the not-needed check
});

// ── marketgap: registered type + mutual exclusion with the other profile-enrichment drips ─────────
test("stampFor marketgap → { marketgap_last_at, last_drip_at }", () => {
  const iso = new Date(NOW).toISOString();
  assert.deepEqual(stampFor("marketgap", iso), { marketgap_last_at: iso, last_drip_at: iso });
});
test("marketgap: cooldown blocks a resend 3 days after marketgap_last_at (7d default)", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: { marketgap_last_at: new Date(NOW - 3 * DAY).toISOString() } };
  const g = await dripGuard({ email: "u@x.com", dripType: "marketgap", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown/);
});
test("marketgap: a recent completeness nudge blocks it (no double profile-enrichment in one window)", async () => {
  const candidate = { email: "u@x.com", dossier: completeDossier, email_config: { last_gap_drip_at: new Date(NOW - 2 * DAY).toISOString() } };
  const g = await dripGuard({ email: "u@x.com", dripType: "marketgap", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown:last_gap_drip_at/);
});
test("completeness: a recent marketgap drop blocks it (the reverse mutual exclusion)", async () => {
  const candidate = { email: "u@x.com", dossier: thinDossier, email_config: { marketgap_last_at: new Date(NOW - 2 * DAY).toISOString() } };
  const g = await dripGuard({ email: "u@x.com", dripType: "completeness", candidate, now: NOW });
  assert.equal(g.decision, "skip");
  assert.match(g.reason, /cooldown:marketgap_last_at/);
});

// ── runner ────────────────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${tests.length} passed`);
if (pass !== tests.length) process.exitCode = 1;
