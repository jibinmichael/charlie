// lib/schemas/inbound-signal.test.mjs — coerceInboundSignal salvages a message: one over-long label
// costs that label, never the whole message.
import { describe, it, expect } from "vitest";
import { InboundSignal, coerceInboundSignal } from "./inbound-signal.mjs";

const long = (n) => "names the metric they moved and gives the team size and the timeframe too".padEnd(n, " x").slice(0, n);

const record = (labels) => ({
  traits: labels.map((l) => ({ label: l, quote: "grew it from zero to 500K+ users" })),
  facts: { pay_expected: "19.95 LPA", notice: null, work_mode: null, location: null, seeking: "open" },
  has_work_evidence: true,
});

describe("a bad field costs its field, not the record", () => {
  it("the strict parse rejects the whole record over one long label (why coerceInboundSignal exists)", () => {
    const r = record([long(200), "asks what hybrid means"]);
    expect(InboundSignal.safeParse(r).success).toBe(false);
  });

  it("the coercer keeps the message, drops only the label it cannot hold", () => {
    const c = coerceInboundSignal(record([long(200), "asks what hybrid means"]));
    expect(c.ok).toBe(true);
    expect(c.droppedTraits).toBe(1);
    expect(c.data.traits.map((t) => t.label)).toEqual(["asks what hybrid means"]);
    // the facts are the point: a stated pay expectation must survive
    expect(c.data.facts.pay_expected).toBe("19.95 LPA");
    expect(c.data.has_work_evidence).toBe(true);
  });

  it("a label just over 60 characters survives outright", () => {
    const c = coerceInboundSignal(record([long(62)]));
    expect(c.droppedTraits).toBe(0);
    expect(c.data.traits).toHaveLength(1);
  });

  it("an over-long work_mode is dropped to null, never cut down to fit", () => {
    const r = record(["asks what hybrid means"]);
    r.facts.work_mode = "remote preferred, and not open to onsite".padEnd(300, " x");
    const c = coerceInboundSignal(r);
    expect(c.ok).toBe(true);
    expect(c.data.facts.work_mode).toBeNull(); // truncating this one could invert its meaning
  });

  it("an unreadable shape is still refused", () => {
    expect(coerceInboundSignal(null).ok).toBe(false);
    expect(coerceInboundSignal("nope").ok).toBe(false);
  });

  it("an invented seeking value falls back to unclear rather than killing the record", () => {
    const r = record(["asks what hybrid means"]);
    r.facts.seeking = "very open";
    const c = coerceInboundSignal(r);
    expect(c.ok).toBe(true);
    expect(c.data.facts.seeking).toBe("unclear");
  });
});
