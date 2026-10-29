// preflight.test.mjs — unit tests for preflight's PURE checks (no network, no real API calls).
// Also exercises the fail-closed semantics added to the quality gate (ambiguous liveness → digest)
// and the grounding hold (a held role is a clean skip, not a crash). Run:
//   node preflight.test.mjs      # exits non-zero on any failure
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { checkGuardLogic, checkRequiredEnv, assessPoolFreshness, assessAnthropicResult } from "./preflight.mjs";
import { gateRole, checkLiveness } from "./quality-gate.mjs";
import { shouldHold } from "./grounding-verify.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// ── preflight: guard-logic assertion (the known leak shapes block, legit passes) ─────────────────
t("preflight guard-logic check passes on an intact guard", () => {
  const r = checkGuardLogic();
  assert.ok(r.ok === true, `expected ok, got ${JSON.stringify(r)}`);
});

// ── preflight: required-env check ─────────────────────────────────────────────────────────────
t("env check PASSES when all four vars are present and non-trivial", () => {
  const r = checkRequiredEnv({
    ANTHROPIC_API_KEY: "sk-ant-" + "x".repeat(40),
    SUPABASE_SERVICE_ROLE_KEY: "ey" + "y".repeat(40),
    RESEND_API_KEY: "re_" + "z".repeat(20),
    CHARLIE_FROM: "charlie@mail.example.com",
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
t("env check FAILS (fail-closed) when a key is missing", () => {
  const r = checkRequiredEnv({ SUPABASE_SERVICE_ROLE_KEY: "ey" + "y".repeat(40), RESEND_API_KEY: "re_" + "z".repeat(20), CHARLIE_FROM: "a@b.com" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes("ANTHROPIC_API_KEY"), JSON.stringify(r.missing));
});
t("env check FAILS on a trivial/blank key value", () => {
  const r = checkRequiredEnv({ ANTHROPIC_API_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "  ", RESEND_API_KEY: "", CHARLIE_FROM: "" });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(new Set(r.missing), new Set(["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "CHARLIE_FROM"]));
});

// ── preflight: pool freshness (pure, no network) ──────────────────────────────────────────────
const NOW = Date.parse("2026-07-04T13:00:00Z");
t("freshness: a pool scanned 2h ago is FRESH (well within the 48h window)", () => {
  const r = assessPoolFreshness(NOW, new Date(NOW - 2 * 3.6e6).toISOString());
  assert.strictEqual(r.fresh, true, JSON.stringify(r));
});
t("freshness: a pool scanned 60h ago is STALE (past the 48h default)", () => {
  const r = assessPoolFreshness(NOW, new Date(NOW - 60 * 3.6e6).toISOString());
  assert.strictEqual(r.fresh, false, JSON.stringify(r));
});
t("freshness: exactly at the threshold is still FRESH (<=, not <)", () => {
  const r = assessPoolFreshness(NOW, new Date(NOW - 48 * 3.6e6).toISOString(), 48);
  assert.strictEqual(r.fresh, true, JSON.stringify(r));
});
t("freshness: unknown/missing scan-time is STALE (fail-closed, never assume fresh)", () => {
  assert.strictEqual(assessPoolFreshness(NOW, null).fresh, false);
  assert.strictEqual(assessPoolFreshness(NOW, undefined).fresh, false);
  assert.strictEqual(assessPoolFreshness(NOW, "not-a-date").fresh, false);
});
t("freshness: accepts a ms-epoch timestamp too", () => {
  assert.strictEqual(assessPoolFreshness(NOW, NOW - 1 * 3.6e6).fresh, true);
});

// ── preflight: Anthropic reachability parsing (pure, no network) ──────────────────────────────
t("anthropic: HTTP 200 → ok (key valid, API up)", () => {
  assert.strictEqual(assessAnthropicResult({ status: 200 }).ok, true);
});
t("anthropic: HTTP 401 → fail (bad key)", () => {
  assert.strictEqual(assessAnthropicResult({ status: 401 }).ok, false);
});
t("anthropic: HTTP 403 → fail (blocked key)", () => {
  assert.strictEqual(assessAnthropicResult({ status: 403 }).ok, false);
});
t("anthropic: a network/timeout error → fail-closed (cannot confirm reachability)", () => {
  assert.strictEqual(assessAnthropicResult({ errorMessage: "timeout (>8s)" }).ok, false);
});
t("anthropic: an unexpected status (500) → fail-closed", () => {
  assert.strictEqual(assessAnthropicResult({ status: 500 }).ok, false);
});

// ── quality-gate: liveness retry + ambiguous → digest (fail-closed, not a hard drop) ──────────
// A checkable source (greenhouse) whose fetch always throws (network down) → after retries, ambiguous.
await ta("checkLiveness: network error on a checkable source → ambiguous (not a confident live/dead)", async () => {
  const alwaysThrows = async () => { throw new Error("ECONNRESET"); };
  const r = await checkLiveness({ id: "greenhouse:acme:123" }, alwaysThrows);
  assert.strictEqual(r.ok, false, "must not report live");
  assert.strictEqual(r.ambiguous, true, "must be ambiguous (couldn't confirm)");
});
await ta("checkLiveness: confirmed 404 on a checkable source → closed (drop), NOT ambiguous", async () => {
  const notFound = async () => ({ status: 404, json: async () => ({}), text: async () => "" });
  const r = await checkLiveness({ id: "greenhouse:acme:123" }, notFound);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ambiguous, "a confirmed 404 is a real close, not ambiguous");
});
await ta("checkLiveness: confirmed 200 on a checkable source → live (must still SEND)", async () => {
  const ok = async () => ({ status: 200, json: async () => ({}), text: async () => "" });
  const r = await checkLiveness({ id: "lever:acme:123" }, ok);
  assert.strictEqual(r.ok, true);
});

await ta("gateRole: ambiguous liveness routes to DIGEST (never drop, never confident send)", async () => {
  const alwaysThrows = async () => { throw new Error("ETIMEDOUT"); };
  const g = await gateRole({
    job: { id: "greenhouse:acme:123", location: "Remote", remote: true },
    dossier: { headline: "Engineer in Bengaluru" },
    matcherScore: 90,
    getCov: async () => ({ thin: true }),
    fetchImpl: alwaysThrows,
  });
  assert.strictEqual(g.outcome, "digest", `expected digest, got ${JSON.stringify(g)}`);
});
await ta("gateRole: a healthy live+reachable role still SENDS (no over-restriction)", async () => {
  const ok = async () => ({ status: 200, json: async () => ({}), text: async () => "" });
  const g = await gateRole({
    job: { id: "greenhouse:acme:123", location: "Bengaluru, India" },
    dossier: { headline: "Engineer in Bengaluru" },
    matcherScore: 90,
    getCov: async () => ({ thin: true }),
    fetchImpl: ok,
  });
  assert.strictEqual(g.outcome, "send", `expected send, got ${JSON.stringify(g)}`);
});

// ── grounding-verify: hold semantics (enforce by default) — a held role is a clean skip ───────
t("shouldHold: high-severity violation is HELD in enforce (default) mode", () => {
  const prev = process.env.VERIFY_MODE; delete process.env.VERIFY_MODE; // default = enforce
  try { assert.strictEqual(shouldHold({ ok: false, severity: "high", violations: [{}] }), true); }
  finally { if (prev !== undefined) process.env.VERIFY_MODE = prev; }
});
t("shouldHold: a verifier ERROR is uncertainty → HELD (never send unverified)", () => {
  const prev = process.env.VERIFY_MODE; delete process.env.VERIFY_MODE;
  try { assert.strictEqual(shouldHold({ ok: false, errored: true }), true); }
  finally { if (prev !== undefined) process.env.VERIFY_MODE = prev; }
});
t("shouldHold: a clean/none verdict is NOT held (legit send proceeds)", () => {
  const prev = process.env.VERIFY_MODE; delete process.env.VERIFY_MODE;
  try { assert.strictEqual(shouldHold({ ok: true, severity: "none", violations: [] }), false); }
  finally { if (prev !== undefined) process.env.VERIFY_MODE = prev; }
});
t("shouldHold: a skipped verdict (nothing to check) is NOT held (avoids over-suppression)", () => {
  const prev = process.env.VERIFY_MODE; delete process.env.VERIFY_MODE;
  try { assert.strictEqual(shouldHold({ ok: true, skipped: true, severity: "none" }), false); }
  finally { if (prev !== undefined) process.env.VERIFY_MODE = prev; }
});
t("shouldHold: log mode disables holds (opt-out escape hatch)", () => {
  const prev = process.env.VERIFY_MODE; process.env.VERIFY_MODE = "log";
  try { assert.strictEqual(shouldHold({ ok: false, severity: "high" }), false); }
  finally { if (prev !== undefined) process.env.VERIFY_MODE = prev; else delete process.env.VERIFY_MODE; }
});
// A held role is a SKIP, not a crash: shouldHold is a pure boolean the scheduler branches on
// (skipped++, continue). This asserts the contract stays a plain boolean (never throws).
t("shouldHold: never throws on a malformed/empty result (held-role path can't crash the run)", () => {
  assert.doesNotThrow(() => shouldHold(undefined));
  assert.doesNotThrow(() => shouldHold(null));
  assert.doesNotThrow(() => shouldHold({}));
});

// ── cron ordering: the pool gate must run AFTER the scanner ──────────────────────────────────
// The pool-freshness check aborts the chain when the pool is stale, and scan-jobs is the ONLY thing
// that refreshes it. If the gate runs BEFORE the scan, a stale pool can never recover — it aborts
// the scan that would have fixed it, ages another day, and fails harder, killing the daily send.
// This asserts the ORDER in the real cron chain, because a comment cannot enforce it.
t("engine:run runs scan-jobs BEFORE the pre-send pool gate (no stale-pool deadlock)", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const chain = pkg.scripts["engine:run"];
  assert.ok(chain, "engine:run script must exist");

  const scanAt = chain.indexOf("scan-jobs.mjs");
  const preSendAt = chain.indexOf("--phase=pre-send");
  const preScanAt = chain.indexOf("--phase=pre-scan");

  assert.ok(scanAt !== -1, "engine:run must run scan-jobs.mjs");
  assert.ok(preScanAt !== -1, "engine:run must run preflight --phase=pre-scan");
  assert.ok(preSendAt !== -1, "engine:run must run preflight --phase=pre-send");
  assert.ok(preScanAt < scanAt, "pre-scan preflight must run before the scanner");
  assert.ok(scanAt < preSendAt, "the pool gate (--phase=pre-send) must run AFTER scan-jobs, never before it");
  assert.ok(preSendAt < chain.indexOf("scheduler.mjs"), "the pool gate must run before the scheduler sends");
});
// The pre-scan phase must NOT contain a pool check — that is the whole point of the split.
await ta("preflight --phase=pre-scan does not gate on the job pool", async () => {
  const src = readFileSync(new URL("./preflight.mjs", import.meta.url), "utf8");
  const preScanBlock = src.slice(src.indexOf("if (wants(PRE_SCAN))"), src.indexOf("if (wants(PRE_SEND))"));
  assert.ok(!/checkPool\(|checkPoolFreshness\(/.test(preScanBlock), "pool checks must live in the pre-send phase only");
});

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
