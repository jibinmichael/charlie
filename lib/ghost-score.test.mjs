// lib/ghost-score.test.mjs — the evergreen/ghost read (lib/ghost-score.mjs).
//
// The whole risk in this gate is a guard that stops protecting and starts silently discarding. Age is derived from `first_seen`, which comes
// from a store that can be empty, stale, or wrong — so every "cannot tell" path must mean NO
// OPINION, never "hold it". Most of the file is that.
//
// The other half is honesty about scope. Until the seen-store has accumulated history, every pooled
// role carries a recent first_seen, so this gate finds NOTHING by arithmetic. The last test pins that
// fact so nobody reads its silence as evidence that it works.
import { describe, it, expect } from "vitest";
import { openDays, ghostVerdict, ghostMode } from "./ghost-score.mjs";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const daysAgo = (d) => new Date(NOW - d * 86400e3).toISOString();

describe("openDays", () => {
  it("measures continuous days open from first_seen", () => {
    expect(Math.floor(openDays({ first_seen: daysAgo(50) }, NOW))).toBe(50);
    expect(Math.floor(openDays({ first_seen: daysAgo(0.5) }, NOW))).toBe(0);
  });

  it("returns null — not 0 — when the age cannot be known", () => {
    // 0 would compare as "brand new" and silently pass every threshold. null means no opinion.
    for (const j of [{}, { first_seen: null }, { first_seen: "not a date" }, null, undefined])
      expect(openDays(j, NOW)).toBe(null);
  });

  it("treats a FUTURE first_seen as unknown, never as very fresh", () => {
    // A clock skew or a bad row must not read as a negative age that passes every bar.
    expect(openDays({ first_seen: daysAgo(-5) }, NOW)).toBe(null);
  });
});

describe("ghostVerdict — it may only ever HOLD, and only when it is sure", () => {
  it("flags a posting open past the bar without ever closing", () => {
    const v = ghostVerdict({ first_seen: daysAgo(60) }, { now: NOW, days: 45 });
    expect(v.evergreen).toBe(true);
    expect(v.reason).toMatch(/open 60d without ever closing/);
  });

  it("stays silent under the bar", () => {
    expect(ghostVerdict({ first_seen: daysAgo(44) }, { now: NOW, days: 45 }).evergreen).toBe(false);
  });

  it("is SILENT whenever the age is unknown — a broken store must not hold every role", () => {
    // The fail-closed-becomes-fail-to-zero shape. If the seen-store fails to load, every job arrives
    // with no first_seen; holding them all would empty the send entirely and report success.
    for (const j of [{}, { first_seen: null }, { first_seen: "garbage" }]) {
      const v = ghostVerdict(j, { now: NOW, days: 45 });
      expect(v.evergreen, JSON.stringify(j)).toBe(false);
      expect(v.ageDays).toBe(null);
      expect(v.reason).toBe("age unknown");
    }
  });

  it("does not double-judge an already-closed posting — that is the liveness gate's hold", () => {
    const v = ghostVerdict({ first_seen: daysAgo(90), status: "closed" }, { now: NOW, days: 45 });
    expect(v.evergreen).toBe(false);
    expect(v.reason).toBe("already closed");
  });

  it("never throws on junk", () => {
    for (const j of [null, undefined, {}, { first_seen: 42 }, { status: {} }])
      expect(() => ghostVerdict(j, { now: NOW })).not.toThrow();
  });

  it("honours GHOST_DAYS", () => {
    expect(ghostVerdict({ first_seen: daysAgo(20) }, { now: NOW, days: 14 }).evergreen).toBe(true);
    expect(ghostVerdict({ first_seen: daysAgo(20) }, { now: NOW, days: 90 }).evergreen).toBe(false);
  });
});

describe("the mode flag", () => {
  it("defaults to shadow, and an unrecognised value is not `enforce`", () => {
    const prev = process.env.GHOST_SCORE;
    try {
      delete process.env.GHOST_SCORE;
      expect(ghostMode()).toBe("shadow");
      // A typo must never silently start holding roles. Only the literal "enforce" enforces, which
      // is checked at the call site in presend-guard.mjs.
      process.env.GHOST_SCORE = "enforcce";
      expect(ghostMode()).not.toBe("enforce");
    } finally {
      if (prev === undefined) delete process.env.GHOST_SCORE; else process.env.GHOST_SCORE = prev;
    }
  });
});

describe("scope honesty — this gate is inert until the store accumulates", () => {
  it("finds nothing in a pool whose first_seen is all from today, as on a fresh store", () => {
    // Every first_seen < 24h old. If this ever starts failing, the logic changed: a fresh store must
    // never look like a pool of ghosts.
    const poolLikeToday = Array.from({ length: 100 }, (_, i) => ({ first_seen: daysAgo(i / 100) }));
    const flagged = poolLikeToday.filter((j) => ghostVerdict(j, { now: NOW, days: 45 }).evergreen);
    expect(flagged.length, "no signal exists yet — silence here is arithmetic, not proof it works").toBe(0);
  });
});
