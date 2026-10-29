// dry-run-finds.test.mjs — a PREVIEW must not consume the role it previews.
//
// If EMAIL_DRY_RUN=1 wrote its find with status 'new', getEmailedRoleSignatures (which reads
// ["emailed","digest","new"]) would make repeatDecision answer "already sent this posting" on every
// later run: a preview would silently block the real send of every role it previewed.
//
// These are static-source assertions on purpose: the failure is a mismatch between two files (which
// statuses the scheduler WRITES vs which statuses the signature reader COUNTS), and that mismatch is
// invisible to any test that only exercises one of them.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDryRun, findStatus } from "./dry-run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("a dry run leaves no trace that blocks a real send", () => {
  const scheduler = read("scheduler.mjs");
  const store = read("charlie-store.mjs");

  it("the repeat-signature reader does NOT count dry_run finds", () => {
    // The one line that decides whether a preview poisons the repeat guard.
    const m = store.match(/getEmailedRoleSignatures[\s\S]{0,400}?\.in\("status",\s*(\[[^\]]*\])\)/);
    expect(m).not.toBeNull();
    const statuses = JSON.parse(m[1].replace(/'/g, '"'));
    expect(statuses).not.toContain("dry_run");
    // Guard the intent too: these three are what SHOULD block a repeat.
    expect(statuses).toEqual(expect.arrayContaining(["emailed", "digest", "new"]));
  });

  it("the scheduler writes dry_run for the send candidate when dryRun is set", () => {
    expect(scheduler).toMatch(/status:\s*dryRun\s*\?\s*"dry_run"\s*:\s*"new"/);
  });

  it("the scheduler writes dry_run for digest near-misses too", () => {
    // Otherwise a preview queues mail the weekly digest would really send.
    expect(scheduler).toMatch(/status:\s*dryRun\s*\?\s*"dry_run"\s*:\s*"digest"/);
  });

  it("the daily-send watchdog does not count a preview as a delivered run", () => {
    // Otherwise an operator's manual EMAIL_DRY_RUN on the same day masks a genuinely aborted cron:
    // the verdict reads "prepared and delivered" while nothing went out, the exact fail-to-zero
    // shape the check exists to catch.
    // Asserts the BEHAVIOUR, not one query's shape. The check uses two counted queries (a fetched
    // array would stop at 1000 rows without erroring). Both must exclude the preview, so this counts
    // them rather than matching a window: a third query that forgot .neq would slip past.
    const watchdog = read("watchdog.mjs");
    const start = watchdog.indexOf("async function checkDailySendDelivered");
    // Search for the end AFTER the start: dailySendVerdict is imported at the top of the file, so an
    // unanchored indexOf returns that first occurrence and the slice comes back empty, which reads as
    // "no query found" rather than as a broken test.
    const dailyBlock = watchdog.slice(start, watchdog.indexOf("dailySendVerdict", start));
    const findsQueries = dailyBlock.match(/from\("finds"\)[^;]*/g) || [];
    expect(findsQueries.length, "no finds query feeds the daily-send verdict").toBeGreaterThan(0);
    for (const q of findsQueries) expect(q, `a finds query counts previews: ${q}`).toMatch(/\.neq\("status",\s*"dry_run"\)/);
  });

  it("the dry-run log line names the status it actually wrote", () => {
    // The line a debugger reads at 2am must not say 'new' when the row is 'dry_run'. Anchor on the
    // "would email" text: there are three `if (dryRun)` blocks and only this one records a find.
    const line = scheduler.match(/DRY RUN — would email[^\n]*/);
    expect(line).not.toBeNull();
    expect(line[0]).not.toMatch(/saved 'new'/);
    expect(line[0]).toMatch(/dry_run/);
  });

  it("no find write in the scheduler hardcodes a status the signature reader counts", () => {
    // Catches a future upsertFind added with a bare status: "new" / "digest".
    const writes = scheduler.match(/upsertFind\(\{[\s\S]{0,400}?\}\)/g) || [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      if (/status:\s*"(new|digest)"/.test(w)) {
        throw new Error(`upsertFind writes a hardcoded poisoning status; it must be dryRun-aware:\n${w.slice(0, 200)}`);
      }
    }
  });
});

describe("the shared dry-run rule itself", () => {
  it("only the literal '1' is a dry run", () => {
    // Not truthiness: `EMAIL_DRY_RUN=0` or `=false` must mean "send for real", or an operator who
    // typed 0 to turn it OFF would silently get a preview and think nothing sent.
    expect(isDryRun({ EMAIL_DRY_RUN: "1" })).toBe(true);
    for (const v of ["0", "", "false", "true", "yes", undefined]) expect(isDryRun({ EMAIL_DRY_RUN: v })).toBe(false);
    expect(isDryRun({})).toBe(false);
  });

  it("rewrites exactly the statuses the repeat guard counts", () => {
    expect(findStatus("new", true)).toBe("dry_run");
    expect(findStatus("digest", true)).toBe("dry_run");
    expect(findStatus("emailed", true)).toBe("dry_run");
  });

  it("leaves a non-blocking status alone, so a preview still records what it saw", () => {
    // 'closest' is not in the signature set, so it does not burn anything and stays informative.
    for (const s of ["closest", "unsent", "digest_sent", "dry_run", "send_failed"]) expect(findStatus(s, true)).toBe(s);
  });

  it("is a pass-through when it is not a dry run", () => {
    for (const s of ["new", "digest", "emailed", "closest"]) expect(findStatus(s, false)).toBe(s);
  });
});

// ── THE SCOPE HOLE ────────────────────────────────────────────────────────────────────────────────
// Everything above asserts against `scheduler.mjs` alone. `first-role.mjs` and `match-one.mjs` — the
// path EVERY new user's first role takes — write finds and send too, and a guard scoped to one of two
// send paths is worse than none, because it is trusted.
//
// These assertions are over EVERY file that writes a find status, enumerated below, so adding a third
// writer without making it dry-run-aware fails here instead of in somebody's inbox.
describe("every find-status writer is dry-run aware, not just the scheduler", () => {
  // The complete set, from `grep -rn upsertFind` over the deployed (non-script) code.
  const WRITERS = ["scheduler.mjs", "first-role.mjs", "match-one.mjs", "run-charlie.mjs"];

  it("the writer list is still complete", () => {
    // The assertion that keeps THIS file from developing the same scope hole it exists to close.
    const found = [];
    for (const f of readdirSync(ROOT, { withFileTypes: true })) {
      if (!f.isFile() || !/\.mjs$/.test(f.name) || /\.test\.mjs$/.test(f.name)) continue;
      const src = read(f.name);
      if (/export async function upsertFind/.test(src)) continue; // charlie-store.mjs DEFINES it
      if (/upsertFind\(\{/.test(src)) found.push(f.name);
    }
    expect(found.sort()).toEqual([...WRITERS].sort());
  });

  it("no writer hardcodes a status the repeat guard counts", () => {
    // 'emailed' is exempt: it is only ever written AFTER a real send, by setFindStatus, never by a
    // preview. run-charlie.mjs is the owner-only canary and is exempt by name, asserted separately.
    for (const f of WRITERS) {
      if (f === "run-charlie.mjs") continue;
      const src = read(f);
      for (const w of src.match(/upsertFind\(\{[\s\S]{0,500}?\}\)/g) || []) {
        if (/status:\s*"(new|digest)"/.test(w)) {
          throw new Error(`${f}: upsertFind hardcodes a status the signature reader counts, so a preview burns the role:\n${w.slice(0, 220)}`);
        }
      }
    }
  });

  it("first-role and match-one route their statuses through findStatus()", () => {
    // By construction, not by remembering: lib/dry-run.mjs owns the rule and the blocking-status list.
    for (const f of ["first-role.mjs", "match-one.mjs"]) {
      expect(read(f), `${f} must import the shared dry-run helper`).toMatch(/from "\.\/lib\/dry-run\.mjs"/);
      expect(read(f)).toMatch(/status: findStatus\(/);
    }
  });

  it("EMAIL_DRY_RUN actually stops the first-role send, not only the scheduler's", () => {
    // The dangerous half. Both first-role sends must return BEFORE sendGuarded on a dry run.
    const src = read("first-role.mjs");
    for (const tmpl of ["first-role", "first-closest"]) {
      const at = src.indexOf(`template: "${tmpl}"`);
      expect(at, `${tmpl} send not found`).toBeGreaterThan(-1);
      const before = src.slice(0, at);
      const guard = before.lastIndexOf("isDryRun()");
      expect(guard, `no dry-run stop before the ${tmpl} send`).toBeGreaterThan(-1);
      // and the guard must actually return, not merely log
      expect(before.slice(guard)).toMatch(/return false;/);
    }
  });

  it("the flag has ONE interpretation, in lib/dry-run.mjs", () => {
    // Two readings of the same flag is how half of a safety feature goes missing.
    const lib = read("lib/dry-run.mjs");
    expect(lib).toMatch(/EMAIL_DRY_RUN === "1"/);
    for (const f of ["first-role.mjs", "match-one.mjs"]) {
      expect(read(f), `${f} must not re-interpret the flag itself`).not.toMatch(/process\.env\.EMAIL_DRY_RUN/);
    }
  });

  it("the blocking-status list lives beside the helper that avoids it", () => {
    // If these two drift, findStatus() starts letting a poisoning status through silently.
    const lib = read("lib/dry-run.mjs");
    const store = read("charlie-store.mjs");
    const m = store.match(/getEmailedRoleSignatures[\s\S]{0,600}?\.in\("status",\s*(\[[^\]]*\])\)/);
    expect(m).not.toBeNull();
    const guardStatuses = JSON.parse(m[1].replace(/'/g, '"')).sort();
    const libStatuses = JSON.parse(lib.match(/BLOCKING_STATUSES = (\[[^\]]*\])/)[1].replace(/'/g, '"')).sort();
    expect(libStatuses).toEqual(guardStatuses);
  });
});

describe("a first-role that does not send releases the role", () => {
  const src = () => read("first-role.mjs");

  it("resolves the in-flight row in a finally, not at each exit", () => {
    // match-one persists the winner as 'new' BEFORE first-role's gate, grounding checks and send. There
    // are eight non-send exits (v2 cohort, signature read failure, gate DROP, three grounding outcomes,
    // suppression, failed send); resolving them one at a time is exactly what an edit forgets.
    const s = src();
    expect(s).toMatch(/let pendingFindId = null;/);
    const fin = s.match(/\}\s*finally\s*\{[\s\S]*?\n  \}/);
    expect(fin).not.toBeNull();
    expect(fin[0]).toMatch(/if \(pendingFindId && !resolved\)/);
    expect(fin[0]).toMatch(/"unsent"/);
  });

  it("'unsent' is NOT a status the repeat guard counts", () => {
    // The whole point: the role must come back into play.
    const m = read("charlie-store.mjs").match(/getEmailedRoleSignatures[\s\S]{0,600}?\.in\("status",\s*(\[[^\]]*\])\)/);
    expect(JSON.parse(m[1].replace(/'/g, '"'))).not.toContain("unsent");
  });

  it("a row that reached its own terminal status is not overwritten", () => {
    // The digest branch and a delivered send both re-status the row; the finally must leave those alone,
    // or a queued digest pick would be silently un-queued and a delivered role would look unsent.
    const s = src();
    const digest = s.match(/status: findStatus\("digest", dry\)[\s\S]{0,200}/)[0];
    expect(digest).toMatch(/resolved = true/);
    const emailed = s.match(/setFindStatus\(email, findId, "emailed"\)[\s\S]{0,120}/)[0];
    expect(emailed).toMatch(/resolved = true/);
  });

  it("the resolution can never throw into the caller", () => {
    // It runs in a finally on the SUCCESS path too, so a store blip must not turn a delivered first role
    // into a thrown error.
    const fin = src().match(/\}\s*finally\s*\{[\s\S]*?\n  \}/)[0];
    expect(fin).toMatch(/\.then\(/);
    expect(fin).not.toMatch(/await setFindStatus\([^)]*\);\s*$/m);
  });
});
