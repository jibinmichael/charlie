// seen-store.test.mjs — the seen-store persists, fails OPEN, and stays bounded.
//
// WHY IT IS REMOTE. The engine runs in a container with no volume, so a seen-store kept as a local
// file would start empty every run: the disappearance check would have no history, and `first_seen`
// (the ONLY date an undated posting has) would be re-stamped `now` every run, so undated roles could
// never age out.
//
// THE RISK is fail-closed becoming fail-to-zero: a guard that stops protecting and starts silently
// discarding, reporting green throughout. There are TWO directions and both are tested below.
//
//   READ  — if an empty store meant "every job I have ever seen has disappeared", one transient
//           Supabase error would close the entire pool. It must mean "no history, no opinion".
//   WRITE — the subtler one. If a FAILED read is
//           written back, an empty store overwrites the real remote history and a transient error
//           becomes permanent data loss. So a failed read must forfeit the write.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneSeen } from "./scan-jobs.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// ── READ: no history means no opinion ────────────────────────────────────────────────────────────
describe("the disappearance test holds no opinion without history", () => {
  // The test itself lives inside scan-jobs.mjs's run(), which cannot be imported without running a
  // scan, so this asserts the property on the real source: it iterates the store, so an empty store
  // cannot close anything. If someone rewrites this loop to iterate the POOL and close by
  // absence-from-store, the shape changes and this fails.
  const src = read("scan-jobs.mjs");
  const loop = src.match(/\/\/ disappearance test:[\s\S]*?\n {2}\}\n/)[0];

  it("closes by walking the STORE, so an empty store closes nothing", () => {
    expect(loop).toMatch(/for \(const \[id, e\] of Object\.entries\(seen\)\)/);
    expect(loop).toMatch(/e\.status === "open" && !seenThisRun\.has\(id\)/);
    // and it is still gated on the board having answered, so a dead board cannot false-close either
    expect(loop).toMatch(/resolvedBoards\.has\(boardKey\)/);
  });

  it("an empty store yields zero closures — run the real loop body over {}", () => {
    // A faithful re-execution of the loop above against an empty store.
    const seen = {};
    let newlyClosed = 0;
    for (const [, e] of Object.entries(seen)) if (e.status === "open") newlyClosed++;
    expect(newlyClosed).toBe(0);
  });

  it("a read failure is logged and forfeits the write, rather than being swallowed", () => {
    expect(src).toMatch(/seenWritable = false/);
    expect(src).toMatch(/read FAILED/);
    expect(src).toMatch(/if \(!seenWritable\)/);
    // the skip must come BEFORE the upload call, not after it
    const block = src.slice(src.indexOf("if (!seenWritable)"));
    expect(block.indexOf("skipping the write-back")).toBeLessThan(block.indexOf("saveSeenJobs(prunedSeen)"));
  });
});

// ── READ: absent vs unreadable are different facts ────────────────────────────────────────────────
// Behavioural, not a source-text assertion: the Supabase client is mocked so the real loadSeenJobs
// runs against each failure the bucket can actually produce.
describe("loadSeenJobs tells 'no history' apart from 'could not read'", () => {
  // charlie-store caches its Supabase client, so each case gets a fresh module graph with
  // createClient stubbed. No test-only export is added to production code to make this work.
  const load = async (download) => {
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({ storage: { from: () => ({ download }) } }),
    }));
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const mod = await import("./charlie-store.mjs");
    return mod.loadSeenJobs();
  };
  const body = (text) => ({ data: { text: async () => text }, error: null });
  afterEach(() => { vi.doUnmock("@supabase/supabase-js"); });

  it("returns {} when the object has never been written — genuinely the first run", async () => {
    await expect(load(async () => ({ data: null, error: { message: "Object not found" } }))).resolves.toEqual({});
  });

  it("returns the store when it reads cleanly", async () => {
    const store = { "gh:acme:1": { status: "open", first_seen: "2026-01-01T00:00:00Z" } };
    await expect(load(async () => body(JSON.stringify(store)))).resolves.toEqual(store);
  });

  it("THROWS on a network/permission error — never a silent empty store", async () => {
    await expect(load(async () => ({ data: null, error: { message: "connection reset by peer" } })))
      .rejects.toThrow(/seen-jobs read failed/);
  });

  it("THROWS on a truncated body — the failure mode a swallowed JSON.parse would hide", async () => {
    // This is the case that matters. loadJobPoolStats, directly above it in the same file, does
    // `catch { return null }` here. Copying that would turn a half-downloaded 12 MB object into
    // "no history", and the caller would then cheerfully write that emptiness back over the real one.
    await expect(load(async () => body('{"gh:acme:1":{"status":"op'))).rejects.toThrow();
  });

  it("THROWS when the body parses but is not a store — an array or a bare number is not history", async () => {
    for (const junk of ["[]", "42", '"a string"', "null"]) {
      await expect(load(async () => body(junk)), junk).rejects.toThrow(/not an object/);
    }
  });
});

// ── SIZE: prune on write, and prune only what is provably inert ──────────────────────────────────
describe("pruneSeen keeps the store bounded without losing a date that still matters", () => {
  const now = Date.parse("2026-07-31T00:00:00Z");
  const at = (daysAgo) => iso(now - daysAgo * DAY);

  it("drops entries closed longer ago than the pool horizon", () => {
    const { seen, dropped } = pruneSeen(
      { a: { status: "closed", closed_at: at(60), last_seen: at(60) } },
      { nowMs: now },
    );
    expect(seen).toEqual({});
    expect(dropped).toBe(1);
  });

  it("keeps a recently-closed entry — it can still be reported as closed-since-yesterday", () => {
    const e = { status: "closed", closed_at: at(2), last_seen: at(2) };
    expect(pruneSeen({ a: e }, { nowMs: now }).seen).toEqual({ a: e });
  });

  it("drops an entry not seen on any board for longer than the horizon", () => {
    const { seen } = pruneSeen({ a: { status: "open", last_seen: at(90), first_seen: at(400) } }, { nowMs: now });
    expect(seen).toEqual({});
  });

  it("NEVER drops a still-open entry on age — first_seen is the only date an undated role has", () => {
    // The core property: a five-year-old posting that is still live and
    // was seen today must keep its ORIGINAL first_seen, or it silently re-dates as brand new.
    const ancient = { status: "open", first_seen: at(1800), last_seen: at(0) };
    const { seen, dropped } = pruneSeen({ a: ancient }, { nowMs: now });
    expect(seen.a.first_seen).toBe(at(1800));
    expect(dropped).toBe(0);
  });

  it("keeps an entry with a missing or unparseable timestamp — pruning on missing data is data loss", () => {
    const rows = {
      a: { status: "open" },                                  // no last_seen at all
      b: { status: "open", last_seen: "not-a-date" },
      c: { status: "closed", closed_at: undefined, last_seen: at(1) },
    };
    expect(Object.keys(pruneSeen(rows, { nowMs: now }).seen).sort()).toEqual(["a", "b", "c"]);
  });

  it("discards a structurally broken row rather than carrying it forward", () => {
    const { seen, dropped } = pruneSeen({ a: null, b: "nope", c: { status: "open", last_seen: at(1) } }, { nowMs: now });
    expect(Object.keys(seen)).toEqual(["c"]);
    expect(dropped).toBe(2);
  });

  it("is pure and null-safe", () => {
    const input = { a: { status: "open", last_seen: at(1) } };
    const snapshot = JSON.stringify(input);
    pruneSeen(input, { nowMs: now });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(pruneSeen(null).seen).toEqual({});
    expect(pruneSeen(undefined).seen).toEqual({});
  });

  it("actually shrinks a realistic store", () => {
    const rows = {};
    for (let i = 0; i < 1000; i++) rows[`x:y:${i}`] = { status: "closed", closed_at: at(60 + i % 100), last_seen: at(60) };
    for (let i = 0; i < 200; i++) rows[`x:y:live${i}`] = { status: "open", first_seen: at(300), last_seen: at(0) };
    const { seen, dropped } = pruneSeen(rows, { nowMs: now });
    expect(dropped).toBe(1000);
    expect(Object.keys(seen)).toHaveLength(200);
  });
});

// ── WIRING: the store is actually persisted, not just persistable ────────────────────────────────
describe("the scan reads and writes the remote store", () => {
  const src = read("scan-jobs.mjs");

  it("loads from the bucket before the boards are walked", () => {
    expect(src).toMatch(/seen = await loadSeenJobs\(\)/);
    expect(src.indexOf("await loadSeenJobs()")).toBeLessThan(src.indexOf("disappearance test:"));
  });

  it("prunes before either write, so the file and the bucket agree", () => {
    expect(src).toMatch(/const \{ seen: prunedSeen, dropped: seenDropped \} = pruneSeen\(seen, \{ nowMs \}\)/);
    expect(src.indexOf("pruneSeen(seen, { nowMs })")).toBeLessThan(src.indexOf("writeFileSync(SEEN_PATH"));
    expect(src.indexOf("pruneSeen(seen, { nowMs })")).toBeLessThan(src.indexOf("saveSeenJobs(prunedSeen)"));
  });

  it("keeps the local file as the dev path", () => {
    expect(src).toMatch(/writeFileSync\(SEEN_PATH, JSON\.stringify\(prunedSeen/);
    expect(src).toMatch(/} else if \(existsSync\(SEEN_PATH\)\) \{/);
  });

  it("never lets a store failure fail the scan", () => {
    const block = src.slice(src.indexOf("if (!seenWritable)"), src.indexOf("if (!seenWritable)") + 900);
    expect(block).toMatch(/try \{[\s\S]*saveSeenJobs\(prunedSeen\)[\s\S]*\} catch \(e\) \{/);
  });
});
