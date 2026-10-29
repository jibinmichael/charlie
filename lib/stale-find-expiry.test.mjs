// stale-find-expiry.test.mjs — a send that never happened must not block that role forever.
//
// scheduler.mjs writes the find as 'new' BEFORE the send and flips it to 'emailed' after. If the repeat
// guard counted every 'new' row as a prior send, any send that failed, was held, or died with the
// container would leave a row answering "already sent this posting" on every later run: a role offered
// to nobody and then permanently unofferable.
//
// Two halves prevent that, and this file guards both:
//   1. AGE — signaturesFromRows ignores a 'new' row older than STALE_NEW_HOURS (behavioural tests).
//   2. STATUS — a caught failure is recorded as 'send_failed', which the signature reader does not
//      read and the watchdog DOES count as stuck (static-source tests, because the failure is a
//      mismatch BETWEEN files and no single-file test can see it).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signaturesFromRows, STALE_NEW_HOURS, canonicalJobIdentity } from "../charlie-store.mjs";
import { repeatDecision } from "../presend-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// The production row shape: a role prepared for a user and never sent.
const JOB = { company: "Examplecorp", title: "Senior Product Manager", apply_url: "https://jobs.smartrecruiters.com/examplecorp/6000000001266744" };
const NOW = Date.parse("2026-07-30T06:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const row = (status, h, extra = {}) => ({ id: `u@example.com:smartrecruiters:examplecorp:6000000001266744`, job: JOB, status, created_at: hoursAgo(h), ...extra });

describe("a find stuck at 'new' expires out of the repeat guard", () => {
  it("BLOCKS a 'new' find that is still in flight (1h old)", () => {
    // The in-flight guarantee: within a run, and across the
    // paths that run minutes apart in the same engine chain (scheduler then digest), 'new' still means
    // "hands off". Without this a single run could send the same posting twice.
    const sig = signaturesFromRows([row("new", 1)], { now: NOW });
    expect(sig.staleNew).toEqual([]);
    expect(repeatDecision(JOB, sig)?.rule).toBe("repeat:identity");
  });

  it("still BLOCKS at the last hour inside the window", () => {
    const sig = signaturesFromRows([row("new", STALE_NEW_HOURS - 0.5)], { now: NOW });
    expect(repeatDecision(JOB, sig)).not.toBeNull();
  });

  it("RELEASES a 'new' find that outlived the window", () => {
    // The role a person was never sent comes back into play instead of being blocked forever.
    const sig = signaturesFromRows([row("new", STALE_NEW_HOURS + 1)], { now: NOW });
    expect(sig.staleNew).toEqual(["u@example.com:smartrecruiters:examplecorp:6000000001266744"]);
    expect(sig.identities.has(canonicalJobIdentity(JOB))).toBe(false);
    expect(repeatDecision(JOB, sig)).toBeNull();
  });

  it("RELEASES production-shaped rows a day and a month old, never delivered", () => {
    const rows = [
      { id: "u@example.com:smartrecruiters:examplecorp:6000000001266744", job: JOB, status: "new", created_at: "2026-07-29T05:11:01.626979+00:00" },
      { id: "u@example.com:ashby:acme:x", job: { company: "Acme", title: "PM", apply_url: "https://jobs.ashbyhq.com/acme/x" }, status: "new", created_at: "2026-06-28T13:30:00.000Z" },
    ];
    const sig = signaturesFromRows(rows, { now: NOW });
    expect(sig.staleNew).toHaveLength(2);
    expect(repeatDecision(JOB, sig)).toBeNull();
  });

  it("NEVER releases an 'emailed' find, however old", () => {
    // The unbreakable rule. A delivered role is blocked forever; only 'new' has a clock.
    const sig = signaturesFromRows([row("emailed", 24 * 365)], { now: NOW });
    expect(sig.staleNew).toEqual([]);
    expect(repeatDecision(JOB, sig)?.rule).toBe("repeat:identity");
  });

  it("NEVER releases a queued 'digest' find, however old", () => {
    // 'digest' is a queue the weekly email drains, not an in-flight marker — it has no clock.
    const sig = signaturesFromRows([row("digest", 24 * 90)], { now: NOW });
    expect(sig.staleNew).toEqual([]);
    expect(repeatDecision(JOB, sig)).not.toBeNull();
  });

  it("keeps blocking a 'new' find of UNKNOWN age (fail closed)", () => {
    // A missed role is recoverable; a repeat is not. No created_at -> assume it may have been sent.
    const sig = signaturesFromRows([{ id: "x", job: JOB, status: "new", created_at: null }], { now: NOW });
    expect(sig.staleNew).toEqual([]);
    expect(repeatDecision(JOB, sig)).not.toBeNull();
  });

  it("expires independently of the caller's own in-flight exclude", () => {
    // first-role/match-one pass excludeId for the role they are sending RIGHT NOW. That must keep
    // working, and must not be the thing that happens to hide a stale row.
    const fresh = row("new", 0.01);
    const sig = signaturesFromRows([fresh], { excludeId: fresh.id, now: NOW });
    expect(sig.staleNew).toEqual([]); // excluded, not expired — different reason, same outcome
    expect(repeatDecision(JOB, sig)).toBeNull();
  });

  it("the window is longer than a run and shorter than the daily cron", () => {
    // The whole design in one assertion: long enough that today's 'new' blocks the digest that runs
    // minutes later, short enough that a failed send retries on the NEXT run rather than a day later.
    expect(STALE_NEW_HOURS).toBeGreaterThan(2);
    expect(STALE_NEW_HOURS).toBeLessThan(24);
  });
});

describe("a caught send failure is recorded, not left in flight", () => {
  const scheduler = read("scheduler.mjs");
  const store = read("charlie-store.mjs");

  it("the scheduler's catch marks the find 'send_failed'", () => {
    const block = scheduler.match(/\}\s*catch\s*\(e\)\s*\{[\s\S]{0,1200}?kind: "send_failed"/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/setFindStatus\(u\.email,\s*sendFindId,\s*"send_failed"\)/);
  });

  it("the scheduler no longer claims a failed role is retried by being left 'new'", () => {
    expect(scheduler).not.toMatch(/find left 'new'/);
  });

  it("'send_failed' is NOT a status the repeat guard reads", () => {
    const m = store.match(/getEmailedRoleSignatures[\s\S]{0,600}?\.in\("status",\s*(\[[^\]]*\])\)/);
    expect(m).not.toBeNull();
    const statuses = JSON.parse(m[1].replace(/'/g, '"'));
    expect(statuses).not.toContain("send_failed");
    expect(statuses).toEqual(expect.arrayContaining(["emailed", "digest", "new"]));
  });

  it("a dry run never lands in 'send_failed' either", () => {
    // sendFindId is only armed on a real send, so a preview that throws cannot rewrite its dry_run row.
    expect(scheduler).toMatch(/if \(!dryRun\) sendFindId = findId;/);
  });

  it("the watchdog counts 'send_failed' as stuck, so recording the failure does not silence the alarm", () => {
    // Without this, 'send_failed' rows would be invisible to the check that notices a run delivered
    // nothing, if watchdog.mjs counted status === "new" alone.
    const watchdog = read("watchdog.mjs");
    expect(watchdog).toMatch(/STUCK_STATUSES\s*=\s*\["new",\s*"send_failed"\]/);
    // The stuck tally is a counted query (pulling the rows would cap at 1000 and under-report the day).
    // STUCK_STATUSES must still be what defines stuck: the list existing is worthless if nothing reads it.
    const dailyBlock = watchdog.slice(watchdog.indexOf("async function checkDailySendDelivered"), watchdog.indexOf("add(\"daily send delivered\""));
    expect(dailyBlock, "the daily-send check no longer uses STUCK_STATUSES").toMatch(/STUCK_STATUSES/);
    expect(dailyBlock).toMatch(/stuck:\s*stuck\s*\|\|\s*0|STUCK_STATUSES\.includes\(f\.status\)/);
  });
});
