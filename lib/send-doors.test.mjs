// send-doors.test.mjs — who is allowed to call Resend directly.
//
// The rule: a grep for `resend.emails.send` outside lib/send-guard.mjs must find only owner canaries
// and the named operator send tools below — never a new automated send path. Written down, that rule
// is not enforcement; this is the grep, run in CI.
//
// The bar for adding a line here is not "it compiles". It is: does this send reach ONLY a mailbox we
// control, and would routing it through sendGuarded be wrong rather than merely inconvenient? For an
// ops report the answer is yes — suppression would silence the alert that says something is broken,
// and idempotency would swallow the second run of the day. For anything reaching a candidate the
// answer is always no: that is what lib/send-guard.mjs exists for.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file permitted to call Resend directly, each with the reason it is not behind the guard. */
const ALLOWED = new Map([
  ["lib/send-guard.mjs", "THE door. Every user-facing send goes through it: suppression, sent_emails idempotency, then the physical send."],
  ["lib/schemas/resend-send.mjs", "the Zod schema for the send payload; it validates, it does not send."],
  ["presend-guard.mjs", "the send gate itself, which sits immediately in front of the door."],
  ["health-check.mjs", "owner canary — alerts one owner mailbox when a check fails. Never reaches a candidate."],
  ["preflight.mjs", "owner canary — alerts the owner before a run starts. Never reaches a candidate."],
  ["watchdog.mjs", "owner canary — alerts the owner about leaks and drift. Never reaches a candidate."],
  ["run-charlie.mjs", "owner canary — the hand-run local pipeline, owner mailbox only."],
  ["sweep.mjs", "owner canary — the twice-daily sweep's ops report to one owner mailbox. Not behind the guard on purpose: suppression would silence an alert saying something is broken, and idempotency would swallow the second run of the day."],
  ["server/charlie-remote.ts", "the email server. Its user-facing paths route through sendGuarded; the direct references are the transport underneath."],
  ["scripts/send-india-first.mjs", "documented guard-exempt debug tool — operator sends to a controlled alias."],
  ["scripts/send-profile-nudge.mjs", "documented guard-exempt debug tool — operator sends to a controlled alias."],
  ["scripts/send-us-roundup.mjs", "documented guard-exempt debug tool — operator sends to a controlled alias."],
]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".claude", "dist", "build", "coverage", "job-pool"]);

function* sourceFiles(dir = ROOT, rel = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* sourceFiles(path, relPath);
    else if (/\.(mjs|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield [relPath, path];
  }
}

describe("only named doors may call Resend directly", () => {
  const callers = [...sourceFiles()]
    .filter(([, abs]) => /emails\s*\.\s*send/.test(readFileSync(abs, "utf8")))
    .map(([rel]) => rel);

  it("finds the send sites at all (the grep still works)", () => {
    // If this ever returns nothing, the pattern has drifted and every assertion below is vacuous.
    expect(callers.length).toBeGreaterThan(5);
    expect(callers).toContain("lib/send-guard.mjs");
  });

  it("has no unlisted caller", () => {
    const unlisted = callers.filter((f) => !ALLOWED.has(f));
    expect(unlisted, `these call Resend directly and are not named in ALLOWED: ${unlisted.join(", ")}. ` +
      `If it reaches a candidate it belongs behind lib/send-guard.mjs (sendGuarded). If it is an owner ` +
      `canary, add it here WITH the reason it cannot go through the guard.`).toEqual([]);
  });

  it("lists nothing that has since stopped sending", () => {
    // A stale exemption is a hole nobody remembers opening.
    const stale = [...ALLOWED.keys()].filter((f) => existsSync(join(ROOT, f)) && !callers.includes(f));
    expect(stale, `named as send doors but no longer send: ${stale.join(", ")}`).toEqual([]);
  });

  it("gives every exemption a real reason", () => {
    for (const [f, why] of ALLOWED) {
      expect(String(why).length, `${f} is exempt with no reason given`).toBeGreaterThan(30);
    }
  });
});
