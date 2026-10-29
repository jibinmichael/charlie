// voice/controller.test.mjs — the five golden personas, the judge-optional invariant, the audio and
// budget rules, meta handling, and purity. No model, no I/O beyond reading fixtures.
// Invariant 3 (no LLM chooses workflow state; hint optional and shape-checked), invariant 10
// (every move has scripted text), and the failure rules for the judge and for audio. The numbered
// list is in docs/ARCHITECTURE.md, "Voice verification invariants".
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { decide, initCursor, markResume, itemStatuses, CONTROLLER_VERSION } from "./controller.mjs";
import { runScripted } from "./text-mode.mjs";
import { classifyTurn, validHint, LIMITS, MOVES, sortItems } from "./policy.mjs";
import { MECHANISM_RE, EM_DASH } from "./plan.mjs";
import { VerificationPlan } from "../lib/schemas/vv-plan.mjs";

const plan = VerificationPlan.parse(JSON.parse(readFileSync("evals/vv/test-plan.json", "utf8")));
const personas = readdirSync("evals/vv/personas").filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`evals/vv/personas/${f}`, "utf8")));
const byRef = Object.fromEntries(plan.items.map((i) => [i.ref, i]));

describe("golden personas", () => {
  it("there are five, and the test plan is a valid approved plan", () => {
    expect(personas.map((p) => p.name).sort()).toEqual(["refuser", "restarter", "strong_specific", "wanderer", "weak_generic"]);
    expect(plan.status).toBe("approved");
    expect(CONTROLLER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  for (const persona of personas) {
    it(`${persona.name}: produces the expected moves, statuses, probes, and end`, () => {
      const r = runScripted(plan, persona);
      expect(r.moves).toEqual(persona.expect.moves);
      expect(r.statuses).toEqual(persona.expect.statuses);
      expect(r.probes).toEqual(persona.expect.probes);
      expect(r.itemsReached).toBe(persona.expect.itemsReached);
      expect(r.endReason).toBe(persona.expect.endReason);
      expect(r.ended).toBe(true);
      if (persona.expect.restarts) {
        for (const [ref, n] of Object.entries(persona.expect.restarts)) expect(r.cursor.items[byRef[ref].id].restarts).toBe(n);
      }
      // every move is a known move and every text is non-empty and clean
      for (const d of r.decisions) {
        expect(MOVES).toContain(d.move);
        expect(d.text.trim().length).toBeGreaterThan(0);
        expect(EM_DASH.test(d.text)).toBe(false);
        expect(MECHANISM_RE.exec(d.text)).toBeNull();
      }
    });
  }
});

describe("the judge is optional (invariant 3, containment row: judge)", () => {
  it("strong_specific with no hints reaches the same items and the same end; only probe and scenario moves differ", () => {
    const strong = personas.find((p) => p.name === "strong_specific");
    const withHints = runScripted(plan, strong, { withHints: true });
    // the same persona, one extra turn, because without a hint the item is never judged sufficient early
    const longer = { ...strong, turns: [...strong.turns, { say: "That's it, really." }, { say: "Nothing to add." }] };
    const noHints = runScripted(plan, longer, { withHints: false });
    expect(noHints.itemsReached).toBe(withHints.itemsReached);
    expect(noHints.endReason).toBe(withHints.endReason);
    expect(noHints.ended).toBe(true);
    const strip = (moves) => moves.filter((m) => !/^probe_|^scenario$/.test(m));
    expect(strip(noHints.moves)).toEqual(strip(withHints.moves));
    expect(Object.values(noHints.probes).every((n) => n >= LIMITS.MIN_PROBES)).toBe(true);
    expect(Object.values(noHints.statuses).every((s) => s === "moved_on")).toBe(true);
  });

  it("a garbage hint is ignored, not obeyed", () => {
    let d = decide({ plan, latestTurn: null });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "ready" } });
    const malformed = ["sufficient", ["instance"], { relevant: false }, { present: "instance" }, null, 42];
    for (const hint of malformed) {
      const r = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme I repair HVAC since 2023." }, hint, elapsed: 20 });
      expect(r.move).toBe("probe_depth"); // the deterministic default, whatever the hint said
      expect(r.cursor.items[byRef["hard:0"].id].present).toEqual([]);
    }
    // well-formed but naming elements outside this item's contract: the names are dropped, nothing is
    // credited, and the controller does what it does for any hint that says the core is absent
    const r = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme I repair HVAC since 2023." }, hint: { present: ["charisma", "mechanism"] }, elapsed: 20 });
    expect(r.move).toBe("probe_specifics");
    expect(r.cursor.items[byRef["hard:0"].id].present).toEqual([]);
    expect(validHint({ present: ["mechanism", "nope"], relevant: "yes" }, byRef["capabilities:0"].evidence_contract)).toEqual({ present: ["mechanism"] });
  });

  it("the decision shape is identical with and without a hint", () => {
    let d = decide({ plan, latestTurn: null });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "ready" } });
    const a = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme, HVAC repair, since 2023, twelve call-outs a week." }, elapsed: 20 });
    const b = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme, HVAC repair, since 2023, twelve call-outs a week." }, hint: { present: ["context", "dates"] }, elapsed: 20 });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.move).toBe(b.move);
  });
});

describe("audio (containment row: STT uncertainty)", () => {
  function toItem1() {
    let d = decide({ plan, latestTurn: null });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "ready" } });
    return d.cursor;
  }
  it("never ends a conversation on a single empty turn; two strikes make the item insufficient (audio); four in a row close cleanly", () => {
    let c = toItem1();
    let d = decide({ plan, cursor: c, latestTurn: { text: "", unusable: true }, elapsed: 20 });
    expect(d.move).toBe("audio_check");
    expect(d.end).toBe(false);
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "uh" }, elapsed: 40 }); // one word: unusable
    expect(d.move).toBe("acknowledge_move_on");
    expect(d.cursor.items[byRef["hard:0"].id].status).toBe("insufficient_audio");
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "", unusable: true }, elapsed: 60 });
    expect(d.move).toBe("audio_check");
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "", unusable: true }, elapsed: 80 });
    expect(d.move).toBe("wrap_up");
    expect(d.end).toBe(true);
    expect(d.endReason).toBe("audio");
    expect(itemStatuses(plan, d.cursor)).toEqual({ "hard:0": "insufficient_audio", "capabilities:0": "insufficient_audio" });
  });

  it("a usable turn resets the session streak", () => {
    let d = decide({ plan, cursor: toItem1(), latestTurn: { text: "", unusable: true }, elapsed: 20 });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme I repair HVAC since 2023 on commercial sites." }, elapsed: 40 });
    expect(d.cursor.unusableStreak).toBe(0);
    expect(d.move).toBe("probe_depth");
  });
});

describe("budgets are seconds and turns, never dollars", () => {
  it("wraps up when the session budget is nearly spent, and never before one probe on the open item", () => {
    let d = decide({ plan, latestTurn: null });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "ready" } });
    const late = plan.session_budget_seconds - LIMITS.WRAP_MARGIN_SECONDS;
    const r = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme I repair HVAC since 2023." }, elapsed: late });
    expect(r.move).toBe("wrap_up");
    expect(r.endReason).toBe("session_budget");
  });

  it("moves on when the item budget is spent after the minimum probe, even without a hint", () => {
    let d = decide({ plan, latestTurn: null });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "ready" }, elapsed: 0 });
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "At Acme I repair HVAC since 2023." }, elapsed: 20 });
    expect(d.move).toBe("probe_depth");
    d = decide({ plan, cursor: d.cursor, latestTurn: { text: "March 2023 and still most of my week." }, elapsed: 20 + byRef["hard:0"].budget_seconds });
    expect(d.move).toBe("acknowledge_move_on");
    expect(d.cursor.items[byRef["hard:0"].id].status).toBe("moved_on");
  });
});

describe("meta, repeat, restart, resume", () => {
  function inItem2() {
    const strong = personas.find((p) => p.name === "strong_specific");
    const r = runScripted(plan, { turns: strong.turns.slice(0, 4) });
    return r.cursor;
  }
  it("a meta question gets the fixed answer plus the pending question restated; the item is untouched", () => {
    const c = inItem2();
    const before = structuredClone(c.items[byRef["capabilities:0"].id]);
    const d = decide({ plan, cursor: c, latestTurn: { text: "Sorry, who will see this recording?" }, elapsed: 100 });
    expect(d.move).toBe("handle_meta");
    expect(d.meta).toBe("who_sees");
    expect(d.text).toMatch(/hiring team/);
    expect(d.text).toContain(byRef["capabilities:0"].evidence_contract.fallback_text.clarify);
    expect(d.cursor.items[byRef["capabilities:0"].id]).toEqual(before);
    expect(d.cursor.metaCount).toBe(1);
  });

  it("repeat restates the question; restart resets the item but keeps its start time and counts the restart", () => {
    const c = inItem2();
    const rep = decide({ plan, cursor: c, latestTurn: { text: "Sorry, could you repeat that?" }, elapsed: 100 });
    expect(rep.move).toBe("clarify_own_question");
    const before = c.items[byRef["capabilities:0"].id];
    const rs = decide({ plan, cursor: c, latestTurn: { text: "Can I start over on that one?" }, elapsed: 100 });
    expect(rs.move).toBe("restart_item");
    const after = rs.cursor.items[byRef["capabilities:0"].id];
    expect(after.probesAsked).toBe(0);
    expect(after.restarts).toBe(1);
    expect(after.startedAt).toBe(before.startedAt);
    expect(rs.text).toContain(byRef["capabilities:0"].evidence_contract.anchor_question);
  });

  it("a resumed conversation says so and restates the pending question, once", () => {
    const c = markResume(inItem2());
    expect(c.conversationCount).toBe(2);
    const d = decide({ plan, cursor: c, latestTurn: null, elapsed: 120 });
    expect(d.move).toBe("resume");
    expect(d.text).toMatch(/cut off/);
    expect(d.text).toContain(c.lastQuestion);
    expect(d.cursor.resumePending).toBe(false);
    const again = decide({ plan, cursor: d.cursor, latestTurn: { text: "Last month I traced a compressor trip from scratch." }, elapsed: 140 });
    expect(again.move).not.toBe("resume");
  });

  it("at the intro, a refusal ends politely and a meta question is answered before the first item", () => {
    const d0 = decide({ plan, latestTurn: null });
    expect(d0.move).toBe("intro");
    const no = decide({ plan, cursor: d0.cursor, latestTurn: { text: "No thanks, I don't want to do this." } });
    expect(no.move).toBe("wrap_up");
    expect(no.endReason).toBe("declined_at_intro");
    const q = decide({ plan, cursor: d0.cursor, latestTurn: { text: "Wait, are you a bot?" } });
    expect(q.move).toBe("handle_meta");
    expect(q.meta).toBe("are_you_ai");
    expect(q.cursor.phase).toBe("ready");
    const go = decide({ plan, cursor: q.cursor, latestTurn: { text: "Okay, go on." } });
    expect(go.move).toBe("ask_anchor");
  });
});

describe("classifyTurn is deterministic and ordered", () => {
  it("restart before refusal, meta before refusal, unusable first", () => {
    expect(classifyTurn({ text: "can I start over" }).kind).toBe("restart");
    expect(classifyTurn({ text: "can I skip this one?" })).toEqual({ kind: "meta", meta: "can_skip" });
    expect(classifyTurn({ text: "I'll skip that one" }).kind).toBe("refusal");
    expect(classifyTurn({ text: "skip" }).kind).toBe("refusal"); // the one-word command the intro invites beats the word-count rule
    expect(classifyTurn({ text: "Skip that." }).kind).toBe("refusal");
    expect(classifyTurn({ text: "uh" }).kind).toBe("unusable"); // one word and not a command: audio
    expect(classifyTurn({ text: "I need a moment" })).toEqual({ kind: "pause", meta: "pause" });
    expect(classifyTurn({ text: "sorry, what?" }).kind).toBe("repeat");
    expect(classifyTurn({ text: "At Acme I repair HVAC." }).kind).toBe("answer");
    expect(classifyTurn(null).kind).toBe("unusable");
  });
});

describe("purity", () => {
  it("decide never mutates the cursor it was given, and the same inputs give the same decision", () => {
    let d = decide({ plan, latestTurn: null });
    const c = d.cursor;
    const snapshot = JSON.stringify(c);
    const a = decide({ plan, cursor: c, latestTurn: { text: "ready" } });
    const b = decide({ plan, cursor: c, latestTurn: { text: "ready" } });
    expect(JSON.stringify(c)).toBe(snapshot);
    expect(a).toEqual(b);
    expect(initCursor().phase).toBe("intro");
    expect(sortItems(plan.items).map((i) => i.ref)).toEqual(["hard:0", "capabilities:0", "intent:0"]);
  });
});
