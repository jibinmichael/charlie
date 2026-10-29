// cron-chain.test.mjs — the daily cron chain is enforced, not described.
//
// WHY THIS EXISTS: `engine:run` in package.json is a shell chain, and its `&&` / `;` operators are
// the ONLY thing deciding what still runs when a step fails. That is load-bearing behaviour with no
// type and no lint. A one-character edit could silently either
//   (a) let a send run after its guard failed (fail-OPEN — a wrong email in a real inbox), or
//   (b) let one component's abort silence every other email (fail-to-zero, e.g. the match cost
//       ceiling firing and taking the newsletter down with it).
// Both are invisible in review. This test makes them fail CI.
//
// HOW: it parses the real chain out of package.json and evaluates it under sh semantics for a given
// set of failing commands, then asserts which commands ran. No shelling out, no mocks — the string
// under test is the string that ships.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).scripts["engine:run"];

// --- a deliberately small sh subset: `&&`, `;`, and ( ) grouping. -------------------------------
// Precedence matches sh: `&&` binds tighter than `;`.

/** Split on `sep` only at paren depth 0, so a grouped sub-chain is never torn apart. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function parse(s) {
  s = s.trim();
  const semis = splitTop(s, ";");
  if (semis.length > 1) return { type: "seq", items: semis.map(parse) };
  const ands = splitTop(s, "&&");
  if (ands.length > 1) return { type: "and", items: ands.map(parse) };
  if (s.startsWith("(") && s.endsWith(")")) return parse(s.slice(1, -1));
  return { type: "cmd", text: s };
}

/**
 * Evaluate the parsed chain.
 * @param {string[]} failing substrings; a command containing one of them "exits non-zero"
 * @returns {{ ran: string[], ok: boolean }}
 */
function evaluate(node, failing, ran = []) {
  if (node.type === "cmd") {
    ran.push(node.text);
    return { ok: !failing.some((f) => node.text.includes(f)), ran };
  }
  if (node.type === "seq") {
    // `;` — every item runs regardless; the chain's status is the LAST item's.
    let ok = true;
    for (const item of node.items) ok = evaluate(item, failing, ran).ok;
    return { ok, ran };
  }
  // `&&` — stop at the first failure.
  let ok = true;
  for (const item of node.items) {
    ok = evaluate(item, failing, ran).ok;
    if (!ok) break;
  }
  return { ok, ran };
}

const runWith = (...failing) => evaluate(parse(CHAIN), failing).ran;
const ranSome = (ran, needle) => ran.some((c) => c.includes(needle));

// The three user-facing send steps the chain drives.
const SCHEDULER = "scheduler.mjs";
const DIGEST = "digest.mjs";
const NEWSLETTER = "newsletter.mjs";

describe("engine:run — the daily cron chain", () => {
  it("names every step this test reasons about (guards against a rename silently voiding it)", () => {
    for (const step of [SCHEDULER, NEWSLETTER, "preflight.mjs", "presend-guard.test.mjs", "watchdog.mjs"]) {
      expect(CHAIN, `engine:run no longer mentions ${step}`).toContain(step);
    }
  });

  // --- fail-to-zero: one component's abort must not silence the others --------------------------
  // If the match cost ceiling fires inside scheduler.mjs and the next step is joined by `&&`, the
  // newsletter never runs and everyone gets total silence.
  it("a scheduler abort does NOT silence the newsletter", () => {
    const ran = runWith(SCHEDULER);
    expect(ranSome(ran, NEWSLETTER), "newsletter was skipped because scheduler failed").toBe(true);
  });

  // --- the weekly digest is NOT in the chain ---------------------------------------------------
  // digest.mjs is the only caller of setFindStatus(..., "digest_sent"), so leaving it out of the
  // chain leaves every digested role sitting in `finds` as it is: the rows are kept, no email goes.
  //
  // A COMMENT CANNOT KEEP IT OUT. engine:run is a shell string in package.json; re-adding one
  // command is a one-line diff nobody would question in review. This is the check that questions it.
  // The script itself stays: `node digest.mjs --to <email>` is a usable hand-run operator tool.
  it("digest.mjs is NOT in the cron chain, and cannot come back quietly", () => {
    expect(CHAIN).not.toContain(DIGEST);
  });

  it("the chain still runs the sends we DO keep (so the check above cannot pass by emptiness)", () => {
    expect(CHAIN).toContain(SCHEDULER);
    expect(CHAIN).toContain(NEWSLETTER);
  });

  // --- fail-closed: a failed GUARD must stop every send ----------------------------------------
  // The mirror risk. Decoupling the sends with a bare `;` would also decouple them from preflight,
  // letting mail go out after the guard said no. These pin that it cannot.
  it("a failed pre-send preflight stops ALL three sends", () => {
    const ran = runWith("preflight.mjs --phase=pre-send");
    expect(ranSome(ran, SCHEDULER), "scheduler ran after preflight failed").toBe(false);
    expect(ranSome(ran, DIGEST), "digest ran after preflight failed").toBe(false);
    expect(ranSome(ran, NEWSLETTER), "newsletter ran after preflight failed").toBe(false);
  });

  it("a failed presend-guard self-test stops ALL three sends", () => {
    const ran = runWith("presend-guard.test.mjs");
    expect(ranSome(ran, SCHEDULER)).toBe(false);
    expect(ranSome(ran, DIGEST)).toBe(false);
    expect(ranSome(ran, NEWSLETTER)).toBe(false);
  });

  it("a failed pre-scan preflight stops ALL three sends", () => {
    const ran = runWith("preflight.mjs --phase=pre-scan");
    expect(ranSome(ran, SCHEDULER)).toBe(false);
    expect(ranSome(ran, DIGEST)).toBe(false);
    expect(ranSome(ran, NEWSLETTER)).toBe(false);
  });

  // --- the alarm must survive whatever happened above -------------------------------------------
  // watchdog runs after every send failure, so a dead send is still alerted on even though the
  // run's exit status (see "exit status" below) only turns red for a guard abort.
  // ── A SCAN FAILURE MUST NOT CANCEL THE WEEK ─────────────────────────────────────────────────
  //
  // The run is started by hand (see the describe block at the foot of this file), so "the chain
  // aborted" costs a whole run of role emails, not one missed morning. scan-jobs is the heaviest step:
  // the pool is tens of thousands of roles and hundreds of MB, held whole in memory, and saveJobPool
  // builds large Buffers on top. It is the step most likely to die.
  //
  // It is also the step whose failure is SURVIVABLE: the pool it refreshes is already in Supabase, and
  // preflight --phase=pre-send fail-closes on a pool older than POOL_MAX_AGE_HOURS. So the correct
  // behaviour is "let preflight judge the pool", never "cancel every send because the scan died".
  //
  // A bare `;` after the scan FAILS the two guard tests above, because sh's `;` cannot tell "the scan
  // failed" from "a guard failed": the chain would resume into the send after a failed pre-scan
  // preflight. Hence the group: only the INGEST steps are non-fatal, and `; true` is what makes the
  // group's exit status independent of them.
  it("a failed scan does NOT cancel the sends — preflight decides, on pool age", () => {
    const ran = runWith("scan-jobs.mjs");
    expect(ranSome(ran, "preflight.mjs --phase=pre-send"), "pre-send preflight was skipped").toBe(true);
    expect(ranSome(ran, SCHEDULER), "the scan cancelled the role emails").toBe(true);
    expect(ranSome(ran, NEWSLETTER), "the scan cancelled the newsletter").toBe(true);
  });

  it("nor does a failed ingest step", () => {
    for (const step of ["yc-ingest.mjs", "india-ingest.mjs"]) {
      expect(ranSome(runWith(step), SCHEDULER), `${step} cancelled the send`).toBe(true);
    }
  });

  it("but a STALE pool still stops the send — the guard is preflight, not the scan", () => {
    // The safety this trade rests on: if pre-send preflight fails, nothing sends.
    const ran = runWith("preflight.mjs --phase=pre-send");
    expect(ranSome(ran, SCHEDULER)).toBe(false);
    expect(ranSome(ran, NEWSLETTER)).toBe(false);
  });

  // --- the run's exit status: red on a guard abort, so Railway shows the failed run -------------
  // The chain records the guarded part's status in `rc`, runs the reporting tail regardless, then
  // `exit $rc`. The send group ends in `; true`, so `rc` is non-zero exactly when a GUARD (pre-scan
  // preflight, the presend-guard self-test, pre-send preflight) aborted the run. Send failures are
  // reported by health-check / watchdog alerts instead.
  describe("exit status", () => {
    const [guarded, tail] = (() => {
      const i = CHAIN.indexOf("; rc=$?");
      return [CHAIN.slice(0, i), CHAIN.slice(i)];
    })();
    const guardedOk = (...failing) => evaluate(parse(guarded), failing).ok;

    it("records the guarded status and exits with it at the very end", () => {
      expect(CHAIN).toContain("; rc=$? ;");
      expect(CHAIN.trim().endsWith("exit $rc")).toBe(true);
      for (const step of ["health-check.mjs", "watchdog.mjs", "run-eval.mjs"]) expect(tail).toContain(step);
    });

    it("is non-zero when any guard fails", () => {
      for (const g of ["preflight.mjs --phase=pre-scan", "presend-guard.test.mjs", "preflight.mjs --phase=pre-send"]) {
        expect(guardedOk(g), `${g} failed but the run would exit 0`).toBe(false);
      }
    });

    it("is zero when only a scan or a send step fails (those are reported by alerts)", () => {
      for (const s of ["scan-jobs.mjs", "yc-ingest.mjs", SCHEDULER, NEWSLETTER]) expect(guardedOk(s)).toBe(true);
      expect(guardedOk()).toBe(true);
    });
  });

  it("the watchdog still runs after any send failure", () => {
    for (const failed of [SCHEDULER, DIGEST, NEWSLETTER, "preflight.mjs --phase=pre-send"]) {
      expect(ranSome(runWith(failed), "watchdog.mjs"), `watchdog skipped when ${failed} failed`).toBe(true);
    }
  });
});

// ── HEAP: the steps that hold the whole job pool in memory ───────────────────────────────────────
//
// The job pool is hundreds of MB of JSON and loading it costs more than a gigabyte of heap, which is
// close to Node's default ~2 GB old-space cap ("JavaScript heap out of memory"). Every step below
// holds the whole pool at once, so each carries a raised --max-old-space-size.
//
// A raised ceiling BUYS TIME, it does not fix the growth (pruning or streaming the pool would). What
// this test prevents is the quiet regression: someone edits the chain, drops the flag, and the run
// dies mid-scan with nobody watching.
const POOL_HOLDING_STEPS = ["scan-jobs.mjs", "scheduler.mjs", "newsletter.mjs", "run-eval.mjs"];

describe("engine:run — the pool-holding steps get a raised heap", () => {
  for (const step of POOL_HOLDING_STEPS) {
    it(`${step} runs with an explicit --max-old-space-size`, () => {
      // The flag must be on the SAME command as the step. `VAR=x a && b` only exports to `a`, so a
      // single prefix at the head of the chain would silently cover nothing but the first step.
      const seg = CHAIN.split("&&").flatMap((s) => s.split(";")).find((s) => s.includes(step));
      expect(seg, `${step} is not in engine:run at all`).toBeTruthy();
      expect(seg, `${step} would run on the default ~2GB heap and OOM on the live pool`).toMatch(/max-old-space-size=\d{4}/);
    });
  }

  it("the raised heap is at least 4096 MB (the live pool needs ~1.3GB just to load)", () => {
    for (const m of CHAIN.matchAll(/max-old-space-size=(\d+)/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(4096);
    }
  });
});

// ── NOTHING STARTS ITSELF ────────────────────────────────────────────────────────────────────────
//
// Runs are started by an operator, never by a schedule. Railway is the only thing that can start a
// run without a human: a `cronSchedule` in a service's railway config attaches a scheduler, and the
// service then runs its startCommand unattended. This reads the real config files that ship, so a
// cron added to any of them fails here. Re-enabling one means deliberately removing an assertion.
describe("no Railway service starts itself", () => {
  const CONFIGS = ["railway.json", "railway.engine.json", "railway.sweep.json", "railway.worker.json"];

  it("finds the config files (an empty list would pass every case below)", () => {
    for (const f of CONFIGS) {
      expect(() => readFileSync(join(HERE, f), "utf8"), `${f} is missing`).not.toThrow();
    }
  });

  for (const f of CONFIGS) {
    it(`${f} declares no cronSchedule`, () => {
      const cfg = JSON.parse(readFileSync(join(HERE, f), "utf8"));
      expect(
        cfg?.deploy?.cronSchedule,
        `${f} would start a run with nobody watching. Runs are started by an operator only.`,
      ).toBeUndefined();
      // Belt and braces: catch it declared anywhere else in the file too.
      expect(JSON.stringify(cfg)).not.toContain("cronSchedule");
    });
  }

  it("the services still have a startCommand, so a manual run is still possible", () => {
    for (const f of CONFIGS) {
      const cfg = JSON.parse(readFileSync(join(HERE, f), "utf8"));
      expect(typeof cfg?.deploy?.startCommand, `${f} has no startCommand left to run by hand`).toBe("string");
    }
  });
});

// ── Every script in the chain must at least PARSE ────────────────────────────────────────────────
//
// A syntax error in a chain script like watchdog.mjs passes `npm run typecheck` and the whole test
// suite: tsconfig.typecheck.json does not cover it and nothing imports it. The first thing to notice
// would be the cron, where watchdog.mjs is the LAST command and its exit status becomes the
// container's: a parse error there turns a healthy send into a crashed deploy.
//
// `node --check` is a parse, not an execution: no env, no network, no side effects. It is the
// cheapest possible guard for the class, and the class is "a whole cron step never ran".
describe("every command in engine:run parses", () => {
  const scripts = [...CHAIN.matchAll(/(?:^|\s)(?:tsx|node(?:\s+--[\w=-]+)*)\s+([\w./-]+\.(?:mjs|ts))/g)].map((m) => m[1]);

  it("found the scripts (a regex that matches nothing would pass every case below)", () => {
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    expect(scripts).toContain("watchdog.mjs");
    expect(scripts).toContain("scheduler.mjs");
  });

  for (const file of [...new Set(scripts)].filter((f) => f.endsWith(".mjs"))) {
    it(`${file} is syntactically valid`, async () => {
      const { execFileSync } = await import("node:child_process");
      expect(() => execFileSync(process.execPath, ["--check", join(HERE, file)], { stdio: "pipe" })).not.toThrow();
    });
  }
});
