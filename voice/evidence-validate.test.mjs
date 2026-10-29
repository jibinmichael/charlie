// voice/evidence-validate.test.mjs — cite-or-drop, provenance, reliability, probe depth.
// No evidence without transcript provenance, and a failed validation drops the item rather than
// keeping it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateEvidence, probeDepthFor, reliabilityOf, LOW_STT_CONFIDENCE } from "./evidence-validate.mjs";
import { VerificationPlan } from "../lib/schemas/vv-plan.mjs";

const plan = VerificationPlan.parse(JSON.parse(readFileSync("evals/vv/test-plan.json", "utf8")));
const fx = JSON.parse(readFileSync("evals/vv/evidence/strong_specific.json", "utf8"));
const conv = fx.conversation_id;
const turns = fx.turns.map((t) => ({ ...t, conversation_id: conv }));
const item = plan.items[1]; // capabilities:0
const itemTurns = turns.filter((t) => t.plan_item_id === item.id);
const SESSION = "5a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ctx = { item, sessionId: SESSION, turns: itemTurns, extractorVersion: "test.1" };

describe("validateEvidence", () => {
  it("keeps a verbatim quote and adds provenance, reliability and probe depth from the turns", () => {
    const { items, dropped } = validateEvidence(fx.extractor_output[item.id], ctx);
    expect(dropped).toEqual([]);
    expect(items).toHaveLength(3);
    const mech = items.find((e) => e.contract_element === "mechanism");
    expect(mech.provenance).toEqual({ conversation_id: conv, turn_ids: ["aa000000-0000-4000-8000-000000000008"], audio_start_secs: 82, audio_end_secs: 96 });
    expect(mech.reliability).toBe("usable");
    expect(mech.probe_depth).toBe(1);
    const own = items.find((e) => e.contract_element === "ownership");
    expect(own.probe_depth).toBe(2);
    expect(items.find((e) => e.contract_element === "instance").probe_depth).toBe(0);
    expect(items.every((e) => e.session_id === SESSION && e.plan_item_id === item.id && e.extractor_version === "test.1")).toBe(true);
  });

  it("drops a quote that is not in the cited turn, and says so", () => {
    const raw = { items: [{ ...fx.extractor_output[item.id].items[0], quote: "I rebuilt 30 chillers and cut energy use by half." }] };
    const { items, dropped } = validateEvidence(raw, ctx);
    expect(items).toEqual([]);
    expect(dropped).toEqual([{ quote: raw.items[0].quote, reason: "quote not found in the cited turn(s)" }]);
  });

  it("tolerates whitespace and curly quotes but not a changed word", () => {
    const base = fx.extractor_output[item.id].items[2];
    const ok = validateEvidence({ items: [{ ...base, quote: "The diagnosis  and the repair plan were mine." }] }, ctx);
    expect(ok.items).toHaveLength(1);
    const bad = validateEvidence({ items: [{ ...base, quote: "The diagnosis and the repair plan were largely mine." }] }, ctx);
    expect(bad.items).toHaveLength(0);
  });

  it("refuses a turn that does not exist, an agent's turn, another item's turn, and an element outside the contract", () => {
    const base = fx.extractor_output[item.id].items[0];
    expect(validateEvidence({ items: [{ ...base, turn_seqs: [99] }] }, ctx).dropped[0].reason).toMatch(/does not exist/);
    expect(validateEvidence({ items: [{ ...base, quote: "How did you decide where to start looking?", turn_seqs: [7] }] }, ctx).dropped[0].reason).toMatch(/not the candidate's/);
    const other = validateEvidence({ items: [{ ...base, quote: "At Acme I repair rooftop HVAC", turn_seqs: [2] }] }, { ...ctx, turns }); // seq 2 belongs to hard:0
    expect(other.dropped[0].reason).toMatch(/another item/);
    expect(validateEvidence({ items: [{ ...base, contract_element: "availability" }] }, ctx).dropped[0].reason).toMatch(/not in this item's contract/);
  });

  it("a claim is specificity 0 whatever the model said; an unusable turn makes the item unreliable", () => {
    const base = fx.extractor_output[item.id].items[0];
    const r = validateEvidence({ items: [{ ...base, type: "claim", specificity: 2 }] }, ctx);
    expect(r.items[0].specificity).toBe(0);
    const bad = itemTurns.map((t) => (t.seq === 6 ? { ...t, usable: false } : t));
    const u = validateEvidence({ items: [base] }, { ...ctx, turns: bad });
    expect(u.items[0].reliability).toBe("unusable");
    const low = itemTurns.map((t) => (t.seq === 6 ? { ...t, stt_confidence: LOW_STT_CONFIDENCE - 0.1 } : t));
    expect(validateEvidence({ items: [base] }, { ...ctx, turns: low }).items[0].reliability).toBe("low_confidence");
  });

  it("probe depth is read from the agent moves, capped at two, reset by a restart", () => {
    expect(reliabilityOf([{ usable: true }])).toBe("usable");
    const t = [
      { seq: 1, speaker: "agent", move: "ask_anchor", conversation_id: "c" },
      { seq: 2, speaker: "candidate", conversation_id: "c" },
      { seq: 3, speaker: "agent", move: "probe_depth", conversation_id: "c" },
      { seq: 4, speaker: "candidate", conversation_id: "c" },
      { seq: 5, speaker: "agent", move: "probe_ownership", conversation_id: "c" },
      { seq: 6, speaker: "candidate", conversation_id: "c" },
      { seq: 7, speaker: "agent", move: "scenario", conversation_id: "c" },
      { seq: 8, speaker: "candidate", conversation_id: "c" },
      { seq: 9, speaker: "agent", move: "restart_item", conversation_id: "c" },
      { seq: 10, speaker: "candidate", conversation_id: "c" },
    ];
    expect(probeDepthFor(t[1], t)).toBe(0);
    expect(probeDepthFor(t[3], t)).toBe(1);
    expect(probeDepthFor(t[5], t)).toBe(2);
    expect(probeDepthFor(t[7], t)).toBe(2);
    expect(probeDepthFor(t[9], t)).toBe(0);
  });

  it("an empty extraction is a normal result, not an error", () => {
    expect(validateEvidence({ items: [] }, ctx)).toEqual({ items: [], dropped: [] });
    expect(validateEvidence(null, ctx)).toEqual({ items: [], dropped: [] });
  });
});
