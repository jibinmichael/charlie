// scan-health.test.mjs — the counter for the silent-zero check.
//
// The case being defended: a board holds ~30 open reqs in company_req_snapshots for days, then
// reports 0 with the board still answering HTTP 200. Nothing alarms on its own, because a resolved
// board yielding 0 is indistinguishable
// from an honestly empty one within a single run. These tests pin both directions: it must fire
// on that shape, and it must NOT fire on the shapes that merely look like it.
import { describe, it, expect } from "vitest";
import { detectSilentZeros, detectSegmentCollapse, summarizeScanHealth, funnelBreakdown } from "./scan-health.mjs";

const board = (m) => new Map(Object.entries(m));

describe("detectSilentZeros", () => {
  it("fires on the real Apna case: had roles, board resolved, now yields zero", () => {
    const out = detectSilentZeros({
      previousCounts: { Apna: 33, Stripe: 208 },
      todayCounts: { Stripe: 208 },
      resolvedBoards: board({ Apna: "workable:apna", Stripe: "greenhouse:stripe" }),
    });
    expect(out).toEqual([{ company: "Apna", board: "workable:apna", had: 33 }]);
  });

  it("stays silent when the board did NOT resolve — that is already a loud ⚠, not a silent zero", () => {
    // Double-reporting a known failure as a new one is how an alarm becomes noise and gets ignored.
    const out = detectSilentZeros({
      previousCounts: { Apna: 33 },
      todayCounts: {},
      resolvedBoards: board({}), // fetch failed -> not in the resolved map
    });
    expect(out).toEqual([]);
  });

  it("stays silent for a board that had nothing before (an honestly empty board stays empty)", () => {
    // exec/oysterhr: real workable boards whose only postings are years stale. Correctly 0 forever.
    const out = detectSilentZeros({
      previousCounts: { Exec: 0 },
      todayCounts: {},
      resolvedBoards: board({ Exec: "workable:exec" }),
    });
    expect(out).toEqual([]);
  });

  it("stays silent while a board still yields anything at all", () => {
    const out = detectSilentZeros({
      previousCounts: { Apna: 33 },
      todayCounts: { Apna: 1 }, // shrunk hard, but still talking — not this check's job
      resolvedBoards: board({ Apna: "workable:apna" }),
    });
    expect(out).toEqual([]);
  });

  it("reports worst-first so the biggest loss is read first", () => {
    const out = detectSilentZeros({
      previousCounts: { Small: 2, Apna: 33, Mid: 9 },
      todayCounts: {},
      resolvedBoards: board({ Small: "workable:small", Apna: "workable:apna", Mid: "lever:mid" }),
    });
    expect(out.map((z) => z.company)).toEqual(["Apna", "Mid", "Small"]);
  });

  it("never throws on missing/empty inputs (diagnostics must not break a scan)", () => {
    expect(detectSilentZeros({})).toEqual([]);
    expect(detectSilentZeros({ previousCounts: null, todayCounts: null, resolvedBoards: null })).toEqual([]);
  });
});

describe("detectSegmentCollapse", () => {
  // A whole segment can vanish between runs: if watchlist-yc.json is absent, scan-jobs merges it
  // only `if (existsSync(p))`, so those boards are never fetched, no ⚠ is printed and
  // detectSilentZeros is blind to them by design — this is the check that sees it.
  it("fires on the real yc case: 170 roles last run, segment gone this run", () => {
    const out = detectSegmentCollapse({
      previousSegments: { base: { roles: 13276 }, yc: { roles: 170 } },
      todaySegments: { base: { roles: 13362 } }, // yc absent entirely
    });
    expect(out).toEqual([{ segment: "yc", had: 170 }]);
  });

  it("fires when the segment is present but zeroed, not just absent", () => {
    const out = detectSegmentCollapse({
      previousSegments: { yc: { roles: 170 } },
      todaySegments: { yc: { roles: 0 } },
    });
    expect(out).toEqual([{ segment: "yc", had: 170 }]);
  });

  it("stays silent for india, which is legitimately 0 while its seed is empty", () => {
    // india-ingest runs nightly and emits [] because data/india-seed.json is []. That is a known
    // empty, not a collapse — crying wolf here every night is how the alarm gets ignored.
    const out = detectSegmentCollapse({
      previousSegments: { base: { roles: 13276 }, india: { roles: 0 } },
      todaySegments: { base: { roles: 13362 } },
    });
    expect(out).toEqual([]);
  });

  it("stays silent while a segment still carries anything", () => {
    const out = detectSegmentCollapse({
      previousSegments: { yc: { roles: 170 } },
      todaySegments: { yc: { roles: 3 } }, // collapsed hard, but still contributing — not this check
    });
    expect(out).toEqual([]);
  });

  it("never throws on missing/empty inputs (diagnostics must not break a scan)", () => {
    expect(detectSegmentCollapse({})).toEqual([]);
    expect(detectSegmentCollapse({ previousSegments: null, todaySegments: null })).toEqual([]);
    expect(detectSegmentCollapse({ previousSegments: { yc: null }, todaySegments: {} })).toEqual([]);
  });
});

describe("summarizeScanHealth", () => {
  it("headlines the roles a person could have been shown and wasn't", () => {
    const h = summarizeScanHealth({
      previousCounts: { Apna: 33, Oyster: 4 },
      todayCounts: {},
      resolvedBoards: board({ Apna: "workable:apna", Oyster: "workable:oysterhr" }),
      poolSize: 13362,
      at: "2026-07-15T13:02:19Z",
    });
    expect(h.silentZeroBoards).toBe(2);
    expect(h.lostRoles).toBe(37);
    expect(h.bySource).toEqual({ workable: 2 });
    expect(h.poolSize).toBe(13362);
    expect(h.hadPrevious).toBe(true);
  });

  it("flags the first run as having no history, so an empty result is never read as 'all clear'", () => {
    // Without this, run #1 (and any run after a snapshot wipe) would report a clean bill of health
    // it has no evidence for — the exact false-confidence this whole module exists to remove.
    const h = summarizeScanHealth({ previousCounts: {}, todayCounts: { Stripe: 208 }, resolvedBoards: board({}) });
    expect(h.hadPrevious).toBe(false);
    expect(h.silentZeros).toEqual([]);
    expect(h.hadPreviousSegments).toBe(false); // same discipline for segments: no evidence != all clear
    expect(h.segmentCollapses).toEqual([]);
  });

  it("carries the segment collapse alongside the silent zeros, counted separately", () => {
    // The two failures are different (refused vs never asked) and must stay legible apart: a run
    // can lose Apna's board AND the whole yc segment, and the operator needs to see both.
    const h = summarizeScanHealth({
      previousCounts: { Apna: 33 },
      todayCounts: {},
      resolvedBoards: board({ Apna: "workable:apna" }),
      previousSegments: { base: { roles: 13276 }, yc: { roles: 170 } },
      todaySegments: { base: { roles: 13362 } },
      poolSize: 13362,
    });
    expect(h.lostRoles).toBe(33); // board-level loss
    expect(h.segmentCollapses).toEqual([{ segment: "yc", had: 170 }]);
    expect(h.lostSegmentRoles).toBe(170); // segment-level loss, NOT folded into lostRoles
    expect(h.hadPreviousSegments).toBe(true);
  });
});

// funnelBreakdown — where the fetched-but-not-pooled roles actually go.
//
// A scan fetches far more roles than it pools. If only `noDesc` is counted, the remainder has exactly
// one possible reading ("dedupe") and it is the wrong one. These tests pin the distinction the
// counters exist to make.
describe("funnelBreakdown", () => {
  // Numbers shaped like a real full scan (job-pool/scan-health.json).
  const REAL = { fetched: 40935, invalid: 0, noDesc: 32, pooled: 16197, remoteKept: 228 };

  it("without the stale counter, the whole loss is indistinguishable from dedupe", () => {
    // A record with no `stale` key at all: the whole gap lands in the remainder, which reads as
    // "dedupe ate two thirds of every board" — a conclusion nobody could act on.
    const old = funnelBreakdown(REAL);
    expect(old.stale).toBe(0);
    expect(old.dedupe).toBe(24934); // 40935 - 0 - 32 - 0 - (16197 - 228)
    expect(old.accountedFor).toBe(true); // arithmetic closes, and still says nothing useful
  });

  it("with the stale counter, the freshness cutoff is separated from real dedupe", () => {
    // Same intake, now with the 45-day drop recorded. The remainder collapses to true id collisions.
    const out = funnelBreakdown({ ...REAL, stale: 24700 });
    expect(out.stale).toBe(24700);
    expect(out.dedupe).toBe(234);
    expect(out.pooled).toBe(15969); // ATS survivors only — the 228 remote-board roles are not ours
    expect(out.accountedFor).toBe(true);
  });

  it("excludes remote-board roles from the ATS funnel, which were never fetched by it", () => {
    // Charging the ATS funnel for roles RemoteOK supplied would under-report dedupe by exactly 228.
    const withRemote = funnelBreakdown({ fetched: 1000, noDesc: 0, stale: 100, pooled: 900, remoteKept: 100 });
    const without = funnelBreakdown({ fetched: 1000, noDesc: 0, stale: 100, pooled: 800, remoteKept: 0 });
    expect(withRemote.pooled).toBe(800);
    expect(withRemote.dedupe).toBe(100);
    expect(without.dedupe).toBe(100); // identical — the remote merge must not move the ATS numbers
  });

  it("reports accountedFor:false rather than a negative remainder when the counts cannot reconcile", () => {
    // A future exit path added without a counter would surface here as impossible arithmetic, not as
    // a quietly wrong number. Fail loud.
    const broken = funnelBreakdown({ fetched: 100, noDesc: 0, stale: 0, pooled: 500, remoteKept: 0 });
    expect(broken.accountedFor).toBe(false);
  });

  it("treats missing and malformed counters as zero instead of NaN-poisoning the whole record", () => {
    const out = funnelBreakdown({ fetched: "40935", pooled: null, stale: undefined });
    expect(out.fetched).toBe(40935);
    expect(out.pooled).toBe(0);
    expect(out.stale).toBe(0);
    expect(Number.isNaN(out.dedupe)).toBe(false);
  });
});
