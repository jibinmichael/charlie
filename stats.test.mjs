// stats.test.mjs — the KPI counters must be arithmetic-correct (they gate every
// later score/send flip, so a wrong rate would let a regression through).
import { describe, it, expect } from "vitest";
import { computeMatchKpis, computeRetrievalRankKpis, mergeKpiHistory, formatKpiLine } from "./stats.mjs";

describe("computeMatchKpis", () => {
  it("counts scored/passed/borderline and derives rates", () => {
    const byEmail = new Map([
      ["a@x.com", [{ match: { score: 85 }, passed_bar: true }, { match: { score: 70 }, passed_bar: false }]],
      ["b@x.com", [{ match: { score: 60 }, passed_bar: false }, { match: { score: 40 }, passed_bar: false }]],
    ]);
    const k = computeMatchKpis(byEmail);
    expect(k.scored).toBe(4);
    expect(k.passed_bar).toBe(1);
    expect(k.borderline).toBe(2); // 70 and 60 are in [60,80]; 85 and 40 are not
    expect(k.match_positive_rate).toBe(0.25);
    expect(k.borderline_share).toBe(0.5);
  });
  it("ignores non-numeric / missing scores without dividing by zero", () => {
    const byEmail = new Map([["a@x.com", [{ match: {} }, { passed_bar: true }, { match: { score: NaN } }]]]);
    const k = computeMatchKpis(byEmail);
    expect(k).toMatchObject({ scored: 0, passed_bar: 0, borderline: 0, match_positive_rate: 0, borderline_share: 0 });
  });
  it("handles an empty run", () => {
    expect(computeMatchKpis(new Map())).toMatchObject({ scored: 0, match_positive_rate: 0 });
  });
});

describe("mergeKpiHistory", () => {
  it("appends and keeps chronological order", () => {
    const h = mergeKpiHistory([{ date: "2026-07-10" }], { date: "2026-07-11" });
    expect(h.map((s) => s.date)).toEqual(["2026-07-10", "2026-07-11"]);
  });
  it("dedups by date (last write wins for the day)", () => {
    const h = mergeKpiHistory([{ date: "2026-07-11", scored: 1 }], { date: "2026-07-11", scored: 9 });
    expect(h).toEqual([{ date: "2026-07-11", scored: 9 }]);
  });
  it("caps to the newest N days", () => {
    const hist = Array.from({ length: 90 }, (_, i) => ({ date: `2026-04-${String(i + 1).padStart(2, "0")}` }));
    const h = mergeKpiHistory(hist, { date: "2026-09-01" }, 90);
    expect(h.length).toBe(90);
    expect(h[h.length - 1].date).toBe("2026-09-01");
  });
  it("tolerates a missing/non-array history", () => {
    expect(mergeKpiHistory(undefined, { date: "2026-07-11" })).toEqual([{ date: "2026-07-11" }]);
  });
});

describe("formatKpiLine", () => {
  it("renders a readable one-liner and flags a silent no-send day", () => {
    const line = formatKpiLine({
      date: "2026-07-13", scored: 4, passed_bar: 1, match_positive_rate: 0.25, borderline_share: 0.5,
      cost_usd: { match: 0.1234 }, outcomes: { role_sent: 2, digested: 1, silent_no_send_users: 1, grounding_held: 0, failed: 0 }, silent_no_send: true,
    });
    expect(line).toContain("match+ 25.0%");
    expect(line).toContain("borderline 50.0%");
    expect(line).toContain("SILENT NO-SEND");
  });
});

// ── the retrieval-rank instrument ──────────────────────────────────────────────────────────────
// Whether the good roles sit inside the pre-filter cap can only be answered if the retrieval rank at
// score time is recorded. This is the recording.
describe("computeRetrievalRankKpis", () => {
  const run = (pairs) => new Map([["a@b.com", pairs]]);

  it("reports where the ABOVE-BAR roles sat in retrieval, ignoring the rest", () => {
    const k = computeRetrievalRankKpis(run([
      { _retrievalRank: 0, passed_bar: false },
      { _retrievalRank: 5, passed_bar: true },
      { _retrievalRank: 40, passed_bar: true },
      { _retrievalRank: 149, passed_bar: true },
      { _retrievalRank: 3, passed_bar: false },
    ]));
    expect(k.ranked).toBe(5);
    expect(k.above_bar_ranked).toBe(3);
    expect(k.above_bar_rank_max).toBe(149);
    expect(k.above_bar_rank_p50).toBe(40);
  });

  it("aggregates across users, because the question is about the ranker not one person", () => {
    const k = computeRetrievalRankKpis(new Map([
      ["a@b.com", [{ _retrievalRank: 2, passed_bar: true }]],
      ["c@d.com", [{ _retrievalRank: 120, passed_bar: true }]],
    ]));
    expect(k.above_bar_ranked).toBe(2);
    expect(k.above_bar_rank_max).toBe(120);
  });

  // A zero would read as "every good role was rank 0" — the most flattering possible reading of a
  // day with no data. It must be null instead.
  it("reports null, never 0, when no above-bar pair carries a rank", () => {
    const k = computeRetrievalRankKpis(run([{ _retrievalRank: 7, passed_bar: false }]));
    expect(k.above_bar_ranked).toBe(0);
    expect(k.above_bar_rank_p50).toBeNull();
    expect(k.above_bar_rank_p90).toBeNull();
    expect(k.above_bar_rank_max).toBeNull();
  });

  // A scored pair without a stamped `_retrievalRank` looks exactly like this, and the instrument must
  // report "I measured nothing", not a false zero.
  it("counts nothing when the rank is not stamped at all (the pre-instrument shape)", () => {
    const k = computeRetrievalRankKpis(run([
      { match: { score: 88 }, passed_bar: true },
      { match: { score: 12 }, passed_bar: false },
    ]));
    expect(k.ranked).toBe(0);
    expect(k.above_bar_ranked).toBe(0);
    expect(k.above_bar_rank_p90).toBeNull();
  });

  it("survives an empty run and a malformed input without throwing", () => {
    expect(computeRetrievalRankKpis(new Map()).ranked).toBe(0);
    expect(computeRetrievalRankKpis(undefined).ranked).toBe(0);
    expect(computeRetrievalRankKpis(run([null, undefined, {}])).ranked).toBe(0);
  });
});
