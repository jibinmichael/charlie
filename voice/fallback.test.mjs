// voice/fallback.test.mjs — every scripted line exists, and every one passes the candidate-facing
// voice walls (no em dash, never the mechanism).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fallbackText, allSessionLines, META_ANSWERS, REFUSAL_ACK } from "./fallback.mjs";
import { MOVES, classifyTurn } from "./policy.mjs";
import { MECHANISM_RE, EM_DASH } from "./plan.mjs";
import { FALLBACK_MOVES, VerificationPlan } from "../lib/schemas/vv-plan.mjs";

const plan = VerificationPlan.parse(JSON.parse(readFileSync("evals/vv/test-plan.json", "utf8")));

describe("session-level scripted lines", () => {
  it("every line is non-empty, has no em dash, and never names the mechanism", () => {
    const lines = allSessionLines(plan);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(EM_DASH.test(line)).toBe(false);
      expect({ line, hit: MECHANISM_RE.exec(line)?.[0] ?? null }).toEqual({ line, hit: null });
    }
    expect(MECHANISM_RE.exec(REFUSAL_ACK)).toBeNull();
  });

  it("the wrap-up uses HR's sentence when there is one and claims no timeline when there is not", () => {
    const withHr = fallbackText(null, "wrap_up", { plan, context: { nextStepText: "We will be in touch within a week." } });
    expect(withHr).toContain("We will be in touch within a week.");
    const without = fallbackText(null, "wrap_up", { plan, context: {} });
    expect(without).toMatch(/don't set the timeline/);
    expect(without).not.toMatch(/within|days|week/);
  });

  it("how long is built from the plan budget; an unknown meta key gets the honest default", () => {
    expect(fallbackText(null, "handle_meta", { plan, meta: "how_long" })).toMatch(/About 10 minutes/);
    expect(fallbackText(null, "handle_meta", { plan, meta: "nonsense" })).toBe(META_ANSWERS.unknown);
  });

  it("every meta key classifyTurn can produce has an answer", () => {
    const samples = {
      who_sees: "who will see this?", how_long: "how long will this take?", can_skip: "can I skip a question?",
      can_stop: "can I stop if I need to?", is_recorded: "is this being recorded?", are_you_ai: "are you a robot?",
      what_next: "what happens next?", what_is_this: "what is this for?", pause: "give me a second",
    };
    for (const [key, text] of Object.entries(samples)) {
      const cls = classifyTurn({ text });
      expect({ text, meta: cls.meta }).toEqual({ text, meta: key });
      expect(fallbackText(null, "handle_meta", { plan, meta: key }).length).toBeGreaterThan(10);
    }
  });
});

describe("item-level scripted lines", () => {
  it("every item in the plan has all four fallback texts, and every item-level move has text", () => {
    for (const item of plan.items) {
      for (const mv of FALLBACK_MOVES) expect(item.evidence_contract.fallback_text[mv].length).toBeGreaterThan(0);
      for (const move of MOVES) {
        if (["intro", "wrap_up", "resume", "audio_check", "restart_item", "handle_refusal", "handle_meta"].includes(move)) continue;
        const text = fallbackText(item, move, { plan });
        expect({ ref: item.ref, move, len: text.length > 0 }).toEqual({ ref: item.ref, move, len: true });
        expect(MECHANISM_RE.exec(text)).toBeNull();
        expect(EM_DASH.test(text)).toBe(false);
      }
    }
  });

  it("an unknown move throws rather than returning silence", () => {
    expect(() => fallbackText(plan.items[0], "improvise", { plan })).toThrow(/unknown move/);
  });
});
