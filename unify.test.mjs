// unify.test.mjs — the one-composite blend + routing. The whole point is that a single
// number resolves the matcher-vs-coverage contradiction, so the blend + bands must be exact.
import { describe, it, expect } from "vitest";
import { unifyScore, unifiedRoute, unifiedMode, UNIFY_W_COVERAGE, UNIFY_W_MATCHER } from "./unify.mjs";

describe("unifyScore", () => {
  it("blends 0.55·coverage + 0.45·matcher, rounded", () => {
    expect(unifyScore(72, 80)).toBe(Math.round(UNIFY_W_COVERAGE * 80 + UNIFY_W_MATCHER * 72)); // 76
    expect(unifyScore(72, 26)).toBe(Math.round(UNIFY_W_COVERAGE * 26 + UNIFY_W_MATCHER * 72)); // 47 — the 72-vs-26 case
  });
  it("leans on the matcher alone when coverage is thin/null", () => {
    expect(unifyScore(83, null)).toBe(83);
    expect(unifyScore(83, NaN)).toBe(83);
  });
  it("uses coverage alone when matcher is missing", () => {
    expect(unifyScore(null, 60)).toBe(60);
  });
  it("returns null when neither input is usable", () => {
    expect(unifyScore(null, null)).toBeNull();
  });
  it("a low grounded coverage pulls a high matcher down (grounded is the moat)", () => {
    expect(unifyScore(90, 30)).toBeLessThan(60); // 0.55·30 + 0.45·90 = 57
  });
});

describe("unifiedRoute", () => {
  it("routes by band above the bars: send ≥58, digest 45–57, drop <45 (matcher≥70, cov≥floor)", () => {
    expect(unifiedRoute(76, 80, 85)).toBe("send");
    expect(unifiedRoute(58, 60, 72)).toBe("send");
    expect(unifiedRoute(57, 60, 72)).toBe("digest");
    expect(unifiedRoute(45, 60, 72)).toBe("digest");
    expect(unifiedRoute(44, 60, 72)).toBe("drop");
  });
  it("matcher-bar floor (fail-closed): below MATCH_BAR is ALWAYS drop, never a lowered bar", () => {
    expect(unifiedRoute(62, null, 62)).toBe("drop"); // thin coverage + matcher 62 < 70 → drop (not send)
    expect(unifiedRoute(80, 90, 68)).toBe("drop"); // strong blend but matcher 68 < 70 → drop
  });
  it("grounded guard: a scoreable coverage below the floor NEVER sends (the moat)", () => {
    expect(unifiedRoute(90, 40, 90)).toBe("digest"); // matcher ok, but coverage 40 < floor 50 → digest
    expect(unifiedRoute(99, 10, 99)).toBe("digest");
  });
  it("thin/null coverage sends only when the matcher clears the bar", () => {
    expect(unifiedRoute(null, null, null)).toBe("send"); // no scores to judge → don't block
    expect(unifiedRoute(83, null, 83)).toBe("send"); // matcher 83 ≥ bar, thin coverage → send
  });
  it("resolves the 72-vs-26 contradiction to digest from one number", () => {
    expect(unifiedRoute(unifyScore(72, 26), 26, 72)).toBe("digest"); // coverage 26 < floor → digest
  });
});

describe("unifiedMode", () => {
  it("defaults to shadow; maps on/off; unknown → shadow", () => {
    const orig = process.env.UNIFIED_SCORE_MODE;
    delete process.env.UNIFIED_SCORE_MODE; expect(unifiedMode()).toBe("shadow");
    process.env.UNIFIED_SCORE_MODE = "on"; expect(unifiedMode()).toBe("on");
    process.env.UNIFIED_SCORE_MODE = "off"; expect(unifiedMode()).toBe("off");
    process.env.UNIFIED_SCORE_MODE = "??"; expect(unifiedMode()).toBe("shadow");
    if (orig == null) delete process.env.UNIFIED_SCORE_MODE; else process.env.UNIFIED_SCORE_MODE = orig;
  });
});
