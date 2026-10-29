// voice/judge.test.mjs — the judge is optional: a judge that never resolves, errors, or returns
// garbage yields a null hint, and a full persona run completes with it. Model stubbed.
// Invariant 3 and the failure rule "sufficiency judge failure → safe default move" (see
// docs/ARCHITECTURE.md, "Voice verification invariants").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { judgeOnce, startJudge } from "./judge.mjs";
import { decide } from "./controller.mjs";
import { VerificationPlan } from "../lib/schemas/vv-plan.mjs";

const plan = VerificationPlan.parse(JSON.parse(readFileSync("evals/vv/test-plan.json", "utf8")));
const item = plan.items[1];
const exchanges = [{ speaker: "agent", text: item.evidence_contract.anchor_question }, { speaker: "candidate", text: "Last month I traced a compressor trip across 6 rooftop units with a leak detector and wrote a three-step repair plan." }];
const reply = (text) => ({ messages: { create: async () => ({ content: [{ type: "text", text }] }) } });
const quiet = () => {};

describe("judgeOnce", () => {
  it("returns a valid hint", async () => {
    const h = await judgeOnce({ client: reply(JSON.stringify({ present: ["instance"], relevant: true })), model: "stub", item, exchanges, log: quiet });
    expect(h).toEqual({ present: ["instance"], relevant: true });
  });

  it("never throws: error, deadline, non-JSON, schema, unknown element, missing model all give null", async () => {
    expect(await judgeOnce({ client: { messages: { create: async () => { throw new Error("boom"); } } }, model: "stub", item, exchanges, log: quiet })).toBeNull();
    expect(await judgeOnce({ client: { messages: { create: () => new Promise(() => {}) } }, model: "stub", item, exchanges, deadlineMs: 15, log: quiet })).toBeNull();
    expect(await judgeOnce({ client: reply("sufficient"), model: "stub", item, exchanges, log: quiet })).toBeNull();
    expect(await judgeOnce({ client: reply(JSON.stringify({ present: "instance", relevant: true })), model: "stub", item, exchanges, log: quiet })).toBeNull();
    expect(await judgeOnce({ client: reply(JSON.stringify({ present: ["charisma"], relevant: true })), model: "stub", item, exchanges, log: quiet })).toBeNull();
    const prev = process.env.VOICE_JUDGE_MODEL; delete process.env.VOICE_JUDGE_MODEL;
    try { expect(await judgeOnce({ client: reply("{}"), item, exchanges, log: quiet })).toBeNull(); }
    finally { if (prev !== undefined) process.env.VOICE_JUDGE_MODEL = prev; }
  });
});

describe("startJudge is fire-and-forget", () => {
  it("latest() is null until the call resolves, and stays null forever if it never does", async () => {
    const never = startJudge({ client: { messages: { create: () => new Promise(() => {}) } }, model: "stub", item, exchanges, deadlineMs: 20, log: quiet });
    expect(never.latest()).toBeNull();
    await never.settled;
    expect(never.latest()).toBeNull();
    const fast = startJudge({ client: reply(JSON.stringify({ present: ["instance", "mechanism"], relevant: true })), model: "stub", item, exchanges, log: quiet });
    expect(fast.latest()).toBeNull(); // not yet
    await fast.settled;
    expect(fast.latest()).toEqual({ present: ["instance", "mechanism"], relevant: true });
  });

  it("a full session completes with a judge that never resolves, and reaches the same items as with a working one", async () => {
    const answers = [
      "Ready.", "At Acme I repair HVAC on commercial sites since March 2023, twelve call-outs a week.", "March 2023 and still most of my week.",
      "Last month I traced a compressor trip across 6 units from scratch; five cleared.", "I started with the units that tripped most recently.", "The diagnosis and fixes were mine.",
      "Say you joined with no service history: I'd start from the alarm logs.", "I want to work on hospital plant rooms, which this role is.", "Diagnosing faults from scratch without a supervisor on site.", "That's it.", "Nothing to add.",
    ];
    const run = (client) => {
      let cursor = null, d = decide({ plan, latestTurn: null }); cursor = d.cursor;
      const moves = [d.move];
      for (let i = 0; i < answers.length && !d.end; i++) {
        const it = cursor.itemIndex >= 0 ? plan.items[cursor.itemIndex] : null;
        const judge = it ? startJudge({ client, model: "stub", item: it, exchanges: [{ speaker: "candidate", text: answers[i] }], deadlineMs: 5, log: quiet }) : null;
        d = decide({ plan, cursor, latestTurn: { text: answers[i] }, hint: judge?.latest() ?? undefined, elapsed: (i + 1) * 20 });
        cursor = d.cursor; moves.push(d.move);
      }
      return { moves, ended: d.end, itemsReached: Object.keys(cursor.items).length, endReason: cursor.endReason };
    };
    const dead = run({ messages: { create: () => new Promise(() => {}) } });
    expect(dead.ended).toBe(true);
    expect(dead.itemsReached).toBe(3);
    expect(dead.endReason).toBe("items_exhausted");
    const alive = run(reply(JSON.stringify({ present: ["instance", "mechanism", "ownership", "context", "dates", "motivation"], relevant: true })));
    expect(alive.ended).toBe(true);
    expect(alive.itemsReached).toBe(dead.itemsReached);
    expect(alive.endReason).toBe(dead.endReason);
  });
});
