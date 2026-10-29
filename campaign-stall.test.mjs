// campaign-stall.test.mjs — the hiring loop's one nudge, and the three ways it must not misfire.
//
// Applicants who go quiet after the challenge question never reach `verdict_review`, the only stage
// where a human is asked to advance anyone, unless something nudges them once.
//
// The selection rule is pure so it can be tested without a mailbox, because the failure modes here
// are all about WHO gets mail: nudging someone who just wrote, nudging someone a human already
// judged, or nudging the same person twice about a job they have quietly declined.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { stalledApplicants, stallHours, campaignOn } from "./campaign-stall.mjs";

const ENV = ["JOIN_STALL_HOURS", "JOIN_CAMPAIGN"];
const clear = () => ENV.forEach((k) => delete process.env[k]);
beforeEach(clear); afterEach(clear);

const NOW = Date.parse("2026-08-12T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const row = (o = {}) => ({ email: "a@b.com", stage: "challenge", turns: 1, verdict: null, last_msg_at: hoursAgo(48), ...o });

describe("who is genuinely stalled", () => {
  it("THE REAL CASE: mid-challenge and silent past the window", () => {
    expect(stalledApplicants([row()], { now: NOW, hours: 36 }).map((r) => r.email)).toEqual(["a@b.com"]);
  });

  it("does NOT nudge someone who wrote recently", () => {
    expect(stalledApplicants([row({ last_msg_at: hoursAgo(2) })], { now: NOW, hours: 36 })).toEqual([]);
  });

  it("does NOT nudge someone a human has already judged", () => {
    for (const verdict of ["advance", "reject", "hold"]) {
      expect(stalledApplicants([row({ verdict })], { now: NOW, hours: 36 }), verdict).toEqual([]);
    }
  });

  it("does NOT nudge anyone outside the challenge stage", () => {
    for (const stage of ["redirected", "verdict_review", "advanced", "rejected", "prescreen_review"]) {
      expect(stalledApplicants([row({ stage })], { now: NOW, hours: 36 }), stage).toEqual([]);
    }
  });

  it("does NOT nudge on an unreadable last_msg_at — unknown silence is not evidence of silence", () => {
    for (const last of [null, undefined, "", "not a date"]) {
      expect(stalledApplicants([row({ last_msg_at: last })], { now: NOW, hours: 36 })).toEqual([]);
    }
  });

  it("the window is tunable at call time, not frozen at import", () => {
    expect(stallHours()).toBe(36);
    process.env.JOIN_STALL_HOURS = "12";
    expect(stallHours()).toBe(12);
    process.env.JOIN_STALL_HOURS = "nonsense";
    expect(stallHours()).toBe(36); // junk falls back rather than nudging everyone instantly
  });

  it("is inert unless the campaign is on", () => {
    expect(campaignOn()).toBe(false);
    process.env.JOIN_CAMPAIGN = "on";
    expect(campaignOn()).toBe(true);
  });
});

describe("the guarantees that keep this from becoming spam", () => {
  const src = readFileSync(new URL("./campaign-stall.mjs", import.meta.url), "utf8");

  it("exactly ONE nudge per person, forever: the dedupe key carries no date", () => {
    expect(src).toContain("dedupeKey: `stall:${r.email}`");
    expect(src).not.toMatch(/dedupeKey: `stall:\$\{r\.email\}:\$\{/); // no date/run suffix
  });

  it("routes through the one send door", () => {
    expect(src).toContain("sendGuarded({");
    expect(src).not.toMatch(/resend\.emails\.send/);
  });

  it("NEVER advances anybody — the verdict stays human", () => {
    for (const w of ["upsertJoinApplicant", "stage:", "verdict:", "turns:"]) {
      expect(src, `must not write ${w}`).not.toContain(w);
    }
  });

  it("isolates each record so one bad row cannot abort the batch", () => {
    expect(src).toMatch(/for \(const r of due\)[\s\S]{0,120}try \{/);
  });

  it("is wired into the server on a timer, and inert without the flag", () => {
    const server = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");
    expect(server).toContain("runCampaignStallSweep");
    expect(src).toContain("if (!campaignOn()) return");
  });
});
