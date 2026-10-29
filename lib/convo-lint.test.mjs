// lib/convo-lint.test.mjs — the honesty copy-lint (deterministic, no I/O).
//
// A caring, honest message passes; every manipulation class is caught and would be dropped; and a
// line that only works because the reader would feel bad is rejected. Also checks the watchdog
// default copy clears its own gate.

import { describe, it, expect } from "vitest";
import { lintMessage } from "./convo-lint.mjs";
import { journeyMessage } from "../journey-watchdog.mjs";

const COMPLIANT = {
  subject: "Where things stand",
  text: "You flagged the commute on the Stripe role. I kept that in mind and found something fully remote. Want me to send it over? No rush at all.",
  userFacts: ["the commute on the Stripe role"],
};

describe("lintMessage — a caring, honest message passes", () => {
  it("passes a reflection + one question + costless exit, no manipulation", () => {
    expect(lintMessage(COMPLIANT)).toEqual({ ok: true, violations: [] });
  });
  it("passes a safety-net message with no userFacts (reflection skipped)", () => {
    const r = lintMessage({ subject: "Still here", text: "No rush at all, nothing's lost. Want me to keep an eye out?" });
    expect(r.ok).toBe(true);
  });
});

describe("the watchdog default copy clears its own gate", () => {
  for (const phase of ["park", "nudge", "pulse"]) {
    it(`journeyMessage("${phase}") passes the lint`, () => {
      const m = journeyMessage("x", phase, { email: "u@e.com" });
      const r = lintMessage({ subject: m.subject, text: m.text });
      expect(r.ok, `${phase} violations: ${r.violations.map((v) => v.rule).join(",")}`).toBe(true);
    });
  }
});

describe("honesty blocklist — every manipulation class is caught", () => {
  const base = "Here is a thought. Want to take a look? No rush.";
  const cases = {
    "scarcity-countdown": "Only 3 spots left for this. Want in? No rush.",
    "scarcity-lastchance": "Last chance on this one. Interested? No rush.",
    "scarcity-deadline": "Act now before it's gone. Want it? No rush.",
    streak: "Don't lose your streak. Keep going? No rush.",
    "waiting-guilt": "I've been waiting to hear back from you. Still there? No rush.",
    "guilt-debt": "The least you could do is reply. Will you? No rush.",
    "sad-mascot": "I'm so sad you haven't written. Can you? No rush.",
    "fake-progress": "You're 80% complete on your setup. Finish it? No rush.",
  };
  for (const [rule, text] of Object.entries(cases)) {
    it(`catches ${rule}`, () => {
      const r = lintMessage({ text });
      expect(r.ok).toBe(false);
      expect(r.violations.map((v) => v.rule)).toContain(rule);
    });
  }
  it("the prose test: a line that only works because the reader feels bad is rejected", () => {
    // No scarcity, no counter — purely a guilt appeal. Must still fail.
    expect(lintMessage({ text: "You've gone quiet on me. Coming back? No rush." }).ok).toBe(false);
  });
  void base;
});

describe("structural checks — question, exit, voice, reflection", () => {
  it("requires exactly one question (zero and two both fail)", () => {
    expect(lintMessage({ text: "Here is an update. No rush at all." }).violations.map((v) => v.rule)).toContain("question-count");
    expect(lintMessage({ text: "Ready? Or later? No rush." }).violations.map((v) => v.rule)).toContain("question-count");
  });
  it("requires a costless exit", () => {
    expect(lintMessage({ text: "I found a role. Want it?" }).violations.map((v) => v.rule)).toContain("no-costless-exit");
  });
  it("rejects em dashes (voice)", () => {
    expect(lintMessage({ text: "I found a role — a good one. Want it? No rush." }).violations.map((v) => v.rule)).toContain("em-dash");
  });
  it("requires the opening to reflect a supplied fact", () => {
    const bad = lintMessage({ text: "I found a role. Want it? No rush.", userFacts: ["the commute on the Stripe role"] });
    expect(bad.violations.map((v) => v.rule)).toContain("no-reflection");
    const good = lintMessage({ text: "You flagged the commute on the Stripe role. Want the remote one? No rush.", userFacts: ["the commute on the Stripe role"] });
    expect(good.ok).toBe(true);
  });
});

describe("conversational:false — universal-only gate (campaign / non-interrogation sends)", () => {
  it("skips the conversational structural rules (question-count, costless-exit, reflection)", () => {
    // a hiring email: no single question, no 'no rush' exit — would fail conversational mode, passes universal.
    const m = { subject: "You're through", text: "I read every word. All of it. You earned this." };
    expect(lintMessage({ ...m }).ok).toBe(false); // conversational default: fails structural
    expect(lintMessage({ ...m, conversational: false }).ok).toBe(true); // universal-only: passes
  });
  it("STILL blocks manipulation and em dashes even in universal mode", () => {
    expect(lintMessage({ text: "only 2 spots left, hurry", conversational: false }).ok).toBe(false);
    expect(lintMessage({ text: "a good role, take it or leave it — no worries", conversational: false }).violations.map((v) => v.rule)).toContain("em-dash");
    expect(lintMessage({ text: "", conversational: false }).violations.map((v) => v.rule)).toContain("empty");
  });
});
