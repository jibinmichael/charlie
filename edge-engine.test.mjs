// edge-engine.test.mjs — behavior guard for the Edge Engine (no live API).
//
// Two things must hold:
//   1. DARK SWITCH: with EDGE_ENGINE unset, the built dossier carries NO `edge` key and the verifier is
//      never called. This is the regression fence.
//   2. FAIL CLOSED: with the flag on, an ungrounded/unverifiable edge is dropped; only a grounded edge
//      survives, stamped with the verifier's confidence (not the builder's).
//
// We test finalizeEdge() directly with an INJECTED fake Anthropic client, so the whole edge path runs
// deterministically without a real key or a real dossier build.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { finalizeEdge } from "./dossier-build.mjs";

// A fake client whose messages.create returns a canned verifier reply, and counts calls.
function fakeClient(replyJson) {
  const calls = { n: 0 };
  return {
    calls,
    messages: {
      create: async () => {
        calls.n++;
        return { content: [{ type: "text", text: JSON.stringify(replyJson) }] };
      },
    },
  };
}

const RESUME = "Jane Doe\nB.Arch. 5 years as a licensed architect, then 3 years UX design for indoor maps and wayfinding.";
const makeDossier = () => ({
  headline: "product designer",
  edge: { combo: "architecture background + UX design", evidence: ["resume: B.Arch, licensed architect"], strong_in: ["indoor navigation UX"], generic_in: ["fintech"], source: "resume" },
});

const ENV = process.env.EDGE_ENGINE;
beforeEach(() => { delete process.env.EDGE_ENGINE; });
afterEach(() => { if (ENV === undefined) delete process.env.EDGE_ENGINE; else process.env.EDGE_ENGINE = ENV; });

describe("dark switch — EDGE_ENGINE off", () => {
  it("strips any edge and never calls the verifier", async () => {
    const client = fakeClient({ grounded: true, confidence: "high" });
    const d = await finalizeEdge(makeDossier(), RESUME, client);
    expect("edge" in d).toBe(false);
    expect(client.calls.n).toBe(0); // the dark switch must not spend a model call
  });

  it("leaves an edge-less dossier untouched", async () => {
    const client = fakeClient({ grounded: true, confidence: "high" });
    const d = await finalizeEdge({ headline: "x" }, RESUME, client);
    expect("edge" in d).toBe(false);
    expect(client.calls.n).toBe(0);
  });
});

describe("flag on — the verifier gates the edge", () => {
  beforeEach(() => { process.env.EDGE_ENGINE = "on"; });

  it("keeps a grounded edge and stamps the verifier's confidence", async () => {
    const client = fakeClient({ grounded: true, confidence: "medium", reason: "grounded but mildly unusual" });
    const d = await finalizeEdge(makeDossier(), RESUME, client);
    expect(d.edge).toBeTruthy();
    expect(d.edge.confidence).toBe("medium"); // verifier's read overrides whatever the builder claimed
    expect(client.calls.n).toBe(1);
  });

  it("drops an edge the verifier says is not grounded", async () => {
    const client = fakeClient({ grounded: false, confidence: "low", reason: "second half not in source" });
    const d = await finalizeEdge(makeDossier(), RESUME, client);
    expect("edge" in d).toBe(false);
  });

  it("drops the edge when the verifier reply is unreadable (fail closed)", async () => {
    const client = {
      messages: { create: async () => ({ content: [{ type: "text", text: "not json at all" }] }) },
    };
    const d = await finalizeEdge(makeDossier(), RESUME, client);
    expect("edge" in d).toBe(false);
  });

  it("drops the edge when the verifier throws (fail closed, never throws up)", async () => {
    const client = { messages: { create: async () => { throw new Error("api down"); } } };
    const d = await finalizeEdge(makeDossier(), RESUME, client);
    expect("edge" in d).toBe(false);
  });
});
